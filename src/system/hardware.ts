import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const COMMAND_TIMEOUT_MS = 1_500;
const COMMAND_MAX_BUFFER = 128 * 1024;
const MIB = 1024 * 1024;

export interface CpuInfo {
  model: string | null;
  architecture: string;
  physicalCores: number | null;
  logicalCores: number;
  availableCores: number;
  maxFrequencyMHz: number | null;
  loadAverage: {
    oneMinute: number;
    fiveMinutes: number;
    fifteenMinutes: number;
  };
}

export interface MemoryInfo {
  totalBytes: number;
  availableBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  swap: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  };
}

export interface GpuInfo {
  vendor: string;
  model: string;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  memoryFreeBytes: number | null;
  utilizationPercent: number | null;
  driverVersion: string | null;
  source: "nvidia-smi" | "amd-smi" | "system_profiler" | "lspci";
}

export interface StorageInfo {
  totalBytes: number;
  availableBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface HardwareInfo {
  system: {
    platform: string;
    release: string;
    architecture: string;
    uptimeSeconds: number;
  };
  cpu: CpuInfo;
  memory: MemoryInfo;
  gpus: GpuInfo[];
  storage: StorageInfo | null;
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

function safePercent(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round(Math.min(100, Math.max(0, (used / total) * 100)) * 10) / 10;
}

function bytesFromMiB(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(finiteNonNegative(parsed * MIB)) : null;
}

function bytesFromDisplaySize(value: string | null): number | null {
  if (!value || /^N\/A$/i.test(value.trim())) return null;
  const match = value.trim().match(/^([\d.,]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?$/i);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1].replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const unit = (match[2] ?? "B").toLowerCase();
  const multiplier = unit === "tb" || unit === "tib"
    ? 1024 ** 4
    : unit === "gb" || unit === "gib"
      ? 1024 ** 3
      : unit === "mb" || unit === "mib"
        ? MIB
        : unit === "kb" || unit === "kib"
          ? 1024
          : 1;
  return Math.round(finiteNonNegative(parsed * multiplier));
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function runFixedCommand(command: string, args: string[]): string | null {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function parseMeminfo(text: string | null): Map<string, number> {
  const result = new Map<string, number>();
  if (!text) return result;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(\d+)(?:\s*(kB|MB|GB))?/i);
    if (!match) continue;
    const multiplier = match[3]?.toLowerCase() === "gb"
      ? 1024 * 1024 * 1024
      : match[3]?.toLowerCase() === "mb"
        ? MIB
        : 1024;
    result.set(match[1], finiteNonNegative(Number(match[2]) * multiplier));
  }
  return result;
}

function detectPhysicalCores(): number | null {
  const text = readText("/proc/cpuinfo");
  if (!text) return null;

  const pairs = new Set<string>();
  let physicalId: string | undefined;
  let coreId: string | undefined;
  const commit = (): void => {
    if (physicalId !== undefined && coreId !== undefined) pairs.add(`${physicalId}:${coreId}`);
    physicalId = undefined;
    coreId = undefined;
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      commit();
      continue;
    }
    const match = line.match(/^\s*(physical id|core id)\s*:\s*(\S+)/i);
    if (!match) continue;
    if (match[1].toLowerCase() === "physical id") physicalId = match[2];
    else coreId = match[2];
  }
  commit();
  return pairs.size > 0 ? pairs.size : null;
}

function collectCpuInfo(): CpuInfo {
  const cpus = os.cpus();
  const logicalCores = Math.max(1, cpus.length);
  const availableCores = Math.max(1, os.availableParallelism?.() ?? logicalCores);
  const frequencies = cpus.map((cpu) => cpu.speed).filter((speed) => Number.isFinite(speed) && speed > 0);
  const load = os.loadavg();

  return {
    model: cpus.find((cpu) => cpu.model.trim())?.model.trim() || null,
    architecture: os.arch(),
    physicalCores: detectPhysicalCores(),
    logicalCores,
    availableCores,
    maxFrequencyMHz: frequencies.length > 0 ? Math.max(...frequencies) : null,
    loadAverage: {
      oneMinute: finiteNonNegative(load[0] ?? 0),
      fiveMinutes: finiteNonNegative(load[1] ?? 0),
      fifteenMinutes: finiteNonNegative(load[2] ?? 0),
    },
  };
}

function collectMemoryInfo(): MemoryInfo {
  const meminfo = parseMeminfo(readText("/proc/meminfo"));
  const totalBytes = meminfo.get("MemTotal") ?? finiteNonNegative(os.totalmem());
  const freeBytes = meminfo.get("MemFree") ?? finiteNonNegative(os.freemem());
  const availableBytes = Math.min(totalBytes, meminfo.get("MemAvailable") ?? freeBytes);
  const usedBytes = Math.max(0, totalBytes - availableBytes);

  const swapTotalBytes = meminfo.get("SwapTotal") ?? 0;
  const swapFreeBytes = Math.min(swapTotalBytes, meminfo.get("SwapFree") ?? 0);
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);

  return {
    totalBytes,
    availableBytes,
    freeBytes: Math.min(totalBytes, freeBytes),
    usedBytes,
    usedPercent: safePercent(usedBytes, totalBytes),
    swap: {
      totalBytes: swapTotalBytes,
      freeBytes: swapFreeBytes,
      usedBytes: swapUsedBytes,
      usedPercent: safePercent(swapUsedBytes, swapTotalBytes),
    },
  };
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

export function parseNvidiaSmiOutput(output: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const [model, total, used, free, utilization, driverVersion] = splitCsvLine(line);
    if (!model || /^N\/A$/i.test(model)) continue;
    const parsePercent = (value: string | undefined): number | null => {
      const parsed = value ? Number.parseFloat(value.replace(/%/g, "").trim()) : Number.NaN;
      return Number.isFinite(parsed) && parsed >= 0 ? Math.min(100, parsed) : null;
    };
    gpus.push({
      vendor: "NVIDIA",
      model,
      memoryTotalBytes: bytesFromMiB(total),
      memoryUsedBytes: bytesFromMiB(used),
      memoryFreeBytes: bytesFromMiB(free),
      utilizationPercent: parsePercent(utilization),
      driverVersion: driverVersion && !/^N\/A$/i.test(driverVersion) ? driverVersion : null,
      source: "nvidia-smi",
    });
  }
  return gpus;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && !/^N\/A$/i.test(value.trim())) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.replace(/,/g, ""));
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return null;
}

function collectRecordObjects(value: unknown, result: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRecordObjects(item, result);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    result.push(record);
    for (const child of Object.values(record)) collectRecordObjects(child, result);
  }
  return result;
}

function parseAmdSmiOutput(output: string): GpuInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }

  const gpus: GpuInfo[] = [];
  for (const record of collectRecordObjects(parsed)) {
    const model = firstString(record, ["Device Name", "Product Name", "GPU product name", "Card series", "Name"]);
    if (!model || !/(amd|radeon|instinct|ati)/i.test(`${model} ${JSON.stringify(record)}`)) continue;
    if (gpus.some((gpu) => gpu.model === model)) continue;
    const total = firstNumber(record, ["GPU Memory Total (B)", "VRAM Total (B)", "memory_total", "vram_total"]);
    const used = firstNumber(record, ["GPU Memory Used (B)", "VRAM Used (B)", "memory_used", "vram_used"]);
    const free = firstNumber(record, ["GPU Memory Free (B)", "VRAM Free (B)", "memory_free", "vram_free"]);
    const utilization = firstNumber(record, ["GPU use (%)", "GPU Utilization (%)", "utilization", "gpu_use"]);
    const driverVersion = firstString(record, ["Driver version", "driver_version"]);
    gpus.push({
      vendor: "AMD",
      model,
      memoryTotalBytes: total,
      memoryUsedBytes: used,
      memoryFreeBytes: free,
      utilizationPercent: utilization === null ? null : Math.min(100, utilization),
      driverVersion,
      source: "amd-smi",
    });
  }
  return gpus;
}

function parseSystemProfilerOutput(output: string): GpuInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const gpus: GpuInfo[] = [];
  for (const record of collectRecordObjects(parsed)) {
    const model = firstString(record, ["sppci_model", "_name", "spdisplays_device"]);
    if (!model || gpus.some((gpu) => gpu.model === model)) continue;
    const vendor = firstString(record, ["spdisplays_vendor"]) ?? "Apple";
    const memoryText = firstString(record, ["spdisplays_vram", "spdisplays_vram_shared"]);
    gpus.push({
      vendor,
      model,
      memoryTotalBytes: bytesFromDisplaySize(memoryText),
      memoryUsedBytes: null,
      memoryFreeBytes: null,
      utilizationPercent: null,
      driverVersion: null,
      source: "system_profiler",
    });
  }
  return gpus;
}

function parseLspciOutput(output: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/(VGA compatible controller|3D controller|Display controller)/i.test(line)) continue;
    const separator = line.indexOf(": ");
    if (separator < 0) continue;
    const model = line
      .slice(separator + 2)
      .replace(/\s+\[[0-9a-f]{4}:[0-9a-f]{4}\]/gi, "")
      .replace(/\s+\(rev\s+[^)]+\)/i, "")
      .trim();
    if (!model || gpus.some((gpu) => gpu.model === model)) continue;
    const vendor = /nvidia/i.test(model) ? "NVIDIA" : /amd|ati|radeon/i.test(model) ? "AMD" : /intel/i.test(model) ? "Intel" : "Unknown";
    gpus.push({
      vendor,
      model,
      memoryTotalBytes: null,
      memoryUsedBytes: null,
      memoryFreeBytes: null,
      utilizationPercent: null,
      driverVersion: null,
      source: "lspci",
    });
  }
  return gpus;
}

function collectGpuInfo(): GpuInfo[] {
  const nvidia = runFixedCommand("nvidia-smi", [
    "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,driver_version",
    "--format=csv,noheader,nounits",
  ]);
  if (nvidia) {
    const parsed = parseNvidiaSmiOutput(nvidia);
    if (parsed.length > 0) return parsed;
  }

  for (const [command, args] of [
    ["amd-smi", ["list", "--json"]],
    ["rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--showuse", "--json"]],
  ] as const) {
    const amd = runFixedCommand(command, [...args]);
    if (!amd) continue;
    const parsed = parseAmdSmiOutput(amd);
    if (parsed.length > 0) return parsed;
  }

  if (process.platform === "darwin") {
    const profiler = runFixedCommand("system_profiler", ["SPDisplaysDataType", "-json"]);
    if (profiler) {
      const parsed = parseSystemProfilerOutput(profiler);
      if (parsed.length > 0) return parsed;
    }
  }

  const lspci = runFixedCommand("lspci", ["-nn"]);
  return lspci ? parseLspciOutput(lspci) : [];
}

function collectStorageInfo(root: string): StorageInfo | null {
  try {
    const stats = fs.statfsSync(root);
    const blockSize = finiteNonNegative(Number(stats.bsize));
    if (blockSize <= 0) return null;
    const totalBytes = finiteNonNegative(Number(stats.blocks) * blockSize);
    const freeBytes = Math.min(totalBytes, finiteNonNegative(Number(stats.bfree) * blockSize));
    const availableBytes = Math.min(totalBytes, finiteNonNegative(Number(stats.bavail) * blockSize));
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      totalBytes,
      availableBytes,
      freeBytes,
      usedBytes,
      usedPercent: safePercent(usedBytes, totalBytes),
    };
  } catch {
    return null;
  }
}

export function collectHardwareInfo(workspaceRoot: string): HardwareInfo {
  return {
    system: {
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      uptimeSeconds: finiteNonNegative(Math.floor(os.uptime())),
    },
    cpu: collectCpuInfo(),
    memory: collectMemoryInfo(),
    gpus: collectGpuInfo(),
    storage: collectStorageInfo(workspaceRoot),
  };
}
