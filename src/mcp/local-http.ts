import type { Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Logger } from "../logger/index.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import type { LocalMcpRegistry } from "./local-registry.js";

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function createLocalMcpHttpHandler(registry: LocalMcpRegistry, logger: Logger) {
  const handleMessage = async (message: RpcRequest): Promise<Record<string, unknown> | null> => {
    const id = message.id;
    if (typeof message.method !== "string") return rpcError(id, -32600, "Invalid JSON-RPC request.");
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
    if (message.method === "initialize") {
      const params = isRecord(message.params) ? message.params : {};
      const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${PRODUCT_NAME} Local MCP`, version: VERSION },
        instructions: "Tools are dynamically aggregated from local Streamable HTTP MCP servers discovered during setup.",
      });
    }
    if (message.method === "ping") return rpcResult(id, {});
    if (message.method === "tools/list") return rpcResult(id, { tools: registry.listTools() });
    if (message.method === "tools/call") {
      const params = isRecord(message.params) ? message.params : null;
      const name = params && typeof params.name === "string" ? params.name : null;
      if (!name) return rpcError(id, -32602, "tools/call requires a tool name.");
      const args = params && isRecord(params.arguments) ? params.arguments : undefined;
      try {
        return rpcResult(id, await registry.callTool(name, args));
      } catch (error) {
        logger.warn("Aggregated local MCP tool call failed", {
          name,
          message: error instanceof Error ? error.message : String(error),
        });
        return rpcError(id, -32010, error instanceof Error ? error.message : "Local MCP tool call failed.");
      }
    }
    return rpcError(id, -32601, `Method not available through the tools-only local MCP bridge: ${message.method}`);
  };

  return async (req: Request, res: Response): Promise<void> => {
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      res.status(405).json(rpcError(null, -32000, "Method not allowed. Use POST."));
      return;
    }
    const auth = (req as Request & { auth?: AuthInfo }).auth;
    if (!auth?.scopes.includes("mcp.tools")) {
      res.status(403).json(rpcError(null, -32001, "The mcp.tools scope is required."));
      return;
    }
    const messages = Array.isArray(req.body) ? req.body : [req.body];
    if (messages.length === 0 || messages.some((message) => !isRecord(message))) {
      res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC request."));
      return;
    }
    const responses: Record<string, unknown>[] = [];
    for (const raw of messages) {
      const response = await handleMessage(raw as RpcRequest);
      if (response) responses.push(response);
    }
    if (responses.length === 0) {
      res.status(202).end();
      return;
    }
    res.status(200).type("application/json").send(JSON.stringify(Array.isArray(req.body) ? responses : responses[0]));
  };
}
