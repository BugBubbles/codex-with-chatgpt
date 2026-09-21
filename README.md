# Codex with ChatGPT — CLI-only fork

> ChatGPT thinks. Codex CLI works.

This fork adapts [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)
for users who want **Codex CLI only** and do not want to install the Codex or
ChatGPT desktop app.

The local bridge, OAuth, Cloudflare tunnel, workspace isolation and read-only
MCP model remain intact. The difference is the control plane: instead of
requiring an in-app browser, the user operates normal ChatGPT Web and copies
only small structured C2C messages between ChatGPT and the terminal.

中文说明见 [README.zh-CN.md](README.zh-CN.md).

## What changed

- No dependency on Codex Desktop or ChatGPT Desktop.
- No `control-in-app-browser`, `agent.browsers` or Computer Use requirement.
- Codex CLI still performs editing, shell, git and tests.
- ChatGPT Web still reads code/diffs/test records through the read-only MCP connector.
- The user manually handles connector setup and copies small `[C2C]` messages.
- File bodies, diffs and logs are **not** copied through the chat control plane.

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

The data plane stays automatic:

```text
ChatGPT Web
    |
    | read-only MCP
    v
C2C Bridge ----> local workspace
                    ^
                    |
              Codex CLI edits/tests
```

The control plane is manual and deliberately tiny:

```text
Codex CLI -> [C2C] INIT      -> paste into ChatGPT
ChatGPT   -> [C2C] PLAN      -> paste back into Codex CLI
Codex CLI -> execute + test
Codex CLI -> [C2C] EXECUTED  -> paste into ChatGPT
ChatGPT   -> PLAN or DONE    -> paste back into Codex CLI
```

Only protocol state and summaries move through copy/paste. ChatGPT reads
actual files, git diffs and released test output directly through MCP.

## Why CLI-only is different

The upstream Skill automates ChatGPT Web using an in-app browser. Codex CLI
does not provide that browser surface. This fork therefore makes browser
handoff explicit instead of pretending CLI can automate a capability it does
not have.

The tradeoff is a few manual paste actions per planning/review round. The
benefit is that the coding side remains pure Codex CLI with no desktop-app
dependency.

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

The security model remains the upstream design:

- ChatGPT has no write/delete/shell/commit MCP tools.
- Tokens are scoped to one workspace.
- Canonical path containment blocks path escape.
- Sensitive files such as `.env`, private keys and credentials are denied.
- `.c2cignore` can add more exclusions.
- The browser receives only a short-lived one-time pairing code.
- Command output is sanitized locally before it can be exposed through
  `execution_output`.

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
