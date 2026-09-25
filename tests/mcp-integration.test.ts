import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git, isolateStateDir } from "./helpers.js";

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;
let stateDir: string;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

function structuredJsonOf<T = Record<string, unknown>>(result: { content?: unknown; structuredContent?: unknown }): T {
  const parsed = jsonOf<T>(result);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function executionBrief(title = "Implement the requested workspace change") {
  return {
    title,
    objective:
      "Complete the requested workspace change as one coherent implementation batch and leave the project in a validated, reviewable state.",
    current_state:
      "ChatGPT Web has inspected the relevant workspace state and identified the files and validation surface needed for this integration-test execution.",
    diagnosis:
      "The requested change is self-contained. The local Codex worker should execute the prescribed edits and validation directly instead of performing a new planning phase or splitting the work into separate tasks.",
    implementation_steps: [
      {
        title: "Apply the implementation",
        instructions:
          "Carry out the requested change in the current workspace exactly as described by the objective. Keep the edit localized, preserve existing behavior outside the requested scope, and finish all implementation work in this same Codex turn.",
        files: ["remote-task.txt"],
        commands: [],
        verification:
          "Verify the requested workspace artifact exists with the expected contents before reporting the turn complete.",
      },
    ],
    validation_plan: ["Check the resulting workspace artifact and report any execution failure in the final Codex output."],
    success_criteria: ["The requested artifact exists and the Codex task exits successfully without leaving an unresolved blocker."],
    constraints: ["Remain inside the current workspace, keep network access disabled, and do not commit or push changes."],
    risks: ["Do not replace the requested implementation with a planning-only response."],
  };
}

function expectToolOutputSchema(
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  name: string,
  properties: string[]
): void {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  expect(schema?.type).toBe("object");
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(properties));
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  const codexStub = write(
    stateDir,
    "codex-stub.mjs",
    `import fs from "node:fs";
const argv = process.argv.slice(2);
const isResume = argv.includes("resume");
for (const value of ["exec", "--json", "--skip-git-repo-check"]) {
  if (!argv.includes(value)) {
    process.stderr.write("missing expected arg: " + value + "\\n");
    process.exit(2);
  }
}
if (argv.includes("--ephemeral")) {
  process.stderr.write("remote tasks must not use ephemeral sessions\\n");
  process.exit(2);
}
const configPairs = argv.flatMap((value, index) => value === "--config" ? [argv[index + 1]] : []);
if (!configPairs.includes('approval_policy="on-request"') || !configPairs.includes("sandbox_workspace_write.network_access=false")) {
  process.stderr.write("missing security config override\\n");
  process.exit(2);
}
if (isResume) {
  const resumeIndex = argv.indexOf("resume");
  if (argv[resumeIndex + 1] !== "c2c-test-thread") {
    process.stderr.write("wrong resumed thread id\\n");
    process.exit(2);
  }
  if (!configPairs.includes('sandbox_mode="workspace-write"')) {
    process.stderr.write("resume must reapply workspace-write sandbox via config\\n");
    process.exit(2);
  }
} else if (!argv.includes("--sandbox") || !argv.includes("workspace-write") || !argv.includes("--cd")) {
  process.stderr.write("initial task missing workspace sandbox/cwd args\\n");
  process.exit(2);
}
const invocationLog = process.env.C2C_STATE_DIR + "/codex-invocations.jsonl";
fs.appendFileSync(invocationLog, JSON.stringify({ argv, isResume }) + "\\n");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString();
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "c2c-test-thread" }) + "\\n");
if (prompt.includes("C2C_TEST_SLOW")) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
} else {
  fs.writeFileSync("remote-task.txt", "written by remote codex task\\n");
}
process.stdout.write(JSON.stringify({ type: "result", promptReceived: prompt.length > 0 }) + "\\n");
`
  );
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, ".c2c.json", JSON.stringify({ codexApprovalPolicy: "on-request" }));
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
    codexCommand: process.execPath,
    codexArgsPrefix: [codexStub],
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read", "execution.write"],
  });
  accessToken = tokens.accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  cleanup(root);
});

describe("MCP tools over Streamable HTTP", () => {
  it("lists read tools plus scoped Codex task controls", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "cancel_codex_task",
      "clear_codex_session",
      "codex_task_status",
      "execution_output",
      "execution_summary",
      "git_diff",
      "git_status",
      "list_directory",
      "read_file",
      "search_workspace",
      "submit_codex_task",
      "test_status",
      "workspace_info",
    ]);
    // Still no raw filesystem or shell primitives: execution is mediated by Codex.
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }

    expectToolOutputSchema(tools, "workspace_info", ["workspaceId", "workspaceName", "projectType", "git", "execution"]);
    expectToolOutputSchema(tools, "list_directory", ["path", "entries", "total", "hasMore"]);
    expectToolOutputSchema(tools, "read_file", ["path", "content", "startLine", "endLine", "nextStartLine"]);
    expectToolOutputSchema(tools, "search_workspace", ["matches", "matchCount", "truncated", "engine"]);
    expectToolOutputSchema(tools, "git_status", ["isRepo", "branch", "staged", "unstaged", "untracked", "hidden"]);
    expectToolOutputSchema(tools, "git_diff", ["isRepo", "mode", "diff", "hasMore", "nextOffset"]);
    expectToolOutputSchema(tools, "test_status", ["available", "tests", "outputAvailable", "outputId"]);
    expectToolOutputSchema(tools, "execution_summary", ["records"]);
    expectToolOutputSchema(tools, "execution_output", ["action", "items", "text"]);
    expectToolOutputSchema(tools, "submit_codex_task", ["taskId", "status", "outputId", "threadId", "pollIntervalSeconds", "nextPollAt"]);
    expectToolOutputSchema(tools, "codex_task_status", ["taskId", "status", "outputId", "threadId", "pollIntervalSeconds", "nextPollAt"]);
    expectToolOutputSchema(tools, "cancel_codex_task", ["taskId", "status", "outputId", "threadId", "pollIntervalSeconds", "nextPollAt"]);
    expectToolOutputSchema(tools, "clear_codex_session", ["cleared", "previousThreadId", "sessionActive"]);
  });

  it("documents git_diff pagination with its output field names", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "git_diff")?.description;
    expect(description).toContain("hasMore");
    expect(description).toContain("nextOffset");
    expect(description).not.toContain("has_more");
    expect(description).not.toContain("next_offset");
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = structuredJsonOf<{
      workspaceId: string;
      projectType: string;
      frameworks: string[];
      git: { isRepo: boolean; branch: string };
      execution: {
        persistentSession: boolean;
        pollIntervalSeconds: number;
        approvalPolicy: "never" | "on-request";
        sessionActive: boolean;
      };
    }>(result);
    expect(info.workspaceId).toBe(bridge.workspace.id);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
    expect(info.execution).toEqual({
      persistentSession: true,
      pollIntervalSeconds: 180,
      approvalPolicy: "on-request",
      sessionActive: false,
    });
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = structuredJsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = structuredJsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = structuredJsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = structuredJsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = structuredJsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = structuredJsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = structuredJsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");

    const status = structuredJsonOf<{ available: boolean; tests: string; outputAvailable: boolean; outputId: number | null }>(
      await client.callTool({ name: "test_status", arguments: {} })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.outputAvailable).toBe(false);
    expect(status.outputId).toBeNull();
  });

  it("skips invalid persisted records when reporting execution status", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_valid_before_invalid",
      iteration: 2,
      changedFiles: 0,
      tests: "31 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    fs.appendFileSync(
      path.join(stateDir, "executions", `${bridge.workspace.id}.jsonl`),
      JSON.stringify({
        taskId: "c2c_invalid",
        iteration: null,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      }) + "\n"
    );

    const statusResult = await client.callTool({ name: "test_status", arguments: {} });
    expect(statusResult.isError ?? false).toBe(false);
    const status = structuredJsonOf<{ taskId: string; iteration: number }>(statusResult);
    expect(status.taskId).toBe("c2c_valid_before_invalid");
    expect(status.iteration).toBe(2);

    const summaryResult = await client.callTool({ name: "execution_summary", arguments: { limit: 1 } });
    expect(summaryResult.isError ?? false).toBe(false);
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(summaryResult);
    expect(summary.records.map((record) => record.taskId)).toEqual(["c2c_valid_before_invalid"]);
  });

  it("execution_output lists readable items and refuses restricted bodies", async () => {
    const readable = saveExecutionOutput(bridge.workspace.id, {
      command: "pnpm test",
      raw: "FAIL src/a.test.ts\nAssertionError: expected true",
      exitCode: 1,
    });
    const hidden = saveExecutionOutput(bridge.workspace.id, {
      command: "print-key",
      raw: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      exitCode: 0,
    });
    const listResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    const list = structuredJsonOf<{
      action: "list";
      items: { id: number; status: string; command: string; text?: string }[];
    }>(listResult);
    expect(list.action).toBe("list");
    expect(list.items.some((item) => item.id === readable.id && item.status === "readable")).toBe(true);
    expect(list.items.some((item) => item.id === hidden.id && item.status === "restricted")).toBe(true);
    expect(list.items.every((item) => item.text === undefined)).toBe(true);

    const readResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: readable.id },
    });
    const body = structuredJsonOf<{ action: "read"; text: string }>(readResult);
    expect(body.action).toBe("read");
    expect(body.text).toContain("AssertionError");

    const denied = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: hidden.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("OUTPUT_RESTRICTED");
    expect(textOf(denied)).not.toContain("BEGIN RSA");

    const missing = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: 999999 },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("submits a Codex task, observes completion, and exposes sanitized output", async () => {
    const submitted = structuredJsonOf<{ taskId: string; status: string; pollIntervalSeconds: number; nextPollAt: string | null }>(
      await client.callTool({
        name: "submit_codex_task",
        arguments: { execution_brief: executionBrief("Create remote-task.txt for the integration test") },
      })
    );
    expect(submitted.status).toBe("running");
    expect(submitted.pollIntervalSeconds).toBe(180);
    expect(submitted.nextPollAt).toEqual(expect.any(String));

    for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(root, "remote-task.txt")); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const terminal = structuredJsonOf<{
      taskId: string;
      status: string;
      outputId: number | null;
      threadId: string | null;
      nextPollAt: string | null;
    }>(
      await client.callTool({ name: "codex_task_status", arguments: { task_id: submitted.taskId } })
    );
    expect(terminal.status).toBe("succeeded");
    expect(terminal.outputId).toEqual(expect.any(Number));
    expect(terminal.threadId).toBe("c2c-test-thread");
    expect(terminal.nextPollAt).toBeNull();
    expect(fs.readFileSync(path.join(root, "remote-task.txt"), "utf8")).toContain("written by remote codex task");

    const output = structuredJsonOf<{ action: string; text: string }>(
      await client.callTool({
        name: "execution_output",
        arguments: { action: "read", id: terminal.outputId! },
      })
    );
    expect(output.text).toContain("promptReceived");
  });

  it("cancels a running Codex task", async () => {
    const submitted = structuredJsonOf<{ taskId: string; threadId: string | null }>(
      await client.callTool({
        name: "submit_codex_task",
        arguments: {
          execution_brief: {
            ...executionBrief("Exercise cancellation on the persistent Codex thread"),
            implementation_steps: [
              {
                ...executionBrief().implementation_steps[0],
                instructions:
                  "C2C_TEST_SLOW. Remain in this execution turn long enough for the integration test to issue cancellation while preserving the same persistent Codex thread and without starting a new planning phase.",
              },
            ],
          },
        },
      })
    );
    expect(submitted.threadId).toBe("c2c-test-thread");
    let invocations: { isResume: boolean }[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      const invocationFile = path.join(stateDir, "codex-invocations.jsonl");
      if (fs.existsSync(invocationFile)) {
        invocations = fs
          .readFileSync(invocationFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { isResume: boolean });
      }
      if (invocations.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    expect(invocations.at(-1)?.isResume).toBe(true);

    const tooEarly = await client.callTool({
      name: "codex_task_status",
      arguments: { task_id: submitted.taskId },
    });
    expect(tooEarly.isError).toBe(true);
    expect(textOf(tooEarly)).toContain("POLL_TOO_EARLY");
    expect(textOf(tooEarly)).toContain("Do not poll again before");

    const clearWhileRunning = await client.callTool({
      name: "clear_codex_session",
      arguments: {},
    });
    expect(clearWhileRunning.isError).toBe(true);
    expect(textOf(clearWhileRunning)).toContain("TASK_BUSY");

    const cancelling = structuredJsonOf<{ taskId: string; status: string }>(
      await client.callTool({
        name: "cancel_codex_task",
        arguments: { task_id: submitted.taskId },
      })
    );
    expect(cancelling.taskId).toBe(submitted.taskId);
    expect(["cancelling", "cancelled"]).toContain(cancelling.status);

    let terminalStatus = cancelling.status;
    for (let attempt = 0; attempt < 100 && terminalStatus === "cancelling"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      terminalStatus = structuredJsonOf<{ status: string }>(
        await client.callTool({ name: "codex_task_status", arguments: { task_id: submitted.taskId } })
      ).status;
    }
    expect(terminalStatus).toBe("cancelled");
  });

  it("clears the persistent Codex session locally and forces the next task to start fresh", async () => {
    const sessionFile = path.join(stateDir, "codex-sessions", `${bridge.workspace.id}.json`);
    expect(fs.existsSync(sessionFile)).toBe(true);

    const cleared = structuredJsonOf<{
      cleared: boolean;
      previousThreadId: string | null;
      sessionActive: false;
    }>(
      await client.callTool({
        name: "clear_codex_session",
        arguments: {},
      })
    );

    expect(cleared).toEqual({
      cleared: true,
      previousThreadId: "c2c-test-thread",
      sessionActive: false,
    });
    expect(fs.existsSync(sessionFile)).toBe(false);

    const infoAfterClear = structuredJsonOf<{ execution: { sessionActive: boolean } }>(
      await client.callTool({ name: "workspace_info", arguments: {} })
    );
    expect(infoAfterClear.execution.sessionActive).toBe(false);

    const invocationFile = path.join(stateDir, "codex-invocations.jsonl");
    const beforeCount = fs
      .readFileSync(invocationFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean).length;

    const submitted = structuredJsonOf<{ taskId: string; threadId: string | null }>(
      await client.callTool({
        name: "submit_codex_task",
        arguments: { execution_brief: executionBrief("Start a fresh Codex thread after clearing the saved session") },
      })
    );
    expect(submitted.threadId).toBeNull();

    let invocations: { isResume: boolean }[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fs.existsSync(invocationFile)) {
        invocations = fs
          .readFileSync(invocationFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { isResume: boolean });
      }
      if (invocations.length > beforeCount) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(invocations.length).toBeGreaterThan(beforeCount);
    expect(invocations.at(-1)?.isResume).toBe(false);

    for (let attempt = 0; attempt < 100 && !fs.existsSync(sessionFile); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(sessionFile)).toBe(true);
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const outputDenied = await limitedClient.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    expect(outputDenied.isError).toBe(true);
    expect(textOf(outputDenied)).toContain("INSUFFICIENT_SCOPE");
    const executeDenied = await limitedClient.callTool({
      name: "submit_codex_task",
      arguments: { execution_brief: executionBrief("This must not run") },
    });
    expect(executeDenied.isError).toBe(true);
    expect(textOf(executeDenied)).toContain("INSUFFICIENT_SCOPE");
    const clearDenied = await limitedClient.callTool({
      name: "clear_codex_session",
      arguments: {},
    });
    expect(clearDenied.isError).toBe(true);
    expect(textOf(clearDenied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });
});
