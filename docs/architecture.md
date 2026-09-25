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
          read-only │        │ coherent brief dispatch
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
- **ChatGPT Web remains the planning brain**: root-cause analysis, log/data analysis,
  architecture decisions and the detailed implementation plan are completed before dispatch.
- **Codex remains the execution harness**: structured implementation briefs run through
  non-interactive `codex exec`, not bridge-implemented editing primitives. A persistent
  Codex thread is reused across batches.
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
| `execution/codex-tasks.ts` | One-at-a-time local `codex exec` dispatch, persistent thread/resume state, polling metadata, timeout, cancellation and result recording |
| `execution/` | Execution records plus sanitized command/Codex output |
| `tunnel/` | Cloudflare Quick/Named tunnel implementations |
| `process/` | Bridge daemon spawn/reuse, health probing and shutdown |
| `cli/` | `c2c` commands used by the Skill |
| `config/`, `logger/` | OS-convention state directory and secret-redacting logs |

## MCP request lifecycle

**Read call**: ChatGPT → tunnel (HTTPS) → bridge `/mcp` → bearer middleware →
tool scope check → workspace layer → JSON result.

**Task submit**: ChatGPT first inspects the relevant workspace evidence and produces one
structured execution brief for the complete coherent goal. The call then flows through
`submit_codex_task` → `execution.write` scope check → CodexTaskManager.

For the first batch, CodexTaskManager starts local `codex exec` with the
`workspace-write` sandbox, approval policy `never`, the workspace as cwd and network
access disabled. It captures `thread.started.thread_id` and persists it per workspace.
Later batches use `codex exec resume <thread_id>` and explicitly reapply
`sandbox_mode="workspace-write"` plus network denial. The formatted implementation brief
is sent over stdin; the bridge never accepts a caller-supplied shell command.

**Task progress**: task snapshots expose `pollIntervalSeconds` and `nextPollAt`.
The default interval is 180 seconds and can be configured in `.c2c.json` (30–3600
seconds). The web planner should not busy-poll while the local executor is working.

**Task completion**: Codex stdout/stderr → existing local sanitizer → execution output
record; git status is recorded as execution metadata. ChatGPT then independently checks
`execution_output`, `git_diff` and relevant files against the complete success criteria.

Only one remotely submitted task may run at a time. The MCP submission default is a
60-minute timeout and callers may request 30–3600 seconds.

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
