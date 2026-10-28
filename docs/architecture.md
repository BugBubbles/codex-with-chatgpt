# Architecture — local MCP connectors

```text
ChatGPT connector A                       ChatGPT connector B
        |                                          |
        | /mcp/<service-id>                       | /mcp/<service-id>
        +--------------------+---------------------+
                             |
                   shared OAuth + tunnel
                             |
                    C2C local MCP Bridge
                    |-- OAuth resource metadata per service
                    |-- token audience per service
                    |-- one-time pairing code per service
                    |-- tools/list and tools/call proxy
                       |                       |
               local MCP server A       local MCP server B
```

## Principles

- One connected local MCP server maps to one ChatGPT connector URL.
- The bridge does not aggregate tool lists. Each resource forwards only the named server's original tool definitions and calls.
- A server's configured `name` becomes its connector ID. Unnamed servers receive a stable ID derived from their loopback endpoint.
- The same tunnel can serve multiple connectors through separate `/mcp/<id>` paths.
- OAuth tokens and one-time pairing codes are bound to one MCP service. A token issued for one path cannot call another path.
- The upstream service controls its tool schemas and behavior. The bridge forwards read and write tools without maintaining a separate fixed tool list.
- Existing image blocks pass through. Configured image artifact path mappings are resolved locally and returned as standard MCP image blocks.

## Request flow

1. Setup discovers local Streamable HTTP MCP services and reads each service's full paginated `tools/list` result for status.
2. Setup prints one connector URL per service.
3. The client discovers service-specific protected-resource metadata and the shared OAuth authorization server.
4. The user creates a one-time code for the selected service with `c2c pair --server <id>`.
5. OAuth authorization binds the token to the selected `/mcp/<id>` resource.
6. Each `tools/list` request fetches the selected service's current tool definitions. `tools/call` forwards the original tool name and arguments to that service.

## Security boundaries

- Local endpoints must use loopback HTTP. Discovery cannot target arbitrary internal or public hosts.
- A local service's Bearer token is read from an environment variable and used only for its upstream connection.
- The public OAuth token is never forwarded to an upstream service.
- Admin endpoints are loopback-only and require the bridge's admin token.
- The old combined `/mcp` resource is not mounted.

## Components

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express assembly, OAuth, per-service MCP routes, tunnel and admin wiring |
| `mcp/local-registry.ts` | Local service discovery, tool snapshots, stable connector IDs and upstream routing |
| `mcp/local-http.ts` | Tools-only MCP HTTP surface for one selected local service |
| `auth/` | OAuth, service-bound tokens and token checks |
| `pairing/` | One-time codes bound to one local service |
| `tunnel/` | Shared Cloudflare public transport |
