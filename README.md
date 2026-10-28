# Codex with ChatGPT — local-mcp branch

This branch provides one independent ChatGPT MCP connector for each local Streamable HTTP MCP server. It does not combine tools into one connector or add C2C-owned workspace, Git, Python, or execution tools.

During `c2c setup`, the bridge discovers loopback MCP servers and prints one URL per server, such as `https://<tunnel>/mcp/llm-for-zotero`. Each connector fetches that server's current `tools/list`, preserving its original tool names and schemas. Servers without a configured `name` get a stable ID derived from their endpoint.

Add each printed URL as a separate OAuth connector in ChatGPT. When an authorization page is open, generate a one-time code for that service:

```bash
c2c pair --server <id>
```

The code and OAuth token are restricted to that one MCP service. Pair services one at a time. The old combined `/mcp` connector is no longer served and should be removed after adding the individual connectors.

By default discovery scans `127.0.0.1`, ports `1-65535`, and path `/mcp`. Optional environment variables can narrow the scan or configure named loopback endpoints:

- `C2C_LOCAL_MCP_ENDPOINTS`
- `C2C_LOCAL_MCP_HOSTS`
- `C2C_LOCAL_MCP_PORTS`
- `C2C_LOCAL_MCP_PATHS`
- `C2C_LOCAL_MCP_SCAN_CONCURRENCY`
- `C2C_LOCAL_MCP_CONNECT_TIMEOUT_MS`
- `C2C_LOCAL_MCP_PROBE_TIMEOUT_MS`
- `C2C_LOCAL_MCP_PROBE_CONCURRENCY`
- `C2C_LOCAL_MCP_SERVERS`

Named server configuration supports a Bearer-token environment variable and explicit image-artifact path mappings. Upstream tool calls and results, including write tools and image blocks, are forwarded through that service's connector.

Usage:

```bash
git checkout local-mcp
corepack pnpm install
corepack pnpm build
c2c setup -w <local-directory-used-for-connection-state>
```

Re-run `c2c setup` when local MCP services are added or removed. Each connector refreshes its tool definitions from its upstream server when ChatGPT requests `tools/list`.
