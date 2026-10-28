import { describe, it, expect } from "vitest";
import {
  connectorAction,
  connectorNameForServer,
  mcpUrlForServer,
  normalizePublicUrl,
} from "../src/config/endpoint.js";

describe("connectorAction", () => {
  it("creates on the first successful URL", () => {
    expect(connectorAction(null, "https://a.trycloudflare.com/mcp/service-a")).toBe("create");
  });

  it("is a no-op when the URL is unchanged", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp/service-a", "https://a.trycloudflare.com/mcp/service-a/")).toBe("none");
  });

  it("updates when the old address was reclaimed", () => {
    expect(connectorAction("https://old.trycloudflare.com/mcp/service-a", "https://new.trycloudflare.com/mcp/service-a")).toBe("update");
  });

  it("does nothing without a next URL", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp/service-a", null)).toBe("none");
  });
});

describe("server connector identifiers", () => {
  it("uses service names and constructs a service-specific URL", () => {
    expect(connectorNameForServer("llm-for-zotero")).toBe("llm-for-zotero");
    expect(mcpUrlForServer("https://A.trycloudflare.com/", "llm-for-zotero")).toBe(
      "https://a.trycloudflare.com/mcp/llm-for-zotero"
    );
    expect(mcpUrlForServer("https://A.trycloudflare.com/base/", "OpenReview")).toBe(
      "https://a.trycloudflare.com/base/mcp/OpenReview"
    );
  });

  it("normalizes host and trailing slash without lowercasing the service path", () => {
    expect(normalizePublicUrl("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
    expect(normalizePublicUrl("https://A.trycloudflare.com/mcp/OpenReview/")).toBe(
      "https://a.trycloudflare.com/mcp/OpenReview"
    );
  });
});
