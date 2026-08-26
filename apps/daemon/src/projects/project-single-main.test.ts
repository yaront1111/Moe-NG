import { describe, expect, it, vi } from "vitest";

import {
  runSingleProjectMain,
} from "./project-single-main.js";
import type { ProjectSingleMainDependencies } from "./project-single-main.js";
import type { ProjectRuntimeSupervisor } from "./project-runtime-supervisor.js";

const CREDENTIAL = "a".repeat(64);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = Object.freeze({
  configPath: "C:\\work\\alpha\\moe.config.json",
  projectId: "alpha",
  root: "C:\\work\\alpha",
  storePath: "C:\\work\\alpha\\store.sqlite",
});

async function* operatorChunks(...chunks: readonly string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

function runtime(overrides: Partial<ProjectRuntimeSupervisor> = {}): ProjectRuntimeSupervisor {
  return Object.freeze({
    approvePairing: vi.fn(async () => ({
      code: "PROJECT_RUNTIME_PAIRING_APPROVED" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    })),
    list: () => Object.freeze([]),
    open: vi.fn(async () => ({
      code: "PROJECT_RUNTIME_OPENED" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
      origin: "http://127.0.0.1:49152",
    })),
    shutdown: vi.fn(async () => ({
      code: "PROJECT_RUNTIME_SHUTDOWN" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    })),
    start: vi.fn(async () => ({
      code: "PROJECT_RUNTIME_STARTED" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    })),
    stop: vi.fn(async () => ({
      code: "PROJECT_RUNTIME_STOPPED" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    })),
    wait: vi.fn(async () => ({
      code: "PROJECT_RUNTIME_COMPLETED" as const,
      exitCode: 7,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    })),
    ...overrides,
  });
}

function dependencies(supervisor: ProjectRuntimeSupervisor): Partial<ProjectSingleMainDependencies> {
  return {
    createFiles: () => ({
      create: async () => ({ code: "UNUSED", layer: "PROJECT_MANAGER_FILES", ok: false }),
      register: async () => ({ ok: true, project: PROJECT }),
    }),
    createRuntime: () => supervisor,
    mintUuid: () => INSTANCE_ID,
    resolveAssetRoot: () => "D:\\artifact\\control-room",
  };
}

describe("runSingleProjectMain", () => {
  it("runs legacy start through the same locked project boundary and returns its proven exit", async () => {
    const supervisor = runtime();
    const logs: string[] = [];
    const result = await runSingleProjectMain({
      dependencies: dependencies(supervisor),
      env: { ANTHROPIC_API_KEY: "provider-secret" },
      log: (line) => { logs.push(line); },
      onSignal: vi.fn(),
      platform: "win32",
      projectRoot: PROJECT.root,
      root: "D:\\artifact",
    });

    expect(result).toBe(7);
    expect(supervisor.start).toHaveBeenCalledWith({
      ...PROJECT,
      instanceId: INSTANCE_ID,
      title: "alpha",
    });
    expect(supervisor.open).toHaveBeenCalledWith(INSTANCE_ID);
    expect(supervisor.wait).toHaveBeenCalledWith(INSTANCE_ID);
    expect(supervisor.approvePairing).not.toHaveBeenCalled();
    expect(logs).toEqual([
      "moe start: project runtime ready",
      "moe start: http://127.0.0.1:49152",
      "moe start: Ctrl-C stops this project runtime",
    ]);
    expect(logs.join("\n")).not.toContain(CREDENTIAL);
  });

  it("routes only an exact foreground label to this project instance", async () => {
    const label = "dead-beef-1234";
    const approvePairing = vi.fn(async () => ({
      code: "PROJECT_RUNTIME_PAIRING_APPROVED" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    }));
    let finish!: (value: {
      code: "PROJECT_RUNTIME_COMPLETED"; exitCode: number;
      layer: "PROJECT_RUNTIME_SUPERVISOR"; ok: true;
    }) => void;
    const wait = vi.fn(() => new Promise<{
      code: "PROJECT_RUNTIME_COMPLETED"; exitCode: number;
      layer: "PROJECT_RUNTIME_SUPERVISOR"; ok: true;
    }>((resolve) => { finish = resolve; }));
    const supervisor = runtime({ approvePairing, wait });
    const logs: string[] = [];
    const completed = runSingleProjectMain({
      dependencies: dependencies(supervisor), env: { ANTHROPIC_API_KEY: "key" },
      log: (line) => { logs.push(line); }, onSignal: vi.fn(),
      operatorInput: operatorChunks("wrong\n", `${label}\n`, `${"a".repeat(64)}\n`),
      platform: "win32", projectRoot: PROJECT.root, root: "D:\\artifact",
    });

    await vi.waitFor(() => {
      expect(approvePairing).toHaveBeenCalledWith(INSTANCE_ID, label);
    });
    expect(approvePairing).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain(label);
    finish({
      code: "PROJECT_RUNTIME_COMPLETED", exitCode: 0,
      layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true,
    });
    expect(await completed).toBe(0);
  });

  it("cancels the same runtime authority on Ctrl-C and exits only after proven shutdown", async () => {
    let signal = (): void => { throw new Error("signal missing"); };
    const wait = new Promise<never>(() => undefined);
    const shutdown = vi.fn(async () => ({
      code: "PROJECT_RUNTIME_SHUTDOWN" as const,
      layer: "PROJECT_RUNTIME_SUPERVISOR" as const,
      ok: true as const,
    }));
    const supervisor = runtime({ shutdown, wait: vi.fn(() => wait) });
    const pending = runSingleProjectMain({
      dependencies: dependencies(supervisor), env: { ANTHROPIC_API_KEY: "key" },
      log: vi.fn(), onSignal: (handler) => { signal = handler; }, platform: "win32",
      projectRoot: PROJECT.root, root: "D:\\artifact",
    });
    await vi.waitFor(() => { expect(supervisor.open).toHaveBeenCalled(); });
    signal();
    expect(await pending).toBe(0);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("preserves exact preparation and runtime refusals and opens no ticket", async () => {
    const start = vi.fn(async () => ({
      code: "PROCESS_BOUNDARY_BROKER_REFUSED" as const,
      layer: "WINDOWS_PROCESS_TRANSPORT" as const,
      ok: false as const,
    }));
    const supervisor = runtime({ start });
    const logs: string[] = [];
    expect(await runSingleProjectMain({
      dependencies: dependencies(supervisor), env: { ANTHROPIC_API_KEY: "key" },
      log: (line) => { logs.push(line); }, onSignal: vi.fn(), platform: "win32",
      projectRoot: PROJECT.root, root: "D:\\artifact",
    })).toBe(1);
    expect(logs).toEqual(["PROCESS_BOUNDARY_BROKER_REFUSED WINDOWS_PROCESS_TRANSPORT"]);
    expect(supervisor.open).not.toHaveBeenCalled();
  });

  it("refuses non-Windows and missing bundle authority before reading project files", async () => {
    const createFiles = vi.fn();
    const logs: string[] = [];
    expect(await runSingleProjectMain({
      dependencies: { createFiles }, env: {}, log: (line) => { logs.push(line); },
      onSignal: vi.fn(), platform: "linux", projectRoot: PROJECT.root, root: "D:\\artifact",
    })).toBe(1);
    expect(logs).toEqual(["PROJECT_SINGLE_PLATFORM_UNSUPPORTED PROJECT_SINGLE_MAIN"]);
    expect(createFiles).not.toHaveBeenCalled();

    const missing: string[] = [];
    expect(await runSingleProjectMain({
      dependencies: { resolveAssetRoot: () => null }, env: {},
      log: (line) => { missing.push(line); }, onSignal: vi.fn(), platform: "win32",
      projectRoot: PROJECT.root, root: "D:\\artifact",
    })).toBe(1);
    expect(missing).toEqual(["PROJECT_SINGLE_ASSET_ROOT_MISSING PROJECT_SINGLE_MAIN"]);
  });

  it("refuses a non-v4 or unmintable instance id before opening any runtime (task-bd5c2a0e)", async () => {
    // TWO PROBES, because the guard has two arms and one probe would leave the
    // other free to stop refusing. The session id is the binding between this
    // process and the project instance: a v1 id is attacker-shaped rather than
    // minted, and an id that cannot be minted at all is entropy failure. Either
    // must refuse BEFORE a runtime exists, which is why the spies are asserted
    // rather than only the exit code.
    const wrongVersion = runtime();
    const wrongVersionLogs: string[] = [];
    expect(await runSingleProjectMain({
      // Version nibble 1, otherwise byte-identical to this file's valid
      // INSTANCE_ID — so ONLY the UUID_V4 version check can refuse it. A
      // malformed-looking id would also trip the shape check and prove less.
      dependencies: { ...dependencies(wrongVersion), mintUuid: () => "11111111-1111-1111-8111-111111111111" },
      env: {}, log: (line) => { wrongVersionLogs.push(line); }, onSignal: vi.fn(),
      platform: "win32", projectRoot: PROJECT.root, root: "D:\\artifact",
    })).toBe(1);
    // EXACT equality, not a contains: a residue line would mean something was
    // disclosed after the refusal, and the layer is asserted alongside the code.
    expect(wrongVersionLogs).toEqual(["PROJECT_SINGLE_INSTANCE_ID_INVALID PROJECT_SINGLE_MAIN"]);
    expect(wrongVersion.start).not.toHaveBeenCalled();
    expect(wrongVersion.open).not.toHaveBeenCalled();

    const unmintable = runtime();
    const unmintableLogs: string[] = [];
    expect(await runSingleProjectMain({
      dependencies: {
        ...dependencies(unmintable),
        mintUuid: () => { throw new Error("entropy unavailable"); },
      },
      env: {}, log: (line) => { unmintableLogs.push(line); }, onSignal: vi.fn(),
      platform: "win32", projectRoot: PROJECT.root, root: "D:\\artifact",
    })).toBe(1);
    expect(unmintableLogs).toEqual(["PROJECT_SINGLE_INSTANCE_ID_INVALID PROJECT_SINGLE_MAIN"]);
    expect(unmintable.start).not.toHaveBeenCalled();
    expect(unmintable.open).not.toHaveBeenCalled();
  });
});
