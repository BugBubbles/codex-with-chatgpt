import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_METADATA_BYTES = 1024 * 1024;
const DISCOVERY_TTL_MS = 5_000;
const metadataCache = new Map<string, {
  directoryStamp: string;
  pythonFile: string | null;
  pythonStamp: string;
  packageCount: number;
  pythonVersion: string | null;
  checkedAt: number;
}>();
const KNOWN_HOME_ROOTS = [
  "miniconda3",
  "anaconda3",
  "miniforge3",
  "mambaforge",
  "micromamba",
  path.join(".local", "share", "mamba"),
];

export interface CondaEnvironmentInfo {
  id: string;
  name: string;
  prefix: string;
  python: string;
  pythonVersion: string | null;
  packageCount: number;
  isDefault: boolean;
}

function safeRealpath(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function executableFile(candidate: string): string | null {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    if (!fs.statSync(candidate).isFile()) return null;
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function resolveCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep)) return executableFile(trimmed);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const resolved = executableFile(path.join(dir, trimmed));
    if (resolved) return resolved;
  }
  return null;
}

export function configuredPythonCommand(): string {
  return process.env.C2C_PYTHON_BIN?.trim() || (process.platform === "win32" ? "python" : "python3");
}

function pythonInPrefix(prefix: string): string | null {
  const candidates =
    process.platform === "win32"
      ? [path.join(prefix, "python.exe")]
      : [path.join(prefix, "bin", "python"), path.join(prefix, "bin", "python3")];
  for (const candidate of candidates) {
    const resolved = executableFile(candidate);
    if (!resolved) continue;
    // Do not turn a registered environment into an arbitrary executable selector.
    // A normal Conda interpreter resolves inside its own prefix.
    if (resolved === prefix || resolved.startsWith(prefix + path.sep)) return resolved;
  }
  return null;
}

function isCondaPrefix(prefix: string): boolean {
  return isDirectory(path.join(prefix, "conda-meta")) && pythonInPrefix(prefix) !== null;
}

function prefixFromPythonCommand(command: string): string | null {
  const executable = resolveCommand(command);
  if (!executable) return null;
  const prefix = safeRealpath(path.dirname(path.dirname(executable)));
  return prefix && isCondaPrefix(prefix) ? prefix : null;
}

function readRegisteredPrefixes(home: string): string[] {
  const registry = path.join(home, ".conda", "environments.txt");
  try {
    const stat = fs.statSync(registry);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return [];
    return fs
      .readFileSync(registry, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fileStamp(file: string): string {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return "missing";
  }
}

function packageMetadata(prefix: string): { packageCount: number; pythonVersion: string | null } {
  const metaDir = path.join(prefix, "conda-meta");
  const directoryStamp = fileStamp(metaDir);
  const cached = metadataCache.get(prefix);
  if (cached && cached.directoryStamp === directoryStamp &&
      (cached.pythonFile ? cached.pythonStamp === fileStamp(cached.pythonFile) : Date.now() - cached.checkedAt < DISCOVERY_TTL_MS)) {
    return { packageCount: cached.packageCount, pythonVersion: cached.pythonVersion };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(metaDir).filter((name) => name.endsWith(".json"));
  } catch {
    return { packageCount: 0, pythonVersion: null };
  }

  let pythonVersion: string | null = null;
  let pythonFile: string | null = null;
  // Standard Conda filenames identify Python directly; retain a fallback for
  // nonstandard metadata names without reading every package on normal installs.
  const candidates = entries.filter((name) => /^python-\d/.test(name));
  const others = entries.filter((name) => !/^python-\d/.test(name));
  for (const name of [...candidates, ...others]) {
    if (pythonVersion !== null) break;
    const file = path.join(metaDir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
      if (parsed.name === "python" && typeof parsed.version === "string") {
        pythonVersion = parsed.version;
        pythonFile = file;
      }
    } catch {
      // Malformed package metadata should not make environment discovery fail.
    }
  }
  const result = { packageCount: entries.length, pythonVersion };
  if (metadataCache.size >= 64) metadataCache.delete(metadataCache.keys().next().value!);
  metadataCache.set(prefix, {
    ...result, directoryStamp, pythonFile,
    pythonStamp: pythonFile ? fileStamp(pythonFile) : "missing",
    checkedAt: Date.now(),
  });
  return result;
}

function envId(prefix: string): string {
  return "conda-" + createHash("sha256").update(prefix).digest("hex").slice(0, 12);
}

function addPrefix(target: Set<string>, candidate: string | undefined): void {
  if (!candidate) return;
  const resolved = safeRealpath(candidate);
  if (resolved && isCondaPrefix(resolved)) target.add(resolved);
}

function scanRoot(rootCandidate: string, prefixes: Set<string>, basePrefixes: Set<string>): void {
  const root = safeRealpath(rootCandidate);
  if (!root) return;
  if (isCondaPrefix(root)) {
    prefixes.add(root);
    basePrefixes.add(root);
  }

  const envsDir = path.join(root, "envs");
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(envsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    addPrefix(prefixes, path.join(envsDir, child.name));
  }
}

/**
 * Discover Conda environments without invoking conda/mamba or executing any
 * environment hook. Only filesystem metadata and executable presence are read.
 */
interface Discovery {
  key: string;
  expiresAt: number;
  prefixes: Set<string>;
  basePrefixes: Set<string>;
  currentPrefix: string | null;
  directories: Map<string, string>;
}

let discovery: Discovery | undefined;

function discoverPrefixes(): Discovery {
  const home = os.homedir();
  const key = JSON.stringify([
    home, configuredPythonCommand(), process.env.PATH, process.env.C2C_CONDA_ROOTS,
    Object.entries(process.env).filter(([name]) => name === "CONDA_PREFIX" || /^CONDA_PREFIX_\d+$/.test(name)).sort(),
    fileStamp(path.join(home, ".conda", "environments.txt")),
  ]);
  if (discovery?.key === key && discovery.expiresAt > Date.now() &&
      [...discovery.directories].every(([dir, expected]) => fileStamp(dir) === expected)) return discovery;
  const prefixes = new Set<string>();
  const roots = new Set<string>();
  const basePrefixes = new Set<string>();

  const configuredRoots = (process.env.C2C_CONDA_ROOTS ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const root of configuredRoots) roots.add(root);

  for (const relative of KNOWN_HOME_ROOTS) roots.add(path.join(home, relative));

  for (const [key, value] of Object.entries(process.env)) {
    if ((key === "CONDA_PREFIX" || /^CONDA_PREFIX_\d+$/.test(key)) && value) {
      addPrefix(prefixes, value);
      const resolved = safeRealpath(value);
      if (resolved && path.basename(path.dirname(resolved)) === "envs") {
        roots.add(path.dirname(path.dirname(resolved)));
      }
    }
  }

  const currentPrefix = prefixFromPythonCommand(configuredPythonCommand());
  if (currentPrefix) {
    prefixes.add(currentPrefix);
    if (path.basename(path.dirname(currentPrefix)) === "envs") {
      roots.add(path.dirname(path.dirname(currentPrefix)));
    } else {
      roots.add(currentPrefix);
    }
  }

  for (const registered of readRegisteredPrefixes(home)) {
    addPrefix(prefixes, registered);
    const resolved = safeRealpath(registered);
    if (resolved && path.basename(path.dirname(resolved)) === "envs") {
      roots.add(path.dirname(path.dirname(resolved)));
    }
  }

  for (const root of roots) scanRoot(root, prefixes, basePrefixes);

  const directories = new Map<string, string>();
  for (const root of roots) {
    directories.set(root, fileStamp(root));
    directories.set(path.join(root, "envs"), fileStamp(path.join(root, "envs")));
  }
  discovery = { key, expiresAt: Date.now() + DISCOVERY_TTL_MS, prefixes, basePrefixes, currentPrefix, directories };
  return discovery;
}

function environmentInfo(prefix: string, discovered: Discovery): CondaEnvironmentInfo | null {
  // Execution must revalidate the selected prefix/interpreter even when its
  // discovery and package metadata were cached.
  if (safeRealpath(prefix) !== prefix || !isDirectory(path.join(prefix, "conda-meta"))) return null;
  const python = pythonInPrefix(prefix);
  if (!python) return null;
  return {
    id: envId(prefix),
    name: discovered.basePrefixes.has(prefix) ? "base" : path.basename(prefix),
    prefix,
    python,
    ...packageMetadata(prefix),
    isDefault: discovered.currentPrefix === prefix,
  };
}

export function listCondaEnvironments(): CondaEnvironmentInfo[] {
  const discovered = discoverPrefixes();
  const result: CondaEnvironmentInfo[] = [];
  for (const prefix of discovered.prefixes) {
    const info = environmentInfo(prefix, discovered);
    if (info) result.push(info);
  }

  return result.sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      a.name.localeCompare(b.name) ||
      a.prefix.localeCompare(b.prefix)
  );
}

export function findCondaEnvironment(id: string): CondaEnvironmentInfo | null {
  const discovered = discoverPrefixes();
  for (const prefix of discovered.prefixes) {
    if (envId(prefix) === id) return environmentInfo(prefix, discovered);
  }
  return null;
}
