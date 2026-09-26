import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "../logger/index.js";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { VERSION } from "../version.js";

interface LocalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

interface ConnectedServer {
  endpoint: string;
  client: Client;
  tools: LocalTool[];
}

interface ToolRoute {
  publicName: string;
  sourceName: string;
  endpoint: string;
  client: Client;
  tool: LocalTool;
}

interface PersistedDiscovery {
  endpoints: string[];
  savedAt: string;
}

export interface LocalMcpDiscoveryOptions {
  endpoints?: string[];
  autoDiscover?: boolean;
  hosts?: string[];
  portSpec?: string;
  paths?: string[];
  scanConcurrency?: number;
  connectTimeoutMs?: number;
  probeTimeoutMs?: number;
  probeConcurrency?: number;
}

export interface LocalMcpSummary {
  serverCount: number;
  toolCount: number;
  duplicateToolNames: string[];
  lastDiscoveryAt: string | null;
  servers: Array<{ endpoint: string; toolCount: number }>;
}

const DEFAULT_PORT_SPEC = "1-65535";
const DEFAULT_PATHS = ["/mcp"];
const DEFAULT_SCAN_CONCURRENCY = 512;
const DEFAULT_CONNECT_TIMEOUT_MS = 35;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_PROBE_CONCURRENCY = 16;

function splitEnv(value: string | undefined): string[] {
  return (value ?? "").split(/[;,]/).map((part) => part.trim()).filter(Boolean);
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/mcp";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password) {
    throw new Error(`Local MCP endpoint must be an unauthenticated HTTP loopback URL: ${value}`);
  }
  url.hash = "";
  return url.toString();
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function parsePortSpec(spec: string): number[] {
  const ports = new Set<number>();
  for (const token of spec.split(",").map((part) => part.trim()).filter(Boolean)) {
    const range = token.match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end > 65535 || start > end) throw new Error(`Invalid port range: ${token}`);
      for (let port = start; port <= end; port += 1) ports.add(port);
      continue;
    }
    if (!/^\d{1,5}$/.test(token)) throw new Error(`Invalid port: ${token}`);
    const port = Number(token);
    if (port < 1 || port > 65535) throw new Error(`Invalid port: ${token}`);
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function endpointAlias(endpoint: string): string {
  const url = new URL(endpoint);
  const host = url.hostname.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "local";
  const port = url.port || "80";
  return `mcp_${host}_${port}`;
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function scanOpenPorts(host: string, ports: number[], concurrency: number, timeoutMs: number): Promise<number[]> {
  if (ports.length === 0) return [];
  const open: number[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= ports.length) return;
      const port = ports[index];
      if (await isPortOpen(host, port, timeoutMs)) open.push(port);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), ports.length) }, () => worker()));
  return open.sort((a, b) => a - b);
}

async function mapLimit<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()));
  return results;
}

async function readAllTools(client: Client): Promise<LocalTool[]> {
  const tools: LocalTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...(page.tools as unknown as LocalTool[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export class LocalMcpRegistry {
  private readonly workspaceId: string;
  private readonly logger: Logger;
  private readonly discovery: Required<
    Pick<LocalMcpDiscoveryOptions,
      "autoDiscover" | "hosts" | "portSpec" | "paths" | "scanConcurrency" |
      "connectTimeoutMs" | "probeTimeoutMs" | "probeConcurrency">
  > & { endpoints: string[] };
  private servers: ConnectedServer[] = [];
  private routes = new Map<string, ToolRoute>();
  private duplicates: string[] = [];
  private lastDiscoveryAt: string | null = null;

  constructor(opts: { workspaceId: string; logger: Logger; discovery?: LocalMcpDiscoveryOptions }) {
    this.workspaceId = opts.workspaceId;
    this.logger = opts.logger;
    const provided = opts.discovery ?? {};
    const envEndpoints = splitEnv(process.env.C2C_LOCAL_MCP_ENDPOINTS);
    const envHosts = splitEnv(process.env.C2C_LOCAL_MCP_HOSTS);
    const envPaths = splitEnv(process.env.C2C_LOCAL_MCP_PATHS);
    this.discovery = {
      endpoints: [...(provided.endpoints ?? []), ...envEndpoints].map(validateEndpoint),
      autoDiscover: provided.autoDiscover ?? true,
      hosts: provided.hosts ?? (envHosts.length > 0 ? envHosts : ["127.0.0.1"]),
      portSpec: provided.portSpec ?? process.env.C2C_LOCAL_MCP_PORTS ?? DEFAULT_PORT_SPEC,
      paths: (provided.paths ?? (envPaths.length > 0 ? envPaths : DEFAULT_PATHS)).map(normalizePath),
      scanConcurrency: provided.scanConcurrency ?? envNumber("C2C_LOCAL_MCP_SCAN_CONCURRENCY", DEFAULT_SCAN_CONCURRENCY, 1, 2048),
      connectTimeoutMs: provided.connectTimeoutMs ?? envNumber("C2C_LOCAL_MCP_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS, 5, 5000),
      probeTimeoutMs: provided.probeTimeoutMs ?? envNumber("C2C_LOCAL_MCP_PROBE_TIMEOUT_MS", DEFAULT_PROBE_TIMEOUT_MS, 100, 30000),
      probeConcurrency: provided.probeConcurrency ?? envNumber("C2C_LOCAL_MCP_PROBE_CONCURRENCY", DEFAULT_PROBE_CONCURRENCY, 1, 128),
    };
    for (const host of this.discovery.hosts) {
      if (!isLoopbackHost(host)) throw new Error(`Local MCP discovery host must be loopback: ${host}`);
    }
  }

  private stateFile(): string {
    return path.join(ensureDir(path.join(getStateDir(), "local-mcp")), `${this.workspaceId}.json`);
  }

  private savedEndpoints(): string[] {
    const saved = readJsonIfExists<PersistedDiscovery>(this.stateFile());
    return (saved?.endpoints ?? []).map(validateEndpoint);
  }

  private persist(): void {
    writeSecureJson(this.stateFile(), {
      endpoints: this.servers.map((server) => server.endpoint),
      savedAt: new Date().toISOString(),
    } satisfies PersistedDiscovery);
  }

  private async connectEndpoint(endpoint: string): Promise<ConnectedServer | null> {
    let client: Client | null = null;
    try {
      client = new Client({ name: "c2c-local-mcp", version: VERSION });
      const transport = new StreamableHTTPClientTransport(new URL(endpoint));
      await withTimeout(client.connect(transport), this.discovery.probeTimeoutMs, `MCP initialize ${endpoint}`);
      const tools = await withTimeout(readAllTools(client), this.discovery.probeTimeoutMs, `MCP tools/list ${endpoint}`);
      return { endpoint, client, tools };
    } catch (error) {
      if (client) await client.close().catch(() => undefined);
      this.logger.debug("Local endpoint is not a usable Streamable HTTP MCP server", {
        endpoint,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async replaceServers(endpoints: string[]): Promise<void> {
    const unique = [...new Set(endpoints.map(validateEndpoint))];
    const connected = await mapLimit(unique, this.discovery.probeConcurrency, (endpoint) => this.connectEndpoint(endpoint));
    const next = connected.filter((server): server is ConnectedServer => server !== null);
    const previous = this.servers;
    this.servers = next;
    this.rebuildRoutes();
    await Promise.all(previous.map((server) => server.client.close().catch(() => undefined)));
  }

  private rebuildRoutes(): void {
    this.routes.clear();
    const byName = new Map<string, Array<{ server: ConnectedServer; tool: LocalTool }>>();
    for (const server of this.servers) {
      for (const tool of server.tools) {
        const list = byName.get(tool.name) ?? [];
        list.push({ server, tool });
        byName.set(tool.name, list);
      }
    }
    this.duplicates = [...byName.entries()].filter(([, entries]) => entries.length > 1).map(([name]) => name).sort();
    const used = new Set<string>();
    for (const [sourceName, entries] of byName) {
      for (const entry of entries) {
        let publicName = entries.length === 1
          ? sourceName
          : `${endpointAlias(entry.server.endpoint)}__${sanitizeToolName(sourceName)}`;
        publicName = publicName.slice(0, 128);
        let suffix = 2;
        const base = publicName;
        while (used.has(publicName)) {
          const tail = `_${suffix++}`;
          publicName = `${base.slice(0, Math.max(1, 128 - tail.length))}${tail}`;
        }
        used.add(publicName);
        this.routes.set(publicName, {
          publicName,
          sourceName,
          endpoint: entry.server.endpoint,
          client: entry.server.client,
          tool: entry.tool,
        });
      }
    }
  }

  async restore(): Promise<LocalMcpSummary> {
    await this.replaceServers([...new Set([...this.discovery.endpoints, ...this.savedEndpoints()])]);
    return this.summary();
  }

  async discover(): Promise<LocalMcpSummary> {
    const candidates = new Set<string>(this.discovery.endpoints);
    if (this.discovery.autoDiscover) {
      const ports = parsePortSpec(this.discovery.portSpec || DEFAULT_PORT_SPEC);
      for (const host of this.discovery.hosts) {
        const openPorts = await scanOpenPorts(host, ports, this.discovery.scanConcurrency, this.discovery.connectTimeoutMs);
        for (const port of openPorts) {
          for (const mcpPath of this.discovery.paths) {
            candidates.add(validateEndpoint(`http://${urlHost(host)}:${port}${mcpPath}`));
          }
        }
      }
    }
    await this.replaceServers([...candidates]);
    this.lastDiscoveryAt = new Date().toISOString();
    this.persist();
    const summary = this.summary();
    this.logger.info("Local MCP discovery completed", { serverCount: summary.serverCount, toolCount: summary.toolCount });
    return summary;
  }

  listTools(): LocalTool[] {
    return [...this.routes.values()].map((route) => ({ ...route.tool, name: route.publicName }));
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const route = this.routes.get(name);
    if (!route) throw new Error(`Unknown local MCP tool: ${name}`);
    try {
      return await route.client.callTool({ name: route.sourceName, arguments: args ?? {} });
    } catch (error) {
      this.logger.warn("Local MCP tool call failed", {
        name,
        endpoint: route.endpoint,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  summary(): LocalMcpSummary {
    return {
      serverCount: this.servers.length,
      toolCount: this.routes.size,
      duplicateToolNames: [...this.duplicates],
      lastDiscoveryAt: this.lastDiscoveryAt,
      servers: this.servers.map((server) => ({ endpoint: server.endpoint, toolCount: server.tools.length })),
    };
  }

  async close(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    this.routes.clear();
    await Promise.all(servers.map((server) => server.client.close().catch(() => undefined)));
  }
}
