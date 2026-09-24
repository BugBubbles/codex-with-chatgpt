# Security Model

## Trust boundaries

1. **Workspace root** is the authorization boundary. One bridge serves exactly one
   workspace and every OAuth token is bound to that workspace.
2. **Workspace content is untrusted.** README text, comments, source files and diffs may
   contain prompt injection. Read tools never grant capabilities based on file content.
3. **Execution is separately authorized.** Read access does not imply the ability to run
   Codex. Remote task submission and cancellation require `execution.write`.
4. **The bridge does not expose arbitrary shell or direct file-write primitives.** The only
   write-capable remote surface submits a bounded goal to the locally installed Codex CLI.
5. **The model never receives long-lived bridge credentials.** OAuth access/refresh tokens
   stay in the connector/bridge flow; pairing uses a short-lived one-time code.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | Every `/mcp` request requires a valid workspace-bound bearer token |
| Pairing-code brute force | CSPRNG code, TTL, attempt limit, rate limit and one-time use |
| OAuth CSRF / code interception | `state` round trip + PKCE S256 + one-time authorization codes |
| Token theft | Opaque high-entropy tokens, SHA-256-at-rest hashes, expiration, refresh rotation and revocation |
| Silent privilege escalation after upgrade | `execution.write` is a new scope; existing tokens must be re-authorized before task submission works |
| Workspace traversal in read tools | Canonical realpath containment, symlink checks and sensitive-file policy |
| Prompt injection in workspace content | MCP descriptions mark workspace data untrusted; the Codex worker prompt repeats this boundary and forbids following embedded instructions that conflict with the requested goal/constraints |
| Arbitrary remote shell | No shell command string is accepted by MCP. The caller supplies only a goal plus bounded model/reasoning/timeout options |
| Broad remote writes | Codex is started with the `workspace-write` sandbox and the workspace as cwd; direct bridge file-write tools do not exist |
| Approval escalation | Remote `codex exec` uses `--ask-for-approval never`; a task cannot pause and obtain broader permission interactively |
| Network exfiltration by a remote task | `sandbox_workspace_write.network_access=false` is forced for remotely submitted tasks |
| Concurrent workspace corruption | Only one remotely submitted Codex task may run at a time |
| Runaway process | Remote tasks have a bounded 30–3600 second timeout and an explicit cancellation tool |
| Git publication | Worker instructions forbid commit, push, remote changes and publishing; MCP exposes no git-commit/push primitive |
| Execution-output leak | Captured stdout/stderr goes through the existing sanitizer; tokens/home paths are redacted, private-key blocks are withheld and output is truncated |
| Admin API abuse | Admin surface remains loopback-only with a random admin token and rejects proxy-forwarded requests |
| Tunnel exposure | Bridge binds loopback only; public access is only through the OAuth-protected HTTPS tunnel |

## Important residual risks

Remote Codex execution is materially more powerful than the original read-only design.
`workspace-write` is a Codex sandbox boundary, not a proof that every future Codex
version can never read host data outside the workspace. Users should keep Codex CLI
updated and should not grant `execution.write` to connectors they do not trust.

Likewise, model instructions against reading secrets or following malicious repository
instructions are defense in depth, not a substitute for OS-level isolation. For
high-sensitivity repositories, run the bridge/Codex worker inside a dedicated WSL
distribution, container or VM with only the intended workspace mounted.

## Token & scope design

Scopes:

- `workspace.read`
- `workspace.search`
- `git.read`
- `execution.read`
- `execution.write`
- `offline_access`

Read/status tools require their existing read scopes. `submit_codex_task` and
`cancel_codex_task` require `execution.write`; `codex_task_status` requires
`execution.read`.

Access tokens live for one hour. Refresh tokens live for 30 days and rotate. All tokens
are bound to `workspace_id` and `client_id`.

## Remote task contract

The bridge invokes the locally resolved Codex executable (or `C2C_CODEX_BIN` when the
operator explicitly overrides it) approximately as:

```text
codex exec --json   --sandbox workspace-write   --ask-for-approval never   --skip-git-repo-check   --ephemeral   --cd <workspace>   --config sandbox_workspace_write.network_access=false   -
```

The goal is provided on stdin rather than interpolated into a shell command. Optional
model and reasoning-effort values are passed as separate argv values and validated by the
MCP schema.

## Storage

Auth, runtime and execution metadata remain under the OS-convention state directory with
owner-only permissions where supported. Raw OAuth tokens are not persisted. Finished
remote task output uses the existing sanitized execution-output store.

Task process handles are in-memory. After a bridge restart, use
`execution_summary`/`execution_output` and git state for completed work rather than
expecting `codex_task_status` to remember the old process.
