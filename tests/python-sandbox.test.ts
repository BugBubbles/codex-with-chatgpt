import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executePython, pythonThreadPlan } from "../src/execution/python-runner.js";
import { nullLogger } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const supported = process.platform === "linux" && process.arch === "x64";
const sandboxIt = supported ? it : it.skip;
const unsupportedIt = supported ? it.skip : it;

describe("strict Python sandbox", () => {
  let stateDir = "";
  let root = "";
  let outside = "";
  let workspace: Workspace;

  beforeAll(() => {
    stateDir = isolateStateDir();
    root = makeTmpDir("python-sandbox-ws");
    outside = makeTmpDir("python-sandbox-outside");
    makeGitRepo(root);
    write(outside, "secret.txt", "OUTSIDE_SECRET_MUST_NOT_LEAK\n");
    workspace = new Workspace(root);
  });

  afterAll(() => {
    cleanup(root);
    cleanup(outside);
    cleanup(stateDir);
  });

  sandboxIt("runs Python with a verified sandbox handshake and workspace write access", async () => {
    const result = await executePython(workspace, nullLogger, {
      code: [
        "from pathlib import Path",
        "Path('sandbox-created.txt').write_text('ok\\n', encoding='utf-8')",
        "print('SANDBOX_OK')",
      ].join("\n"),
      timeoutSeconds: 30,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("SANDBOX_OK");
    expect(result.changedFiles).toContain("sandbox-created.txt");
    expect(result.sandbox).toMatchObject({
      enforced: true,
      backend: "landlock+seccomp",
      noNewPrivs: true,
      network: "blocked",
      externalExec: "blocked",
    });
    expect(result.sandbox.landlockAbi).toBeGreaterThanOrEqual(4);
    expect(result.sandbox.limits.openFiles).toBeLessThanOrEqual(128);
  });

  sandboxIt("reports only paths changed by the current execution", async () => {
    fs.writeFileSync(path.join(root, "hello.txt"), "dirty before execution\n", "utf8");
    write(root, "preexisting-untracked/old.txt", "old\n");

    const untouched = await executePython(workspace, nullLogger, {
      code: "print('NO_WORKSPACE_WRITE')",
      timeoutSeconds: 30,
    });
    expect(untouched.exitCode).toBe(0);
    expect(untouched.changedFiles).toEqual([]);

    const changed = await executePython(workspace, nullLogger, {
      code: [
        "from pathlib import Path",
        "Path('hello.txt').write_text('changed by execution\\n', encoding='utf-8')",
        "Path('preexisting-untracked/new.txt').write_text('new\\n', encoding='utf-8')",
      ].join("\n"),
      timeoutSeconds: 30,
    });

    expect(changed.exitCode).toBe(0);
    expect(changed.changedFiles).toEqual([
      "hello.txt",
      "preexisting-untracked/new.txt",
    ]);
    expect(changed.changedFiles).not.toContain("sandbox-created.txt");
    expect(changed.changedFiles).not.toContain("preexisting-untracked/old.txt");
  });

  sandboxIt("auto-sizes numeric thread pools within the sandbox task budget", async () => {
    const plan = pythonThreadPlan();
    expect(plan.systemLogical).toBeGreaterThanOrEqual(1);
    expect(plan.available).toBeGreaterThanOrEqual(1);
    expect(plan.available).toBeLessThanOrEqual(plan.systemLogical);
    expect(plan.compute).toBeGreaterThanOrEqual(1);
    expect(plan.compute).toBeLessThanOrEqual(plan.available);
    expect(plan.compute).toBeLessThanOrEqual(16);

    const result = await executePython(workspace, nullLogger, {
      code: [
        "import os",
        "import threading",
        "keys = ['OPENBLAS_NUM_THREADS','GOTO_NUM_THREADS','OMP_NUM_THREADS','OMP_THREAD_LIMIT','MKL_NUM_THREADS','VECLIB_MAXIMUM_THREADS','BLIS_NUM_THREADS','NUMEXPR_NUM_THREADS','NUMEXPR_MAX_THREADS']",
        "values = {key: os.environ.get(key) for key in keys}",
        "print('THREAD_ENV', values)",
        "n = int(os.environ['OMP_NUM_THREADS'])",
        "workers = [threading.Thread(target=lambda: None) for _ in range(n)]",
        "[worker.start() for worker in workers]",
        "[worker.join() for worker in workers]",
        "print('THREADS_STARTED', n)",
      ].join("\n"),
      timeoutSeconds: 30,
    });

    expect(result.exitCode).toBe(0);
    expect(result.sandbox.threads).toEqual(plan);
    expect(result.output).toContain(`THREADS_STARTED ${plan.compute}`);
    for (const key of [
      "OPENBLAS_NUM_THREADS",
      "GOTO_NUM_THREADS",
      "OMP_NUM_THREADS",
      "OMP_THREAD_LIMIT",
      "MKL_NUM_THREADS",
      "VECLIB_MAXIMUM_THREADS",
      "BLIS_NUM_THREADS",
      "NUMEXPR_NUM_THREADS",
      "NUMEXPR_MAX_THREADS",
    ]) {
      expect(result.output).toContain(`'${key}': '${plan.compute}'`);
    }
  });

  sandboxIt("denies reads outside the connected workspace", async () => {
    const secretPath = path.join(outside, "secret.txt");
    const result = await executePython(workspace, nullLogger, {
      code: [
        "from pathlib import Path",
        "try:",
        `    print(Path(${JSON.stringify(secretPath)}).read_text(encoding='utf-8'))`,
        "    print('OUTSIDE_READ_ESCAPE')",
        "except OSError as exc:",
        "    print('OUTSIDE_READ_DENIED', type(exc).__name__, exc.errno)",
      ].join("\n"),
      timeoutSeconds: 30,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("OUTSIDE_READ_DENIED");
    expect(result.output).not.toContain("OUTSIDE_SECRET_MUST_NOT_LEAK");
    expect(result.output).not.toContain("OUTSIDE_READ_ESCAPE");
  });

  sandboxIt("blocks network sockets, external exec and peer-process signalling", async () => {
    const result = await executePython(workspace, nullLogger, {
      code: [
        "import os",
        "import socket",
        "import subprocess",
        "try:",
        "    socket.socket()",
        "    print('SOCKET_ESCAPE')",
        "except OSError as exc:",
        "    print('SOCKET_DENIED', exc.errno)",
        "try:",
        "    subprocess.run(['/bin/sh', '-c', 'echo EXEC_ESCAPE'], check=True)",
        "    print('EXEC_ESCAPE')",
        "except OSError as exc:",
        "    print('EXEC_DENIED', type(exc).__name__, exc.errno)",
        "try:",
        "    os.kill(os.getppid(), 0)",
        "    print('SIGNAL_ESCAPE')",
        "except OSError as exc:",
        "    print('SIGNAL_DENIED', exc.errno)",
      ].join("\n"),
      timeoutSeconds: 30,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("SOCKET_DENIED");
    expect(result.output).toContain("EXEC_DENIED");
    expect(result.output).toContain("SIGNAL_DENIED");
    expect(result.output).not.toContain("SOCKET_ESCAPE");
    expect(result.output).not.toContain("EXEC_ESCAPE");
    expect(result.output).not.toContain("SIGNAL_ESCAPE");
  });

  sandboxIt("scrubs inherited secrets and applies no_new_privs/resource limits", async () => {
    const previous = process.env.C2C_TEST_SECRET;
    process.env.C2C_TEST_SECRET = "do-not-leak-to-python";
    try {
      const result = await executePython(workspace, nullLogger, {
        code: [
          "import ctypes",
          "import os",
          "libc = ctypes.CDLL(None)",
          "print('SECRET', os.environ.get('C2C_TEST_SECRET', 'missing'))",
          "print('NO_NEW_PRIVS', libc.prctl(39, 0, 0, 0, 0))",
        ].join("\n"),
        timeoutSeconds: 30,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("SECRET missing");
      expect(result.output).not.toContain("do-not-leak-to-python");
      expect(result.output).toContain("NO_NEW_PRIVS 1");
      // Limits are attested by the bootstrap before user code starts. We do not
      // call resource.getrlimit() from user code because prlimit64 is intentionally
      // denied by seccomp to prevent modifying peer-process limits.
      expect(result.sandbox.limits.openFiles).toBeLessThanOrEqual(128);
      expect(result.sandbox.limits.core).toBe(0);
      expect(result.sandbox.limits.addressSpace).toBeLessThanOrEqual(4 * 1024 ** 3);
      expect(result.sandbox.limits.fileSize).toBeLessThanOrEqual(64 * 1024 ** 2);
    } finally {
      if (previous === undefined) delete process.env.C2C_TEST_SECRET;
      else process.env.C2C_TEST_SECRET = previous;
    }
  });

  unsupportedIt("fails closed instead of running unsandboxed on unsupported hosts", async () => {
    await expect(
      executePython(workspace, nullLogger, {
        code: "print('must not run unsandboxed')",
        timeoutSeconds: 10,
      })
    ).rejects.toMatchObject({ code: "PYTHON_SANDBOX_FAILED" });
  });
});
