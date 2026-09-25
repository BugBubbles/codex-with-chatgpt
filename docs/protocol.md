# MCP execution protocol — Python branch

The `python` branch uses MCP directly rather than dispatching work to local Codex.

## Recommended workflow

1. Inspect only the required files through `read_file`, `search_workspace`,
   `git_status`, and `git_diff`.
2. For a complete text replacement, call `python_write_file`.
3. For programmatic/multi-file edits or local scripts/tests, call `python_execute`
   with inline Python or a workspace-relative `.py` file.
4. Inspect the returned sanitized output and, when useful, `execution_output`.
5. Independently review `git_diff` and the relevant files.
6. Repeat only for concrete residual issues.

There is no `submit_codex_task`, `codex_task_status`, or
`cancel_codex_task` on this branch.

## python_execute contract

Exactly one of `code` and `path` must be supplied.

- `code`: inline Python source.
- `path`: workspace-relative `.py` file.
- `args`: optional strings exposed through `sys.argv`.
- `timeout_seconds`: 1–3600, default 120.

The result reports the execution id, mode, exit code, timeout status, duration, output id,
whether output is readable after sanitization, sanitized output when available, and the
current git-visible changed files.

Because Python is not OS-sandboxed, callers should use the smallest necessary program and
review the resulting diff after every modifying execution.
