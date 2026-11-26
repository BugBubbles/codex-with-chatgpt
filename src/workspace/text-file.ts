import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { ReadFileResult } from "./manager.js";
import { WorkspaceError } from "./errors.js";

const BLOCK_BYTES = 64 * 1024;
const MAX_INDEXES = 16;
const MAX_ANCHORS = 32 * 1024;

interface LineIndex {
  stamp: string;
  totalLines: number;
  stride: number;
  offsets: number[];
}

const indexes = new Map<string, LineIndex>();
const pending = new Map<string, Promise<LineIndex>>();

function stamp(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Scan bounded byte blocks, recognizing LF, CRLF and CR without buffering a line. */
async function scanLines(
  file: FileHandle,
  start: number,
  onText: (bytes: Buffer) => boolean,
  onLine: (endOffset: number) => boolean,
  size: number
): Promise<void> {
  const block = Buffer.allocUnsafe(BLOCK_BYTES);
  let position = start;
  let pendingCr = false;
  let hasText = false;
  for (;;) {
    const length = Math.min(block.length, size - position);
    if (length <= 0) break;
    const { bytesRead } = await file.read(block, 0, length, position);
    if (bytesRead === 0) break;
    let segment = 0;
    if (pendingCr) {
      segment = block[0] === 10 ? 1 : 0;
      if (!onLine(position + segment)) return;
      pendingCr = false;
      hasText = false;
    }
    for (let index = segment; index < bytesRead; index++) {
      const byte = block[index];
      if (byte !== 10 && byte !== 13) continue;
      if (index > segment && !onText(block.subarray(segment, index))) return;
      if (byte === 13 && index + 1 === bytesRead) {
        pendingCr = true;
      } else {
        if (byte === 13 && block[index + 1] === 10) index++;
        if (!onLine(position + index + 1)) return;
      }
      hasText = false;
      segment = index + 1;
    }
    if (segment < bytesRead) {
      hasText = true;
      if (!onText(block.subarray(segment, bytesRead))) return;
    }
    position += bytesRead;
  }
  if (pendingCr || hasText) onLine(position);
}

async function buildIndex(file: FileHandle, expectedStamp: string, size: number, rel: string): Promise<LineIndex> {
  const sample = Buffer.allocUnsafe(8192);
  const { bytesRead } = await file.read(sample, 0, Math.min(sample.length, size), 0);
  if (sample.subarray(0, bytesRead).includes(0)) {
    throw new WorkspaceError("BINARY_FILE", `Binary file: ${rel}. Content is not returned.`);
  }
  const result: LineIndex = { stamp: expectedStamp, totalLines: 0, stride: 256, offsets: [0] };
  await scanLines(file, 0, () => true, (end) => {
    result.totalLines++;
    if (result.totalLines % result.stride === 0) {
      result.offsets.push(end);
      if (result.offsets.length >= MAX_ANCHORS) {
        result.offsets = result.offsets.filter((_offset, index) => index % 2 === 0);
        result.stride *= 2;
      }
    }
    return true;
  }, size);
  return result;
}

async function lineIndex(file: FileHandle, abs: string, expectedStamp: string, size: number, rel: string): Promise<LineIndex> {
  const cached = indexes.get(abs);
  if (cached?.stamp === expectedStamp) {
    indexes.delete(abs);
    indexes.set(abs, cached);
    return cached;
  }
  indexes.delete(abs);
  const key = JSON.stringify([abs, expectedStamp]);
  const existing = pending.get(key);
  if (existing) return existing;
  const building = buildIndex(file, expectedStamp, size, rel);
  pending.set(key, building);
  try {
    const index = await building;
    if (stamp(await file.stat({ bigint: true })) === expectedStamp) {
      if (indexes.size >= MAX_INDEXES) indexes.delete(indexes.keys().next().value!);
      indexes.set(abs, index);
    }
    return index;
  } finally {
    pending.delete(key);
  }
}

export interface TextReadOptions {
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  maxBytes?: number;
}

export async function readIndexedTextFile(abs: string, rel: string, opts: TextReadOptions): Promise<ReadFileResult> {
  const startLine = Math.max(1, Math.floor(opts.startLine ?? 1));
  const maxLines = Math.min(2000, Math.max(1, Math.floor(opts.maxLines ?? 400)));
  const endLimit = opts.endLine
    ? Math.min(Math.floor(opts.endLine), startLine + 1999)
    : startLine + maxLines - 1;
  const maxBytes = Math.min(1024 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 256 * 1024)));

  for (let attempt = 0; attempt < 2; attempt++) {
    let file: FileHandle;
    try {
      file = await fs.promises.open(abs, "r");
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
      }
      throw error;
    }
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
      const expectedStamp = stamp(stat);
      const index = await lineIndex(file, abs, expectedStamp, Number(stat.size), rel);
      const lines: string[] = [];
      let actualEnd = startLine - 1;
      let collectedBytes = 0;
      let parts: Buffer[] = [];
      let lineBytes = 0;
      if (startLine <= index.totalLines && endLimit >= startLine) {
        const anchor = Math.min(Math.floor((startLine - 1) / index.stride), index.offsets.length - 1);
        let lineNumber = anchor * index.stride + 1;
        const tooLarge = (): boolean => {
          if (lines.length === 0) {
            throw new WorkspaceError("FILE_TOO_LARGE", `Line ${lineNumber} in ${rel} exceeds the ${maxBytes}-byte response limit.`);
          }
          return false;
        };
        await scanLines(file, index.offsets[anchor]!, (segment) => {
          if (lineNumber < startLine) return true;
          lineBytes += segment.length;
          if (collectedBytes + (lines.length > 0 ? 1 : 0) + lineBytes > maxBytes) return tooLarge();
          parts.push(Buffer.from(segment));
          return true;
        }, () => {
          if (lineNumber >= startLine) {
            const text = Buffer.concat(parts, lineBytes).toString("utf8");
            const cost = Buffer.byteLength(text, "utf8") + (lines.length > 0 ? 1 : 0);
            if (collectedBytes + cost > maxBytes) return tooLarge();
            lines.push(text);
            collectedBytes += cost;
            actualEnd = lineNumber;
            parts = [];
            lineBytes = 0;
          }
          lineNumber++;
          return lineNumber <= endLimit;
        }, Number(stat.size));
      }
      if (stamp(await file.stat({ bigint: true })) !== expectedStamp) continue;
      const remaining = Math.max(0, index.totalLines - actualEnd);
      return {
        path: rel,
        sizeBytes: Number(stat.size),
        totalLines: index.totalLines,
        startLine: Math.min(startLine, Math.max(index.totalLines, 1)),
        endLine: actualEnd,
        truncated: remaining > 0,
        remainingLines: remaining,
        nextStartLine: remaining > 0 ? actualEnd + 1 : null,
        content: lines.join("\n"),
      };
    } finally {
      await file.close();
    }
  }
  throw new WorkspaceError("FILE_CHANGED", `File changed while being read: ${rel}. Retry the read.`);
}
