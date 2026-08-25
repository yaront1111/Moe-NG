#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, win32 } from "node:path";

import {
  openWindowsProjectStackBoundary,
  type WindowsProjectStackRequest,
} from "@moe/runner";

import { controlRoomAssetRoot } from "../orchestrator/moe-up-spawn.js";
import { resolveLaunchEnv } from "../orchestrator/moe-up-env.js";
import {
  createNodeProjectCatalogFs,
  loadProjectCatalog,
  registerCatalogProject,
  saveProjectCatalogAtomic,
} from "./project-catalog.js";
import type {
  ProjectCatalog,
  ProjectCatalogEntry,
  ProjectCatalogPorts,
  RegisterCatalogProjectInput,
} from "./project-catalog.js";
import { createNodeProjectManagerFiles } from "./project-manager-files.js";
import {
  startProjectManagerHttp,
} from "./project-manager-http.js";
import type {
  StartProjectManagerHttpOptions,
  StartProjectManagerHttpResult,
} from "./project-manager-http.js";
import {
  createNodeProjectManagerLaunchFs,
  prepareProjectManagerLaunch,
} from "./project-manager-launch.js";
import type { ProjectManagerLaunchFs } from "./project-manager-launch.js";
import {
  selectedProviderEnvironment,
  snapshotProjectLaunchEnvironment,
} from "./project-launch-environment.js";
import { createProjectManagerService } from "./project-manager-service.js";
import type { ProjectManagerCatalogPort } from "./project-manager-service.js";
import {
  createProjectRuntimeSupervisor,
} from "./project-runtime-supervisor.js";
import type {
  ProjectRuntimeBoundary,
  ProjectRuntimeBoundaryUnknown,
  ProjectRuntimeSupervisor,
  ProjectRuntimeSupervisorOptions,
} from "./project-runtime-supervisor.js";
import { consumePairingOperatorLines } from "../http/pairing-operator-channel.js";
import type { PairingOperatorInput } from "../http/pairing-operator-channel.js";

export const PROJECT_MANAGER_MAIN_LAYER = "PROJECT_MANAGER_MAIN" as const;
export const PROJECT_MANAGER_PLATFORM_UNSUPPORTED = "PROJECT_MANAGER_PLATFORM_UNSUPPORTED" as const;
export const PROJECT_MANAGER_LOCAL_APP_DATA_INVALID = "PROJECT_MANAGER_LOCAL_APP_DATA_INVALID" as const;
export const PROJECT_MANAGER_DIRECTORY_UNUSABLE = "PROJECT_MANAGER_DIRECTORY_UNUSABLE" as const;
export const PROJECT_MANAGER_ASSET_ROOT_MISSING = "PROJECT_MANAGER_ASSET_ROOT_MISSING" as const;
export const PROJECT_MANAGER_SIGNAL_REGISTRATION_FAILED = "PROJECT_MANAGER_SIGNAL_REGISTRATION_FAILED" as const;
export const PROJECT_MANAGER_SHUTDOWN_FAILED = "PROJECT_MANAGER_SHUTDOWN_FAILED" as const;
export const PROJECT_MANAGER_START_FAILED = "PROJECT_MANAGER_START_FAILED" as const;
export const PROJECT_MANAGER_PORT = 39_122;
export const PROJECT_MANAGER_DIRECTORY_NAME = "Moe" as const;
export const PROJECT_MANAGER_CATALOG_FILENAME = "projects.json" as const;

type ManagedRuntime = ProjectRuntimeSupervisor;
type ProjectBoundaryOpener = (
  request: WindowsProjectStackRequest,
) => ProjectRuntimeBoundary | ProjectRuntimeBoundaryUnknown;

export interface CreateProjectBoundaryOpenerOptions {
  readonly assetRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly launchFs?: ProjectManagerLaunchFs;
  readonly nodeExecutable: string;
  readonly openBoundary: ProjectBoundaryOpener;
  readonly root: string;
}

export interface ProjectManagerMainDependencies {
  readonly createRuntime: (options: ProjectRuntimeSupervisorOptions) => ManagedRuntime;
  readonly mintUuid: () => string;
  readonly openBoundary: ProjectBoundaryOpener;
  readonly resolveAssetRoot: (root: string) => string | null;
  readonly startHttp: (
    options: StartProjectManagerHttpOptions,
  ) => Promise<StartProjectManagerHttpResult>;
}

export interface ProjectManagerMainOptions {
  readonly dependencies?: Partial<ProjectManagerMainDependencies>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly operatorInput?: PairingOperatorInput | undefined;
  readonly onSignal?: (handler: () => void) => void;
  readonly platform?: string;
  readonly root: string;
}

const DEFAULT_DEPENDENCIES: ProjectManagerMainDependencies = Object.freeze({
  createRuntime: (options: ProjectRuntimeSupervisorOptions): ManagedRuntime =>
    createProjectRuntimeSupervisor(options),
  mintUuid: randomUUID,
  openBoundary: (request: WindowsProjectStackRequest) => openWindowsProjectStackBoundary(request),
  resolveAssetRoot: controlRoomAssetRoot,
  startHttp: startProjectManagerHttp,
});

function mainRefusal(code: string): Readonly<{
  readonly code: string; readonly layer: typeof PROJECT_MANAGER_MAIN_LAYER; readonly ok: false;
}> {
  return Object.freeze({ code, layer: PROJECT_MANAGER_MAIN_LAYER, ok: false });
}

function disclose(
  value: Readonly<{ readonly code: string; readonly layer: string }>,
  log: (line: string) => void,
): void {
  log(`${value.code} ${value.layer}`);
}

function localWindowsDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && value.trim() === value && !value.includes("\0")
    && /^[A-Za-z]:[\\/]/u.test(value) && win32.isAbsolute(value);
}

/** The only composition edge allowed to open a per-project native Job. */
export function createProjectBoundaryOpener(
  options: CreateProjectBoundaryOpenerOptions,
): (entry: ProjectCatalogEntry) => ProjectRuntimeBoundary | ProjectRuntimeBoundaryUnknown {
  const launchFs = options.launchFs ?? createNodeProjectManagerLaunchFs();
  const entryPath = join(
    options.root,
    "apps", "daemon", "src", "projects", "project-stack-host-main.ts",
  );
  return (entry: ProjectCatalogEntry): ProjectRuntimeBoundary | ProjectRuntimeBoundaryUnknown => {
    const snapshot = snapshotProjectLaunchEnvironment(options.environment);
    if (snapshot === null) {
      return Object.freeze({
        code: "PROJECT_MANAGER_LAUNCH_ENVIRONMENT_INVALID",
        layer: "PROJECT_MANAGER_LAUNCH",
        truthClass: "UNKNOWN",
      });
    }
    const provider = resolveLaunchEnv({ env: snapshot, repoRoot: entry.root });
    if (!provider.ok) {
      return Object.freeze({
        code: provider.refusals[0]?.code ?? "MOE_UP_ENV_MISSING",
        layer: "PROJECT_MANAGER_LAUNCH",
        truthClass: "UNKNOWN",
      });
    }
    const prepared = prepareProjectManagerLaunch(
      entry,
      selectedProviderEnvironment(snapshot, provider.env),
      launchFs,
    );
    if (!prepared.ok) {
      return Object.freeze({ code: prepared.code, layer: prepared.layer, truthClass: "UNKNOWN" });
    }
    return options.openBoundary({
      assetRoot: options.assetRoot,
      configPath: entry.configPath,
      cwd: entry.root,
      entryPath,
      environment: prepared.environment,
      instanceId: entry.instanceId,
      nodeExecutable: options.nodeExecutable,
      storePath: entry.storePath,
    });
  };
}

function defaultSignalRegistration(handler: () => void): void {
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

async function drain(
  listener: Extract<StartProjectManagerHttpResult, { readonly ok: true }>,
  runtime: ManagedRuntime,
  log: (line: string) => void,
): Promise<number> {
  let failed = false;
  try { await listener.close(); } catch { failed = true; }
  try {
    const shutdown = await runtime.shutdown();
    if (!shutdown.ok) { disclose(shutdown, log); failed = true; }
  } catch { failed = true; }
  if (failed) disclose(mainRefusal(PROJECT_MANAGER_SHUTDOWN_FAILED), log);
  return failed ? 1 : 0;
}

/**
 * Foreground Windows manager. The fixed loopback port is the live singleton;
 * the durable catalog holds identity only, while every runtime secret stays in
 * the selected project's config and is re-read only at start.
 */
export async function runProjectManagerMain(options: ProjectManagerMainOptions): Promise<number> {
  const dependencies: ProjectManagerMainDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };
  if ((options.platform ?? process.platform) !== "win32") {
    disclose(mainRefusal(PROJECT_MANAGER_PLATFORM_UNSUPPORTED), options.log);
    return 1;
  }
  const localAppData = options.env["LOCALAPPDATA"];
  if (!localWindowsDirectory(localAppData)) {
    disclose(mainRefusal(PROJECT_MANAGER_LOCAL_APP_DATA_INVALID), options.log);
    return 1;
  }
  const assetRoot = dependencies.resolveAssetRoot(options.root);
  if (assetRoot === null) {
    disclose(mainRefusal(PROJECT_MANAGER_ASSET_ROOT_MISSING), options.log);
    return 1;
  }
  const managerDirectory = join(localAppData, PROJECT_MANAGER_DIRECTORY_NAME);
  const catalogPath = join(managerDirectory, PROJECT_MANAGER_CATALOG_FILENAME);
  try {
    await mkdir(managerDirectory, { mode: 0o700, recursive: true });
  } catch {
    disclose(mainRefusal(PROJECT_MANAGER_DIRECTORY_UNUSABLE), options.log);
    return 1;
  }

  const catalogFs = createNodeProjectCatalogFs();
  const loaded = await loadProjectCatalog(catalogPath, catalogFs);
  if (!loaded.ok) {
    disclose(loaded, options.log);
    return 1;
  }
  const catalogPorts: ProjectCatalogPorts = Object.freeze({
    fs: catalogFs,
    mintUuid: dependencies.mintUuid,
  });
  const runtime = dependencies.createRuntime({
    openBoundary: createProjectBoundaryOpener({
      assetRoot,
      environment: options.env,
      nodeExecutable: process.execPath,
      openBoundary: dependencies.openBoundary,
      root: options.root,
    }),
  });
  const manager = createProjectManagerService({
    catalog: loaded.catalog,
    catalogPort: Object.freeze({
      register: async (catalog: ProjectCatalog, input: RegisterCatalogProjectInput) =>
        await registerCatalogProject(catalog, input, catalogPorts),
      save: async (catalog: ProjectCatalog) =>
        await saveProjectCatalogAtomic(catalogPath, catalog, catalogPorts),
    } satisfies ProjectManagerCatalogPort),
    files: createNodeProjectManagerFiles(),
    runtime,
  });
  let csrfToken: string;
  try { csrfToken = dependencies.mintUuid(); }
  catch {
    disclose(mainRefusal(PROJECT_MANAGER_START_FAILED), options.log);
    return 1;
  }
  let listener: StartProjectManagerHttpResult;
  try {
    listener = await dependencies.startHttp({
      assetRoot,
      csrfToken,
      manager,
      port: PROJECT_MANAGER_PORT,
    });
  } catch {
    disclose(mainRefusal(PROJECT_MANAGER_START_FAILED), options.log);
    return 1;
  }
  if (!listener.ok) {
    disclose(listener, options.log);
    return 1;
  }

  let settle!: (code: number) => void;
  const completed = new Promise<number>((resolve) => { settle = resolve; });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void drain(listener, runtime, options.log).then(settle);
  };
  try {
    (options.onSignal ?? defaultSignalRegistration)(stop);
  } catch {
    disclose(mainRefusal(PROJECT_MANAGER_SIGNAL_REGISTRATION_FAILED), options.log);
    return await drain(listener, runtime, options.log).then(() => 1);
  }
  options.log("moe projects: project manager ready");
  options.log(`moe projects: ${listener.origin}`);
  options.log("moe projects: Ctrl-C stops the manager and every project runtime");
  if (options.operatorInput !== undefined) {
    void consumePairingOperatorLines(options.operatorInput, async (line) => {
      if (/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u.test(line)) {
        const result = listener.approvePairing(line);
        if (!result.ok) disclose(result, options.log);
        return;
      }
      const project = /^(?<instanceId>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) (?<label>[0-9a-f]{4}(?:-[0-9a-f]{4}){2})$/u.exec(line)?.groups;
      if (project?.["instanceId"] !== undefined && project["label"] !== undefined) {
        const result = await runtime.approvePairing(project["instanceId"], project["label"]);
        if (!result.ok) disclose(result, options.log);
      }
    });
  }
  return await completed;
}
