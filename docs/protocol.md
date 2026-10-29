# Local MCP connector protocol

## Configure independent connectors

Run setup to discover the configured local MCP services and print one URL per service:

```text
c2c setup -w <workspace>
```

Add every service URL as its own OAuth connector in ChatGPT. Use the service name printed by setup as the suggested connector name. The same Bridge and tunnel serve all connectors on distinct `/mcp/<id>` paths.

## Authorize a service

When a service's OAuth page is open, generate its one-time pairing code:

```text
c2c pair -w <workspace> --server <id>
```

Enter the code in that service's authorization page. It cannot authorize another MCP path. Each service can have one active pairing code at a time, and codes for different services remain valid independently.

## Tool behavior

- Each connector's `tools/list` is refreshed from that MCP service whenever ChatGPT requests the tool list.
- Tool names, schemas, annotations, and write hints remain those supplied by the upstream service.
- `tools/call` forwards the selected original tool name and arguments only to the MCP service selected by the connector URL.
- MCP image blocks pass through; configured artifact path mappings can turn image artifacts into standard MCP image blocks.
- Resources, prompts, and other non-tool methods are not exposed.

Re-run setup after adding, removing, or reconfiguring local MCP services. If the public tunnel URL changes, doctor reports the affected connector URLs individually.
