import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { IgnoreRules } from "./ignore.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export async function runGit(root: string, args: string[]): Promise<GitCommandResult> {
  try {
    return await new Promise<GitCommandResult>((resolve) => {
      execFile("git", args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        resolve({ ok: !error, stdout, stderr, code: error ? (typeof error.code === "number" ? error.code : null) : 0 });
      });
    });
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number | string };
    return { ok: false, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: typeof result.code === "number" ? result.code : null };
  }
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

export async function gitInfo(root: string): Promise<GitInfo> {
  const status = await runGit(root, ["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "--", "."]);
  if (!status.ok) {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const lines = status.stdout.split("\n");
  const branch = lines.find((line) => line.startsWith("# branch.head "))?.slice(14) ?? null;
  const commit = lines.find((line) => line.startsWith("# branch.oid "))?.slice(13) ?? null;
  return {
    isRepo: true,
    branch: branch === "(detached)" ? "HEAD" : branch,
    commit: commit === "(initial)" ? null : commit?.slice(0, 7) ?? null,
    dirty: lines.some((line) => line.length > 0 && !line.startsWith("# ")),
  };
}

export interface WorkspaceLike {
  root: string;
  ignoreRules?: IgnoreRules;
}

export type GitTarget = string | WorkspaceLike;

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
  /** Sensitive entries withheld. `conflicts` stays separate so a merge is not reported as clean. */
  hidden: { changes: number; conflicts: number };
}

export async function gitStatus(target: GitTarget): Promise<GitStatusResult> {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules ? target.ignoreRules : new IgnoreRules(root);
  const empty: GitStatusResult = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    hidden: { changes: 0, conflicts: 0 },
  };
  const result = await runGit(root, ["status", "--porcelain=v2", "--branch", "--", "."]);
  if (!result.ok) return empty;
  const out: GitStatusResult = { ...empty, hidden: { ...empty.hidden }, isRepo: true };
  const withheld = (paths: string[]): boolean => paths.some((p) => ignoreRules.isSensitive(p));

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      out.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        out.ahead = parseInt(m[1], 10);
        out.behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "";
      const isRename = line.startsWith("2 ");
      const destination = isRename
        ? (line.split("\t")[0]?.split(" ").slice(9).join(" ") ?? "")
        : parts.slice(8).join(" ");
      const origin = isRename ? (line.split("\t")[1] ?? "") : null;
      const rawPaths = origin === null ? [destination] : [destination, origin];
      const filePath = origin === null ? destination : `${destination} -> ${origin}`;
      if (withheld(rawPaths)) {
        out.hidden.changes += (xy[0] !== "." ? 1 : 0) + (xy[1] !== "." ? 1 : 0);
        continue;
      }
      if (xy[0] !== ".") out.staged.push({ path: filePath, change: xy[0] });
      if (xy[1] !== ".") out.unstaged.push({ path: filePath, change: xy[1] });
    } else if (line.startsWith("? ")) {
      const filePath = line.slice(2);
      if (withheld([filePath])) out.hidden.changes += 1;
      else out.untracked.push(filePath);
    } else if (line.startsWith("u ")) {
      const filePath = line.split(" ").slice(10).join(" ");
      if (withheld([filePath])) out.hidden.conflicts += 1;
      else out.conflicted.push(filePath);
    }
  }
  return out;
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
}

function getDiffModeArgs(mode: DiffMode): string[] {
  if (mode === "staged") return ["--cached"];
  if (mode === "head") return ["HEAD"];
  return [];
}

function chunkSafePaths(paths: string[], maxCount = 50, maxBytes = 32 * 1024): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentBytes = 0;

  for (const p of paths) {
    const pBytes = Buffer.byteLength(p, "utf8") + 12; // overhead for ":(literal)"
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxCount || currentBytes + pBytes > maxBytes)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(p);
    currentBytes += pBytes;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

function isPathInScope(filePath: string, scope?: string): boolean {
  if (!scope || scope === ".") return true;
  return filePath === scope || filePath.startsWith(scope + "/");
}

interface DiffSnapshot {
  state: string;
  full: Buffer;
  expiresAt: number;
  bytes: number;
}

const diffSnapshots = new Map<string, DiffSnapshot>();
const pendingDiffs = new Map<string, { state: string | null; value: Promise<Buffer | null> }>();
const MAX_DIFF_CACHE_BYTES = 64 * 1024 * 1024;
let diffCacheBytes = 0;
const repositoryPaths = new Map<string, { expiresAt: number; files: string[] }>();

async function repositoryDependencies(root: string): Promise<string[]> {
  const cached = repositoryPaths.get(root);
  if (cached && cached.expiresAt > Date.now()) return cached.files;
  let directories: string[] = [];
  try {
    if ((await fs.promises.stat(path.join(root, ".git"))).isDirectory()) directories = [path.join(root, ".git")];
  } catch {
    // A nested workspace or linked worktree needs Git to locate its metadata.
  }
  if (directories.length === 0) {
    const result = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
    if (result.ok) directories = result.stdout.trim().split("\n");
  }
  const files = directories.flatMap((dir) => [path.join(dir, "config"), path.join(dir, "config.worktree"), path.join(dir, "info", "attributes")]);
  if (repositoryPaths.size >= 16) repositoryPaths.delete(repositoryPaths.keys().next().value!);
  repositoryPaths.set(root, { expiresAt: Date.now() + 30_000, files });
  return files;
}

async function diffState(root: string, mode: DiffMode, inventory?: GitCommandResult): Promise<string | null> {
  // Reuse the safety inventory on the first page; subsequent pages only need
  // this inventory and metadata, never another full patch.
  const raw = inventory ?? await runGit(root, ["diff", "--raw", "-z", "--relative", "--find-renames=1%", ...getDiffModeArgs(mode), "--", "."]);
  if (!raw.ok) return null;
  const dependencies = new Set<string>([
    path.join(root, ".git"), path.join(root, ".git", "config"),
    path.join(root, ".git", "info", "attributes"),
    process.env.GIT_CONFIG_GLOBAL ?? path.join(os.homedir(), ".gitconfig"),
    process.env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig",
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "git", "config"),
    ...await repositoryDependencies(root),
  ]);
  const tokens = raw.stdout.split("\0");
  for (let index = 0; index < tokens.length; ) {
    const header = tokens[index++];
    if (!header) break;
    if (!header.startsWith(":")) return null;
    const status = header.split(" ").at(-1) ?? "";
    const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let item = 0; item < count; item++) {
      const rel = tokens[index++];
      if (!rel) return null;
      const file = path.resolve(root, rel);
      if (mode !== "staged") dependencies.add(file);
      for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        dependencies.add(path.join(dir, ".gitattributes"));
        if (path.dirname(dir) === dir) break;
      }
    }
  }
  const files = [...dependencies].sort();
  const metadata: string[] = [];
  for (let start = 0; start < files.length; start += 16) {
    metadata.push(...await Promise.all(files.slice(start, start + 16).map(async (file) => {
      try {
        const stat = await fs.promises.lstat(file, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code ?? "unavailable";
      }
    })));
  }
  const gitEnvironment = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")).sort();
  return JSON.stringify([raw.stdout, files, metadata, gitEnvironment]);
}

function storeDiff(key: string, state: string, full: Buffer): void {
  const now = Date.now();
  for (const [candidate, snapshot] of diffSnapshots) {
    if (candidate === key || snapshot.expiresAt <= now) {
      diffCacheBytes -= snapshot.bytes;
      diffSnapshots.delete(candidate);
    }
  }
  const bytes = full.length + Buffer.byteLength(state) + Buffer.byteLength(key);
  if (bytes > MAX_DIFF_CACHE_BYTES) return;
  while (diffSnapshots.size >= 8 || diffCacheBytes + bytes > MAX_DIFF_CACHE_BYTES) {
    const oldest = diffSnapshots.keys().next().value!;
    diffCacheBytes -= diffSnapshots.get(oldest)!.bytes;
    diffSnapshots.delete(oldest);
  }
  diffSnapshots.set(key, { state, full, bytes, expiresAt: now + 30_000 });
  diffCacheBytes += bytes;
}

export async function gitDiff(target: GitTarget, opts: GitDiffOptions = {}, relPath?: string): Promise<GitDiffResult> {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules = typeof target === "object" && target.ignoreRules ? target.ignoreRules : new IgnoreRules(root);
  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const key = JSON.stringify([root, mode, relPath, ignoreRules.cacheKey]);
  const prepared = await prepareDiff(root, ignoreRules, mode, relPath);
  if (!prepared) return { isRepo: false, mode, totalBytes: 0, offset: 0, returnedBytes: 0, hasMore: false, nextOffset: null, diff: "" };
  const { state } = prepared;
  const cached = diffSnapshots.get(key);
  let full: Buffer | null;
  if (state !== null && cached?.state === state && cached.expiresAt > Date.now()) {
    full = cached.full;
  } else {
    let building = pendingDiffs.get(key);
    if (!building || building.state !== state) {
      const value = (async () => {
        const result = await buildDiff(root, mode, prepared.safePaths);
        // Never associate a patch with a state which changed during generation.
        if (result && result.length > maxBytes && state !== null && await diffState(root, mode) === state) storeDiff(key, state, result);
        return result;
      })();
      building = { state, value };
      pendingDiffs.set(key, building);
    }
    try {
      full = await building.value;
    } finally {
      if (pendingDiffs.get(key) === building) pendingDiffs.delete(key);
    }
  }
  if (!full) return { isRepo: false, mode, totalBytes: 0, offset: 0, returnedBytes: 0, hasMore: false, nextOffset: null, diff: "" };
  let end = Math.min(full.length, offset + maxBytes);
  if (end < full.length) {
    while (end > offset && (full[end] & 0xc0) === 0x80) end--;
    const newline = full.lastIndexOf(10, end - 1);
    if (newline >= offset) end = newline + 1;
  }
  const page = full.subarray(offset, end);
  const hasMore = offset + page.length < full.length;
  return {
    isRepo: true, mode, totalBytes: full.length, offset, returnedBytes: page.length,
    hasMore, nextOffset: hasMore ? offset + page.length : null, diff: page.toString("utf8"),
  };
}

async function prepareDiff(root: string, ignoreRules: IgnoreRules, mode: DiffMode, relPath?: string): Promise<{ state: string | null; safePaths: string[] } | null> {
  const modeArgs = getDiffModeArgs(mode);

  // 1. Full-workspace inventory using NUL separation and global rename detection
  const listArgs = [
    "diff",
    "--raw",
    "--relative",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
    "--",
    ".",
  ];
  const listResult = await runGit(root, listArgs);
  if (!listResult.ok) {
    return null;
  }

  const tokens = listResult.stdout.split("\0");
  const safePaths: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const header = tokens[i++];
    if (!header) break;
    const status = header.split(" ").at(-1) ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) {
        // Layer 1: Security - EITHER side sensitive -> completely unsafe
        const isSafe = !ignoreRules.isSensitive(oldPath) && !ignoreRules.isSensitive(newPath);
        // Layer 2: Scope - EITHER side in scope -> relevant
        const isRelevant = isPathInScope(oldPath, relPath) || isPathInScope(newPath, relPath);
        if (isSafe && isRelevant) {
          safePaths.push(oldPath, newPath);
        }
      }
    } else {
      const filePath = tokens[i++];
      if (filePath) {
        const isSafe = !ignoreRules.isSensitive(filePath);
        const isRelevant = isPathInScope(filePath, relPath);
        if (isSafe && isRelevant) {
          safePaths.push(filePath);
        }
      }
    }
  }

  return { state: await diffState(root, mode, listResult), safePaths };
}

async function buildDiff(root: string, mode: DiffMode, safePaths: string[]): Promise<Buffer | null> {
  if (safePaths.length === 0) return Buffer.alloc(0);
  const modeArgs = getDiffModeArgs(mode);
  // 2. Fetch diffs for safe paths in bounded batches (path count + argv bytes)
  const batches = chunkSafePaths(safePaths);
  const chunks: Buffer[] = [];
  let totalAggregateBytes = 0;
  const MAX_AGGREGATE_DIFF_BYTES = 64 * 1024 * 1024;

  for (const batch of batches) {
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffArgs = [
      "diff",
      "--no-color",
      "--relative",
      "--find-renames=1%",
      ...modeArgs,
      "--",
      ...pathspecs,
    ];
    const diffResult = await runGit(root, diffArgs);
    if (!diffResult.ok) {
      // Fail closed on any batch error: never return partial silent success
      return null;
    }
    if (diffResult.stdout) {
      const chunkBytes = Buffer.byteLength(diffResult.stdout, "utf8");
      if (totalAggregateBytes + chunkBytes > MAX_AGGREGATE_DIFF_BYTES) {
        // Fail closed on aggregate cap: do not fake a partial successful diff
        return null;
      }
      chunks.push(Buffer.from(diffResult.stdout, "utf8"));
      totalAggregateBytes += chunkBytes;
    }
  }

  return Buffer.concat(chunks, totalAggregateBytes);
}
