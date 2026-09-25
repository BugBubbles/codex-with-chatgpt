import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger/index.js";
import { gitStatus } from "../workspace/git.js";
import { Workspace, WorkspaceError } from "../workspace/manager.js";
import { appendExecutionRecord } from "./records.js";
import { readExecutionOutput, saveExecutionOutput } from "./output.js";

const MAX_CAPTURED_CHARS = 2_000_000;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

export class PythonExecutionError extends Error {
  constructor(
    readonly code: "INVALID_ARGUMENTS" | "PYTHON_SPAWN_FAILED",
    message: string
  ) {
    super(message);
    this.name = "PythonExecutionError";
  }
}

export interface PythonExecuteInput {
  code?: string;
  path?: string;
  args?: string[];
  timeoutSeconds?: number;
}

export interface PythonExecuteResult {
  executionId: string;
  mode: "inline" | "file";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputId: number;
  outputAvailable: boolean;
  output: string | null;
  changedFiles: string[];
}

export interface PythonWriteResult {
  path: string;
  bytesWritten: number;
  created: boolean;
  sha256: string;
}

function pythonCommand(): string {
  return process.env.C2C_PYTHON_BIN?.trim() || (process.platform === "win32" ? "python" : "python3");
}

function childEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "VIRTUAL_ENV",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONNOUSERSITE = "1";
  env.C2C_PYTHON_EXEC = "1";
  return env;
}

function changedFiles(workspace: Workspace): string[] {
  try {
    const status = gitStatus(workspace);
    const files = new Set<string>();
    for (const entry of status.staged) files.add(entry.path);
    for (const entry of status.unstaged) files.add(entry.path);
    for (const entry of status.untracked) files.add(entry);
    for (const entry of status.conflicted) files.add(entry);
    return [...files].sort();
  } catch {
    return [];
  }
}

function appendCaptured(current: string, chunk: unknown): string {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  const next = current + text;
  return next.length > MAX_CAPTURED_CHARS ? next.slice(-MAX_CAPTURED_CHARS) : next;
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may already have exited.
  }
}

export function writeWorkspaceTextFile(
  workspace: Workspace,
  requestedPath: string,
  content: string
): PythonWriteResult {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new WorkspaceError(
      "FILE_TOO_LARGE",
      `Refusing to write ${bytes} bytes; python_write_file is limited to ${MAX_WRITE_BYTES} bytes.`
    );
  }

  const { abs, rel } = workspace.resolve(requestedPath);
  if (!rel) throw new WorkspaceError("INVALID_PATH", "Cannot overwrite the workspace root.");

  const existed = fs.existsSync(abs);
  let mode = 0o644;
  if (existed) {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
    mode = stat.mode & 0o777;
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(abs), `.c2c-python-write-${randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode });
    fs.renameSync(temp, abs);
  } finally {
    fs.rmSync(temp, { force: true });
  }

  return {
    path: rel,
    bytesWritten: bytes,
    created: !existed,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

export async function executePython(
  workspace: Workspace,
  logger: Logger,
  input: PythonExecuteInput
): Promise<PythonExecuteResult> {
  const hasCode = typeof input.code === "string";
  const hasPath = typeof input.path === "string";
  if (hasCode === hasPath) {
    throw new PythonExecutionError(
      "INVALID_ARGUMENTS",
      "Provide exactly one of 'code' or 'path'."
    );
  }

  const command = pythonCommand();
  const extraArgs = input.args ?? [];
  let mode: "inline" | "file";
  let argv: string[];
  let commandLabel: string;

  if (hasCode) {
    mode = "inline";
    argv = ["-B", "-u", "-c", input.code!, ...extraArgs];
    commandLabel = `${command} -B -u -c <inline-python>`;
  } else {
    const resolved = workspace.resolve(input.path!);
    if (path.extname(resolved.rel).toLowerCase() !== ".py") {
      throw new PythonExecutionError("INVALID_ARGUMENTS", "Python file execution requires a .py path.");
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved.abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${resolved.rel}`);
    }
    if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${resolved.rel}`);
    mode = "file";
    argv = ["-B", "-u", resolved.abs, ...extraArgs];
    commandLabel = `${command} -B -u ${resolved.rel}`;
  }

  const executionId = `py_exec_${randomBytes(8).toString("hex")}`;
  const timeoutSeconds = Math.max(1, Math.min(3600, Math.floor(input.timeoutSeconds ?? 120)));
  const startedAt = Date.now();

  return await new Promise<PythonExecuteResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, argv, {
        cwd: workspace.root,
        env: childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(
        new PythonExecutionError(
          "PYTHON_SPAWN_FAILED",
          error instanceof Error ? error.message : String(error)
        )
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout?.on("data", (chunk) => {
      stdout = appendCaptured(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendCaptured(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutSeconds * 1000);
    timer.unref?.();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PythonExecutionError("PYTHON_SPAWN_FAILED", error.message));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const durationMs = Date.now() - startedAt;
      const rawParts: string[] = [];
      if (stdout) rawParts.push(`[stdout]\n${stdout}`);
      if (stderr) rawParts.push(`[stderr]\n${stderr}`);
      if (timedOut) rawParts.push(`[c2c]\nPython execution timed out after ${timeoutSeconds} seconds.`);
      if (signal && !timedOut) rawParts.push(`[c2c]\nPython exited after signal ${signal}.`);
      if (rawParts.length === 0) rawParts.push("(Python produced no output.)");

      const output = saveExecutionOutput(workspace.id, {
        command: commandLabel,
        raw: rawParts.join("\n"),
        exitCode: code,
        taskId: executionId,
        iteration: 0,
      });
      const files = changedFiles(workspace);
      appendExecutionRecord(workspace.id, {
        taskId: executionId,
        iteration: 0,
        changedFiles: files,
        tests: null,
        exitStatus: timedOut ? "timeout" : code === 0 ? "ok" : "failed",
        timestamp: new Date().toISOString(),
        notes: timedOut
          ? `Python execution timed out after ${timeoutSeconds} seconds.`
          : `Python ${mode} execution completed.`,
        outputId: output.id,
        outputAvailable: output.allowed,
      });

      const readable = output.allowed ? readExecutionOutput(workspace.id, output.id) : null;
      const result: PythonExecuteResult = {
        executionId,
        mode,
        exitCode: code,
        timedOut,
        durationMs,
        outputId: output.id,
        outputAvailable: output.allowed,
        output: readable?.ok ? readable.text : null,
        changedFiles: files,
      };
      logger.info(
        `Python execution ${executionId} finished: mode=${mode} exit=${code ?? "null"} timedOut=${timedOut}`
      );
      resolve(result);
    });
  });
}
