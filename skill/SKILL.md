# Codex with ChatGPT — local MCP connectors

Use this skill to configure and troubleshoot the local Streamable HTTP MCP services exposed by the C2C Bridge.

## Connector model

- One configured local MCP service maps to one ChatGPT OAuth connector.
- All services share one Bridge and tunnel, but have distinct URLs: `<base>/mcp/<id>`.
- Each connector lists and calls tools from only its selected MCP service. Tool names are returned exactly as supplied by the upstream MCP, without prefixes or rewriting; calls forward the same original name. Schemas, annotations, write hints, and results also come from that service.
- OAuth tokens and pairing codes are restricted to one service ID.
- The old combined `/mcp` connector is retired. Do not recreate or recommend it.

## Security

- Never expose local Bearer tokens, OAuth tokens, or other long-lived credentials.
- Generate a one-time pairing code only after the matching service's ChatGPT authorization page is open.
- Do not call write or destructive tools unless the user asked for that action.
- Do not assume a tool exists. Inspect the selected connector's current tool list first.
- Never automate the user's ChatGPT Web interface; guide them through normal browser steps.

## First setup

Run:

```text
c2c setup -w <workspace> --tunnel --json
```

The result contains a `connectors` array. For each entry:

1. In ChatGPT Developer Mode, create a separate connector using its `connectorName`, `mcpUrl`, and OAuth authentication.
2. When that connector's authorization page is open, run:

   ```text
   c2c pair -w <workspace> --server <id> --json
   ```

3. Enter the returned one-time code on that page, then repeat for the next service.

Use one connector per entry. Do not combine multiple service URLs or tool lists. After the individual connectors are configured, delete the old aggregate connector if one exists.

If a service has no explicit `name`, setup derives a stable ID from its local endpoint and includes that ID in the result.

## Verify a connector

Select the connector matching the requested function. Inspect its tools and descriptions. For a harmless verification, use a read-only tool supplied by that MCP service and report the result. Do not use a write tool merely to test connectivity.

Image blocks and configured image artifacts are returned by that service's connector. Write tools, when present, are forwarded to the same local service.

## Troubleshooting

Before changing tunnel or authorization state, run:

```text
c2c doctor -w <workspace> --json
```

If `chatgptRepair.connectors` contains an `update`, delete and recreate only that service's connector with the reported URL. If it contains a `create`, add that service as a new connector. For entries in `staleConnectors`, delete the corresponding ChatGPT connector. If `legacyAggregate` is present, delete that retired aggregate connector.

After opening an affected connector's authorization page, generate its service-bound code:

```text
c2c pair -w <workspace> --server <id> --json
```

Never use Reconnect for a replaced temporary URL. Re-run doctor after the user finishes the browser steps. Doctor verifies local Bridge, MCP, OAuth, and tunnel reachability; it cannot verify that a connector was created or authorized in ChatGPT.

## Useful commands

```text
c2c status -w <workspace> --json
c2c setup -w <workspace> --tunnel --json
c2c pair -w <workspace> --server <id> --json
c2c doctor -w <workspace> --json
```
