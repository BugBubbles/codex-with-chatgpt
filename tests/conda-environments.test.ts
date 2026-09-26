import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCondaEnvironments, type CondaEnvironmentInfo } from "../src/execution/conda-environments.js";
import { executePython } from "../src/execution/python-runner.js";
import { nullLogger } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const supported = process.platform === "linux" && process.arch === "x64";
const sandboxIt = supported ? it : it.skip;

describe("read-only Conda environment selection", () => {
  let stateDir = "";
  let workspaceRoot = "";
  let condaRoot = "";
  let envPrefix = "";
  let environment: CondaEnvironmentInfo;
  let workspace: Workspace;
  let previousRoots: string | undefined;

  beforeAll(() => {
    stateDir = isolateStateDir();
    workspaceRoot = makeTmpDir("conda-workspace");
    condaRoot = makeTmpDir("conda-root");
    envPrefix = path.join(condaRoot, "envs", "c2c-test");
    makeGitRepo(workspaceRoot);
    workspace = new Workspace(workspaceRoot);

    const creator = process.env.C2C_PYTHON_BIN?.trim() || "python3";
    const venv = spawnSync(creator, ["-m", "venv", "--copies", envPrefix], {
      encoding: "utf8",
      env: process.env,
    });
    if (venv.status !== 0) {
      throw new Error(`failed to create test Python environment: ${venv.stderr || venv.stdout}`);
    }

    const envPython = path.join(envPrefix, "bin", "python");
    const version = spawnSync(envPython, ["-c", "import platform; print(platform.python_version())"], {
      encoding: "utf8",
    });
    if (version.status !== 0) throw new Error(`failed to query test Python: ${version.stderr}`);
    const pythonVersion = version.stdout.trim();

    fs.mkdirSync(path.join(envPrefix, "conda-meta"), { recursive: true });
    write(
      envPrefix,
      `conda-meta/python-${pythonVersion}-test.json`,
      JSON.stringify({ name: "python", version: pythonVersion }) + "\n"
    );
    write(
      envPrefix,
      "conda-meta/c2c-marker-1.0-test.json",
      JSON.stringify({ name: "c2c-marker", version: "1.0" }) + "\n"
    );

    const purelib = spawnSync(
      envPython,
      ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
      { encoding: "utf8" }
    );
    if (purelib.status !== 0) throw new Error(`failed to query site-packages: ${purelib.stderr}`);
    const packageDir = path.join(purelib.stdout.trim(), "c2c_conda_marker");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "__init__.py"),
      "VALUE = 'CONDA_LIBRARY_OK'\n",
      "utf8"
    );

    previousRoots = process.env.C2C_CONDA_ROOTS;
    process.env.C2C_CONDA_ROOTS = condaRoot;

    const environments = listCondaEnvironments();
    const found = environments.find((item) => item.prefix === fs.realpathSync.native(envPrefix));
    if (!found) throw new Error("test Conda environment was not discovered");
    environment = found;
  });

  afterAll(() => {
    if (previousRoots === undefined) delete process.env.C2C_CONDA_ROOTS;
    else process.env.C2C_CONDA_ROOTS = previousRoots;
    cleanup(workspaceRoot);
    cleanup(condaRoot);
    cleanup(stateDir);
  });

  it("discovers environments from metadata without invoking conda", () => {
    const environments = listCondaEnvironments();
    const found = environments.find((item) => item.id === environment.id);
    expect(found).toMatchObject({
      id: environment.id,
      name: "c2c-test",
      prefix: fs.realpathSync.native(envPrefix),
      packageCount: 2,
    });
    expect(found?.pythonVersion).toMatch(/^\d+\.\d+/);
    expect(found?.python).toBe(fs.realpathSync.native(path.join(envPrefix, "bin", "python")));
  });

  sandboxIt("imports installed libraries while keeping the selected prefix read-only", async () => {
    const result = await executePython(workspace, nullLogger, {
      environment: environment.id,
      code: [
        "import os",
        "import sys",
        "from pathlib import Path",
        "import c2c_conda_marker",
        "print('MARKER', c2c_conda_marker.VALUE)",
        "print('PREFIX_MATCH', os.environ.get('CONDA_PREFIX') == sys.prefix)",
        "try:",
        "    Path(sys.prefix, 'c2c-mutation-test').write_text('no', encoding='utf-8')",
        "    print('ENV_WRITE_ESCAPE')",
        "except OSError as exc:",
        "    print('ENV_WRITE_DENIED', type(exc).__name__, exc.errno)",
      ].join("\n"),
      timeoutSeconds: 30,
    });

    expect(result.exitCode).toBe(0);
    expect(result.environment?.id).toBe(environment.id);
    expect(result.output).toContain("MARKER CONDA_LIBRARY_OK");
    expect(result.output).toContain("PREFIX_MATCH True");
    expect(result.output).toContain("ENV_WRITE_DENIED");
    expect(result.output).not.toContain("ENV_WRITE_ESCAPE");
    expect(fs.existsSync(path.join(envPrefix, "c2c-mutation-test"))).toBe(false);
  });

  sandboxIt("keeps network and external execution blocked in a selected environment", async () => {
    const result = await executePython(workspace, nullLogger, {
      environment: environment.id,
      code: [
        "import socket",
        "import subprocess",
        "import sys",
        "try:",
        "    socket.socket()",
        "    print('SOCKET_ESCAPE')",
        "except OSError as exc:",
        "    print('SOCKET_DENIED', exc.errno)",
        "try:",
        "    subprocess.run([sys.executable, '-m', 'pip', '--version'], check=True)",
        "    print('PIP_EXEC_ESCAPE')",
        "except OSError as exc:",
        "    print('PIP_EXEC_DENIED', type(exc).__name__, exc.errno)",
      ].join("\n"),
      timeoutSeconds: 30,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("SOCKET_DENIED");
    expect(result.output).toContain("PIP_EXEC_DENIED");
    expect(result.output).not.toContain("SOCKET_ESCAPE");
    expect(result.output).not.toContain("PIP_EXEC_ESCAPE");
  });

  sandboxIt("rejects arbitrary or stale environment ids", async () => {
    await expect(
      executePython(workspace, nullLogger, {
        environment: "conda-not-a-real-environment",
        code: "print('must not run')",
        timeoutSeconds: 10,
      })
    ).rejects.toMatchObject({ code: "CONDA_ENVIRONMENT_NOT_FOUND" });
  });
});
