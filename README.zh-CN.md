# Codex with ChatGPT — CLI-only 分支

> ChatGPT 负责思考，Codex CLI 负责干活。

这是 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
的 **Codex CLI-only** 改造版本，目标是：

**只安装 Codex CLI，不安装 Windows Codex 桌面版，也不依赖 ChatGPT 桌面版。**

底层 C2C Bridge、OAuth、Cloudflare Tunnel 和工作区隔离保持不变。
本分支现在在原有“以读取为主”的 MCP 数据面之上增加一个受限执行控制面：
ChatGPT 可以向本地 Codex CLI 提交目标、查询状态和取消任务，但不会获得裸 Shell。
原来的人工 C2C 消息交接仍保留为兼容回退方式。

## 主要变化

- 不依赖 Codex Desktop。
- 不依赖 ChatGPT Desktop。
- 不使用 `control-in-app-browser`。
- 不使用 `agent.browsers` 或 Computer Use。
- Codex CLI 继续负责改代码、Shell、Git、测试。
- ChatGPT 继续通过现有读取工具自行读取代码、diff 和测试记录。
- 授权 `execution.write` 后，ChatGPT 可调用 `submit_codex_task`、
  `codex_task_status` 和 `cancel_codex_task`。
- 不暴露通用 `write_file` 或 `execute_shell` 工具。
- 未授权执行 scope 时，仍可使用原来的 `[C2C]` 人工复制流程。

## 环境要求

- Codex CLI
- Node.js >= 20
- git
- `cloudflared`
- 能够创建/使用开发者模式 Connector 的 ChatGPT 账号

Windows 上可以使用 `winget` 安装缺失依赖。

**不需要安装 Windows Codex 桌面应用。**

## 安装

克隆这个 fork：

```bash
git clone https://github.com/BugBubbles/codex-with-chatgpt.git
cd codex-with-chatgpt
git checkout cli-only
corepack pnpm install
corepack pnpm build
```

然后把：

```text
skill/SKILL.md
```

复制到：

```text
~/.codex/skills/codex-with-chatgpt/SKILL.md
```

Windows 默认对应：

```text
%USERPROFILE%\.codex\skills\codex-with-chatgpt\SKILL.md
```

并把 Skill 中：

```text
The codex-with-chatgpt checkout lives at: <ACTUAL_CHECKOUT_PATH>
```

替换为实际克隆目录。

之后进入你真正要开发的项目目录，启动 Codex CLI，然后说：

```text
使用 Codex with ChatGPT 完成首次配置。
```

## 首次配置

Codex CLI 会自动处理本地部分：

- 检查 Node/git/cloudflared；
- 建立 C2C Bridge；
- 建立 Cloudflare 安全连接；
- 生成 Connector 所需的 MCP 地址；
- 在需要时生成一次性配对码。

ChatGPT 网页部分由你在普通浏览器中完成。

### 第一次只需要做这些

1. 打开 ChatGPT Developer mode 页面并启用开发者模式。
2. 打开 Connector 创建页面。
3. 使用 Codex CLI 给出的 **Connector 名称**。
4. Server URL 填 Codex CLI 给出的 **MCP URL**。
5. Authentication 选择 **OAuth**。
6. 浏览器进入授权页面后，Codex 执行 `c2c pair`，你输入新的配对码。
7. 在正常 ChatGPT 对话中让它调用 `workspace_info`，确认返回的是当前工作区。

常用页面：

```text
https://chatgpt.com/#settings/Security
https://chatgpt.com/plugins
https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins
```

## 日常使用方式

重新授权 `execution.write` 后，推荐直接使用：

```text
ChatGPT 网页
    | submit_codex_task(goal)
    v
C2C Bridge ----> 本地 Codex CLI ----> 工作区修改/测试
    ^                                      |
    | codex_task_status / execution_output |
    +--------------- git_diff -------------+
```

远程任务使用非交互 `codex exec`，固定为 `workspace-write` 沙箱、
`never` 审批模式、临时会话并关闭网络访问；同一工作区同时只允许一个远程任务。
任务结束后 ChatGPT 应继续通过 `git_diff` 独立审查结果。

原来的 INIT / PLAN / EXECUTED 人工复制流程仍保留，适用于没有授权
`execution.write` 的旧 Connector 或作为故障回退。

ChatGPT 会自己通过 MCP 调用：

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`
- `execution_output`

## CLI-only 的控制方式

本分支仍然不尝试自动点击 ChatGPT 网页，也不依赖 Codex Desktop。
不同之处是：执行控制现在可以通过受限 MCP 工具直接派发给本地 `codex exec`，
因此正常开发回合不再必须人工搬运 PLAN。人工 C2C 消息仅作为兼容和恢复路径。

## 常用命令

```bash
c2c start -w <workspace> --tunnel
c2c doctor -w <workspace>
c2c pair -w <workspace>
c2c record -w <workspace> ...
c2c session -w <workspace> --json
c2c status -w <workspace>
c2c unpair -w <workspace>
c2c stop -w <workspace>
```

如果你有 Cloudflare 域名，建议使用固定地址：

```bash
c2c tunnel choose -w <workspace> --mode named --zone example.com --json
```

如果使用默认 Quick Tunnel，重启后地址可能变化。此时
`c2c doctor` 会返回 `chatgptRepair.needed`，你只需要删除当前工作区旧的
Connector，并使用新地址重新创建同名 Connector。

## 安全模型

执行能力采用独立授权和受限任务派发：

- 原有读取工具继续保留 workspace 边界、realpath 校验和敏感文件过滤；
- 远程执行必须额外获得 `execution.write` OAuth scope；
- 不提供裸 Shell、直接写文件、安装包或 git commit 类型 MCP 原语；
- 每个任务由本地 Codex CLI 在 `workspace-write` 沙箱内执行，关闭网络访问；
- 同时只允许一个远程任务，并设置超时；
- Codex 输出仍需经过本地 sanitizer 后才能通过 `execution_output` 返回。

升级已有 Connector 后需要重新授权一次，旧 token 不会自动得到执行权限。

完整说明见 [docs/security.md](docs/security.md)。

## 开发

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm test
```

相关文档：

- [架构](docs/architecture.md)
- [协议](docs/protocol.md)
- [安全](docs/security.md)
- [故障排查](docs/troubleshooting.md)

## 来源

本仓库是
[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
的 CLI-only fork。

原项目和本 fork 都属于非官方社区项目，与 OpenAI 无关联，未获 OpenAI 背书。

## License

MIT
