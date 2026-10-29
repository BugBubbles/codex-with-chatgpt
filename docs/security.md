# Security model — per-service MCP connectors

## Trust boundaries

1. The public bridge accepts OAuth access tokens bound to its workspace.
2. Each token also carries exactly one MCP resource URI, such as `/mcp/llm-for-zotero`.
3. A service route accepts only a token whose resource matches that route.
4. Each one-time pairing code is bound to one service ID and is consumed on use.
5. Upstream local MCP services are trusted to implement their own tool permissions, including write or destructive operations.

New access and refresh tokens have no time-based expiry. They remain usable
for the exact service resource until the token is revoked, `c2c unpair` runs,
or the service URL changes. This keeps authorization from expiring while a
temporary tunnel URL remains stable; it also means a long-lived token should
be revoked when access is no longer wanted.

## Local upstream connections

- Configured endpoints must use HTTP on loopback and cannot include credentials in the URL.
- Automatic discovery scans only loopback hosts.
- A configured `bearerTokenEnv` stores the environment variable name, not the token. The upstream token is attached only to that server's local MCP connection.
- The OAuth token used between ChatGPT and the Bridge is not forwarded upstream.
- Each public connector exposes only `initialize`, `ping`, `tools/list`, `tools/call`, and required notifications for its selected service.
- Resources and prompts are not proxied.

## Images and writes

Tool definitions and write annotations come from the upstream MCP server. Calls are sent only to that service and their results are returned through the same connector. Existing image blocks pass through. Artifact files are read only from explicitly mapped local directories, with path containment and size checks.

## Tunnel and admin surface

The Bridge listens on loopback. The shared Cloudflare tunnel forwards service-specific MCP paths and the OAuth endpoints. Admin routes require a random token and reject requests that arrived through a proxy.

The former aggregate `/mcp` resource is not available. The separate service paths are the only public MCP resources.
