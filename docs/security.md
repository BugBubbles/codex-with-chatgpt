# Security Model

## Trust boundaries

1. **Workspace root** is the authorization boundary. One bridge serves exactly one
   workspace and every OAuth token is bound to that workspace.
2. **Workspace content is untrusted.** README text, comments, source files and diffs may
   contain prompt injection. Read tools never grant capabilities based on file content.
3. **Execution is separately authorized.** Read access does not imply the ability to run
   Codex. Remote task submission and cancellation require `execution.write`.
4. **The bridge does not expose arbitrary shell or direct file-write primitives.** The only
   write-capable remote surface submits a structured execution brief to the locally installed
   Codex CLI.
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
| Arbitrary remote shell | No shell command string is accepted by MCP. The caller supplies a structured implementation brief plus bounded model/reasoning/timeout options |
| Broad remote writes | Initial Codex runs use the `workspace-write` sandbox and the workspace as cwd; resumed turns explicitly reapply `sandbox_mode="workspace-write"`; direct bridge file-write tools do not exist |
| Silent Codex context loss | The bridge persists the first `thread.started.thread_id`, resumes that exact thread on later tasks, and fails closed if a resume reports a different thread id |
| Approval escalation | Remote `codex exec` uses `--config approval_policy="never"`; a task cannot pause and obtain broader permission interactively |
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
operator explicitly overrides it). The first remote turn creates a normal saved Codex
thread:

```text
codex exec --json \
  --sandbox workspace-write \
  --config approval_policy="never" \
  --skip-git-repo-check \
  --cd <workspace> \
  --config sandbox_workspace_write.network_access=false \
  -
```

The bridge captures `thread.started.thread_id` immediately and stores it under the local
C2C state directory. Later remote turns resume that exact thread:

```text
codex exec resume <thread_id> --json \
  --config approval_policy="never" \
  --skip-git-repo-check \
  --config sandbox_mode="workspace-write" \
  --config sandbox_workspace_write.network_access=false \
  -
```

Direct-mode tasks deliberately do **not** use `--ephemeral`. If a resume reports a
different `thread.started.thread_id`, the bridge treats that as context loss, clears the
stale session record and fails the task so partial edits can be reviewed.

The structured execution brief is rendered as a detailed Markdown implementation document
and provided on stdin rather than interpolated into a shell command. Optional model and
reasoning-effort values are passed as separate argv values and validated by the MCP schema.

## Storage

Auth, runtime and execution metadata remain under the OS-convention state directory with
owner-only permissions where supported. Raw OAuth tokens are not persisted. Finished
remote task output uses the existing sanitized execution-output store.

Task process handles are in-memory. The persistent Codex thread id is stored separately
per workspace so future tasks can resume the same Codex conversation even after a bridge
restart. After a restart, `codex_task_status` still does not remember an old process;
use `execution_summary`/`execution_output` and git state to review completed work.
