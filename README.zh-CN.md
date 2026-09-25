# Codex with ChatGPT — Python 执行分支

> ChatGPT 负责分析并生成 Python，本地 Bridge 直接执行。

`python` 分支从 `main` 创建，但移除了 MCP 中启动本地 Codex 的执行链。
OAuth、Cloudflare Tunnel、workspace 读取/Git 工具继续保留，执行能力改为直接
Python 编码与运行。

## MCP 工具

保留 9 个读取/状态工具：

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`
- `execution_output`

获得 `execution.write` OAuth scope 后新增：

- `python_write_file(path, content)`：在 workspace 内原子创建或完整覆盖一个
  UTF-8 文本文件，并继续使用 canonical path、symlink escape 和敏感文件检查。
- `python_execute(code | path, args?, timeout_seconds?)`：直接执行内联 Python
  或 workspace 内的 `.py` 文件。cwd 固定为当前 workspace，输出经过现有
  sanitizer 后进入 `execution_output`，Git 可见变更进入 `execution_summary`。

本分支不再暴露 `submit_codex_task`、`codex_task_status`、
`cancel_codex_task`，Bridge 也不再创建本地 Codex Task Manager。

## 环境要求

- Node.js >= 20
- Python 3
- git
- 需要公网 Connector 时安装 `cloudflared`

Linux/macOS 默认执行 `python3`，Windows 默认执行 `python`。如需指定解释器：

```bash
export C2C_PYTHON_BIN=/absolute/path/to/python
```

## 安装

```bash
git clone https://github.com/BugBubbles/codex-with-chatgpt.git
cd codex-with-chatgpt
git checkout python
corepack pnpm install
corepack pnpm build
c2c start -w <workspace> --tunnel
```

已有 Connector 需要拥有 `execution.write` scope 才能调用 Python 写入/执行工具。

## 安全说明

`python_write_file` 受 workspace 边界约束。

但 `python_execute` **不是操作系统沙箱**。Bridge 只会固定 cwd、减少继承的环境
变量、设置 1–3600 秒超时、脱敏输出并记录 Git 变化；Python 代码本身仍拥有启动
Bridge 的本地用户权限。如果代码主动访问 workspace 外路径，它在操作系统允许时
仍然能够访问。

因此只应把此分支连接到你信任的 ChatGPT Connector。需要更强隔离时，应把 Bridge
放在只挂载目标工程的容器、VM 或独立 WSL 环境中。
