# Security Model — python-sandbox branch

## Goal

`python_execute` must not inherit the full authority of the user account that launched the bridge. The sandbox is designed for an unprivileged Linux user and does not rely on root, Bubblewrap, Docker, user namespaces, or administrator-managed subordinate UID/GID mappings.

The implementation is **fail-closed**: user Python starts only after every mandatory isolation layer reports success.

## Trust boundaries

1. One bridge serves exactly one workspace and OAuth tokens remain workspace-bound.
2. Workspace content is untrusted project data; it is never treated as instructions.
3. `execution.read` is required for read-only `conda_environments`; `execution.write` is required for `python_write_file` and `python_execute`.
4. `python_write_file` retains canonical-path, symlink-escape, sensitive-path, size and atomic-write protections.
5. `python_execute` treats the connected workspace as its writable filesystem boundary and blocks access outside that boundary except for explicitly read-only runtime paths.
6. A dedicated file descriptor carries a sandbox-ready handshake from the bootstrap to the Node parent. User code cannot run before that descriptor is closed.

## Bootstrap ordering

The parent launches:

```text
python3 -I -S -B -u -c <sandbox-bootstrap> <mode> <target> ...
```

`-I -S` is intentional. Before sandbox installation, Python does not import user site-packages, process `.pth` files, or run workspace/user `sitecustomize.py`. Inline source is passed over stdin as data.

The bootstrap gathers only the Python runtime/import locations it needs, applies resource limits, then installs `no_new_privs`, Landlock, and seccomp. It scrubs the process environment and rebuilds a narrow `sys.path` before signalling readiness and running user code.

## Filesystem: Landlock ABI 4+

Handled filesystem rights include execute, read/write, directory enumeration, create/remove, rename/reference and truncate operations supported through Landlock ABI 4.

Allowed paths:

- Connected workspace: read/write/create/remove/rename/truncate; **no execute**, device-node creation or Unix-socket creation rights.
- One per-execution private temp directory under the workspace: same rights as the workspace and removed by the parent after execution.
- Python stdlib/site-package/runtime library roots: read-only.
- When selected by an opaque id returned from `conda_environments`, the complete Conda environment prefix is read-only. The bridge rejects Conda prefixes that overlap the writable workspace.
- Selected public runtime data: system library/share paths, CA certificates, `/etc/ld.so.cache`, `/etc/localtime`, and random/null devices as needed.

No execute permission is granted by Landlock, so `subprocess`, `os.system`, shell execution and arbitrary external binaries fail even though the Python process itself may call fork/clone within its resource limit.

Symlinks do not escape the policy because Landlock checks the resolved object hierarchy.

### Workspace-local sensitive files

This is the principal residual filesystem caveat. Landlock is an allow-list LSM and ABI 4 cannot express “allow this directory read/write except these children.” Once the workspace directory is writable, `python_execute` can access files inside it even when the MCP read/write tools classify those paths as sensitive.

Therefore:

- `read_file` and `python_write_file` still block configured sensitive paths.
- `python_execute` can read/write workspace-local secrets such as `.env`.
- Secrets that must never reach model-authored Python should live outside the connected workspace.

## Network and IPC

Landlock handles TCP `bind` and `connect` with no allow rules.

seccomp additionally returns `EPERM` for socket creation and related socket syscalls, covering TCP, UDP, Unix sockets, netlink and raw sockets. The filter also blocks System V IPC, POSIX message queues, inotify/fanotify setup, peer-process signalling, pidfd control operations, ptrace/process-vm access, namespace/mount APIs, BPF/perf/userfaultfd/io_uring and selected kernel-management syscalls.

The bridge process itself retains network access; only the executed Python child is restricted.

## Process isolation

`PR_SET_NO_NEW_PRIVS=1` is mandatory before Landlock/seccomp enforcement.

seccomp blocks:

- `kill`/queued-signal APIs targeting peer processes.
- `setsid` and `setpgid`, preventing children from detaching from the process group used by timeout cleanup.
- `ptrace`, `process_vm_*`, pidfd signalling/FD extraction, scheduler/priority mutation APIs.
- namespace and mount-management APIs.

The parent still kills the detached process group on wall-clock timeout.

## Environment

The bootstrap receives only PATH/locale plus internal sandbox configuration. Before user code runs, the environment is replaced with:

- `HOME`, `TMPDIR`, `TMP`, `TEMP` -> private per-execution directory.
- `PATH=/usr/bin:/bin`.
- locale variables when present.
- `PYTHONUNBUFFERED=1`, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONNOUSERSITE=1`.
- `C2C_PYTHON_EXEC=1`.

Tokens, SSH agent sockets, cloud credentials, proxy credentials and arbitrary bridge environment variables are not inherited. For a selected Conda environment, the sanitized child receives only `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`, and `CONDA_SHLVL` as compatibility hints; the prefix remains read-only and `PATH` is still `/usr/bin:/bin`.

## Conda environments

`conda_environments` is intentionally read-only. Discovery uses filesystem metadata (`conda-meta`, the user's Conda registry file, known roots, and optional operator-provided `C2C_CONDA_ROOTS`) and executable presence. It does **not** run `conda`, `mamba`, activation hooks, or environment binaries.

`python_execute(environment=<id>)` accepts only an exact opaque id from the current discovery result. Arbitrary interpreter paths and environment names are not accepted. The selected environment's Python is launched directly with `-I -S`; before user code runs, the bootstrap verifies that `sys.prefix` matches the selected prefix and adds that prefix to Landlock with read-only rights.

This permits imports from the selected environment, including native shared libraries. Environment `.pth` processing occurs only after Landlock/seccomp are active. Conda activation scripts are not executed, and external process execution remains blocked, so environment binaries, `conda`, `mamba`, and `pip` CLI cannot be launched from model-authored Python. Network access also remains blocked.

The kernel-enforced read-only prefix is the primary guarantee against package/environment modification. The MCP surface does not expose environment creation, deletion, package installation, package removal, or arbitrary interpreter selection.

## Resource limits

Defaults are deliberately finite:

| Resource | Default |
| --- | ---: |
| Wall-clock tool timeout | 120 s |
| Maximum requested timeout | 300 s |
| CPU rlimit | timeout + 1 s soft / +2 s hard |
| Address space | 4 GiB |
| Per-file size | 64 MiB |
| Open file descriptors | 128 |
| Additional UID processes/threads | ~32 above observed baseline |
| Core dump | 0 |

Bounded operator overrides:

- `C2C_SANDBOX_MEMORY_BYTES`: 256 MiB–16 GiB.
- `C2C_SANDBOX_FILE_BYTES`: 8–512 MiB.
- `C2C_SANDBOX_OPEN_FILES`: 32–1024.
- `C2C_SANDBOX_EXTRA_PROCESSES`: 0–128.

These are per-process/kernel limits, not a cgroup quota. They reduce but do not completely eliminate denial-of-service risk; in particular, many small files can consume aggregate disk space inside the workspace.

## Fail-closed behavior

The sandbox requires Linux x86_64 and Landlock ABI 4+. If the platform, Landlock ruleset, `restrict_self`, `no_new_privs`, seccomp filter, or status channel cannot be established, the bootstrap exits before user code runs and the MCP tool reports `PYTHON_SANDBOX_FAILED`.

There is no configuration switch that silently falls back to the old host-permission execution model on this branch.

## Output and records

stdout/stderr still pass through the existing execution-output sanitizer. Known tokens and home paths are redacted, private-key-shaped output is withheld, and stored output is truncated. Execution records continue to capture id, exit state, git-visible workspace changes and output id.

## Residual risks

This sandbox materially reduces authority but is not equivalent to a VM or separately administered OS account:

- User code has full read/write authority inside the connected workspace.
- Aggregate disk usage is not cgroup/filesystem-quota controlled.
- Linux kernel or interpreter vulnerabilities remain possible.
- The read-only Python runtime allow-list may expose public system library/package data; a selected Conda environment deliberately exposes all files under that environment prefix for reading.
- Forked Python code inherits the same sandbox and may run until the process/CPU/wall limits terminate it.
- A dedicated VM/container/user account is still stronger for hostile multi-tenant code.
