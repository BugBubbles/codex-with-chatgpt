import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
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

export interface LocalMcpArtifactPathMapping {
  /** Artifact path prefix reported by the MCP server. */
  from: string;
  /** Local absolute directory containing the same artifacts. */
  to: string;
}

export interface LocalMcpServerConfig {
  /** Optional stable service name used for its connector path and display name. */
  name?: string;
  endpoint: string;
  /** Read the Bearer token from this environment variable. The token is never persisted. */
  bearerTokenEnv?: string;
  /** Explicit path mappings for image artifacts returned by this server. */
  imageArtifactPathMappings?: LocalMcpArtifactPathMapping[];
}

interface ConnectedServerCandidate {
  config: LocalMcpServerConfig;
  endpoint: string;
  client: Client;
  tools: LocalTool[];
}

interface ConnectedServer extends ConnectedServerCandidate {
  id: string;
  name: string;
}

interface PersistedDiscovery {
  /** Legacy endpoint list retained for existing local MCP configurations. */
  endpoints?: string[];
  /** Named/authenticated endpoint records. */
  servers?: LocalMcpServerConfig[];
  savedAt?: string;
}

export interface LocalMcpDiscoveryOptions {
  endpoints?: string[];
  servers?: LocalMcpServerConfig[];
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
  lastDiscoveryAt: string | null;
  servers: Array<{ id: string; name: string; endpoint: string; toolCount: number }>;
}

const DEFAULT_PORT_SPEC = "1-65535";
const DEFAULT_PATHS = ["/mcp"];
const DEFAULT_SCAN_CONCURRENCY = 512;
const DEFAULT_CONNECT_TIMEOUT_MS = 35;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_PROBE_CONCURRENCY = 16;
const MAX_IMAGE_ARTIFACT_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid local MCP endpoint URL.");
  }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password) {
    throw new Error("Local MCP endpoints must use HTTP on loopback and cannot contain embedded credentials.");
  }
  url.hash = "";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateServerConfig(value: unknown): LocalMcpServerConfig {
  if (!isRecord(value) || typeof value.endpoint !== "string") {
    throw new Error("Each local MCP server must have an endpoint URL.");
  }

  const config: LocalMcpServerConfig = { endpoint: validateEndpoint(value.endpoint) };
  if (value.name !== undefined) {
    if (typeof value.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.name)) {
      throw new Error("Local MCP server names must be 1-64 letters, numbers, underscores, or hyphens.");
    }
    config.name = value.name;
  }
  if (value.bearerTokenEnv !== undefined) {
    if (typeof value.bearerTokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.bearerTokenEnv)) {
      throw new Error("bearerTokenEnv must be a valid environment variable name.");
    }
    config.bearerTokenEnv = value.bearerTokenEnv;
  }
  if (value.imageArtifactPathMappings !== undefined) {
    if (!Array.isArray(value.imageArtifactPathMappings)) {
      throw new Error("imageArtifactPathMappings must be an array.");
    }
    config.imageArtifactPathMappings = value.imageArtifactPathMappings.map((mapping) => {
      if (!isRecord(mapping) || typeof mapping.from !== "string" || typeof mapping.to !== "string") {
        throw new Error("Each image artifact path mapping requires from and to paths.");
      }
      const remotePrefix = mapping.from.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!(remotePrefix.startsWith("/") || /^[A-Za-z]:\//.test(remotePrefix)) || !path.isAbsolute(mapping.to)) {
        throw new Error("Image artifact mappings require an absolute source prefix and absolute local directory.");
      }
      return { from: mapping.from, to: path.resolve(mapping.to) };
    });
  }
  return config;
}

function mergeServerConfigs(configs: LocalMcpServerConfig[]): LocalMcpServerConfig[] {
  const byEndpoint = new Map<string, LocalMcpServerConfig>();
  for (const raw of configs) {
    const config = validateServerConfig(raw);
    const previous = byEndpoint.get(config.endpoint);
    if (previous?.name && config.name && previous.name !== config.name) {
      throw new Error("Local MCP endpoint has conflicting server names.");
    }
    if (previous?.bearerTokenEnv && config.bearerTokenEnv && previous.bearerTokenEnv !== config.bearerTokenEnv) {
      throw new Error("Local MCP endpoint has conflicting Bearer token environment settings.");
    }
    byEndpoint.set(config.endpoint, {
      ...previous,
      ...config,
      name: config.name ?? previous?.name,
      bearerTokenEnv: config.bearerTokenEnv ?? previous?.bearerTokenEnv,
      imageArtifactPathMappings: config.imageArtifactPathMappings ?? previous?.imageArtifactPathMappings,
    });
  }
  return [...byEndpoint.values()];
}

function serverConfigsFromEnv(value: string | undefined): LocalMcpServerConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("C2C_LOCAL_MCP_SERVERS must contain a JSON array of server configurations.");
  }
  if (!Array.isArray(parsed)) throw new Error("C2C_LOCAL_MCP_SERVERS must contain a JSON array of server configurations.");
  return parsed.map(validateServerConfig);
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveArtifactPath(
  artifactPath: string,
  mappings: LocalMcpArtifactPathMapping[]
): { root: string; candidate: string } | null {
  const normalizedArtifact = artifactPath.replace(/\\/g, "/");
  for (const mapping of mappings) {
    const remotePrefix = mapping.from.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedLower = normalizedArtifact.toLowerCase();
    const prefixLower = remotePrefix.toLowerCase();
    if (normalizedLower !== prefixLower && !normalizedLower.startsWith(`${prefixLower}/`)) continue;
    const suffix = normalizedArtifact.slice(remotePrefix.length).replace(/^\/+/, "");
    const root = path.resolve(mapping.to);
    const candidate = path.resolve(root, ...suffix.split("/").filter(Boolean));
    if (isWithinPath(root, candidate)) return { root, candidate };
  }
  return null;
}

function imageArtifactsFromResult(result: unknown): Array<{ mimeType: string; storedPath: string }> {
  if (!isRecord(result) || !Array.isArray(result.content)) return [];
  const found: Array<{ mimeType: string; storedPath: string }> = [];
  for (const block of result.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    const text = block.text.trim();
    if (!text.startsWith("{") || !text.includes('"artifacts"')) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || !Array.isArray(parsed.artifacts)) continue;
      for (const artifact of parsed.artifacts) {
        if (!isRecord(artifact) || artifact.kind !== "image") continue;
        const mimeType = typeof artifact.mimeType === "string" ? artifact.mimeType : "";
        const storedPath = typeof artifact.storedPath === "string"
          ? artifact.storedPath
          : typeof artifact.cropPath === "string" ? artifact.cropPath : "";
        if (IMAGE_MIME_TYPES.has(mimeType) && storedPath) found.push({ mimeType, storedPath });
      }
    } catch {
      // Ordinary text tool output is not an artifact manifest.
    }
  }
  return found;
}

async function imageBlocksFromArtifacts(
  result: unknown,
  mappings: LocalMcpArtifactPathMapping[]
): Promise<Record<string, unknown>[]> {
  if (!mappings.length) return [];
  if (isRecord(result) && Array.isArray(result.content) && result.content.some((block) => isRecord(block) && block.type === "image")) {
    return [];
  }
  const artifacts = imageArtifactsFromResult(result);
  const blocks: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (seen.has(artifact.storedPath) || blocks.length >= 8) continue;
    seen.add(artifact.storedPath);
    const mapped = resolveArtifactPath(artifact.storedPath, mappings);
    if (!mapped) continue;
    try {
      const [realRoot, realCandidate] = await Promise.all([fs.realpath(mapped.root), fs.realpath(mapped.candidate)]);
      if (!isWithinPath(realRoot, realCandidate)) continue;
      const info = await fs.stat(realCandidate);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_ARTIFACT_BYTES) continue;
      const data = await fs.readFile(realCandidate);
      blocks.push({ type: "image", mimeType: artifact.mimeType, data: data.toString("base64") });
    } catch {
      // Keep the original artifact metadata when its image is not locally available.
    }
  }
  return blocks;
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

function endpointName(endpoint: string): string {
  const url = new URL(endpoint);
  const segments = url.pathname.split("/").filter(Boolean);
  if (["mcp", "sse", "rpc"].includes((segments.at(-1) ?? "").toLowerCase())) segments.pop();
  const name = segments.at(-1)?.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return name?.slice(0, 48) || "local-mcp";
}

function endpointAlias(endpoint: string): string {
  const name = endpointName(endpoint);
  const suffix = createHash("sha256").update(endpoint).digest("hex").slice(0, 10);
  return `${name}__${suffix}`;
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
  > & { servers: LocalMcpServerConfig[] };
  private servers: ConnectedServer[] = [];
  private lastDiscoveryAt: string | null = null;

  constructor(opts: { workspaceId: string; logger: Logger; discovery?: LocalMcpDiscoveryOptions }) {
    this.workspaceId = opts.workspaceId;
    this.logger = opts.logger;
    const provided = opts.discovery ?? {};
    const envEndpoints = splitEnv(process.env.C2C_LOCAL_MCP_ENDPOINTS);
    const envServers = serverConfigsFromEnv(process.env.C2C_LOCAL_MCP_SERVERS);
    const envHosts = splitEnv(process.env.C2C_LOCAL_MCP_HOSTS);
    const envPaths = splitEnv(process.env.C2C_LOCAL_MCP_PATHS);
    this.discovery = {
      servers: mergeServerConfigs([
        ...(provided.endpoints ?? []),
        ...envEndpoints,
      ].map((endpoint) => ({ endpoint })).concat(provided.servers ?? [], envServers)),
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

  private savedServers(): LocalMcpServerConfig[] {
    const saved = readJsonIfExists<PersistedDiscovery>(this.stateFile());
    const legacy = (Array.isArray(saved?.endpoints) ? saved.endpoints : [])
      .filter((endpoint): endpoint is string => typeof endpoint === "string")
      .map((endpoint) => ({ endpoint: validateEndpoint(endpoint) }));
    const configured = (Array.isArray(saved?.servers) ? saved.servers : []).map(validateServerConfig);
    return mergeServerConfigs([...legacy, ...configured]);
  }

  private persist(servers: LocalMcpServerConfig[]): void {
    const normalized = mergeServerConfigs(servers);
    writeSecureJson(this.stateFile(), {
      endpoints: normalized.map((server) => server.endpoint),
      servers: normalized.filter((server) => Boolean(
        server.name || server.bearerTokenEnv || server.imageArtifactPathMappings?.length
      )),
      savedAt: new Date().toISOString(),
    } satisfies PersistedDiscovery);
  }

  private async connectEndpoint(config: LocalMcpServerConfig): Promise<ConnectedServerCandidate | null> {
    let client: Client | null = null;
    try {
      let requestInit: RequestInit | undefined;
      if (config.bearerTokenEnv) {
        const token = process.env[config.bearerTokenEnv]?.trim();
        if (!token) throw new Error(`Bearer token environment variable ${config.bearerTokenEnv} is not set.`);
        requestInit = { headers: { Authorization: `Bearer ${token}` } };
      }
      client = new Client({ name: "c2c-local-mcp", version: VERSION });
      const transport = new StreamableHTTPClientTransport(
        new URL(config.endpoint),
        requestInit ? { requestInit } : undefined
      );
      await withTimeout(client.connect(transport), this.discovery.probeTimeoutMs, `MCP initialize ${config.endpoint}`);
      const tools = await withTimeout(readAllTools(client), this.discovery.probeTimeoutMs, `MCP tools/list ${config.endpoint}`);
      return { config, endpoint: config.endpoint, client, tools };
    } catch (error) {
      if (client) await client.close().catch(() => undefined);
      this.logger.debug("Local endpoint is not a usable Streamable HTTP MCP server", {
        endpoint: config.endpoint,
        name: config.name,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async replaceServers(configs: LocalMcpServerConfig[]): Promise<void> {
    const unique = mergeServerConfigs(configs);
    const connected = await mapLimit(unique, this.discovery.probeConcurrency, (config) => this.connectEndpoint(config));
    const next = this.assignConnectorIds(connected.filter((server): server is ConnectedServerCandidate => server !== null));
    const previous = this.servers;
    this.servers = next;
    await Promise.all(previous.map((server) => server.client.close().catch(() => undefined)));
  }

  private assignConnectorIds(servers: ConnectedServerCandidate[]): ConnectedServer[] {
    const ordered = [...servers].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
    const baseIds = ordered.map((server) => server.config.name ?? endpointAlias(server.endpoint));
    const counts = new Map<string, number>();
    for (const base of baseIds) counts.set(base, (counts.get(base) ?? 0) + 1);
    const used = new Set<string>();
    return ordered.map((server, index) => {
      const base = sanitizeToolName(baseIds[index]).slice(0, 96) || "local_mcp";
      let id = (counts.get(baseIds[index]) ?? 0) > 1
        ? `${base}__${endpointAlias(server.endpoint)}`
        : base;
      if (used.has(id)) {
        const suffix = createHash("sha256").update(server.endpoint).digest("hex").slice(0, 10);
        id = `${id.slice(0, 110)}__${suffix}`;
      }
      used.add(id);
      return { ...server, id, name: server.config.name ?? endpointName(server.endpoint) };
    });
  }

  async restore(): Promise<LocalMcpSummary> {
    await this.replaceServers(mergeServerConfigs([...this.savedServers(), ...this.discovery.servers]));
    return this.summary();
  }

  async discover(): Promise<LocalMcpSummary> {
    const explicit = mergeServerConfigs([...this.savedServers(), ...this.discovery.servers]);
    const candidates = new Map(explicit.map((server) => [server.endpoint, server]));
    if (this.discovery.autoDiscover) {
      const ports = parsePortSpec(this.discovery.portSpec || DEFAULT_PORT_SPEC);
      for (const host of this.discovery.hosts) {
        const openPorts = await scanOpenPorts(host, ports, this.discovery.scanConcurrency, this.discovery.connectTimeoutMs);
        for (const port of openPorts) {
          for (const mcpPath of this.discovery.paths) {
            const endpoint = validateEndpoint(`http://${urlHost(host)}:${port}${mcpPath}`);
            if (!candidates.has(endpoint)) candidates.set(endpoint, { endpoint });
          }
        }
      }
    }
    await this.replaceServers([...candidates.values()]);
    this.lastDiscoveryAt = new Date().toISOString();
    this.persist(mergeServerConfigs([...explicit, ...this.servers.map((server) => server.config)]));
    const summary = this.summary();
    this.logger.info("Local MCP discovery completed", { serverCount: summary.serverCount, toolCount: summary.toolCount });
    return summary;
  }

  getServer(id: string): LocalMcpSummary["servers"][number] | undefined {
    const server = this.servers.find((candidate) => candidate.id === id);
    if (!server) return undefined;
    return {
      id: server.id,
      name: server.name,
      endpoint: server.endpoint,
      toolCount: server.tools.length,
    };
  }

  async listTools(serverId: string): Promise<LocalTool[]> {
    const server = this.servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new Error(`Unknown local MCP server: ${serverId}`);
    server.tools = await readAllTools(server.client);
    return server.tools.map((tool) => ({ ...tool }));
  }

  async callTool(serverId: string, name: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const server = this.servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new Error(`Unknown local MCP server: ${serverId}`);
    const tool = server.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown tool for local MCP server ${serverId}: ${name}`);
    try {
      const result: unknown = await server.client.callTool({ name: tool.name, arguments: args ?? {} });
      const imageBlocks = await imageBlocksFromArtifacts(result, server.config.imageArtifactPathMappings ?? []);
      if (imageBlocks.length > 0 && isRecord(result) && Array.isArray(result.content)) {
        return { ...result, content: [...result.content, ...imageBlocks] };
      }
      return result;
    } catch (error) {
      this.logger.warn("Local MCP tool call failed", {
        name,
        endpoint: server.endpoint,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  summary(): LocalMcpSummary {
    return {
      serverCount: this.servers.length,
      toolCount: this.servers.reduce((count, server) => count + server.tools.length, 0),
      lastDiscoveryAt: this.lastDiscoveryAt,
      servers: this.servers.map((server) => ({
        id: server.id,
        name: server.name,
        endpoint: server.endpoint,
        toolCount: server.tools.length,
      })),
    };
  }

  async close(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    await Promise.all(servers.map((server) => server.client.close().catch(() => undefined)));
  }
}
