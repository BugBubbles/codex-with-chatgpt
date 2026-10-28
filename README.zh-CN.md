# Codex with ChatGPT — local-mcp 分支

此分支为每个本地 Streamable HTTP MCP 服务提供一个独立的 ChatGPT OAuth 插件。不会把多个服务的工具合并进同一个插件，也不会暴露 C2C 自带的 workspace、Git、Python 或执行工具。

运行 `c2c setup` 后，Bridge 会发现本机 loopback 上的 MCP 服务，并为每个服务输出独立 URL，例如 `https://<隧道域名>/mcp/llm-for-zotero`。ChatGPT 请求 `tools/list` 时，Bridge 会从该 URL 对应的本地 MCP 服务读取最新工具定义，并原样返回工具名，不加前缀、不改写。没有配置 `name` 的服务会根据 endpoint 生成稳定 ID。

在 ChatGPT 中为列表里的每个 URL 分别添加 OAuth 插件。打开某个插件的授权页后，为对应服务生成一次性配对码：

```bash
c2c pair --server <id>
```

每个插件的配对码和 OAuth token 只允许访问对应 MCP 服务。请逐个完成授权。旧的汇总地址 `/mcp` 已不再提供工具；添加完独立插件后，请从 ChatGPT 删除旧汇总插件。

## 使用

```bash
git checkout local-mcp
corepack pnpm install
corepack pnpm build
c2c setup -w <用于保存连接状态的本地目录>
```

默认自动发现：

- host：`127.0.0.1`
- port：`1-65535`
- path：`/mcp`

## 可选发现配置

- `C2C_LOCAL_MCP_ENDPOINTS`：分号或逗号分隔的 loopback URL，例如 `http://127.0.0.1:8765/mcp;http://127.0.0.1:9000/custom`
- `C2C_LOCAL_MCP_HOSTS`：默认 `127.0.0.1`
- `C2C_LOCAL_MCP_PORTS`：例如 `3000,5173,8000-9000,9999`
- `C2C_LOCAL_MCP_PATHS`：默认 `/mcp`
- `C2C_LOCAL_MCP_SCAN_CONCURRENCY`
- `C2C_LOCAL_MCP_CONNECT_TIMEOUT_MS`
- `C2C_LOCAL_MCP_PROBE_TIMEOUT_MS`
- `C2C_LOCAL_MCP_PROBE_CONCURRENCY`
- `C2C_LOCAL_MCP_SERVERS`：具名服务的 JSON 配置；支持用环境变量名引用 Bearer token

具名服务配置示例：

```json
[
  {
    "name": "llm-for-zotero",
    "endpoint": "http://127.0.0.1:23119/llm-for-zotero/mcp",
    "bearerTokenEnv": "LLM_FOR_ZOTERO_BEARER_TOKEN",
    "imageArtifactPathMappings": [
      {
        "from": "D:\\ProgramData\\Zotero\\llm-for-zotero-mineru",
        "to": "/mnt/d/ProgramData/Zotero/llm-for-zotero-mineru"
      }
    ]
  }
]
```

`bearerTokenEnv` 只保存环境变量名，token 本身不会写入状态文件。服务名用于该插件的 URL 路径和推荐名称。工具名与原始 MCP 接口完全一致；调用时也使用同一个原名转发。图像 artifact 按显式目录映射读取，并作为标准 MCP image block 返回。

多个服务共用同一个本地 Bridge 和 Cloudflare 隧道，但分别使用 `/mcp/<id>` 路径。工具调用只路由到 URL 对应的服务；同名工具可以在不同插件中各自保留原名。写工具的 schema 和调用结果也由对应服务原样提供并转发。

发现结果保存在用户状态目录。再次运行 `c2c setup` 会重新发现服务并输出最新插件 URL。服务增删后需重新运行 setup；工具定义则会在 ChatGPT 请求 `tools/list` 时从对应 MCP 更新。授权每个服务时，需在对应的 OAuth 授权页打开后运行 `c2c pair --server <id>`。

## 安全边界

- 每个 OAuth token 绑定到一个具体 MCP 资源，不能跨插件调用其他服务。
- 本地 MCP 的 Bearer token 只用于 Bridge 到该本地 MCP 的连接，不会转发公网 OAuth token。
- 自动发现只扫描 loopback 地址。
- 每个公网 MCP 路径只代理对应服务提供的 `initialize`、`ping`、`tools/list`、`tools/call` 和通知；不会合并其他服务或 Bridge 内置工具。
- 图像 artifact 只从显式配置的本地映射目录读取。
