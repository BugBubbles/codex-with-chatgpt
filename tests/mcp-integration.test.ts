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
  toolNames: string[];
  seenAuthorization: Array<string | undefined>;
  seenMethods: string[];
  writtenValues: string[];
}

async function startFakeMcp(id: string, tools: string[]): Promise<FakeServer> {
  const app = express();
  app.use(express.json());
  const seenAuthorization: Array<string | undefined> = [];
  const seenMethods: string[] = [];
  const writtenValues: string[] = [];

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
            ...(name === "write_note" ? { annotations: { readOnlyHint: false, destructiveHint: false } } : {}),
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
      if (params?.name === "write_note" && typeof params.arguments?.value === "string") {
        writtenValues.push(params.arguments.value);
      }
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
    toolNames: tools,
    seenAuthorization,
    seenMethods,
    writtenValues,
  };
}

let root: string;
let bridge: Bridge;
let alpha: FakeServer;
let beta: FakeServer;
let alphaId: string;
let betaId: string;
let alphaResource: string;
let alphaAccessToken: string;
let alphaClient: Client;
let betaClient: Client;

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("local-mcp-ws");
  write(root, "README.md", "local MCP connectors test\n");
  alpha = await startFakeMcp("alpha", ["search", "alpha_only", "write_note"]);
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
  const summary = (await discovery.json()) as { serverCount: number; toolCount: number };
  expect(summary.serverCount).toBe(2);
  expect(summary.toolCount).toBe(5);

  const services = bridge.localMcp.summary().servers;
  alphaId = services.find((service) => service.endpoint === alpha.endpoint)!.id;
  betaId = services.find((service) => service.endpoint === beta.endpoint)!.id;
  alphaResource = `${bridge.localBaseUrl()}/mcp/${alphaId}`;
  const betaResource = `${bridge.localBaseUrl()}/mcp/${betaId}`;
  alphaAccessToken = bridge.authStore.issueTokens({
    clientId: "local-mcp-test",
    scopes: ["mcp.tools"],
    resource: alphaResource,
  }).accessToken;
  const betaAccessToken = bridge.authStore.issueTokens({
    clientId: "local-mcp-test",
    scopes: ["mcp.tools"],
    resource: betaResource,
  }).accessToken;

  alphaClient = new Client({ name: "alpha-remote-test", version: "1.0.0" });
  betaClient = new Client({ name: "beta-remote-test", version: "1.0.0" });
  const alphaTransport = new StreamableHTTPClientTransport(new URL(alphaResource), {
    requestInit: { headers: { authorization: `Bearer ${alphaAccessToken}` } },
  });
  const betaTransport = new StreamableHTTPClientTransport(new URL(betaResource), {
    requestInit: { headers: { authorization: `Bearer ${betaAccessToken}` } },
  });
  await alphaClient.connect(alphaTransport);
  await betaClient.connect(betaTransport);
});

afterAll(async () => {
  await alphaClient.close();
  await betaClient.close();
  await bridge.close();
  await Promise.all([
    new Promise<void>((resolve) => alpha.server.close(() => resolve())),
    new Promise<void>((resolve) => beta.server.close(() => resolve())),
  ]);
  cleanup(root);
});

describe("independent local Streamable HTTP MCP connectors", () => {
  it("automatically discovers multiple local MCP ports during configuration", () => {
    const summary = bridge.localMcp.summary();
    expect(summary.serverCount).toBe(2);
    expect(summary.toolCount).toBe(5);
    expect(summary.servers.map((server) => server.id)).toEqual([alphaId, betaId].sort());
    expect(summary.servers.map((server) => server.endpoint).sort()).toEqual(
      [alpha.endpoint, beta.endpoint].sort()
    );
  });

  it("exposes only the tools supplied by the selected local MCP server", async () => {
    const alphaTools = await alphaClient.listTools();
    const betaTools = await betaClient.listTools();
    expect(alphaTools.tools.map((tool) => tool.name).sort()).toEqual(["alpha_only", "search", "write_note"]);
    expect(betaTools.tools.map((tool) => tool.name).sort()).toEqual(["beta_only", "search"]);

    alpha.toolNames.splice(alpha.toolNames.indexOf("alpha_only"), 1, "runtime_added");
    const refreshedAlphaTools = await alphaClient.listTools();
    expect(refreshedAlphaTools.tools.map((tool) => tool.name).sort()).toEqual(["runtime_added", "search", "write_note"]);
  });

  it("routes same-named tools only to their selected local server", async () => {
    const results = await Promise.all([
      alphaClient.callTool({ name: "search", arguments: { value: "needle" } }),
      betaClient.callTool({ name: "search", arguments: { value: "needle" } }),
    ]);
    const texts = results
      .flatMap((result) => result.content)
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .sort();
    expect(texts).toEqual(["alpha:search:needle", "beta:search:needle"]);
  });

  it("preserves write annotations and forwards write calls to the local MCP", async () => {
    const { tools } = await alphaClient.listTools();
    const writeTool = tools.find((tool) => tool.name === "write_note");
    expect(writeTool?.annotations?.readOnlyHint).toBe(false);
    expect(writeTool?.annotations?.destructiveHint).toBe(false);

    const result = await alphaClient.callTool({ name: "write_note", arguments: { value: "local note update" } });
    expect(result.content).toContainEqual({ type: "text", text: "alpha:write_note:local note update" });
    expect(alpha.writtenValues).toEqual(["local note update"]);
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
    const response = await fetch(alphaResource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alphaAccessToken}`,
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
      resource: alphaResource,
    }).accessToken;
    const response = await fetch(alphaResource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${wrongScope}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(403);

    const crossService = await fetch(`${bridge.localBaseUrl()}/mcp/${betaId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alphaAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 101, method: "tools/list", params: {} }),
    });
    expect(crossService.status).toBe(403);
  });
});
