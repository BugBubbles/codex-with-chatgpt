# C2C Agent Protocol

Preferred control plane: scoped MCP task dispatch (`submit_codex_task` / `codex_task_status` /
`cancel_codex_task`) when the connector has `execution.write`.
Data plane: MCP read tools for files, diffs, search results and sanitized execution output.
Manual browser handoff remains the fallback protocol for old/read-only connectors.

Never expose raw shell commands through the protocol. Direct mode carries a structured,
web-authored execution brief; manual control messages carry state, never file bodies,
diffs or logs.

## Direct execution mode

When `submit_codex_task` is available and the user asks ChatGPT to implement or modify
workspace code, direct mode is a **planner → executor → reviewer** pipeline:

- **ChatGPT Web = planner/reviewer.** It owns deep reasoning, log/data analysis,
  diagnosis, architecture decisions, implementation planning and final review.
- **Local Codex CLI = executor.** It primarily follows the web-authored execution
  document, edits files, runs local commands and resolves ordinary implementation
  failures. Assume the local model may be materially weaker than the web model.
- **C2C Bridge = bounded control plane.** It preserves workspace/sandbox/auth
  boundaries and keeps the executor on one persistent Codex thread.

### Required dispatch procedure

1. Inspect enough relevant code, configuration, git state, diffs and released
   execution output to understand the user's **complete** goal. "Minimum necessary"
   does not mean stopping at the first plausible symptom.
2. Finish the heavy analysis on ChatGPT Web before dispatch. Do not send a vague
   request such as "investigate", "figure out the architecture", or "fix this file"
   when the web side can determine the required plan itself.
3. Construct one `execution_brief` with all required fields:
   - title;
   - complete objective;
   - verified current state/evidence;
   - web-side diagnosis and reasoning;
   - ordered implementation steps, each with exact instructions, likely files,
     local commands and a concrete verification condition;
   - validation plan;
   - success criteria;
   - constraints;
   - known risks/regression checks.
4. Treat the brief as an **authoritative formatted implementation document for a
   lower-capability executor**. Be explicit about what to change and how. Do not
   rely on local Codex to rediscover the root cause, choose the architecture, or
   perform the main planning.
5. Dispatch the entire coherent implementation batch with one
   `submit_codex_task` call. Do not split one user goal into separate tasks by
   file, symptom, or plan step merely to make each task small.
6. The first task creates a saved Codex thread; subsequent tasks resume the exact
   same `thread_id`. A resume that reports a different thread id is a continuity
   failure and must not be treated as a successful continuation.
7. While the task is running, respect `nextPollAt` /
   `pollIntervalSeconds`. The default is 180 seconds (3 minutes), configurable
   through `.c2c.json`. Do not busy-poll.
8. When terminal, read `execution_output` if released, then independently inspect
   `git_diff` and relevant files. Review all success criteria together.
9. Submit another Codex task only for a concrete residual issue that was genuinely
   unforeseen, blocked, or could not reasonably be included in the prior brief.
   The corrective task should again be one coherent execution brief.
10. Use `cancel_codex_task` if the user asks to stop or the task is clearly no
    longer appropriate.

Only one remotely submitted task can run at a time. Cancellation may briefly report
`cancelling` while the Codex process group is being terminated; no new task is admitted
until that process has actually exited. A completed task may have partial edits
even when its status is `failed` or `cancelled`, so review git state in every terminal case.

### Persistent Codex thread

Direct-mode remote execution intentionally does **not** use `--ephemeral`.

- First dispatch: `codex exec ...`; capture and persist `thread.started.thread_id`.
- Later dispatches: `codex exec resume <thread_id> ...`.
- Resume turns reapply the workspace-write sandbox through config and force network
  access off again.
- If the expected thread id and observed `thread.started.thread_id` differ, the
  bridge clears the stale saved id, fails the task and requires review before a
  fresh dispatch. It never silently accepts context loss.

Per-workspace execution configuration:

```json
{
  "pollIntervalSeconds": 180,
  "codexApprovalPolicy": "on-request"
}
```

`pollIntervalSeconds` is clamped to 30–3600 seconds; omitted value: 180 seconds.
`codexApprovalPolicy` accepts only `"never"` (default) or `"on-request"`. It is
local-only configuration and is intentionally absent from `submit_codex_task`, so the
remote planner cannot enable approval escalation.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step). Those values are not ChatGPT protocol states. ChatGPT still sees
only the table above. If the original chat is gone, Codex sends HANDOFF
built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint automatically.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Create an implementation plan for Codex.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`. Command output
is a separate opt-in: `execution_output` (`list` then `read`). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Old records without output
stay valid. Never paste logs into the control message.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (Codex → new ChatGPT conversation)

`c2c session --json` → `conversation.mode` chooses how chats are grouped.

- **long-chat:** one long-lived C2C conversation per workspace. Codex opens a
  replacement chat only when the user asks, the old chat lags, or the chat was
  lost.
- **project:** one ChatGPT Project (collection) per workspace. A new Codex
  conversation starts a new chat **inside that Project**. The same Codex
  conversation keeps using its saved chat URL.

Right after the user pastes the boot prompt, Codex produces a HANDOFF for the user to paste so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns execution.
You own high-level reasoning, planning and review.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Use MCP to inspect enough relevant code, git state, diffs and released
   execution output to understand the whole user goal before dispatching.
3. You own deep reasoning: root-cause analysis, log/data analysis,
   architecture decisions, implementation planning and review belong on
   ChatGPT Web. Do not delegate those tasks to the local Codex worker.
4. Prefer one coherent execution batch per user goal. Do not split work by
   file, symptom, or implementation step merely to keep tasks small.
5. Before calling submit_codex_task, produce its complete structured
   execution_brief: objective, verified current state, diagnosis, exact
   ordered implementation steps, files, local commands, per-step
   verification, validation plan, success criteria, constraints and risks.
   Write it so a lower-capability executor can implement without inventing
   the architecture or plan.
6. If submit_codex_task is available and execution is authorized, dispatch
   that complete brief directly; otherwise use the manual C2C PLAN flow.
7. After submission, respect nextPollAt/pollIntervalSeconds and do not
   busy-poll codex_task_status. Default cadence is 180 seconds.
8. After any Codex task completes or Codex reports EXECUTED, independently
   inspect execution_output when readable, git_diff and relevant files.
9. Do not assume an implementation succeeded just because Codex says so.
10. Submit a corrective Codex task only for a concrete residual issue that
    was unforeseen or blocked; again use one complete execution brief.
11. Continue until the implementation satisfies the full success criteria.
12. Avoid unnecessary rewrites.
13. Return C2C structured control messages only when using the manual fallback flow.
14. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
15. If this chat sits in a ChatGPT Project, use only the connector named
    in that Project's instructions. Do not use another workspace's connector.
```

## Project instructions

New workspaces store durable identity in the ChatGPT Project settings
(指令), not in every boot prompt. In CLI-only mode the user can paste this template into Project instructions once.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_output (list, then read) when a readable item
exists; if status is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the
brief, re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Own the planning burden. Before direct execution, inspect the relevant
workspace evidence and prepare one detailed implementation brief for the
entire coherent goal. Specify why, exact files, exact implementation steps,
local commands, per-step verification, validation, success criteria and
risks so a lower-capability local Codex can execute rather than plan.
Respect nextPollAt/pollIntervalSeconds (default 180 seconds) instead of
busy-polling. Use C2C control messages only for the manual fallback flow.
```
