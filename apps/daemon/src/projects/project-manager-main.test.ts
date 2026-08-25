import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  it("starts one fixed-host manager, waits, then closes HTTP before every project Job", async () => {
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
  });

  it("keeps manager and project approvals on bounded instance-correlated input", async () => {
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
  });

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

  it("preserves a malformed durable catalog refusal and starts no HTTP listener", async () => {
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
  });

  it("discloses exact asset and bind refusals without raw exceptions", async () => {
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
  });
});
