# Architecture — Python branch

```text
ChatGPT Web
    |
    | OAuth-protected MCP
    v
C2C Bridge
    |-- workspace read/search/git tools
    |-- python_write_file
    |-- python_execute
    |-- execution records/output sanitizer
    |
    +--> connected workspace
    +--> local Python interpreter
```

## Principles

- ChatGPT performs reasoning and may author source directly through
  `python_write_file` or generate Python for `python_execute`.
- The bridge does not instantiate or launch a local Codex task manager on this branch.
- Workspace is still the authorization boundary for read tools and direct file writes.
- Python execution is separately authorized with `execution.write`.
- Python execution is direct host execution, not a filesystem/network sandbox.

## MCP lifecycle

A read call goes through tunnel → OAuth bearer validation → per-tool scope check →
workspace layer.

A Python write call goes through the same authorization path, then canonicalizes the
destination with `Workspace.resolve` and performs an atomic UTF-8 replacement.

A Python execution call validates that exactly one of inline `code` or workspace
`.py` `path` was provided, spawns Python directly with cwd set to the workspace,
captures stdout/stderr, enforces the timeout, stores sanitized output, and appends an
execution record. ChatGPT can then inspect `git_diff` independently.

## Components

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express assembly, loopback listener, OAuth/MCP/tunnel/admin wiring |
| `mcp/` | Read/status tools plus `python_write_file` and `python_execute` |
| `workspace/` | Path containment, sensitive-file policy, search and git views |
| `execution/python-runner.ts` | Direct Python process execution and atomic workspace text writes |
| `execution/output.ts` | Sanitized execution output store |
| `execution/records.ts` | Execution metadata history |
| `auth/` | OAuth, workspace-bound tokens and scopes |
| `tunnel/` | Cloudflare public transport |
