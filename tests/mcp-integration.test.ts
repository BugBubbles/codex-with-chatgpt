import express from "express";
import type { Server } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

interface FakeServer {
  server: Server;
  port: number;
  endpoint: string;
  seenAuthorization: Array<string | undefined>;
  seenMethods: string[];
}

async function startFakeMcp(id: string, tools: string[]): Promise<FakeServer> {
  const app = express();
  app.use(express.json());
  const seenAuthorization: Array<string | undefined> = [];
  const seenMethods: string[] = [];

  app.post("/mcp", (req, res) => {
    const body = req.body as {
      id?: unknown;
      method?: string;
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
    };
    seenAuthorization.push(req.get("authorization"));
    seenMethods.push(body.method ?? "");

    if (body.method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: id, version: "1.0.0" },
        },
      });
      return;
    }
    if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") {
      res.status(202).end();
      return;
    }
    if (body.method === "ping") {
      res.json({ jsonrpc: "2.0", id: body.id, result: {} });
      return;
    }
    if (body.method === "tools/list") {
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: tools.map((name) => ({
            name,
            description: `${id} tool ${name}`,
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
            },
          })),
        },
      });
      return;
    }
    if (body.method === "tools/call") {
      const params = body.params as { name?: string; arguments?: { value?: string } } | undefined;
      res.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [{ type: "text", text: `${id}:${params?.name}:${params?.arguments?.value ?? ""}` }],
        },
      });
      return;
    }
    res.json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: { code: -32601, message: "Method not found" },
    });
  });

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake MCP server failed to bind");
  return {
    server,
    port: address.port,
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    seenAuthorization,
    seenMethods,
  };
}

let root: string;
let bridge: Bridge;
let alpha: FakeServer;
let beta: FakeServer;
let accessToken: string;
let client: Client;

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("local-mcp-ws");
  write(root, "README.md", "local MCP aggregation test\n");
  alpha = await startFakeMcp("alpha", ["search", "alpha_only"]);
  beta = await startFakeMcp("beta", ["search", "beta_only"]);

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
    localMcpDiscovery: {
      autoDiscover: true,
      hosts: ["127.0.0.1"],
      portSpec: `${alpha.port},${beta.port}`,
      paths: ["/mcp"],
      connectTimeoutMs: 100,
      probeTimeoutMs: 3000,
    },
  });

  const discovery = await fetch(`${bridge.localBaseUrl()}/admin/local-mcp/discover`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.adminToken}` },
  });
  expect(discovery.status).toBe(200);
  const summary = (await discovery.json()) as { serverCount: number; toolCount: number; duplicateToolNames: string[] };
  expect(summary.serverCount).toBe(2);
  expect(summary.toolCount).toBe(4);
  expect(summary.duplicateToolNames).toEqual(["search"]);

  accessToken = bridge.authStore.issueTokens({
    clientId: "local-mcp-test",
    scopes: ["mcp.tools"],
  }).accessToken;

  client = new Client({ name: "local-mcp-remote-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  await Promise.all([
    new Promise<void>((resolve) => alpha.server.close(() => resolve())),
    new Promise<void>((resolve) => beta.server.close(() => resolve())),
  ]);
  cleanup(root);
});

describe("local Streamable HTTP MCP aggregation", () => {
  it("automatically discovers multiple local MCP ports during configuration", () => {
    const summary = bridge.localMcp.summary();
    expect(summary.serverCount).toBe(2);
    expect(summary.toolCount).toBe(4);
    expect(summary.servers.map((server) => server.endpoint).sort()).toEqual(
      [alpha.endpoint, beta.endpoint].sort()
    );
  });

  it("exposes every discovered tool and none of the workspace/Python tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toContain("alpha_only");
    expect(names).toContain("beta_only");
    expect(names).not.toContain("workspace_info");
    expect(names).not.toContain("python_execute");
    expect(names.filter((name) => name.endsWith("__search"))).toHaveLength(2);
  });

  it("routes duplicate tool names to the correct local server using source aliases", async () => {
    const { tools } = await client.listTools();
    const aliases = tools.map((tool) => tool.name).filter((name) => name.endsWith("__search"));
    const results = await Promise.all(
      aliases.map((name) => client.callTool({ name, arguments: { value: "needle" } }))
    );
    const texts = results
      .flatMap((result) => result.content)
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .sort();
    expect(texts).toEqual(["alpha:search:needle", "beta:search:needle"]);
  });

  it("does not forward the public OAuth bearer token to local MCP servers", () => {
    expect(alpha.seenAuthorization.length).toBeGreaterThan(0);
    expect(beta.seenAuthorization.length).toBeGreaterThan(0);
    expect(alpha.seenAuthorization.every((value) => value === undefined)).toBe(true);
    expect(beta.seenAuthorization.every((value) => value === undefined)).toBe(true);
  });

  it("blocks resources/prompts and other non-tool MCP methods at the public bridge", async () => {
    const before = alpha.seenMethods.filter((method) => method === "resources/list").length
      + beta.seenMethods.filter((method) => method === "resources/list").length;
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "resources/list", params: {} }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
    const after = alpha.seenMethods.filter((method) => method === "resources/list").length
      + beta.seenMethods.filter((method) => method === "resources/list").length;
    expect(after).toBe(before);
  });

  it("requires the mcp.tools scope", async () => {
    const wrongScope = bridge.authStore.issueTokens({
      clientId: "wrong-scope",
      scopes: ["offline_access"],
    }).accessToken;
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${wrongScope}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(403);
  });
});
