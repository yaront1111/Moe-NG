import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectCatalogEntry } from "./project-catalog.js";
import type { ProjectManagerPort } from "./project-manager-http-contract.js";
import {
  PROJECT_MANAGER_PORT,
  createProjectBoundaryOpener,
  runProjectManagerMain,
} from "./project-manager-main.js";
import type { ProjectManagerMainDependencies } from "./project-manager-main.js";
import type {
  ProjectRuntimeSupervisor,
} from "./project-runtime-supervisor.js";
import type { CancellablePairingOperatorInput } from "../http/pairing-operator-channel.js";

const CREDENTIAL = "a".repeat(64);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY: ProjectCatalogEntry = Object.freeze({
  configPath: "C:\\work\\alpha\\moe.config.json",
  instanceId: INSTANCE_ID,
  projectId: "alpha",
  root: "C:\\work\\alpha",
  storePath: "C:\\work\\alpha\\store.sqlite",
  title: "Alpha",
});
const temporaries: string[] = [];

afterEach(async () => {
  for (const path of temporaries.splice(0)) await rm(path, { force: true, recursive: true });
});

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "moe-project-manager-"));
  temporaries.push(path);
  return path;
}

async function* operatorChunks(...chunks: readonly string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

/** A console stdin: never typed into and closed by nobody, so only destroy() ends the read. */
function heldOpenOperatorInput(): CancellablePairingOperatorInput & { destroys(): number } {
  let destroys = 0;
  let settleNext: ((value: IteratorResult<string>) => void) | undefined;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<string>> =>
        await new Promise<IteratorResult<string>>((resolve) => { settleNext = resolve; }),
    }),
    destroy: (): void => {
      destroys += 1;
      settleNext?.({ done: true, value: undefined });
    },
    destroys: () => destroys,
  };
}

function runtime(order: string[]): ProjectRuntimeSupervisor {
  return Object.freeze({
    approvePairing: async () => ({
      code: "PROJECT_RUNTIME_PAIRING_APPROVED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true,
    }),
    list: () => Object.freeze([]),
    open: async () => ({ code: "PROJECT_RUNTIME_NOT_RUNNING", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: false }),
    shutdown: async () => {
      order.push("shutdown");
      return { code: "PROJECT_RUNTIME_SHUTDOWN", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true };
    },
    start: async () => ({ code: "PROJECT_RUNTIME_STARTED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true }),
    stop: async () => ({ code: "PROJECT_RUNTIME_STOPPED", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true }),
    wait: async () => ({
      code: "PROJECT_RUNTIME_COMPLETED" as const, exitCode: 0,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const, ok: true as const,
    }),
  });
}

describe("createProjectBoundaryOpener", () => {
  it("binds the catalog identity, private config, reviewed environment and fixed host entry", () => {
    const openBoundary = vi.fn(() => ({
      code: "PROCESS_BOUNDARY_TEST",
      layer: "WINDOWS_PROCESS_TEST",
      truthClass: "UNKNOWN" as const,
    }));
    const opener = createProjectBoundaryOpener({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      environment: {
        ANTHROPIC_API_KEY: "provider-secret",
        NODE_OPTIONS: "--require=attacker.js",
      },
      launchFs: {
        canonicalDirectory: (path) => path,
        canonicalFile: (path) => path,
        readConfig: () => JSON.stringify({
          credential: CREDENTIAL,
          projectId: "alpha",
          schemaVersion: "moe-cli-config/1",
          storePath: ENTRY.storePath,
        }),
      },
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      openBoundary,
      root: "D:\\artifact",
    });
    expect(opener(ENTRY)).toMatchObject({ truthClass: "UNKNOWN" });
    expect(openBoundary).toHaveBeenCalledWith({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      configPath: ENTRY.configPath,
      cwd: ENTRY.root,
      entryPath: "D:\\artifact\\apps\\daemon\\src\\projects\\project-stack-host-main.ts",
      environment: {
        ANTHROPIC_API_KEY: "provider-secret",
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_AGENT_COMMAND: "claude",
        MOE_PROJECT_ID: "alpha",
      },
      instanceId: ENTRY.instanceId,
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      storePath: ENTRY.storePath,
    });
    expect(JSON.stringify(openBoundary.mock.calls)).not.toContain("attacker.js");
  });

  it("passes only the selected Codex credential into the project stack", () => {
    const openBoundary = vi.fn(() => ({
      code: "PROCESS_BOUNDARY_TEST",
      layer: "WINDOWS_PROCESS_TEST",
      truthClass: "UNKNOWN" as const,
    }));
    const opener = createProjectBoundaryOpener({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      environment: {
        ANTHROPIC_API_KEY: "unrelated-claude-secret",
        // The claude relocation dir is provider-scoped like CODEX_HOME: a codex launch
        // must not carry it.
        CLAUDE_CONFIG_DIR: "C:\\Users\\operator\\.claude",
        CODEX_HOME: "C:\\Users\\operator\\.codex",
        MOE_AGENT_COMMAND: "codex",
        SYSTEMROOT: "C:\\Windows",
      },
      launchFs: {
        canonicalDirectory: (path) => path,
        canonicalFile: (path) => path,
        readConfig: () => JSON.stringify({
          credential: CREDENTIAL,
          projectId: "alpha",
          schemaVersion: "moe-cli-config/1",
          storePath: ENTRY.storePath,
        }),
      },
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      openBoundary,
      root: "D:\\artifact",
    });

    expect(opener(ENTRY)).toMatchObject({ truthClass: "UNKNOWN" });
    expect(openBoundary).toHaveBeenCalledWith(expect.objectContaining({
      environment: {
        CODEX_HOME: "C:\\Users\\operator\\.codex",
        MOE_AGENT_COMMAND: "codex",
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_PROJECT_ID: "alpha",
        SYSTEMROOT: "C:\\Windows",
      },
    }));
    expect(JSON.stringify(openBoundary.mock.calls)).not.toContain("unrelated-claude-secret");
    expect(JSON.stringify(openBoundary.mock.calls)).not.toContain("CLAUDE_CONFIG_DIR");
  });

  describe("claude sign-in directory", () => {
    // Real directories and the real existsSync: the opener injects no fileExists, so this
    // is the packaged path. INSTALL.md says `moe start` looks in CLAUDE_CONFIG_DIR, or in
    // %USERPROFILE%\.claude by default; both were false before the roster carried the
    // variable (measured 2026-09-13: refused MOE_UP_ENV_MISSING with a relocated sign-in,
    // and the DEFAULTED CLAUDE_CONFIG_DIR the gate minted never reached openBoundary).
    const launchFs = {
      canonicalDirectory: (path: string) => path,
      canonicalFile: (path: string) => path,
      readConfig: () => JSON.stringify({
        credential: CREDENTIAL,
        projectId: "alpha",
        schemaVersion: "moe-cli-config/1",
        storePath: ENTRY.storePath,
      }),
    };
    type OpenBoundary = Parameters<typeof createProjectBoundaryOpener>[0]["openBoundary"];
    const openerFor = (environment: Readonly<Record<string, string>>, openBoundary: OpenBoundary) =>
      createProjectBoundaryOpener({
        assetRoot: "D:\\artifact\\apps\\control-room\\dist",
        environment,
        launchFs,
        nodeExecutable: "C:\\node.exe",
        openBoundary,
        root: "D:\\artifact",
      });

    it("honors a relocated sign-in and hands the seats the same CLAUDE_CONFIG_DIR", async () => {
      const home = await temporary();
      const custom = await temporary();
      await writeFile(join(custom, ".credentials.json"), "{}", "utf8");
      const openBoundary = vi.fn(() => ({
        code: "PROCESS_BOUNDARY_TEST", layer: "WINDOWS_PROCESS_TEST", truthClass: "UNKNOWN" as const,
      }));
      const result = openerFor({ CLAUDE_CONFIG_DIR: custom, USERPROFILE: home }, openBoundary)(ENTRY);
      expect(result).toMatchObject({ truthClass: "UNKNOWN", code: "PROCESS_BOUNDARY_TEST" });
      expect(openBoundary).toHaveBeenCalledTimes(1);
      expect(openBoundary).toHaveBeenCalledWith(expect.objectContaining({
        environment: {
          CLAUDE_CONFIG_DIR: custom,
          MOE_AGENT_COMMAND: "claude",
          MOE_DAEMON_CREDENTIAL: CREDENTIAL,
          MOE_PROJECT_ID: "alpha",
          USERPROFILE: home,
        },
      }));
    });

    it("hands the seats the DEFAULTED CLAUDE_CONFIG_DIR the gate found under USERPROFILE", async () => {
      const home = await temporary();
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(join(home, ".claude", ".credentials.json"), "{}", "utf8");
      const openBoundary = vi.fn(() => ({
        code: "PROCESS_BOUNDARY_TEST", layer: "WINDOWS_PROCESS_TEST", truthClass: "UNKNOWN" as const,
      }));
      openerFor({ USERPROFILE: home }, openBoundary)(ENTRY);
      expect(openBoundary).toHaveBeenCalledWith(expect.objectContaining({
        environment: expect.objectContaining({
          CLAUDE_CONFIG_DIR: join(home, ".claude"),
          MOE_AGENT_COMMAND: "claude",
        }),
      }));
    });

    it("prefers the relocated sign-in when a default one also exists, so the seat is the selected account", async () => {
      const home = await temporary();
      const custom = await temporary();
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(join(home, ".claude", ".credentials.json"), "{}", "utf8");
      await writeFile(join(custom, ".credentials.json"), "{}", "utf8");
      const openBoundary = vi.fn(() => ({
        code: "PROCESS_BOUNDARY_TEST", layer: "WINDOWS_PROCESS_TEST", truthClass: "UNKNOWN" as const,
      }));
      openerFor({ CLAUDE_CONFIG_DIR: custom, USERPROFILE: home }, openBoundary)(ENTRY);
      expect(openBoundary).toHaveBeenCalledWith(expect.objectContaining({
        environment: expect.objectContaining({ CLAUDE_CONFIG_DIR: custom }),
      }));
    });
  });

  it("does not pass known provider credentials to a custom agent command", () => {
    const openBoundary = vi.fn(() => ({
      code: "PROCESS_BOUNDARY_TEST",
      layer: "WINDOWS_PROCESS_TEST",
      truthClass: "UNKNOWN" as const,
    }));
    const opener = createProjectBoundaryOpener({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      environment: {
        ANTHROPIC_AUTH_TOKEN: "claude-secret",
        CODEX_ACCESS_TOKEN: "codex-secret",
        MOE_AGENT_COMMAND: "C:\\tools\\noop-agent.cmd",
      },
      launchFs: {
        canonicalDirectory: (path) => path,
        canonicalFile: (path) => path,
        readConfig: () => JSON.stringify({
          credential: CREDENTIAL,
          projectId: "alpha",
          schemaVersion: "moe-cli-config/1",
          storePath: ENTRY.storePath,
        }),
      },
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      openBoundary,
      root: "D:\\artifact",
    });

    expect(opener(ENTRY)).toMatchObject({ truthClass: "UNKNOWN" });
    expect(openBoundary).toHaveBeenCalledWith(expect.objectContaining({
      environment: {
        MOE_AGENT_COMMAND: "C:\\tools\\noop-agent.cmd",
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_PROJECT_ID: "alpha",
      },
    }));
    expect(JSON.stringify(openBoundary.mock.calls)).not.toContain("claude-secret");
    expect(JSON.stringify(openBoundary.mock.calls)).not.toContain("codex-secret");
  });

  it("preserves Claude alias delivery without forwarding the unused Claude key", () => {
    const openBoundary = vi.fn(() => ({
      code: "PROCESS_BOUNDARY_TEST",
      layer: "WINDOWS_PROCESS_TEST",
      truthClass: "UNKNOWN" as const,
    }));
    const opener = createProjectBoundaryOpener({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      environment: {
        ANTHROPIC_API_KEY: "unused-api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
        MOE_AGENT_COMMAND: "claude.cmd",
      },
      launchFs: {
        canonicalDirectory: (path) => path,
        canonicalFile: (path) => path,
        readConfig: () => JSON.stringify({
          credential: CREDENTIAL,
          projectId: "alpha",
          schemaVersion: "moe-cli-config/1",
          storePath: ENTRY.storePath,
        }),
      },
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      openBoundary,
      root: "D:\\artifact",
    });

    expect(opener(ENTRY)).toMatchObject({ truthClass: "UNKNOWN" });
    expect(openBoundary).toHaveBeenCalledWith(expect.objectContaining({
      environment: {
        ANTHROPIC_AUTH_TOKEN: "subscription-token",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
        MOE_AGENT_COMMAND: "claude.cmd",
        MOE_DAEMON_CREDENTIAL: CREDENTIAL,
        MOE_PROJECT_ID: "alpha",
      },
    }));
    expect(JSON.stringify(openBoundary.mock.calls)).not.toContain("unused-api-key");
  });

  it("refuses an accessor-backed environment without evaluating the accessor", () => {
    const openBoundary = vi.fn();
    const environment: Record<string, string | undefined> = {
      MOE_AGENT_COMMAND: "C:\\tools\\noop-agent.cmd",
    };
    const credential = vi.fn(() => { throw new Error("credential getter executed"); });
    Object.defineProperty(environment, "ANTHROPIC_API_KEY", {
      enumerable: true,
      get: credential,
    });

    const result = createProjectBoundaryOpener({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      environment,
      launchFs: {
        canonicalDirectory: (path) => path,
        canonicalFile: (path) => path,
        readConfig: () => JSON.stringify({
          credential: CREDENTIAL,
          projectId: "alpha",
          schemaVersion: "moe-cli-config/1",
          storePath: ENTRY.storePath,
        }),
      },
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      openBoundary,
      root: "D:\\artifact",
    })(ENTRY);

    expect(result).toEqual({
      code: "PROJECT_MANAGER_LAUNCH_ENVIRONMENT_INVALID",
      layer: "PROJECT_MANAGER_LAUNCH",
      truthClass: "UNKNOWN",
    });
    expect(credential).not.toHaveBeenCalled();
    expect(openBoundary).not.toHaveBeenCalled();
  });

  it("carries the credential gate's message with its stable code so the operator sees the fix", async () => {
    // A fresh profile with no sign-in and no token: the gate refuses by name. The CODE is
    // what scripts match; the MESSAGE names the three accepted variables and the path that
    // was looked for, and it was dropped here (measured 2026-09-13: only code+layer left).
    const home = await temporary();
    const openBoundary = vi.fn();
    const result = createProjectBoundaryOpener({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      environment: { MOE_AGENT_COMMAND: "claude", USERPROFILE: home },
      launchFs: {
        canonicalDirectory: (path) => path,
        canonicalFile: (path) => path,
        readConfig: () => JSON.stringify({
          credential: CREDENTIAL,
          projectId: "alpha",
          schemaVersion: "moe-cli-config/1",
          storePath: ENTRY.storePath,
        }),
      },
      nodeExecutable: "C:\\node.exe",
      openBoundary,
      root: "D:\\artifact",
    })(ENTRY);
    expect(result).toEqual({
      code: "MOE_UP_ENV_MISSING",
      layer: "PROJECT_MANAGER_LAUNCH",
      message: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY"),
      truthClass: "UNKNOWN",
    });
    expect((result as { message?: string }).message)
      .toContain(`no sign-in at ${join(home, ".claude", ".credentials.json")}`);
    expect(openBoundary).not.toHaveBeenCalled();
  });

  it("returns the exact config refusal before opening a process boundary", () => {
    const openBoundary = vi.fn();
    const result = createProjectBoundaryOpener({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      environment: { ANTHROPIC_API_KEY: "provider-secret" },
      launchFs: {
        canonicalDirectory: (path) => path,
        canonicalFile: (path) => path,
        readConfig: () => "{}",
      },
      nodeExecutable: "C:\\node.exe",
      openBoundary,
      root: "D:\\artifact",
    })(ENTRY);
    expect(result).toEqual({
      code: "PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH",
      layer: "PROJECT_MANAGER_LAUNCH",
      truthClass: "UNKNOWN",
    });
    expect(openBoundary).not.toHaveBeenCalled();
  });
});

describe("runProjectManagerMain", () => {
  it.runIf(process.platform === "win32")("waits for the owned operator reader to release during stop", async () => {
    let release!: (result: IteratorResult<string>) => void;
    const input = { destroy: vi.fn(), [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<string>>((settle) => { release = settle; }),
    }) };
    let signal: (() => void) | undefined;
    let finished = false;
    const completed = runProjectManagerMain({
      dependencies: { createRuntime: () => runtime([]), resolveAssetRoot: () => "D:\\artifact",
        startHttp: async () => ({ approvePairing: () => ({ code: "PAIRING_CONFIRMATION_UNKNOWN",
          layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false }), close: async () => undefined,
          ok: true, origin: "http://127.0.0.2:39122", port: 39122 }) },
      env: { LOCALAPPDATA: await temporary() }, log: () => undefined,
      onSignal: (handler) => { signal = handler; }, operatorInput: input,
      platform: "win32", root: "D:\\artifact",
    }).then((code) => { finished = true; return code; });
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      signal!();
      await vi.waitFor(() => expect(input.destroy).toHaveBeenCalledTimes(1));
      expect(finished).toBe(false);
      release({ done: true, value: undefined });
      expect(await completed).toBe(0);
    } finally {
      release?.({ done: true, value: undefined });
      signal?.();
      await completed;
    }
  });

  it.runIf(process.platform === "win32").each(["missing", "eof", "error"] as const)(
    "reports live operator availability after %s", async (ending) => {
      const localAppData = await temporary();
      const input = new PassThrough();
      let available: (() => boolean) | undefined;
      let signal: (() => void) | undefined;
      const completed = runProjectManagerMain({
        dependencies: {
          createRuntime: () => runtime([]),
          resolveAssetRoot: () => "D:\\artifact\\apps\\control-room\\dist",
          startHttp: async (options) => {
            available = options.operatorChannelAvailable;
            return { approvePairing: () => ({ code: "PAIRING_CONFIRMATION_UNKNOWN",
              layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false }),
              close: async () => undefined, ok: true,
              origin: "http://127.0.0.2:39122", port: 39122 };
          },
        },
        env: { LOCALAPPDATA: localAppData }, log: () => undefined,
        onSignal: (handler) => { signal = handler; },
        ...(ending === "missing" ? {} : { operatorInput: input }),
        platform: "win32", root: "D:\\artifact",
      });
      try {
        await vi.waitFor(() => expect(signal).toBeTypeOf("function"));
        expect(available).toBeTypeOf("function");
        expect(available!()).toBe(ending !== "missing");
        if (ending === "error") input.destroy(new Error("operator stream failed"));
        else input.end();
        await vi.waitFor(() => expect(available!()).toBe(false));
      } finally {
        input.destroy();
        signal?.();
        await completed;
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "starts one fixed-host manager, waits, then closes HTTP before every project Job", async () => {
    const localAppData = await temporary();
    const order: string[] = [];
    let signal = (): void => { throw new Error("signal not registered"); };
    let manager: ProjectManagerPort | null = null;
    let receivedPort: number | undefined;
    const logs: string[] = [];
    const dependencies: Partial<ProjectManagerMainDependencies> = {
      createRuntime: () => runtime(order),
      resolveAssetRoot: () => "D:\\artifact\\apps\\control-room\\dist",
      startHttp: async (options) => {
        manager = options.manager;
        receivedPort = options.port;
        return {
          approvePairing: () => ({
            code: "PAIRING_CONFIRMATION_UNKNOWN" as const,
            layer: "CONTROL_ROOM_PAIRING_APPROVAL" as const,
            ok: false as const,
          }),
          close: async () => { order.push("http-close"); },
          ok: true,
          origin: "http://127.0.0.2:39122",
          port: 39122,
        };
      },
    };
    const completed = runProjectManagerMain({
      dependencies,
      env: { LOCALAPPDATA: localAppData },
      log: (line) => { logs.push(line); },
      onSignal: (handler) => { signal = handler; },
      platform: "win32",
      root: "D:\\artifact",
    });
    await vi.waitFor(() => { expect(manager).not.toBeNull(); });
    expect(receivedPort).toBe(PROJECT_MANAGER_PORT);
    expect(await manager!.list()).toEqual({ projects: [], schemaVersion: "moe-project-manager/1" });
    expect(logs).toEqual([
      "moe projects: project manager ready",
      "moe projects: http://127.0.0.2:39122",
      "moe projects: Ctrl-C stops the manager and every project runtime",
    ]);
    signal();
    expect(await completed).toBe(0);
    expect(order).toEqual(["http-close", "shutdown"]);
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps manager and project approvals on bounded instance-correlated input", async () => {
    const localAppData = await temporary();
    const order: string[] = [];
    let signal = (): void => { throw new Error("signal not registered"); };
    const managerLabel = "cafe-babe-1234";
    const projectLabel = "dead-beef-1234";
    const approveManager = vi.fn(() => ({
      code: "PAIRING_CONFIRMATION_APPROVED" as const,
      layer: "CONTROL_ROOM_PAIRING_APPROVAL" as const,
      ok: true as const,
      requestId: "e".repeat(64),
      state: "APPROVED" as const,
    }));
    const approveProject = vi.fn(async () => ({
      code: "PROJECT_RUNTIME_PAIRING_APPROVED" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    }));
    const supervisor = Object.freeze({ ...runtime(order), approvePairing: approveProject });
    const logs: string[] = [];
    const completed = runProjectManagerMain({
      dependencies: {
        createRuntime: () => supervisor,
        resolveAssetRoot: () => "D:\\artifact\\apps\\control-room\\dist",
        startHttp: async () => ({
          approvePairing: approveManager,
          close: async () => { order.push("http-close"); },
          ok: true,
          origin: "http://127.0.0.2:39122",
          port: 39122,
        }),
      },
      env: { LOCALAPPDATA: localAppData },
      log: (line) => { logs.push(line); },
      onSignal: (handler) => { signal = handler; },
      operatorInput: operatorChunks(
        "not-an-approval\n",
        `${managerLabel}\n`,
        `${INSTANCE_ID} ${projectLabel}\n`,
        `${"a".repeat(64)}\n`,
      ),
      platform: "win32",
      root: "D:\\artifact",
    });

    await vi.waitFor(() => {
      expect(approveManager).toHaveBeenCalledWith(managerLabel);
      expect(approveProject).toHaveBeenCalledWith(INSTANCE_ID, projectLabel);
    });
    expect(approveManager).toHaveBeenCalledTimes(1);
    expect(approveProject).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain(managerLabel);
    expect(logs.join("\n")).not.toContain(projectLabel);

    signal();
    expect(await completed).toBe(0);
    expect(order).toEqual(["http-close", "shutdown"]);
    },
  );

  it.runIf(process.platform === "win32")(
    "normalises shouted or padded manager and project labels, and names an ignored line", async () => {
    const localAppData = await temporary();
    const order: string[] = [];
    let signal = (): void => { throw new Error("signal not registered"); };
    const approveManager = vi.fn((_label: string) => ({
      code: "PAIRING_CONFIRMATION_APPROVED" as const,
      layer: "CONTROL_ROOM_PAIRING_APPROVAL" as const,
      ok: true as const,
      requestId: "e".repeat(64),
      state: "APPROVED" as const,
    }));
    const approveProject = vi.fn(async (_instanceId: string, _label: string) => ({
      code: "PROJECT_RUNTIME_PAIRING_APPROVED" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    }));
    const supervisor = Object.freeze({ ...runtime(order), approvePairing: approveProject });
    const logs: string[] = [];
    const completed = runProjectManagerMain({
      dependencies: {
        createRuntime: () => supervisor,
        resolveAssetRoot: () => "D:\\artifact\\apps\\control-room\\dist",
        startHttp: async () => ({
          approvePairing: approveManager,
          close: async () => { order.push("http-close"); },
          ok: true,
          origin: "http://127.0.0.2:39122",
          port: 39122,
        }),
      },
      env: { LOCALAPPDATA: localAppData },
      log: (line) => { logs.push(line); },
      onSignal: (handler) => { signal = handler; },
      // Sentinel last: the exact lowercase label proves every earlier line was consumed.
      operatorInput: operatorChunks(
        "CAFE-BABE-1234\n",
        " cafe-babe-5678 \n",
        `${INSTANCE_ID.toUpperCase()}  DEAD-BEEF-1234 \n`,
        "not-an-approval\n",
        "0000-0000-0000\n",
      ),
      platform: "win32",
      root: "D:\\artifact",
    });

    await vi.waitFor(() => { expect(approveManager).toHaveBeenCalledWith("0000-0000-0000"); });
    expect(approveManager.mock.calls.map((call) => call[0]))
      .toEqual(["cafe-babe-1234", "cafe-babe-5678", "0000-0000-0000"]);
    expect(approveProject).toHaveBeenCalledTimes(1);
    expect(approveProject).toHaveBeenCalledWith(INSTANCE_ID, "dead-beef-1234");
    expect(logs.filter((line) => line === "PROJECT_MANAGER_OPERATOR_LINE_IGNORED PROJECT_MANAGER_MAIN"))
      .toHaveLength(1);
    expect(logs.join("\n")).not.toContain("not-an-approval");
    expect(logs.join("\n")).not.toContain("cafe-babe");
    expect(logs.join("\n")).not.toContain("dead-beef");

    signal();
    expect(await completed).toBe(0);
    },
  );

  it.runIf(process.platform === "win32")(
    "releases a held-open operator stdin after the Ctrl-C drain so the process can exit", async () => {
    // The manager's drain closed HTTP and shut the runtime down but never touched the
    // stdin consumer, so a console `moe projects` stayed up after Ctrl-C (measured 2026-09-13).
    const localAppData = await temporary();
    const order: string[] = [];
    let signal = (): void => { throw new Error("signal not registered"); };
    const stdin = heldOpenOperatorInput();
    let registered = false;
    const completed = runProjectManagerMain({
      dependencies: {
        createRuntime: () => runtime(order),
        resolveAssetRoot: () => "D:\\artifact\\apps\\control-room\\dist",
        startHttp: async () => {
          return {
            approvePairing: () => ({
              code: "PAIRING_CONFIRMATION_UNKNOWN" as const,
              layer: "CONTROL_ROOM_PAIRING_APPROVAL" as const,
              ok: false as const,
            }),
            close: async () => { order.push("http-close"); },
            ok: true,
            origin: "http://127.0.0.2:39122",
            port: 39122,
          };
        },
      },
      env: { LOCALAPPDATA: localAppData },
      log: vi.fn(),
      onSignal: (handler) => { signal = handler; registered = true; },
      operatorInput: stdin,
      platform: "win32",
      root: "D:\\artifact",
    });
    await vi.waitFor(() => { expect(registered).toBe(true); });
    expect(stdin.destroys()).toBe(0);
    signal();
    expect(await completed).toBe(0);
    expect(order).toEqual(["http-close", "shutdown"]);
    expect(stdin.destroys()).toBe(1);
    },
  );

  it("refuses unsupported platforms and missing LOCALAPPDATA before creating authority", async () => {
    const startHttp = vi.fn();
    expect(await runProjectManagerMain({
      dependencies: { startHttp }, env: {}, log: vi.fn(), onSignal: vi.fn(),
      platform: "linux", root: "D:\\artifact",
    })).toBe(1);
    const logs: string[] = [];
    expect(await runProjectManagerMain({
      dependencies: { startHttp }, env: {}, log: (line) => { logs.push(line); },
      onSignal: vi.fn(), platform: "win32", root: "D:\\artifact",
    })).toBe(1);
    expect(logs).toEqual(["PROJECT_MANAGER_LOCAL_APP_DATA_INVALID PROJECT_MANAGER_MAIN"]);
    expect(startHttp).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "preserves a malformed durable catalog refusal and starts no HTTP listener", async () => {
    const localAppData = await temporary();
    const managerDirectory = join(localAppData, "Moe");
    await mkdir(managerDirectory, { recursive: true });
    await writeFile(join(managerDirectory, "projects.json"), "not-json", "utf8");
    const startHttp = vi.fn();
    const logs: string[] = [];
    expect(await runProjectManagerMain({
      dependencies: {
        resolveAssetRoot: () => "D:\\artifact\\apps\\control-room\\dist",
        startHttp,
      },
      env: { LOCALAPPDATA: localAppData },
      log: (line) => { logs.push(line); }, onSignal: vi.fn(), platform: "win32",
      root: "D:\\artifact",
    })).toBe(1);
    expect(logs).toEqual(["PROJECT_CATALOG_MALFORMED PROJECT_CATALOG"]);
    expect(startHttp).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "discloses exact asset and bind refusals without raw exceptions", async () => {
    const localAppData = await temporary();
    const missingLogs: string[] = [];
    expect(await runProjectManagerMain({
      dependencies: { resolveAssetRoot: () => null },
      env: { LOCALAPPDATA: localAppData }, log: (line) => { missingLogs.push(line); },
      onSignal: vi.fn(), platform: "win32", root: "D:\\artifact",
    })).toBe(1);
    expect(missingLogs).toEqual(["PROJECT_MANAGER_ASSET_ROOT_MISSING PROJECT_MANAGER_MAIN"]);

    const bindLogs: string[] = [];
    expect(await runProjectManagerMain({
      dependencies: {
        resolveAssetRoot: () => "D:\\assets",
        startHttp: async () => ({ code: "PROJECT_MANAGER_BIND_FAILED", layer: "PROJECT_MANAGER_HTTP", ok: false }),
      },
      env: { LOCALAPPDATA: localAppData }, log: (line) => { bindLogs.push(line); },
      onSignal: vi.fn(), platform: "win32", root: "D:\\artifact",
    })).toBe(1);
    expect(bindLogs).toEqual(["PROJECT_MANAGER_BIND_FAILED PROJECT_MANAGER_HTTP"]);
    },
  );
});
