# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
            MCP data +  │          │ manual C2C fallback
          task control  │          │
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP Server         │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Codex Task Manager │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────┬────────┬─────┘
                    │        │
          read-only │        │ bounded task dispatch
                    ▼        ▼
             ┌───────────┐  ┌──────────────┐
             │ Workspace │◀─│ Codex CLI    │
             └───────────┘  │ exec/edit/test│
                            └──────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge does not expose a generic remote shell.
- **MCP data plane**: ChatGPT reads files, diffs, search results and sanitized execution output.
- **MCP control plane**: a separately authorized `execution.write` scope permits only
  `submit_codex_task`, `codex_task_status` and `cancel_codex_task`.
- **Codex remains the execution harness**: submitted goals run through non-interactive
  `codex exec`, not bridge-implemented editing primitives.
- **Manual browser handoff remains a fallback** for old connectors and recovery.
- **Workspace is the authorization boundary**: one bridge = one workspace = one token audience.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | MCP tools: nine read/data tools plus three scoped Codex task-control tools |
| `auth/` | OAuth 2.1 authorization server, PKCE, dynamic registration, refresh rotation and per-tool scopes |
| `pairing/` | Pairing-code lifecycle: CSPRNG generation, TTL, attempt limits and one-time use |
| `workspace/` | Canonical-path containment, sensitive-file policy, paginated read/list, search and git status/diff |
| `execution/codex-tasks.ts` | One-at-a-time local `codex exec` task dispatch, timeout, cancellation and result recording |
| `execution/` | Execution records plus sanitized command/Codex output |
| `tunnel/` | Cloudflare Quick/Named tunnel implementations |
| `process/` | Bridge daemon spawn/reuse, health probing and shutdown |
| `cli/` | `c2c` commands used by the Skill |
| `config/`, `logger/` | OS-convention state directory and secret-redacting logs |

## MCP request lifecycle

**Read call**: ChatGPT → tunnel (HTTPS) → bridge `/mcp` → bearer middleware →
tool scope check → workspace layer → JSON result.

**Task submit**: ChatGPT → `submit_codex_task` → `execution.write` scope check →
CodexTaskManager → local `codex exec --sandbox workspace-write --ask-for-approval never`
with the workspace as cwd. Network access is disabled for the spawned task. The prompt is
sent over stdin; the bridge never accepts a caller-supplied shell command.

**Task completion**: Codex stdout/stderr → existing local sanitizer → execution output
record; git status is recorded as execution metadata. ChatGPT then independently checks
`codex_task_status`, `execution_output` and `git_diff`.

Only one remotely submitted task may run at a time. Remote tasks default to a 30-minute
timeout and MCP callers may request 30–3600 seconds.

## Authorization

OAuth discovery advertises separate scopes for read/search/git/execution-read and
`execution.write`. Existing connector tokens do not gain the new capability silently;
the connector must be re-authorized to receive the scope.

Authorization still uses PKCE S256, one-time pairing codes and workspace-bound opaque
tokens.

## Ports and tunnel

The bridge prefers port 48765 and binds loopback only. On conflict it reuses the same
workspace bridge when possible or falls back to an ephemeral port.

Cloudflare Quick Tunnel remains the default public transport. A workspace can instead use
a Named Tunnel for a stable hostname. The public surface is HTTPS + OAuth; the admin API
stays loopback-only.
