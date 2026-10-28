import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export const CHATGPT_DEVELOPER_MODE_URL = "https://chatgpt.com/#settings/Security";
export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";

export interface ConnectorEndpoint {
  id: string;
  name: string;
  mcpUrl: string;
  connectorName: string;
}

export interface LastEndpoint {
  workspaceId: string;
  port: number;
  publicUrl: string | null;
  /** Legacy single-aggregator URL retained only to guide one-time migration. */
  mcpUrl?: string | null;
  connectorName?: string;
  connectors?: ConnectorEndpoint[];
  legacyAggregate?: { mcpUrl: string; connectorName?: string };
  savedAt: string;
}

export function endpointFile(workspaceId: string): string {
  return path.join(getStateDir(), "endpoints", `${workspaceId}.json`);
}

export function readLastEndpoint(workspaceId: string): LastEndpoint | null {
  return readJsonIfExists<LastEndpoint>(endpointFile(workspaceId));
}

export function writeLastEndpoint(endpoint: Omit<LastEndpoint, "savedAt">): LastEndpoint {
  const saved: LastEndpoint = { ...endpoint, savedAt: new Date().toISOString() };
  writeSecureJson(endpointFile(saved.workspaceId), saved);
  return saved;
}

export function normalizePublicUrl(url: string): string {
  const parsed = new URL(url.trim());
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
}

export function mcpUrlForServer(publicUrl: string | null | undefined, serverId: string): string | null {
  if (!publicUrl) return null;
  const base = new URL(publicUrl.trim());
  base.hash = "";
  base.search = "";
  const pathname = base.pathname.replace(/\/+$/, "");
  return `${base.origin}${pathname}/mcp/${encodeURIComponent(serverId)}`;
}

/** Classifies whether one service-specific connector URL must be created or updated. */
export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined
): "none" | "create" | "update" {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl) ? "none" : "update";
}

export function connectorNameForServer(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 40) || "local-mcp";
}
