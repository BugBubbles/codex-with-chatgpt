import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexChildEnv } from "../src/execution/codex-tasks.js";
import { cleanup, makeTmpDir } from "./helpers.js";

describe("buildCodexChildEnv", () => {
  it("isolates Linux Codex temp state from inherited app-server mounts", () => {
    const root = makeTmpDir("codex-child-env");
    const codexTmp = path.join(root, "codex-tmp");

    try {
      const env = buildCodexChildEnv(
        {
          PATH: "/usr/bin",
          HOME: "/home/tester",
          CODEX_HOME: "/home/tester/.codex",
          C2C_CODEX_TMPDIR: codexTmp,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode",
          CODEX_SESSION_ID: "old-session",
          CODEX_THREAD_ID: "old-thread",
          CODEX_PERMISSION_PROFILE: ":workspace",
          CODEX_SANDBOX_NETWORK_DISABLED: "1",
          VSCODE_IPC_HOOK_CLI: "/tmp/vscode-ipc.sock",
          VSCODE_GIT_ASKPASS_NODE: "/opt/vscode/node",
        },
        "linux"
      );

      expect(env.C2C_REMOTE_TASK).toBe("1");
      expect(env.TMPDIR).toBe(path.resolve(codexTmp));
      expect(env.TMP).toBe(path.resolve(codexTmp));
      expect(env.TEMP).toBe(path.resolve(codexTmp));
      expect(fs.statSync(codexTmp).isDirectory()).toBe(true);

      expect(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
      expect(env.CODEX_SESSION_ID).toBeUndefined();
      expect(env.CODEX_THREAD_ID).toBeUndefined();
      expect(env.CODEX_PERMISSION_PROFILE).toBeUndefined();
      expect(env.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();
      expect(env.VSCODE_IPC_HOOK_CLI).toBeUndefined();

      // Keep user configuration and unrelated Git credential helpers.
      expect(env.CODEX_HOME).toBe("/home/tester/.codex");
      expect(env.VSCODE_GIT_ASKPASS_NODE).toBe("/opt/vscode/node");
    } finally {
      cleanup(root);
    }
  });

  it("does not rewrite temp variables on non-Linux platforms", () => {
    const env = buildCodexChildEnv(
      {
        TMPDIR: "/existing/tmpdir",
        TMP: "/existing/tmp",
        TEMP: "/existing/temp",
        CODEX_SESSION_ID: "old-session",
      },
      "darwin"
    );

    expect(env.TMPDIR).toBe("/existing/tmpdir");
    expect(env.TMP).toBe("/existing/tmp");
    expect(env.TEMP).toBe("/existing/temp");
    expect(env.CODEX_SESSION_ID).toBeUndefined();
    expect(env.C2C_REMOTE_TASK).toBe("1");
  });
});
