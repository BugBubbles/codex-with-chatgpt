# Security Model — Python branch

## Trust boundaries

1. One bridge serves exactly one workspace and OAuth tokens remain workspace-bound.
2. Workspace content is untrusted data; read tools never grant capabilities based on it.
3. `execution.write` is required for both `python_write_file` and `python_execute`.
4. `python_write_file` is workspace-bounded and reuses canonical path and sensitive-file
   protections.
5. `python_execute` is direct local code execution and is **not** an OS sandbox.

## Python authoring

`python_write_file` resolves the requested destination against the canonical workspace
root, rejects symlink/path escapes and sensitive paths, limits one write to 2 MiB, writes
through a temporary file, and atomically renames it into place.

## Python execution

The bridge launches the configured Python interpreter without a shell:

```text
python3 -B -u -c <inline-code> [args...]
python3 -B -u <workspace/script.py> [args...]
```

The working directory is the workspace. The child inherits only a reduced environment
(PATH/home/locale/temp/virtualenv essentials), sets `PYTHONDONTWRITEBYTECODE=1`,
`PYTHONNOUSERSITE=1`, and is killed when the requested timeout expires. Output passes
through the existing sanitizer before it can be returned to ChatGPT.

### Critical residual risk

Changing cwd and reducing environment variables do not constrain filesystem or network
syscalls. Python code runs with the OS permissions of the bridge user and may read/write
outside the workspace, spawn subprocesses, or access the network if the host permits it.
This is intentional for the `python` branch and is the main difference from the Codex
sandbox design on other branches.

Use this branch only with a trusted connector. For high-sensitivity work, run the bridge
inside an OS/container/VM boundary with only the intended workspace mounted and with
network policy enforced outside the Python process.

## Scopes

- `workspace.read`
- `workspace.search`
- `git.read`
- `execution.read`
- `execution.write`
- `offline_access`

`python_write_file` and `python_execute` require `execution.write`.
`execution_output`, `execution_summary`, and `test_status` require
`execution.read`.

## Output and records

Python stdout/stderr is stored through the existing execution-output sanitizer: known
tokens and home paths are redacted, private-key blocks are withheld, and output is
truncated. Each execution also writes an execution record containing its id, exit state,
current git-visible changed files, and output id.
