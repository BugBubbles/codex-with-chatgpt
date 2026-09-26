# Codex with ChatGPT — local-mcp branch

This branch turns the existing OAuth, pairing and Cloudflare tunnel into a **local Streamable HTTP MCP aggregator**.

During `c2c setup`, the bridge scans loopback listening ports, connects to usable Streamable HTTP MCP endpoints, reads each server's `tools/list`, and exposes the discovered tools remotely. Ports and tool names are not hard-coded.

By default discovery scans `127.0.0.1`, ports `1-65535`, and path `/mcp`. Optional environment variables can narrow the scan or add explicit loopback endpoints with arbitrary ports and paths:

- `C2C_LOCAL_MCP_ENDPOINTS`
- `C2C_LOCAL_MCP_HOSTS`
- `C2C_LOCAL_MCP_PORTS`
- `C2C_LOCAL_MCP_PATHS`
- `C2C_LOCAL_MCP_SCAN_CONCURRENCY`
- `C2C_LOCAL_MCP_CONNECT_TIMEOUT_MS`
- `C2C_LOCAL_MCP_PROBE_TIMEOUT_MS`
- `C2C_LOCAL_MCP_PROBE_CONCURRENCY`

Unique upstream tool names are preserved. Duplicate names are automatically aliased by source so no tool is silently dropped.

The public bridge exposes tools only: initialize, ping, `tools/list`, `tools/call`, and required notifications. OAuth bearer tokens are never forwarded upstream, and automatic discovery remains limited to loopback addresses.

Usage:

```bash
git checkout local-mcp
corepack pnpm install
corepack pnpm build
c2c setup -w <local-directory-used-for-connection-state>
```

Re-run `c2c setup` whenever local MCP servers change to rescan and refresh the aggregated tool set.
