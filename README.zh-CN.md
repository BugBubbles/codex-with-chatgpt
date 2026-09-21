# Codex with ChatGPT — CLI-only 分支

> ChatGPT 负责思考，Codex CLI 负责干活。

这是 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
的 **Codex CLI-only** 改造版本，目标是：

**只安装 Codex CLI，不安装 Windows Codex 桌面版，也不依赖 ChatGPT 桌面版。**

底层 C2C Bridge、OAuth、Cloudflare Tunnel、工作区隔离和只读 MCP 安全模型
保持不变。变化的是“控制面”：原版依赖内置浏览器自动操作 ChatGPT；本分支改为
由你在普通浏览器中操作 ChatGPT Web，只复制很短的 C2C 状态消息。

## 主要变化

- 不依赖 Codex Desktop。
- 不依赖 ChatGPT Desktop。
- 不使用 `control-in-app-browser`。
- 不使用 `agent.browsers` 或 Computer Use。
- Codex CLI 继续负责改代码、Shell、Git、测试。
- ChatGPT 继续通过只读 MCP 自己读取代码、diff 和测试记录。
- 你只需要在终端与 ChatGPT 网页之间复制少量 `[C2C]` 控制消息。
- **不需要复制文件正文、diff 或日志。**

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

数据读取仍然是自动的：

```text
ChatGPT 网页
    |
    | 只读 MCP
    v
C2C Bridge ----> 本地工作区
                    ^
                    |
              Codex CLI 修改/测试
```

只有控制消息需要人工交接：

```text
Codex CLI -> [C2C] INIT      -> 粘贴到 ChatGPT
ChatGPT   -> [C2C] PLAN      -> 粘贴回 Codex CLI
Codex CLI -> 执行修改和测试
Codex CLI -> [C2C] EXECUTED  -> 粘贴到 ChatGPT
ChatGPT   -> PLAN / DONE     -> 粘贴回 Codex CLI
```

这些消息通常很短，只包含任务状态、目标、测试摘要等信息。

**代码内容不会通过复制粘贴来回传输。**

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

## 为什么不能做到完全无人值守

原版项目把 ChatGPT 网页自动化建立在 Codex 的内置浏览器能力之上。

Codex CLI 本身没有这套浏览器控制面，因此 CLI-only 模式如果仍然宣称可以
自动点击 ChatGPT 页面，会形成错误依赖。

本分支选择保留真正有价值的部分：

**Codex CLI 自动执行 + ChatGPT MCP 自动读取**

而把浏览器操作明确变成少量人工交接。

代价是每轮 PLAN/REVIEW 需要复制一两次很短的 C2C 消息；好处是完全不需要安装
Codex 桌面版。

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

继续沿用原项目的安全边界：

- ChatGPT 侧不存在写文件、删文件、Shell、commit 类型 MCP 工具；
- 一个 token 绑定一个 workspace；
- realpath 校验阻止 `../`、symlink 等路径逃逸；
- `.env`、SSH key、credentials 等敏感文件默认禁止读取；
- `.c2cignore` 可以继续增加屏蔽规则；
- 浏览器只会接触短期一次性配对码；
- 测试输出通过 `execution_output` 暴露前先在本地脱敏。

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
