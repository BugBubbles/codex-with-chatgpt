# Codex with ChatGPT — Python executor branch

> ChatGPT reasons and writes Python; the local bridge executes it directly.

The `python` branch is derived from `main` but removes the MCP path that launches
local Codex. It keeps the workspace/OAuth/tunnel/read tooling and replaces the Codex
task-control surface with direct Python authoring and execution.

## MCP tools

Read/status tools remain available:

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`
- `execution_output`

Write/execute tools, gated by the existing `execution.write` OAuth scope:

- `python_write_file(path, content)` — atomically create or fully replace one UTF-8
  text file inside the workspace, with the same canonical-path/sensitive-file checks
  used by the read layer.
- `python_execute(code | path, args?, timeout_seconds?)` — run inline Python or one
  workspace-relative `.py` file directly with the workspace as cwd. Output is
  sanitized and recorded through `execution_output`; git-visible changes are recorded
  in `execution_summary`.

The branch does **not** expose `submit_codex_task`, `codex_task_status`, or
`cancel_codex_task`, and the bridge does not instantiate a local Codex task manager.

## Requirements

- Node.js >= 20
- Python 3
- git
- `cloudflared` when using a public ChatGPT connector

The Python interpreter defaults to `python3` on Linux/macOS and `python` on Windows.
Set `C2C_PYTHON_BIN=/absolute/path/to/python` before starting the bridge to override it.

## Install

```bash
git clone https://github.com/BugBubbles/codex-with-chatgpt.git
cd codex-with-chatgpt
git checkout python
corepack pnpm install
corepack pnpm build
```

Then start the bridge for the workspace as usual:

```bash
c2c start -w <workspace> --tunnel
```

Existing connectors must be authorized for `execution.write` before they can use the
Python write/execute tools.

## Execution model and security

`python_write_file` is workspace-bounded: paths are canonicalized, symlink escapes are
rejected, sensitive-file rules are applied, and writes are atomic.

`python_execute` is intentionally different: it is **direct local Python execution, not
an OS sandbox**. The bridge fixes cwd to the workspace, passes a reduced environment,
applies a 1–3600 second timeout, captures output through the existing sanitizer, and
records git-visible changes. But Python code still runs with the operating-system
permissions of the bridge user and can access resources outside the workspace if the
code explicitly does so.

Only use this branch with a connector you trust. For stronger isolation, run the bridge
inside a dedicated container/VM/WSL environment that exposes only the intended project.

## Development

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

See [docs/security.md](docs/security.md) and [docs/architecture.md](docs/architecture.md).
