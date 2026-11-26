import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { IgnoreRules } from "./ignore.js";
import { readJsonIfExists } from "../config/paths.js";
import { WorkspaceError } from "./errors.js";
import { readIndexedTextFile, type TextReadOptions } from "./text-file.js";
export { WorkspaceError, type WorkspaceErrorCode } from "./errors.js";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normCase = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);

export interface ReadFileResult {
  path: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
}

export interface DirEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ProjectConfig {
  name?: string;
  maxIterations?: number;
}

function parseProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const config: ProjectConfig = {};
  if (typeof raw.name === "string") config.name = raw.name;
  if (typeof raw.maxIterations === "number") config.maxIterations = raw.maxIterations;
  return config;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

export class Workspace {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly ignoreRules: IgnoreRules;
  readonly projectConfig: ProjectConfig;

  constructor(rootInput: string) {
    const resolved = path.resolve(rootInput);
    let real: string;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Workspace root does not exist: ${rootInput}`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Workspace root is not a directory: ${rootInput}`);
    }
    this.root = real;
    this.id = createHash("sha256").update(normCase(real)).digest("hex").slice(0, 12);
    this.ignoreRules = new IgnoreRules(real);
    this.projectConfig = parseProjectConfig(readJsonIfExists<unknown>(path.join(real, ".c2c.json")));
    this.name = this.projectConfig.name ?? path.basename(real);
  }

  private contains(candidate: string): boolean {
    const r = normCase(this.root);
    const c = normCase(candidate);
    return c === r || c.startsWith(r + path.sep);
  }

  /**
   * Canonicalize a path by realpath-ing its deepest existing ancestor.
   * Defends against symlink escapes even for not-yet-existing leaf segments.
   */
  private canonicalize(abs: string): string {
    let current = abs;
    const suffix: string[] = [];
    for (;;) {
      try {
        const real = fs.realpathSync.native(current);
        return suffix.length > 0 ? path.join(real, ...suffix) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return abs;
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  /**
   * Resolve an untrusted path to a canonical absolute path inside the workspace.
   * Throws PATH_OUTSIDE_WORKSPACE or ACCESS_DENIED_SENSITIVE_FILE.
   */
  resolve(requested: string, opts: { allowSensitive?: boolean } = {}): { abs: string; rel: string } {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "Invalid path");
    }
    let p = requested.trim();
    if (p === "" || p === "/") p = ".";
    // Normalize separators so Windows-style input behaves identically everywhere.
    p = p.replace(/\\/g, "/");
    // Strip a "workspace:/" alias prefix if the model echoes it back.
    p = p.replace(/^workspace:\/*/i, "");
    if (p === "") p = ".";

    const abs = path.resolve(this.root, p);
    const canonical = this.canonicalize(abs);
    if (!this.contains(canonical)) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path resolves outside the connected workspace: ${requested}`
      );
    }
    const rel = path.relative(this.root, canonical).split(path.sep).join("/");
    if (rel.startsWith("..")) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside the connected workspace: ${requested}`);
    }
    if (!opts.allowSensitive && rel !== "" && this.ignoreRules.isSensitive(rel)) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        `ACCESS_DENIED_SENSITIVE_FILE: '${rel}' matches the sensitive-file policy and cannot be read.`
      );
    }
    return { abs: canonical, rel };
  }

  async readFile(requested: string, opts: TextReadOptions = {}): Promise<ReadFileResult> {
    const { abs, rel } = this.resolve(requested);
    return readIndexedTextFile(abs, rel, opts);
  }

  async listDirectory(
    requested: string,
    opts: { depth?: number; limit?: number; offset?: number } = {}
  ): Promise<ListDirectoryResult> {
    const { abs, rel } = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Directory not found: ${rel || "."}`);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Not a directory: ${rel}`);
    }
    const depth = Math.min(4, Math.max(1, Math.floor(opts.depth ?? 1)));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const page: DirEntry[] = [];
    let total = 0;
    const include = (entry: DirEntry): void => {
      if (total >= offset && total < offset + limit) page.push(entry);
      total++;
    };
    const walk = async (dirAbs: string, dirRel: string, level: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (this.ignoreRules.isHidden(childRel) || this.ignoreRules.isHidden(childRel + "/")) continue;
        if (entry.isDirectory()) {
          include({ path: childRel + "/", type: "dir" });
          if (level < depth) await walk(path.join(dirAbs, entry.name), childRel, level + 1);
        } else if (entry.isFile()) {
          include({ path: childRel, type: "file" });
        }
      }
    };
    await walk(abs, rel, 1);

    const files = page.filter((entry) => entry.type === "file");
    // Bound concurrency and only stat files which will actually be returned.
    for (let start = 0; start < files.length; start += 16) {
      await Promise.all(files.slice(start, start + 16).map(async (entry) => {
        try {
          entry.sizeBytes = (await fs.promises.stat(path.join(this.root, entry.path))).size;
        } catch {
          // The entry may have disappeared since readdir.
        }
      }));
    }
    return {
      path: rel || ".",
      entries: page,
      total,
      offset,
      limit,
      hasMore: offset + page.length < total,
    };
  }

  /** Lightweight project detection for workspace_info. */
  detectProject(): {
    projectType: string;
    languages: string[];
    frameworks: string[];
    packageManager: string | null;
    scripts: Record<string, string>;
  } {
    const has = (f: string): boolean => fs.existsSync(path.join(this.root, f));
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    let projectType = "unknown";
    let packageManager: string | null = null;
    let scripts: Record<string, string> = {};

    if (has("package.json")) {
      projectType = "node";
      languages.add("JavaScript");
      const rawPackage = readJsonIfExists<unknown>(path.join(this.root, "package.json"));
      const pkg = rawPackage && typeof rawPackage === "object" && !Array.isArray(rawPackage)
        ? rawPackage as Record<string, unknown>
        : {};
      scripts = stringRecord(pkg.scripts);
      const deps = { ...stringRecord(pkg.dependencies), ...stringRecord(pkg.devDependencies) };
      const known: Record<string, string> = {
        next: "Next.js",
        react: "React",
        vue: "Vue",
        svelte: "Svelte",
        express: "Express",
        fastify: "Fastify",
        "@nestjs/core": "NestJS",
        electron: "Electron",
        vitest: "Vitest",
        jest: "Jest",
      };
      for (const [dep, label] of Object.entries(known)) {
        if (deps[dep]) frameworks.add(label);
      }
      if (has("pnpm-lock.yaml")) packageManager = "pnpm";
      else if (has("yarn.lock")) packageManager = "yarn";
      else if (has("bun.lockb") || has("bun.lock")) packageManager = "bun";
      else if (has("package-lock.json")) packageManager = "npm";
    }
    if (has("tsconfig.json")) languages.add("TypeScript");
    if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
      languages.add("Python");
      if (projectType === "unknown") projectType = "python";
    }
    if (has("Cargo.toml")) {
      languages.add("Rust");
      if (projectType === "unknown") projectType = "rust";
    }
    if (has("go.mod")) {
      languages.add("Go");
      if (projectType === "unknown") projectType = "go";
    }
    if (has("Package.swift")) {
      languages.add("Swift");
      if (projectType === "unknown") projectType = "swift";
    }
    return {
      projectType,
      languages: [...languages],
      frameworks: [...frameworks],
      packageManager,
      scripts,
    };
  }
}
