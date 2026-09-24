# Codex with ChatGPT — CLI-only fork

> ChatGPT thinks. Codex CLI works.

This fork adapts [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
for users who want **Codex CLI only** and do not want to install the Codex or
ChatGPT desktop app.

The local bridge, OAuth, Cloudflare tunnel and workspace isolation remain intact.
This branch now adds a narrow execution control plane on top of the existing
read-oriented MCP data plane: ChatGPT can submit a goal to the local Codex CLI,
query its status and cancel it without receiving a raw shell primitive.
Manual C2C message handoff remains available as a fallback.

中文说明见 [README.zh-CN.md](README.zh-CN.md).

## What changed

- No dependency on Codex Desktop or ChatGPT Desktop.
- No `control-in-app-browser`, `agent.browsers` or Computer Use requirement.
- Codex CLI still owns editing, shell, git and tests.
- ChatGPT Web reads code/diffs/test records through the existing read tools.
- With the `execution.write` OAuth scope, ChatGPT may call `submit_codex_task`,
  `codex_task_status` and `cancel_codex_task`.
- No generic `write_file` or `execute_shell` MCP tool is exposed.
- Manual `[C2C]` copy/paste remains a fallback when remote execution is not authorized.

## Requirements

- Codex CLI
- Node.js >= 20
- git
- `cloudflared` for the public MCP connection
- A ChatGPT account that can create/use developer-mode connectors

On Windows, `winget` can install missing prerequisites. No Windows Codex
desktop application is required.

## Install

Clone this fork:

```bash
git clone https://github.com/BugBubbles/codex-with-chatgpt.git
cd codex-with-chatgpt
git checkout cli-only
corepack pnpm install
corepack pnpm build
```

Install the Skill into your Codex home:

```text
~/.codex/skills/codex-with-chatgpt/SKILL.md
```

Copy `skill/SKILL.md` there and replace the line

```text
The codex-with-chatgpt checkout lives at: <ACTUAL_CHECKOUT_PATH>
```

with the real checkout path.

Then start Codex CLI in the repository you want to work on and say:

```text
使用 Codex with ChatGPT 完成首次配置。
```

The CLI-only Skill will perform local setup and tell you exactly what to do in
your normal browser.

## First-time browser setup

Codex CLI starts the bridge/tunnel and returns a connector name and MCP URL.
You manually:

1. Enable ChatGPT Developer mode if needed.
2. Create the connector with the exact name and MCP URL supplied by Codex.
3. Select OAuth.
4. When the authorization page asks for a pairing code, Codex runs
   `c2c pair` and gives you a fresh one-time code.
5. In a normal ChatGPT conversation, verify `workspace_info` returns the
   expected workspace name.

Useful ChatGPT pages:

- Developer mode: `https://chatgpt.com/#settings/Security`
- Plugins/connectors: `https://chatgpt.com/plugins`
- Create connector:
  `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`

## Normal workflow
> **WSL note:** the bridge launches `codex` in the same OS environment in which
> `c2c start` is running. If Codex CLI exists only inside WSL, start/build/run C2C
> inside that WSL environment (the normal CLI-only setup does this). A Windows-native
> bridge does not automatically jump into WSL. `C2C_CODEX_BIN` can override the local
> Codex executable path when needed.


Preferred direct workflow after authorizing `execution.write`:

```text
ChatGPT Web
    |  submit_codex_task(goal)
    v
C2C Bridge ----> local Codex CLI ----> workspace edits/tests
    ^                                      |
    | codex_task_status / execution_output |
    +--------------- git_diff -------------+
```

Remote tasks use non-interactive `codex exec` with the `workspace-write`
sandbox, approval policy `never`, an ephemeral Codex session, and network access
disabled. Only one remotely submitted task runs at a time. ChatGPT should review
`git_diff` after completion rather than trusting the task result blindly.

The original manual `[C2C]` INIT/PLAN/EXECUTED flow remains supported as a
fallback for connectors that have not been re-authorized with `execution.write`.

## Why CLI-only is different

The upstream Skill automates ChatGPT Web using an in-app browser. This fork does
not require that browser surface. The bridge can now dispatch bounded goals to
`codex exec` directly, while manual browser handoff remains available for setup,
recovery and users who prefer not to grant execution scope.

## CLI commands

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

For a stable hostname, use the existing Cloudflare named-tunnel workflow:

```bash
c2c tunnel choose -w <workspace> --mode named --zone example.com --json
```

A Quick Tunnel also works, but its URL can change after restart. When that
happens, `c2c doctor` reports `chatgptRepair.needed`; delete only that
workspace's old ChatGPT connector and create it again with the new URL.

## Security model

Execution is explicit and scoped rather than a generic remote shell:

- Existing read tools keep their current workspace/sensitive-file protections.
- Remote execution requires the separate `execution.write` OAuth scope.
- The MCP server exposes task submission/status/cancellation, not arbitrary shell,
  direct file-write, package-install or git-commit primitives.
- Each task runs Codex with `workspace-write`, no approval escalation and network
  access disabled; Codex is also instructed not to commit, push or expose secrets.
- Only one remote task may run at a time and tasks have a bounded timeout.
- Captured Codex output still passes through the existing local sanitizer before
  `execution_output` can return it.

Existing connectors must be re-authorized once to obtain `execution.write`.
See [docs/security.md](docs/security.md).

## Development

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm test
```

Documentation:

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)

## Attribution

This is a CLI-only fork of
[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt).
The original project and this fork are unofficial community projects and are
not affiliated with or endorsed by OpenAI.

## License

MIT
