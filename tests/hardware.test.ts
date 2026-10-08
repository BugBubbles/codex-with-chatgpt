import { describe, expect, it } from "vitest";
import { collectHardwareInfo, parseNvidiaSmiOutput } from "../src/system/hardware.js";

describe("hardware information", () => {
  it("parses the stable nvidia-smi CSV shape", () => {
    const gpus = parseNvidiaSmiOutput(
      "NVIDIA GeForce RTX 4090, 24564, 1024, 23540, 12, 555.42.02\n" +
      "NVIDIA A100, 40960, 2048, 38912, 95, 555.42.02\n"
    );

    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({
      vendor: "NVIDIA",
      model: "NVIDIA GeForce RTX 4090",
      memoryTotalBytes: 24564 * 1024 * 1024,
      memoryUsedBytes: 1024 * 1024 * 1024,
      utilizationPercent: 12,
      driverVersion: "555.42.02",
      source: "nvidia-smi",
    });
  });

  it("returns a bounded resource snapshot without host identity fields", () => {
    const hardware = collectHardwareInfo(process.cwd());

    expect(hardware.system.platform).toBeTypeOf("string");
    expect(hardware.system.release).toBeTypeOf("string");
    expect(hardware.cpu.logicalCores).toBeGreaterThan(0);
    expect(hardware.cpu.availableCores).toBeGreaterThan(0);
    expect(hardware.memory.totalBytes).toBeGreaterThan(0);
    expect(hardware.memory.usedPercent).toBeGreaterThanOrEqual(0);
    expect(hardware.memory.usedPercent).toBeLessThanOrEqual(100);
    expect(hardware.memory.swap.usedPercent).toBeGreaterThanOrEqual(0);
    expect(hardware.memory.swap.usedPercent).toBeLessThanOrEqual(100);
    expect(Array.isArray(hardware.gpus)).toBe(true);
    expect(hardware).not.toHaveProperty("hostname");
    expect(hardware).not.toHaveProperty("username");
    expect(hardware).not.toHaveProperty("environment");
  });
});
