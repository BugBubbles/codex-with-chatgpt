export const PYTHON_SANDBOX_BOOTSTRAP = String.raw`
import errno
import json
import os
import platform
import sys

FAIL_EXIT = 125

def fail(message):
    try:
        os.write(2, ("[c2c-sandbox] " + message + "\n").encode("utf-8", "replace"))
    finally:
        raise SystemExit(FAIL_EXIT)

if sys.platform != "linux":
    fail("strict python sandbox requires Linux")

machine = platform.machine().lower()
if machine not in ("x86_64", "amd64"):
    fail("strict python sandbox currently requires x86_64")

try:
    import ctypes
    import resource
except Exception as exc:
    fail("required sandbox module unavailable: " + repr(exc))

workspace = os.environ.get("C2C_SANDBOX_WORKSPACE", "")
sandbox_tmp = os.environ.get("C2C_SANDBOX_TMP", "")
if not workspace or not sandbox_tmp:
    fail("sandbox paths were not provided")

workspace = os.path.realpath(workspace)
sandbox_tmp = os.path.realpath(sandbox_tmp)
runtime_prefix = os.environ.get("C2C_SANDBOX_RUNTIME_PREFIX", "").strip()
runtime_name = os.environ.get("C2C_SANDBOX_RUNTIME_NAME", "").strip()
if runtime_prefix:
    runtime_prefix = os.path.realpath(runtime_prefix)
if not os.path.isdir(workspace) or not os.path.isdir(sandbox_tmp):
    fail("sandbox workspace/temp directory is unavailable")
if runtime_prefix:
    if not os.path.isdir(runtime_prefix):
        fail("selected Conda runtime prefix is unavailable")
    try:
        overlaps_workspace = (
            os.path.commonpath([workspace, runtime_prefix]) == workspace
            or os.path.commonpath([runtime_prefix, workspace]) == runtime_prefix
        )
    except ValueError:
        overlaps_workspace = True
    if overlaps_workspace:
        fail("selected Conda runtime overlaps the writable workspace")
    if os.path.realpath(sys.prefix) != runtime_prefix:
        fail("selected Conda interpreter prefix does not match the requested environment")

if len(sys.argv) < 3:
    fail("sandbox bootstrap arguments are incomplete")

mode = sys.argv[1]
target = sys.argv[2]
user_args = sys.argv[3:]
if mode not in ("inline", "file"):
    fail("invalid execution mode")

inline_code = sys.stdin.read() if mode == "inline" else None
if mode == "file":
    target = os.path.realpath(target)
    try:
        inside = os.path.commonpath([workspace, target]) == workspace
    except ValueError:
        inside = False
    if not inside or not os.path.isfile(target):
        fail("python file target is outside the workspace or missing")

def env_int(name, default, minimum, maximum):
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))

timeout_seconds = env_int("C2C_SANDBOX_TIMEOUT_SECONDS", 120, 1, 300)
memory_bytes = env_int("C2C_SANDBOX_MEMORY_BYTES", 4 * 1024**3, 256 * 1024**2, 16 * 1024**3)
file_bytes = env_int("C2C_SANDBOX_FILE_BYTES", 64 * 1024**2, 8 * 1024**2, 512 * 1024**2)
open_files = env_int("C2C_SANDBOX_OPEN_FILES", 128, 32, 1024)
extra_processes = env_int("C2C_SANDBOX_EXTRA_PROCESSES", 32, 0, 128)

def clamp_limit(kind, soft, hard=None):
    desired_hard = soft if hard is None else hard
    _current_soft, current_hard = resource.getrlimit(kind)
    if current_hard == resource.RLIM_INFINITY:
        new_hard = desired_hard
    else:
        new_hard = min(current_hard, desired_hard)
    new_soft = min(soft, new_hard)
    resource.setrlimit(kind, (new_soft, new_hard))
    return int(new_soft), int(new_hard)

limits = {}
limits["cpu"] = clamp_limit(resource.RLIMIT_CPU, timeout_seconds + 1, timeout_seconds + 2)
limits["addressSpace"] = clamp_limit(resource.RLIMIT_AS, memory_bytes)
limits["fileSize"] = clamp_limit(resource.RLIMIT_FSIZE, file_bytes)
limits["openFiles"] = clamp_limit(resource.RLIMIT_NOFILE, open_files)
limits["core"] = clamp_limit(resource.RLIMIT_CORE, 0)

def count_uid_processes():
    count = 0
    uid = os.getuid()
    try:
        names = os.listdir("/proc")
    except OSError:
        return None
    for name in names:
        if not name.isdigit():
            continue
        try:
            st = os.stat("/proc/" + name)
            if st.st_uid == uid:
                count += 1
        except OSError:
            pass
    return count

if hasattr(resource, "RLIMIT_NPROC"):
    process_count = count_uid_processes()
    if process_count is not None:
        limits["processes"] = clamp_limit(
            resource.RLIMIT_NPROC,
            process_count + extra_processes,
            process_count + extra_processes,
        )

# Gather import roots before Landlock. The bootstrap is launched with -I -S,
# so no workspace/user startup code has executed at this point.
site_paths = []
try:
    import site
    for item in site.getsitepackages():
        if item and os.path.exists(item):
            site_paths.append(os.path.realpath(item))
except Exception:
    pass

mapped_runtime_dirs = set()
try:
    with open("/proc/self/maps", "r", encoding="utf-8", errors="replace") as maps:
        for line in maps:
            maybe = line.rsplit(None, 1)[-1].strip()
            if maybe.startswith("/") and os.path.exists(maybe):
                mapped_runtime_dirs.add(os.path.realpath(os.path.dirname(maybe)))
except OSError:
    pass

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.prctl.restype = ctypes.c_int

PR_SET_NO_NEW_PRIVS = 38
if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
    err = ctypes.get_errno()
    fail("PR_SET_NO_NEW_PRIVS failed: " + os.strerror(err))

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1

ACCESS_EXECUTE = 1 << 0
ACCESS_WRITE_FILE = 1 << 1
ACCESS_READ_FILE = 1 << 2
ACCESS_READ_DIR = 1 << 3
ACCESS_REMOVE_DIR = 1 << 4
ACCESS_REMOVE_FILE = 1 << 5
ACCESS_MAKE_CHAR = 1 << 6
ACCESS_MAKE_DIR = 1 << 7
ACCESS_MAKE_REG = 1 << 8
ACCESS_MAKE_SOCK = 1 << 9
ACCESS_MAKE_FIFO = 1 << 10
ACCESS_MAKE_BLOCK = 1 << 11
ACCESS_MAKE_SYM = 1 << 12
ACCESS_REFER = 1 << 13
ACCESS_TRUNCATE = 1 << 14

NET_BIND_TCP = 1 << 0
NET_CONNECT_TCP = 1 << 1

FS_HANDLED = (
    ACCESS_EXECUTE
    | ACCESS_WRITE_FILE
    | ACCESS_READ_FILE
    | ACCESS_READ_DIR
    | ACCESS_REMOVE_DIR
    | ACCESS_REMOVE_FILE
    | ACCESS_MAKE_CHAR
    | ACCESS_MAKE_DIR
    | ACCESS_MAKE_REG
    | ACCESS_MAKE_SOCK
    | ACCESS_MAKE_FIFO
    | ACCESS_MAKE_BLOCK
    | ACCESS_MAKE_SYM
    | ACCESS_REFER
    | ACCESS_TRUNCATE
)
FS_WORKSPACE = (
    ACCESS_WRITE_FILE
    | ACCESS_READ_FILE
    | ACCESS_READ_DIR
    | ACCESS_REMOVE_DIR
    | ACCESS_REMOVE_FILE
    | ACCESS_MAKE_DIR
    | ACCESS_MAKE_REG
    | ACCESS_MAKE_FIFO
    | ACCESS_MAKE_SYM
    | ACCESS_REFER
    | ACCESS_TRUNCATE
)
FS_READ = ACCESS_READ_FILE | ACCESS_READ_DIR

class RulesetAttr(ctypes.Structure):
    _fields_ = [
        ("handled_access_fs", ctypes.c_uint64),
        ("handled_access_net", ctypes.c_uint64),
    ]

class PathBeneathAttr(ctypes.Structure):
    _fields_ = [
        ("allowed_access", ctypes.c_uint64),
        ("parent_fd", ctypes.c_int),
    ]

abi = libc.syscall(
    SYS_LANDLOCK_CREATE_RULESET,
    0,
    0,
    LANDLOCK_CREATE_RULESET_VERSION,
)
if abi < 4:
    if abi < 0:
        err = ctypes.get_errno()
        fail("Landlock is unavailable: " + os.strerror(err))
    fail("Landlock ABI 4 or newer is required")

ruleset_attr = RulesetAttr(FS_HANDLED, NET_BIND_TCP | NET_CONNECT_TCP)
ruleset_fd = libc.syscall(
    SYS_LANDLOCK_CREATE_RULESET,
    ctypes.byref(ruleset_attr),
    ctypes.sizeof(ruleset_attr),
    0,
)
if ruleset_fd < 0:
    err = ctypes.get_errno()
    fail("Landlock ruleset creation failed: " + os.strerror(err))

def add_path_rule(candidate, access):
    candidate = os.path.realpath(candidate)
    if not os.path.exists(candidate):
        return
    flags = getattr(os, "O_PATH", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        parent_fd = os.open(candidate, flags)
    except OSError as exc:
        fail("cannot open sandbox allow-path " + candidate + ": " + str(exc))
    try:
        rule = PathBeneathAttr(access, parent_fd)
        rc = libc.syscall(
            SYS_LANDLOCK_ADD_RULE,
            ruleset_fd,
            LANDLOCK_RULE_PATH_BENEATH,
            ctypes.byref(rule),
            0,
        )
        if rc != 0:
            err = ctypes.get_errno()
            fail("cannot add Landlock rule for " + candidate + ": " + os.strerror(err))
    finally:
        os.close(parent_fd)

# Workspace and private temp are writable, but executable files, device nodes and
# Unix sockets cannot be created/executed through the Landlock policy.
add_path_rule(workspace, FS_WORKSPACE)
add_path_rule(sandbox_tmp, FS_WORKSPACE)

read_paths = set()
for item in [*sys.path, *site_paths, *mapped_runtime_dirs]:
    if not item:
        continue
    real = os.path.realpath(item)
    if real == workspace or real.startswith(workspace + os.sep):
        continue
    if real == sandbox_tmp or real.startswith(sandbox_tmp + os.sep):
        continue
    if os.path.exists(real):
        read_paths.add(real)

for candidate in (
    "/usr/lib",
    "/usr/local/lib",
    "/usr/lib64",
    "/lib",
    "/lib64",
    "/usr/share",
    "/etc/ssl/certs",
):
    if os.path.exists(candidate):
        read_paths.add(os.path.realpath(candidate))

if runtime_prefix:
    read_paths.add(runtime_prefix)

for candidate in sorted(read_paths):
    add_path_rule(candidate, FS_READ)

for candidate in (
    "/etc/ld.so.cache",
    "/etc/localtime",
    "/dev/null",
    "/dev/urandom",
    "/dev/random",
):
    if os.path.exists(candidate):
        access = ACCESS_READ_FILE
        if candidate == "/dev/null":
            access |= ACCESS_WRITE_FILE
        add_path_rule(candidate, access)

if libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0) != 0:
    err = ctypes.get_errno()
    os.close(ruleset_fd)
    fail("Landlock restrict_self failed: " + os.strerror(err))
os.close(ruleset_fd)

# seccomp: deny networking, process-control attacks, namespace/mount APIs,
# kernel attack surface, external signalling/IPC and metadata syscalls that
# Landlock ABI 4 does not fully mediate.
BPF_LD_W_ABS = 0x20
BPF_JMP_JEQ_K = 0x15
BPF_RET_K = 0x06
SECCOMP_RET_KILL_PROCESS = 0x80000000
SECCOMP_RET_ERRNO = 0x00050000
SECCOMP_RET_ALLOW = 0x7FFF0000
AUDIT_ARCH_X86_64 = 0xC000003E
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2

class SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint32),
    ]

class SockFprog(ctypes.Structure):
    _fields_ = [
        ("len", ctypes.c_ushort),
        ("filter", ctypes.POINTER(SockFilter)),
    ]

denied_syscalls = {
    # network/socket
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
    # System V IPC
    29, 30, 31, 64, 65, 66, 67, 68, 69, 70, 71, 220,
    # signal/process control of peer processes
    62, 109, 112, 129, 141, 142, 144, 200, 203, 234, 251, 297, 302,
    314, 424, 434, 438, 448,
    # privilege / namespace / kernel attack surface
    101, 155, 165, 166, 167, 168, 169, 170, 171, 172, 173, 175, 176,
    246, 248, 249, 250, 272, 298, 300, 304, 308, 310, 311, 312, 313,
    317, 320, 321, 323, 425, 426, 427, 428, 429, 430, 431, 432, 433,
    442,
    # inotify/fanotify and POSIX message queues
    240, 241, 242, 243, 244, 245, 253, 254, 255, 294,
    # metadata operations not fully mediated by Landlock ABI 4
    90, 91, 92, 93, 94, 132, 133, 188, 189, 190, 191, 192, 193,
    194, 195, 196, 197, 198, 199, 235, 259, 260, 261, 268, 280,
    # anonymous executable handoff
    319, 322,
}

instructions = [
    SockFilter(BPF_LD_W_ABS, 0, 0, 4),
    SockFilter(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64),
    SockFilter(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    SockFilter(BPF_LD_W_ABS, 0, 0, 0),
]
for syscall_number in sorted(denied_syscalls):
    instructions.append(SockFilter(BPF_JMP_JEQ_K, 0, 1, syscall_number))
    instructions.append(SockFilter(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | errno.EPERM))
instructions.append(SockFilter(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW))

filter_array = (SockFilter * len(instructions))(*instructions)
program = SockFprog(len(instructions), filter_array)
if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(program)) != 0:
    err = ctypes.get_errno()
    fail("seccomp filter installation failed: " + os.strerror(err))

clean_env = {
    "PATH": "/usr/bin:/bin",
    "HOME": sandbox_tmp,
    "TMPDIR": sandbox_tmp,
    "TMP": sandbox_tmp,
    "TEMP": sandbox_tmp,
    "PYTHONUNBUFFERED": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONNOUSERSITE": "1",
    "C2C_PYTHON_EXEC": "1",
    "PIP_NO_INDEX": "1",
    "PIP_DISABLE_PIP_VERSION_CHECK": "1",
}
if runtime_prefix:
    clean_env["CONDA_PREFIX"] = runtime_prefix
    clean_env["CONDA_DEFAULT_ENV"] = runtime_name or os.path.basename(runtime_prefix)
    clean_env["CONDA_SHLVL"] = "1"
for key in ("LANG", "LC_ALL", "LC_CTYPE"):
    value = os.environ.get(key)
    if value:
        clean_env[key] = value

os.environ.clear()
os.environ.update(clean_env)

# Rebuild a deliberately narrow import path. .pth files, user site-packages and
# sitecustomize are not executed by the bootstrap.
runtime_path = []
if mode == "file":
    runtime_path.append(os.path.dirname(target))
else:
    runtime_path.append(workspace)
runtime_path.append(workspace)
for item in [*sys.path, *site_paths]:
    if item and item not in runtime_path:
        runtime_path.append(item)
sys.path[:] = runtime_path

# Selected Conda environments may rely on .pth files in site-packages. Process
# them only after Landlock/seccomp are active, so any executable .pth statement
# remains confined by the same sandbox as user code.
if runtime_prefix:
    try:
        import site as _site
        for item in site_paths:
            if item and os.path.isdir(item):
                _site.addsitedir(item)
    except Exception as exc:
        fail("selected Conda site-packages initialization failed: " + repr(exc))

status = {
    "enforced": True,
    "backend": "landlock+seccomp",
    "landlockAbi": int(abi),
    "noNewPrivs": True,
    "network": "blocked",
    "externalExec": "blocked",
    "limits": {key: pair[0] for key, pair in limits.items()},
}
try:
    os.write(3, (json.dumps(status, separators=(",", ":")) + "\n").encode("utf-8"))
    os.close(3)
except OSError as exc:
    fail("sandbox status channel failed: " + str(exc))

# User code begins only after the status channel is closed.
if mode == "inline":
    sys.argv = ["-c", *user_args]
    main_globals = {
        "__name__": "__main__",
        "__package__": None,
        "__builtins__": __builtins__,
    }
    exec(compile(inline_code or "", "<string>", "exec"), main_globals, main_globals)
else:
    import runpy
    sys.argv = [target, *user_args]
    runpy.run_path(target, run_name="__main__")

`;
