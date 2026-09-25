# Architecture — python-sandbox branch

```text
ChatGPT Web
    |
    | OAuth-protected MCP
    v
C2C Bridge (normal user authority)
    |-- workspace read/search/git tools
    |-- python_write_file
    |-- execution records/output sanitizer
    |
    +-- python_execute
           |
           | spawn python -I -S with reduced bootstrap env
           v
       Sandbox bootstrap
           |-- rlimit
           |-- PR_SET_NO_NEW_PRIVS
           |-- Landlock ABI 4+ filesystem/TCP policy
           |-- seccomp syscall filter
           |-- environment scrub
           |-- verified fd-3 ready handshake
           v
       User Python
           |-- workspace: read/write
           |-- private temp: read/write
           |-- Python runtime paths: read-only
           |-- network: blocked
           |-- external exec: blocked
           +-- peer-process control: blocked
```

## Principles

- ChatGPT may author source directly through `python_write_file` or generate Python for `python_execute`.
- The bridge itself remains a normal local user process because it still needs OAuth/tunnel/workspace functionality.
- The untrusted execution boundary is the child Python process, not the bridge.
- Sandbox setup is fail-closed; there is no unsandboxed fallback.
- Kernel policy, rather than AST/import blacklists, is the security boundary.
- The connected workspace remains the writable trust boundary.

## Python execution lifecycle

1. MCP validates `execution.write` scope and exactly one of inline `code` or workspace `.py` `path`.
2. The bridge canonicalizes file targets through `Workspace.resolve`.
3. A private per-execution temp directory is created under the workspace.
4. Python starts with `-I -S`; inline source is sent over stdin and is not executed yet.
5. The bootstrap applies rlimits, `no_new_privs`, Landlock and seccomp.
6. The bootstrap replaces its environment and narrows `sys.path`.
7. A JSON sandbox status is written to a dedicated inherited fd and that fd is closed.
8. Only then is the inline source compiled/executed or the workspace file run via `runpy`.
9. The Node parent enforces wall timeout and kills the process group if necessary.
10. The private temp directory is removed, output is sanitized/stored, and git-visible changes are recorded.
11. `python_execute` returns the sandbox attestation alongside the normal execution result.

If step 4–7 fails, no user Python runs and the tool returns `PYTHON_SANDBOX_FAILED`.

## Components

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express assembly, loopback listener, OAuth/MCP/tunnel/admin wiring |
| `mcp/` | Read/status tools plus scoped Python write/execute surface |
| `workspace/` | Path containment, sensitive-file policy, search and git views |
| `execution/python-runner.ts` | Parent-side process lifecycle, status handshake, timeout, cleanup and records |
| `execution/python-sandbox-script.ts` | Strict unprivileged Linux sandbox bootstrap |
| `execution/output.ts` | Sanitized execution output store |
| `execution/records.ts` | Execution metadata history |
| `auth/` | OAuth, workspace-bound tokens and scopes |
| `tunnel/` | Cloudflare public transport |

## Why not Bubblewrap here?

Bubblewrap normally depends on user-namespace/UID-map behavior that can be disabled by site policy even when `unprivileged_userns_clone` appears enabled. This branch instead uses Landlock and seccomp directly, both applied by the unprivileged child itself, so it does not require administrator installation or subordinate UID/GID mappings.
