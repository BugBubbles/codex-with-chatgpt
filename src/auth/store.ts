import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export const SUPPORTED_SCOPES = [
  "mcp.tools",
  "offline_access",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  resource?: string;
  issuedAt: number;
  /** null means the token remains valid until explicitly revoked. */
  expiresAt: number | null;
  revoked: boolean;
}

interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function isUnexpired(token: TokenRecord, now: number): boolean {
  return token.expiresAt === null || token.expiresAt > now;
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string; accessTokenTtlMs?: number | null } = {}
  ) {
    this.accessTokenTtlMs = opts.accessTokenTtlMs ?? null;
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  /**
   * Access tokens are non-expiring by default so OAuth authorization lasts as
   * long as the service-specific public URL remains unchanged. Set a finite
   * value only for deployments that require periodic reauthorization.
   */
  private readonly accessTokenTtlMs: number | null;

  private load(): void {
    const data = readJsonIfExists<PersistedAuthState>(this.file);
    if (!data) return;
    const now = Date.now();
    for (const client of data.clients ?? []) this.clients.set(client.clientId, client);
    for (const token of data.tokens ?? []) {
      if (!token.revoked && isUnexpired(token, now)) this.tokens.set(token.hash, token);
    }
  }

  private save(): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && isUnexpired(t, now)),
    };
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    resource?: string;
    accessTtlMs?: number | null;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number | null; scopes: string[] } {
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs === undefined ? this.accessTokenTtlMs : input.accessTtlMs;

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      workspaceId,
      scopes: input.scopes,
      ...(input.resource ? { resource: input.resource } : {}),
      issuedAt: now,
      expiresAt: accessTtl === null ? null : now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        ...(input.resource ? { resource: input.resource } : {}),
        issuedAt: now,
        expiresAt: accessTtl === null ? null : now + accessTtl,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: accessTtl === null ? null : Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (record.expiresAt !== null && Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (record.expiresAt !== null && Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
      resource: record.resource,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size;
    this.tokens.clear();
    this.authCodes.clear();
    this.save();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size;
  }

  static deleteStateFile(workspaceId: string): void {
    const file = path.join(getStateDir(), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(requested: string | undefined): string[] {
  if (!requested || requested.trim() === "") return [...SUPPORTED_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  return asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope));
}
