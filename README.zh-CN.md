# Codex with ChatGPT — local-mcp 分支

这个分支把原有的 OAuth、配对码和 Cloudflare Tunnel 变成一个**本地 Streamable HTTP MCP 聚合桥**。

它不再把 workspace、Git、Python、Conda 或 Codex 工具暴露给远程网页。执行 `c2c setup` 时，Bridge 会自动扫描本机 loopback 上正在监听的端口，尝试连接其中的 Streamable HTTP MCP 服务并读取它们的 `tools/list`。远程 ChatGPT 看到的是实际发现到的本地 MCP 工具，而不是代码里预先写死的一组工具或端口。

## 使用

```bash
git checkout local-mcp
corepack pnpm install
corepack pnpm build
c2c setup -w <用于保存连接状态的本地目录>
```

配置输出会显示发现了多少个本地 MCP 服务和工具，然后给出公网 MCP 地址与配对码。

默认自动发现：

- host：`127.0.0.1`
- port：完整的 `1-65535`
- path：`/mcp`

这里的端口不是 allow-list；扫描范围可以自由调整。自定义 path、IPv6-only 服务或不希望扫描的场景，也可以通过显式 endpoint 配置。

## 可选发现配置

以下环境变量不是必须的，只用于加速扫描或覆盖特殊本地部署：

- `C2C_LOCAL_MCP_ENDPOINTS`：逗号或分号分隔的完整 loopback URL，例如 `http://127.0.0.1:23120/mcp;http://127.0.0.1:8765/custom`
- `C2C_LOCAL_MCP_HOSTS`：默认 `127.0.0.1`；需要 IPv6 时可加入 `::1`
- `C2C_LOCAL_MCP_PORTS`：例如 `3000,5173,8000-9000,23120`；默认 `1-65535`
- `C2C_LOCAL_MCP_PATHS`：自动扫描开放端口时尝试的 path，默认 `/mcp`
- `C2C_LOCAL_MCP_SCAN_CONCURRENCY`：TCP 端口扫描并发
- `C2C_LOCAL_MCP_CONNECT_TIMEOUT_MS`：TCP 探测超时
- `C2C_LOCAL_MCP_PROBE_TIMEOUT_MS`：MCP initialize / tools/list 探测超时
- `C2C_LOCAL_MCP_PROBE_CONCURRENCY`：MCP 端点探测并发

显式 endpoint 必须是本机 loopback HTTP 地址，但端口和 path 不受代码中的固定列表限制。

## 多 MCP 聚合

多个本地 MCP 可以同时存在。工具名全局唯一时会原样暴露；如果不同 MCP 提供相同工具名，Bridge 会只对冲突项自动生成带来源的稳定别名，从而保证所有工具都能被远程调用，而不是静默覆盖其中一个。

发现结果会保存在用户状态目录。Bridge 重启时会快速恢复已发现的 endpoint；再次运行 `c2c setup` 会重新扫描并刷新工具表。

## 安全边界

- 公网 OAuth Bearer Token 不会转发给任何本地 MCP。
- 自动发现只扫描 loopback，不会把代理变成任意内网/公网 SSRF。
- 公网 MCP 只暴露 `initialize`、`ping`、`tools/list`、`tools/call` 和必要通知；resources、prompts 等其他 MCP 能力不会透出。
- 本地 MCP 的工具定义和调用结果由对应 MCP 服务本身负责。

## 开发

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```
