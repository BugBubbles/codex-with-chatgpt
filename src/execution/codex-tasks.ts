import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Logger } from "../logger/index.js";
import type { Workspace } from "../workspace/manager.js";
import { gitStatus } from "../workspace/git.js";
import { saveExecutionOutput } from "./output.js";
import { appendExecutionRecord } from "./records.js";

export type CodexTaskState = "running" | "succeeded" | "failed" | "cancelled";

export interface CodexTaskSnapshot {
  taskId: string;
  status: CodexTaskState;
  submittedAt: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  outputId: number | null;
  error: string | null;
}

export interface SubmitCodexTaskInput {
  goal: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  timeoutSeconds?: number;
}

export class CodexTaskError extends Error {
  constructor(
    readonly code: "TASK_BUSY" | "TASK_NOT_FOUND" | "CODEX_SPAWN_FAILED",
    message: string
  ) {
    super(message);
    this.name = "CodexTaskError";
  }
}

interface RunningTask {
  snapshot: CodexTaskSnapshot;
  child: ChildProcess;
  output: string;
  timer: NodeJS.Timeout | null;
  finalized: boolean;
}

export interface CodexTaskManagerOptions {
  command?: string;
  argsPrefix?: string[];
  maxCapturedChars?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MAX_FINISHED_TASKS = 20;
const DEFAULT_MAX_CAPTURED_CHARS = 1_000_000;

function taskPrompt(goal: string): string {
  return [
    "You are the local Codex execution worker for Codex with ChatGPT.",
    "Implement the requested goal in the current workspace.",
    "",
    "Hard constraints:",
    "- Work only on the current workspace.",
    "- Do not commit, push, alter git remotes, or publish artifacts.",
    "- Do not read or expose credentials, private keys, .env files, or other secrets.",
    "- Do not weaken the C2C bridge authentication, workspace boundary, or sandbox unless the goal explicitly requires a security change.",
    "- Network access is disabled for this run. Use only locally available dependencies and tools.",
    "- Run relevant local tests, type checks, or builds when practical.",
    "- If the goal cannot be completed safely under these constraints, stop and explain the blocker.",
    "",
    "GOAL:",
    goal.trim(),
  ].join("\n");
}

function changedFiles(workspace: Workspace): string[] | number {
  try {
    const status = gitStatus(workspace);
    const files = new Set<string>();
    for (const entry of status.staged) files.add(entry.path);
    for (const entry of status.unstaged) files.add(entry.path);
    for (const entry of status.untracked) files.add(entry);
    for (const entry of status.conflicted) files.add(entry);
    return [...files].sort();
  } catch {
    return 0;
  }
}

export class CodexTaskManager {
  private readonly tasks = new Map<string, RunningTask>();
  private readonly command: string;
  private readonly argsPrefix: string[];
  private readonly maxCapturedChars: number;
  private activeTaskId: string | null = null;

  constructor(
    private readonly workspace: Workspace,
    private readonly logger: Logger,
    opts: CodexTaskManagerOptions = {}
  ) {
    this.command = opts.command ?? (process.env.C2C_CODEX_BIN?.trim() || "codex");
    this.argsPrefix = opts.argsPrefix ?? [];
    this.maxCapturedChars = opts.maxCapturedChars ?? DEFAULT_MAX_CAPTURED_CHARS;
  }

  submit(input: SubmitCodexTaskInput): CodexTaskSnapshot {
    if (this.activeTaskId) {
      const active = this.tasks.get(this.activeTaskId);
      if (active && !active.finalized) {
        throw new CodexTaskError(
          "TASK_BUSY",
          `Codex task ${active.snapshot.taskId} is still running. Wait for it to finish or cancel it first.`
        );
      }
      this.activeTaskId = null;
    }

    const taskId = `c2c_exec_${randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    const timeoutSeconds = Math.max(30, Math.min(3600, input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS));
    const args = [
      ...this.argsPrefix,
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
      "--ephemeral",
      "--cd",
      this.workspace.root,
      "--config",
      "sandbox_workspace_write.network_access=false",
    ];
    if (input.model) args.push("--model", input.model);
    if (input.reasoningEffort) {
      args.push("--config", `model_reasoning_effort="${input.reasoningEffort}"`);
    }
    args.push("-");

    let child: ChildProcess;
    try {
      child = spawn(this.command, args, {
        cwd: this.workspace.root,
        env: { ...process.env, C2C_REMOTE_TASK: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new CodexTaskError(
        "CODEX_SPAWN_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }

    const task: RunningTask = {
      snapshot: {
        taskId,
        status: "running",
        submittedAt: now,
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        outputId: null,
        error: null,
      },
      child,
      output: "",
      timer: null,
      finalized: false,
    };
    this.tasks.set(taskId, task);
    this.activeTaskId = taskId;
    this.prune();

    const append = (chunk: unknown): void => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      if (!text) return;
      task.output += text;
      if (task.output.length > this.maxCapturedChars) {
        task.output = "[earlier output truncated]\n" + task.output.slice(-this.maxCapturedChars);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.once("error", (error) => {
      this.finalize(task, "failed", null, error.message);
    });
    child.once("close", (code, signal) => {
      if (task.finalized) return;
      if (signal) {
        this.finalize(task, "failed", code, `Codex exited after signal ${signal}.`);
        return;
      }
      this.finalize(
        task,
        code === 0 ? "succeeded" : "failed",
        code,
        code === 0 ? null : `Codex exited with code ${code ?? "unknown"}.`
      );
    });

    task.timer = setTimeout(() => {
      if (task.finalized) return;
      child.kill("SIGTERM");
      this.finalize(task, "failed", null, `Codex task timed out after ${timeoutSeconds} seconds.`);
    }, timeoutSeconds * 1000);
    task.timer.unref?.();

    child.stdin?.end(taskPrompt(input.goal));
    this.logger.info(`Started remote Codex task ${taskId}`);
    return this.snapshot(task);
  }

  get(taskId: string): CodexTaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new CodexTaskError("TASK_NOT_FOUND", `No Codex task named ${taskId}.`);
    return this.snapshot(task);
  }

  cancel(taskId: string): CodexTaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new CodexTaskError("TASK_NOT_FOUND", `No Codex task named ${taskId}.`);
    if (task.finalized) return this.snapshot(task);
    task.child.kill("SIGTERM");
    this.finalize(task, "cancelled", null, "Cancelled by ChatGPT.");
    return this.snapshot(task);
  }

  shutdown(): void {
    for (const task of this.tasks.values()) {
      if (!task.finalized) {
        task.child.kill("SIGTERM");
        this.finalize(task, "cancelled", null, "Bridge is shutting down.");
      }
    }
  }

  private finalize(
    task: RunningTask,
    status: CodexTaskState,
    exitCode: number | null,
    error: string | null
  ): void {
    if (task.finalized) return;
    task.finalized = true;
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    task.snapshot.status = status;
    task.snapshot.exitCode = exitCode;
    task.snapshot.error = error;
    task.snapshot.finishedAt = new Date().toISOString();

    const output = saveExecutionOutput(this.workspace.id, {
      command: `codex exec (remote task ${task.snapshot.taskId})`,
      raw: task.output || error || "(Codex produced no output.)",
      exitCode,
      taskId: task.snapshot.taskId,
      iteration: 0,
    });
    task.snapshot.outputId = output.id;

    appendExecutionRecord(this.workspace.id, {
      taskId: task.snapshot.taskId,
      iteration: 0,
      changedFiles: changedFiles(this.workspace),
      tests: null,
      exitStatus: status === "succeeded" ? "ok" : status,
      timestamp: task.snapshot.finishedAt,
      notes: error ?? "Remote Codex task completed.",
      outputId: output.id,
      outputAvailable: output.allowed,
    });

    if (this.activeTaskId === task.snapshot.taskId) this.activeTaskId = null;
    this.logger.info(`Remote Codex task ${task.snapshot.taskId} finished with status ${status}`);
  }

  private snapshot(task: RunningTask): CodexTaskSnapshot {
    return { ...task.snapshot };
  }

  private prune(): void {
    const finished = [...this.tasks.entries()].filter(([, task]) => task.finalized);
    while (finished.length > MAX_FINISHED_TASKS) {
      const [taskId] = finished.shift()!;
      this.tasks.delete(taskId);
    }
  }
}
