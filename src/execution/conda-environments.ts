import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_METADATA_BYTES = 1024 * 1024;
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

function packageMetadata(prefix: string): { packageCount: number; pythonVersion: string | null } {
  const metaDir = path.join(prefix, "conda-meta");
  let entries: string[];
  try {
    entries = fs.readdirSync(metaDir).filter((name) => name.endsWith(".json"));
  } catch {
    return { packageCount: 0, pythonVersion: null };
  }

  let pythonVersion: string | null = null;
  for (const name of entries) {
    if (pythonVersion !== null) break;
    const file = path.join(metaDir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
      if (parsed.name === "python" && typeof parsed.version === "string") pythonVersion = parsed.version;
    } catch {
      // Malformed package metadata should not make environment discovery fail.
    }
  }
  return { packageCount: entries.length, pythonVersion };
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
export function listCondaEnvironments(): CondaEnvironmentInfo[] {
  const home = os.homedir();
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

  const result: CondaEnvironmentInfo[] = [];
  for (const prefix of prefixes) {
    const python = pythonInPrefix(prefix);
    if (!python) continue;
    const meta = packageMetadata(prefix);
    result.push({
      id: envId(prefix),
      name: basePrefixes.has(prefix) ? "base" : path.basename(prefix),
      prefix,
      python,
      pythonVersion: meta.pythonVersion,
      packageCount: meta.packageCount,
      isDefault: currentPrefix === prefix,
    });
  }

  return result.sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      a.name.localeCompare(b.name) ||
      a.prefix.localeCompare(b.prefix)
  );
}

export function findCondaEnvironment(id: string): CondaEnvironmentInfo | null {
  return listCondaEnvironments().find((environment) => environment.id === id) ?? null;
}
