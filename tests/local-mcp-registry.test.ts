import { describe, expect, it } from "vitest";
import { parsePortSpec } from "../src/mcp/local-registry.js";

describe("local MCP port configuration", () => {
  it("accepts arbitrary ports and ranges instead of a fixed port allow-list", () => {
    expect(parsePortSpec("23120,3000-3002,65535")).toEqual([3000, 3001, 3002, 23120, 65535]);
  });

  it("rejects invalid port specifications", () => {
    expect(() => parsePortSpec("0")).toThrow();
    expect(() => parsePortSpec("70000")).toThrow();
    expect(() => parsePortSpec("9000-8000")).toThrow();
  });
});
