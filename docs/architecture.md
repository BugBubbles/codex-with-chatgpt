# Architecture — python branch

```text
ChatGPT Web
    |
    | OAuth-protected MCP
    v
C2C Bridge (normal user authority)
    |-- workspace read/search/git tools
    |-- python_write_file
    |-- conda_environments (read-only discovery)
    |-- execution records/output sanitizer
    |
    +-- python_execute(environment=id?)
           |
           | resolve id -> discovered Conda prefix/python (optional)
           | spawn selected python -I -S with reduced bootstrap env
           v
       Sandbox bootstrap
           |-- host/affinity-aware numeric thread plan
           |-- rlimit (UID task-count baseline)
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
           |-- selected Conda prefix: read-only
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
2. If `environment` is supplied, the bridge resolves only an exact id returned by read-only Conda discovery, rejects any prefix overlapping the workspace, and selects that environment's Python.
3. The bridge canonicalizes file targets through `Workspace.resolve`.
4. A private per-execution temp directory is created under the workspace.
5. Python starts with `-I -S`; inline source is sent over stdin and is not executed yet.
6. The bridge supplies the host logical/available CPU counts and a bounded numeric worker count; the bootstrap counts the current UID's Linux tasks, applies rlimits, then installs `no_new_privs`, Landlock and seccomp.
7. The bootstrap replaces its environment and narrows `sys.path`.
8. A JSON sandbox status is written to a dedicated inherited fd and that fd is closed.
9. Only then is the inline source compiled/executed or the workspace file run via `runpy`.
10. The Node parent enforces wall timeout and kills the process group if necessary.
11. The private temp directory is removed, output is sanitized/stored, and git-visible per-execution changes are computed by comparing pre/post dirty-path snapshots; untouched pre-existing dirty files are excluded.
12. `python_execute` returns the sandbox attestation alongside the normal execution result.

If sandbox setup fails, no user Python runs and the tool returns `PYTHON_SANDBOX_FAILED`.

## Components

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express assembly, loopback listener, OAuth/MCP/tunnel/admin wiring |
| `mcp/` | Read/status tools plus scoped Python write/execute surface |
| `workspace/` | Path containment, sensitive-file policy, search and git views |
| `workspace/text-file.ts` | Bounded sparse line indexes and byte-limited text pagination |
| `execution/conda-environments.ts` | Read-only Conda discovery and opaque environment ids |
| `execution/python-runner.ts` | Parent-side interpreter selection, process lifecycle, status handshake, timeout, cleanup and records |
| `execution/python-sandbox-script.ts` | Strict unprivileged Linux sandbox bootstrap |
| `execution/output.ts` | Sanitized execution output store |
| `execution/records.ts` | Execution metadata history |
| `auth/` | OAuth, workspace-bound tokens and scopes |
| `tunnel/` | Cloudflare public transport |

Text pagination builds an exact line count once per file version, then reads from sparse byte offsets. The in-memory cache holds at most 16 indexes with at most 32,768 offsets each; device/inode, size, mtime and ctime changes invalidate an index. Reads are bounded to the observed file size and retry once if the file changes. A line exceeding the response byte limit returns `FILE_TOO_LARGE`. Directory pagination counts all visible entries but fetches file sizes only for the returned page, with at most 16 concurrent requests.

Git commands and hardware probes run asynchronously. Paginated Git patches share a cache bounded to eight snapshots and 64 MiB, expire after 30 seconds, and are checked against the current Git inventory and filesystem metadata before reuse. Conda discovery caches its inventory for up to five seconds, invalidates it when discovery inputs or scanned directories change, and revalidates the selected prefix/interpreter on execution. Package metadata is invalidated by metadata-directory and Python-record changes. GPU probes coalesce concurrent requests and cache readings for five seconds (30 seconds when no GPU is found); CPU topology is cached for 60 seconds, while load, memory and storage are sampled for each request. Execution history reads backwards in 16 KiB blocks until enough valid records are found.

## Why not Bubblewrap here?

Bubblewrap normally depends on user-namespace/UID-map behavior that can be disabled by site policy even when `unprivileged_userns_clone` appears enabled. This branch instead uses Landlock and seccomp directly, both applied by the unprivileged child itself, so it does not require administrator installation or subordinate UID/GID mappings.
