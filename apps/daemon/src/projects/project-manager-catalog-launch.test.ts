import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WindowsProjectStackRequest } from "@moe/runner";

import type { ProjectCatalogEntry } from "./project-catalog.js";
import {
  PROJECT_CATALOG_ENV_KEY,
  resolveProjectCatalogPath,
} from "./project-catalog-registrar.js";
import {
  PROJECT_MANAGER_CATALOG_FILENAME,
  PROJECT_MANAGER_DIRECTORY_NAME,
  createProjectBoundaryOpener,
  runProjectManagerMain,
} from "./project-manager-main.js";
import type { ProjectRuntimeSupervisorOptions } from "./project-runtime-supervisor.js";

/**
 * One manager catalog per host. The manager loads and saves %LOCALAPPDATA%\Moe\projects.json,
 * while the hosted daemon's repository bootstrap registers through `resolveProjectCatalogPath`,
 * which falls back to ~/.moe-next/projects.json when MOE_PROJECT_CATALOG is unbound. Before the
 * opener bound it, a bootstrapped product landed in a file the manager never reads.
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
  const path = await mkdtemp(join(tmpdir(), "moe-project-catalog-launch-"));
  temporaries.push(path);
  // The launch compares canonical paths; an 8.3 temp name would refuse the config as mismatched.
  return realpathSync.native(path);
}

function configFor(storePath: string): string {
  return JSON.stringify({
    credential: CREDENTIAL, projectId: "alpha", schemaVersion: "moe-cli-config/1", storePath,
  });
}

describe("the manager catalog binding at the project launch edge", () => {
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

  it("binds the opener's catalog and ignores a caller's MOE_PROJECT_CATALOG", () => {
    const managerCatalog = "C:\\Users\\operator\\AppData\\Local\\Moe\\projects.json";
    for (const catalogPath of [managerCatalog, undefined]) {
      const requests: WindowsProjectStackRequest[] = [];
      createProjectBoundaryOpener({
        assetRoot: "D:\\artifact\\apps\\control-room\\dist",
        ...(catalogPath === undefined ? {} : { catalogPath }),
        environment: {
          ANTHROPIC_API_KEY: "provider-secret",
          MOE_PROJECT_CATALOG: "C:\\foreign\\projects.json",
        },
        launchFs,
        nodeExecutable: "C:\\node.exe",
        openBoundary: (request) => { requests.push(request); return UNKNOWN; },
        operatorChannelAvailable: () => false,
        root: "D:\\artifact",
      })(ENTRY);
      expect(requests).toHaveLength(1);
      const environment = requests[0]!.environment;
      expect(JSON.stringify(environment)).not.toContain("foreign");
      if (catalogPath === undefined) expect(environment).not.toHaveProperty(PROJECT_CATALOG_ENV_KEY);
      else expect(environment[PROJECT_CATALOG_ENV_KEY]).toBe(managerCatalog);
    }
  });

  it.runIf(process.platform === "win32")(
    "launches every project stack with the exact catalog the manager loads", async () => {
    const localAppData = await temporary();
    const projectRoot = await temporary();
    const storePath = join(projectRoot, "store.sqlite");
    const configPath = join(projectRoot, "moe.config.json");
    await writeFile(configPath, configFor(storePath), "utf8");
    let runtimeOptions: ProjectRuntimeSupervisorOptions | undefined;
    let signal: (() => void) | undefined;
    const requests: WindowsProjectStackRequest[] = [];
    const completed = runProjectManagerMain({
      dependencies: {
        createRuntime: (options) => {
          runtimeOptions = options;
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
        startHttp: async () => ({
          approvePairing: () => ({
            code: "PAIRING_CONFIRMATION_UNKNOWN" as const,
            layer: "CONTROL_ROOM_PAIRING_APPROVAL" as const, ok: false as const,
          }),
          close: async () => undefined, ok: true,
          origin: "http://127.0.0.2:39122", port: 39122,
        }),
      },
      env: {
        ANTHROPIC_API_KEY: "provider-secret",
        LOCALAPPDATA: localAppData,
        MOE_PROJECT_CATALOG: "C:\\foreign\\projects.json",
      },
      log: () => undefined,
      onSignal: (handler) => { signal = handler; },
      platform: "win32",
      root: "D:\\artifact",
    });
    try {
      await vi.waitFor(() => expect(signal).toBeTypeOf("function"));
      expect(runtimeOptions!.openBoundary({
        configPath, instanceId: INSTANCE_ID, projectId: "alpha",
        root: projectRoot, storePath, title: "Alpha",
      })).toEqual(UNKNOWN);
      expect(requests).toHaveLength(1);
      const managerCatalog = join(
        localAppData, PROJECT_MANAGER_DIRECTORY_NAME, PROJECT_MANAGER_CATALOG_FILENAME,
      );
      expect(requests[0]!.environment[PROJECT_CATALOG_ENV_KEY]).toBe(managerCatalog);
      // The hosted daemon's registrar reads its catalog from exactly this environment.
      expect(resolveProjectCatalogPath(requests[0]!.environment)).toBe(managerCatalog);
    } finally {
      signal?.();
      expect(await completed).toBe(0);
    }
    },
  );
});
