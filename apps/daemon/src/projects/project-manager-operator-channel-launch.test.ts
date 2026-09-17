import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WindowsProjectStackRequest } from "@moe/runner";

import type { ProjectCatalogEntry } from "./project-catalog.js";
import { createProjectBoundaryOpener, runProjectManagerMain } from "./project-manager-main.js";
import type { ProjectRuntimeSupervisorOptions } from "./project-runtime-supervisor.js";

/**
 * The hosted daemon cannot see the manager's console, so MOE_OPERATOR_CHANNEL carries what
 * the manager measured. The manager's own pairing route follows the LIVE flag (a console
 * that hit EOF takes no typed label), but the opener baked a boolean snapshot taken before
 * the console was attached: every project launched after EOF told its operator to type a
 * label nobody read, the 2026-09-13 defect back for the post-EOF launches.
 */

const CREDENTIAL = "a".repeat(64);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN = Object.freeze({
  code: "PROCESS_BOUNDARY_TEST", layer: "WINDOWS_PROCESS_TEST", truthClass: "UNKNOWN" as const,
});
const temporaries: string[] = [];

afterEach(async () => {
  for (const path of temporaries.splice(0)) await rm(path, { force: true, recursive: true });
});

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "moe-project-operator-channel-"));
  temporaries.push(path);
  // The launch compares canonical paths; an 8.3 temp name would refuse the config as mismatched.
  return realpathSync.native(path);
}

function configFor(storePath: string): string {
  return JSON.stringify({
    credential: CREDENTIAL, projectId: "alpha", schemaVersion: "moe-cli-config/1", storePath,
  });
}

function channelOf(request: WindowsProjectStackRequest | undefined): string | undefined {
  return request?.environment["MOE_OPERATOR_CHANNEL"];
}

describe("the operator channel at the project launch edge", () => {
  const ENTRY: ProjectCatalogEntry = Object.freeze({
    configPath: "C:\\work\\alpha\\moe.config.json",
    instanceId: INSTANCE_ID,
    projectId: "alpha",
    root: "C:\\work\\alpha",
    storePath: "C:\\work\\alpha\\store.sqlite",
    title: "Alpha",
  });
  const launchFs = Object.freeze({
    canonicalDirectory: (path: string) => path,
    canonicalFile: (path: string) => path,
    readConfig: () => configFor(ENTRY.storePath),
  });

  it("reads the channel at every launch, never at construction, and fails closed on a fault", () => {
    const channel = vi.fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => { throw new Error("channel getter failed"); });
    const requests: WindowsProjectStackRequest[] = [];
    const opener = createProjectBoundaryOpener({
      assetRoot: "D:\\artifact\\apps\\control-room\\dist",
      environment: { ANTHROPIC_API_KEY: "provider-secret" },
      launchFs,
      nodeExecutable: "C:\\node.exe",
      openBoundary: (request) => { requests.push(request); return UNKNOWN; },
      operatorChannelAvailable: channel,
      root: "D:\\artifact",
    });
    expect(channel).not.toHaveBeenCalled();
    for (let launch = 0; launch < 3; launch += 1) expect(opener(ENTRY)).toEqual(UNKNOWN);
    expect(channel).toHaveBeenCalledTimes(3);
    // A getter that throws is no evidence of a console: the daemon is told there is none.
    expect(requests.map(channelOf)).toEqual(["true", "false", "false"]);
  });

  it.runIf(process.platform === "win32")(
    "launches every project with the LIVE channel, so a console that hit EOF is not restated", async () => {
    const localAppData = await temporary();
    const projectRoot = await temporary();
    const storePath = join(projectRoot, "store.sqlite");
    const configPath = join(projectRoot, "moe.config.json");
    await writeFile(configPath, configFor(storePath), "utf8");
    const entry: ProjectCatalogEntry = Object.freeze({
      configPath, instanceId: INSTANCE_ID, projectId: "alpha", root: projectRoot, storePath,
      title: "Alpha",
    });
    const input = new PassThrough();
    let launch: ProjectRuntimeSupervisorOptions["openBoundary"] | undefined;
    let available: (() => boolean) | undefined;
    let signal: (() => void) | undefined;
    const requests: WindowsProjectStackRequest[] = [];
    const completed = runProjectManagerMain({
      dependencies: {
        createRuntime: (options) => {
          launch = options.openBoundary;
          return Object.freeze({
            approvePairing: vi.fn(), list: () => Object.freeze([]), open: vi.fn(),
            shutdown: async () => ({
              code: "PROJECT_RUNTIME_SHUTDOWN", layer: "PROJECT_RUNTIME_SUPERVISOR", ok: true,
            }),
            start: vi.fn(), stop: vi.fn(), wait: vi.fn(),
          });
        },
        openBoundary: (request) => { requests.push(request); return UNKNOWN; },
        resolveAssetRoot: () => "D:\\artifact\\apps\\control-room\\dist",
        startHttp: async (options) => {
          available = options.operatorChannelAvailable;
          return {
            approvePairing: () => ({
              code: "PAIRING_CONFIRMATION_UNKNOWN" as const,
              layer: "CONTROL_ROOM_PAIRING_APPROVAL" as const, ok: false as const,
            }),
            close: async () => undefined, ok: true,
            origin: "http://127.0.0.2:39122", port: 39122,
          };
        },
      },
      env: { ANTHROPIC_API_KEY: "provider-secret", LOCALAPPDATA: localAppData },
      log: () => undefined,
      onSignal: (handler) => { signal = handler; },
      operatorInput: input,
      platform: "win32",
      root: "D:\\artifact",
    });
    try {
      await vi.waitFor(() => expect(signal).toBeTypeOf("function"));
      // With the piped console live, the hosted daemon is told so.
      expect(launch!(entry)).toEqual(UNKNOWN);
      expect(channelOf(requests[0])).toBe("true");
      // The pipe hits EOF: the manager's pairing route stops offering a typed label...
      input.end();
      await vi.waitFor(() => expect(available!()).toBe(false));
      // ...and a project started from the manager UI after that must hear the same fact.
      expect(launch!(entry)).toEqual(UNKNOWN);
      expect(requests).toHaveLength(2);
      expect(channelOf(requests[1])).toBe("false");
    } finally {
      input.destroy();
      signal?.();
      expect(await completed).toBe(0);
    }
    },
  );
});
