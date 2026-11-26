import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Lightweight execution records written by local execution helpers (including
 * the Python executor) and by the legacy manual `c2c record` command.
 * ChatGPT reads them through the `execution_summary` and `test_status` MCP tools.
 */
export const executionRecordSchema = z.object({
  taskId: z.string(),
  iteration: z.number().int().nonnegative(),
  changedFiles: z.union([z.array(z.string()), z.number().int().nonnegative()]),
  tests: z.string().nullable(),
  exitStatus: z.string(),
  timestamp: z.string(),
  notes: z.string().optional(),
  outputId: z.number().int().positive().optional(),
  outputAvailable: z.boolean().optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  fs.appendFileSync(file, JSON.stringify(executionRecordSchema.parse(record)) + "\n", { mode: 0o600 });
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: ExecutionRecord[] = [];
  const requestedLimit = Math.max(1, Math.floor(limit));
  const parse = (line: Buffer): void => {
    try {
      const record = executionRecordSchema.safeParse(JSON.parse(line.toString("utf8")));
      if (record.success) records.push(record.data);
    } catch {
      // skip corrupt lines
    }
  };
  try {
    let position = fs.fstatSync(fd).size;
    let suffix: Buffer[] = [];
    const block = Buffer.allocUnsafe(16 * 1024);
    while (position > 0 && records.length < requestedLimit) {
      const length = Math.min(position, block.length);
      position -= length;
      const bytesRead = fs.readSync(fd, block, 0, length, position);
      let end = bytesRead;
      for (let index = bytesRead - 1; index >= 0; index--) {
        if (block[index] !== 10) continue;
        const line = Buffer.concat([block.subarray(index + 1, end), ...suffix]);
        suffix = [];
        if (line.length > 0) parse(line);
        end = index;
        if (records.length >= requestedLimit) break;
      }
      if (records.length < requestedLimit && end > 0) suffix.unshift(Buffer.from(block.subarray(0, end)));
    }
    if (records.length < requestedLimit && suffix.length > 0) parse(Buffer.concat(suffix));
  } finally {
    fs.closeSync(fd);
  }
  return records.reverse();
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}
