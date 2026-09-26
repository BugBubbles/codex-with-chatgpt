# Codex with ChatGPT — 严格 Python 沙箱分支

> ChatGPT 负责分析并生成 Python，本地 Bridge 只在严格、失败即关闭（fail-closed）的 Linux 沙箱中执行。

`python-sandbox` 分支基于 `python` 分支。它保留 OAuth、Tunnel、workspace 读取/Git 工具和直接 Python 写入能力，但把原先继承本地用户权限的 `python_execute` 改为 Landlock + seccomp + `no_new_privs` + rlimit 的非 root 沙箱。

## MCP 工具

保留读取/状态工具：

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`
- `execution_output`
- `conda_environments`：只读枚举本机已安装的 Conda 环境及其 Python/包元数据；不会调用 Conda，也不会修改环境。

拥有 `execution.write` scope 后：

- `python_write_file(path, content)`：继续使用 workspace canonical path、symlink escape 和敏感文件检查，原子写入 UTF-8 文本。
- `python_execute(code | path, args?, environment?, timeout_seconds?)`：只有严格沙箱全部安装成功后才执行内联 Python 或 workspace 内的 `.py` 文件；`environment` 必须是 `conda_environments` 返回的精确环境 ID。

本分支仍不暴露 `submit_codex_task`、`codex_task_status`、`cancel_codex_task`。

## 环境要求

- Linux x86_64
- 内核 Landlock ABI 4 或更高
- Node.js >= 20
- Python 3
- git
- 公网 Connector 场景需要 `cloudflared`

**不需要 root、系统安装 Bubblewrap、容器运行时或 `/etc/subuid` 配置。**

默认解释器为 `python3`；可通过 `C2C_PYTHON_BIN=/absolute/path/to/python` 指定其他默认解释器。Conda 切换不会执行 `conda activate`：Bridge 只读发现环境后直接启动所选环境的 Python。可选的 `C2C_CONDA_ROOTS`（按系统 PATH 分隔符分隔）可增加由操作者明确允许的扫描根目录。

## 安装

```bash
git clone https://github.com/BugBubbles/codex-with-chatgpt.git
cd codex-with-chatgpt
git checkout python-sandbox
corepack pnpm install
corepack pnpm build
c2c start -w <workspace> --tunnel
```

## 沙箱保证

bootstrap 自身使用 `python -I -S` 启动，因此 workspace 或用户目录中的 Python startup/site hook 不会在隔离前执行。只有以下步骤全部成功后才开始用户代码：

- 设置 `PR_SET_NO_NEW_PRIVS`。
- Landlock ABI >= 4：workspace 和单独临时目录可读写；Python 运行时/库目录只读；文件执行被拒绝；TCP bind/connect 被拒绝。
- seccomp：阻断 socket、对其他进程发送信号、namespace/mount/内核管理接口、若干 IPC、Landlock ABI 4 尚未覆盖的元数据 syscall，以及匿名可执行文件交接。
- rlimit：限制 CPU、地址空间、单文件大小、打开 FD、core dump 和新增进程/线程。
- 清理环境变量：用户代码只得到私有 `HOME`/`TMPDIR`、固定最小 `PATH`、locale 和必要 Python 标志。

外部系统程序不能执行；socket 创建也被 seccomp 阻断。选择 Conda 环境后，整个环境 prefix 只以**只读 runtime**形式加入 Landlock allow-list，因此其中已安装的 Python 包和 native shared library 可读取/加载，但环境目录不能写入。`.pth` 仅在沙箱已经生效后处理；不会执行 activation script，也不会执行环境中的 CLI。

只要任何沙箱步骤失败，`python_execute` 就返回 `PYTHON_SANDBOX_FAILED`，**不会降级为直接本地执行**。

### 默认资源上限

- timeout：默认 120 秒，最大 300 秒。
- 地址空间：4 GiB。
- 单文件：64 MiB。
- 打开文件描述符：128。
- 在启动时已有同 UID 任务数基础上，额外允许约 32 个进程/线程。
- core dump：0。

可由 Bridge 启动环境通过 `C2C_SANDBOX_MEMORY_BYTES`、`C2C_SANDBOX_FILE_BYTES`、`C2C_SANDBOX_OPEN_FILES`、`C2C_SANDBOX_EXTRA_PROCESSES` 在代码设定的安全范围内调整。

## 一个必须明确的剩余边界

`python_execute` 把**整个 connected workspace 当作可读写信任边界**。Landlock ABI 4 无法在允许一个目录可写的同时，再从其中减去单独的敏感子文件。因此，与 `read_file` / `python_write_file` 不同，任意 Python 可以读取或修改 workspace 中已经存在的文件；如果 workspace 本身放了 `.env`，Python 也能看到它。

因此，不希望模型生成的 Python 接触到的密钥，应放在 connected workspace 之外。这个沙箱主要隔离的是用户主目录其余部分、其他项目、网络和同 UID 的其他进程。

完整威胁模型见 [docs/security.md](docs/security.md)。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## Conda 环境使用

1. 调用 `conda_environments` 获取当前可用环境，并选择返回的 `id`。
2. 将该精确 ID 传给 `python_execute(environment=...)`。
3. 所选环境的 Python、已安装 Python 库和 native runtime 库可在沙箱中只读使用；环境 prefix 本身不可写。

本分支刻意不提供 `conda install/remove/create/env remove`、`pip install`、任意解释器路径等 MCP 能力；网络和外部进程执行仍被阻断，因此“切换环境”不会演变为环境/包管理能力。
