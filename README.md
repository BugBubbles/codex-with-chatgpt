# Codex with ChatGPT — strict Python sandbox branch

> ChatGPT reasons and writes Python; the local bridge executes it inside a fail-closed Linux sandbox.

The `python-sandbox` branch is derived from `python`. It keeps the workspace/OAuth/tunnel/read tooling and direct Python authoring surface, but replaces host-permission Python execution with a strict non-root sandbox based on Linux Landlock, seccomp, `no_new_privs`, resource limits, and a scrubbed environment.

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
- `conda_environments` — read-only discovery of installed Conda environments and their Python/package metadata; it never invokes Conda or mutates an environment.

Write/execute tools, gated by the existing `execution.write` OAuth scope:

- `python_write_file(path, content)` — atomically create or fully replace one UTF-8 text file inside the workspace, retaining canonical-path, symlink-escape and sensitive-file checks.
- `python_execute(code | path, args?, environment?, timeout_seconds?)` — run inline Python or one workspace-relative `.py` file only after the strict sandbox handshake succeeds. `environment` must be an exact id returned by `conda_environments`.

The branch does **not** expose `submit_codex_task`, `codex_task_status`, or `cancel_codex_task`.

## Requirements

- Linux x86_64
- Linux kernel with Landlock ABI 4 or newer
- Node.js >= 20
- Python 3
- git
- `cloudflared` when using a public ChatGPT connector

No root access, Bubblewrap installation, container runtime, or `/etc/subuid` configuration is required.

The Python interpreter defaults to `python3`. Set `C2C_PYTHON_BIN=/absolute/path/to/python` before starting the bridge to use another default interpreter. Conda switching does not run `conda activate`: the bridge discovers registered/local environments read-only, then directly starts the selected environment's Python. Optional `C2C_CONDA_ROOTS` (path-delimited) adds operator-approved roots to discovery.

## Install

```bash
git clone https://github.com/BugBubbles/codex-with-chatgpt.git
cd codex-with-chatgpt
git checkout python-sandbox
corepack pnpm install
corepack pnpm build
c2c start -w <workspace> --tunnel
```

Existing connectors must be authorized for `execution.write` before they can use the Python write/execute tools.

## Sandbox guarantees

The bootstrap itself starts with `python -I -S`, so user/workspace startup hooks do not run before isolation is installed. User code starts only after all of the following succeed:

- `PR_SET_NO_NEW_PRIVS`.
- Landlock ABI >= 4 rules that make the workspace and one private temp directory read/write, make Python runtime/library paths read-only, deny executable access, and deny TCP bind/connect.
- A seccomp filter that denies socket APIs, external process signalling, namespace/mount/kernel-management APIs, IPC families, selected metadata syscalls not covered by Landlock ABI 4, and anonymous executable handoff.
- Resource limits for CPU time, address space, output-file size, open file descriptors, core dumps, and additional processes.
- Environment scrubbing. The executed code receives a private `HOME`/`TMPDIR`, a fixed minimal `PATH`, locale variables, and Python runtime flags only.

External program execution is blocked by the Landlock execute policy. Network socket creation is blocked by seccomp in addition to Landlock's TCP restrictions. When a Conda environment is selected, its entire prefix is added as a **read-only** runtime root, allowing its installed Python packages and native shared libraries to load while preventing environment/package writes. Environment `.pth` files are processed only after the sandbox is active; activation scripts and environment binaries are never executed.

If any sandbox step is unavailable or fails, `python_execute` returns `PYTHON_SANDBOX_FAILED`; it never silently falls back to unsandboxed execution.

### Default limits

- Tool timeout: 120 seconds, maximum 300 seconds.
- Address space: 4 GiB.
- Per-file size: 64 MiB.
- Open file descriptors: 128.
- Additional processes/threads under the bridge user's UID: approximately 32 above the count observed at sandbox setup.
- Core dump size: 0.

Bridge operators can adjust bounded defaults with `C2C_SANDBOX_MEMORY_BYTES`, `C2C_SANDBOX_FILE_BYTES`, `C2C_SANDBOX_OPEN_FILES`, and `C2C_SANDBOX_EXTRA_PROCESSES`.

## Important residual boundary

The **workspace itself is the writable trust boundary** for `python_execute`. Unlike `read_file` and `python_write_file`, arbitrary Python execution cannot selectively subtract sensitive children from a writable directory with Landlock ABI 4. Therefore Python code can read or modify files that already exist inside the connected workspace, including a workspace-local `.env` if one is present.

Keep secrets that must never be visible to model-authored Python outside the connected workspace. The sandbox is intended to prevent access to the rest of the user's home directory, unrelated projects, network endpoints and peer processes.

See [docs/security.md](docs/security.md) for the complete threat model and residual risks.

## Development

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## Conda usage

1. Call `conda_environments` and choose an `id` from the returned list.
2. Pass that exact id as `python_execute(environment=...)`.
3. The selected interpreter, Python packages and native runtime libraries are readable inside the sandbox; the Conda prefix itself is not writable.

There is intentionally no MCP tool for `conda install`, `conda remove`, `conda create`, `conda env remove`, `pip install`, or arbitrary interpreter paths. `python_execute` keeps network and external process execution blocked, so selecting an environment does not create a package-management channel.
