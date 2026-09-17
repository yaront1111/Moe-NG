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
import { PROJECT_CATALOG_ENV_KEY } from "./project-catalog-registrar.js";
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
import { projectStackLaunchOverlay } from "./project-launch-overlay.js";
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
import {
  CONFIRMATION_LABEL,
  PROJECT_INSTANCE_LABEL,
  attachOperatorInput,
  normalizeOperatorLine,
} from "./project-operator-input.js";
import type { PairingOperatorInput } from "../http/pairing-operator-channel.js";

export const PROJECT_MANAGER_MAIN_LAYER = "PROJECT_MANAGER_MAIN" as const;
export const PROJECT_MANAGER_PLATFORM_UNSUPPORTED = "PROJECT_MANAGER_PLATFORM_UNSUPPORTED" as const;
export const PROJECT_MANAGER_LOCAL_APP_DATA_INVALID = "PROJECT_MANAGER_LOCAL_APP_DATA_INVALID" as const;
export const PROJECT_MANAGER_DIRECTORY_UNUSABLE = "PROJECT_MANAGER_DIRECTORY_UNUSABLE" as const;
export const PROJECT_MANAGER_ASSET_ROOT_MISSING = "PROJECT_MANAGER_ASSET_ROOT_MISSING" as const;
export const PROJECT_MANAGER_SIGNAL_REGISTRATION_FAILED = "PROJECT_MANAGER_SIGNAL_REGISTRATION_FAILED" as const;
export const PROJECT_MANAGER_SHUTDOWN_FAILED = "PROJECT_MANAGER_SHUTDOWN_FAILED" as const;
export const PROJECT_MANAGER_START_FAILED = "PROJECT_MANAGER_START_FAILED" as const;
/** A typed line that is neither a manager label nor `<instanceId> <label>`; never echoed. */
export const PROJECT_MANAGER_OPERATOR_LINE_IGNORED = "PROJECT_MANAGER_OPERATOR_LINE_IGNORED" as const;
/** No console is attached: nothing in this process reads a typed pairing label. */
export const PROJECT_MANAGER_OPERATOR_CHANNEL_ABSENT = "PROJECT_MANAGER_OPERATOR_CHANNEL_ABSENT" as const;
export const PROJECT_MANAGER_OPERATOR_CHANNEL_ABSENT_MESSAGE =
  "moe projects: no operator terminal; pairing labels cannot be typed here - relaunch from a console or with --operator-stdin";
export const PROJECT_MANAGER_PORT = 39_122;
export const PROJECT_MANAGER_DIRECTORY_NAME = "Moe" as const;
export const PROJECT_MANAGER_CATALOG_FILENAME = "projects.json" as const;

type ManagedRuntime = ProjectRuntimeSupervisor;
type ProjectBoundaryOpener = (
  request: WindowsProjectStackRequest,
) => ProjectRuntimeBoundary | ProjectRuntimeBoundaryUnknown;

export interface CreateProjectBoundaryOpenerOptions {
  readonly assetRoot: string;
  /**
   * The catalog the manager loads and saves, bound as MOE_PROJECT_CATALOG so the hosted daemon's
   * repository bootstrap registers into it. Unbound, the registrar fell back to
   * ~/.moe-next/projects.json: a second catalog on the same host the manager never reads.
   */
  readonly catalogPath?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly launchFs?: ProjectManagerLaunchFs;
  readonly nodeExecutable: string;
  readonly openBoundary: ProjectBoundaryOpener;
  /**
   * Whether THIS process consumes typed pairing labels for the hosted daemon: the CLI
   * attached its console (or `--operator-stdin`) or it did not. The hosted daemon cannot
   * observe that and used to assert `true`, so under piped stdio the control room told
   * the operator to type a label nobody read (measured 2026-09-13, `isTTY` undefined).
   * Read at EVERY launch, never at construction: a console that hit EOF takes no typed
   * label, and a boolean snapshot restated the dead channel to each project started
   * from the manager UI after it. A read that throws is no evidence of a console.
   */
  readonly operatorChannelAvailable: () => boolean;
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

/** `CODE LAYER` first, so a script's match is stable; the detail, when carried, on its own line. */
function disclose(
  value: Readonly<{ readonly code: string; readonly layer: string; readonly message?: string }>,
  log: (line: string) => void,
): void {
  log(`${value.code} ${value.layer}`);
  if (value.message !== undefined) log(value.message);
}

function localWindowsDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && value.trim() === value && !value.includes("\0")
    && /^[A-Za-z]:[\\/]/u.test(value) && win32.isAbsolute(value);
}

/** The live channel at this launch; fail closed, exactly as the manager's pairing route does. */
function operatorChannelAtLaunch(read: () => boolean): boolean {
  try { return read() === true; } catch { return false; }
}

/** The only composition edge allowed to open a per-project native Job. */
export function createProjectBoundaryOpener(
  options: CreateProjectBoundaryOpenerOptions,
): (entry: ProjectCatalogEntry) => ProjectRuntimeBoundary | ProjectRuntimeBoundaryUnknown {
  const launchFs = options.launchFs ?? createNodeProjectManagerLaunchFs();
  const entryPath = win32.join(
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
      // The message is the operator's fix (the accepted names and the sign-in path that
      // was looked for); dropping it left a bare code on the packaged first run.
      const refusal = provider.refusals[0];
      return Object.freeze({
        code: refusal?.code ?? "MOE_UP_ENV_MISSING",
        layer: "PROJECT_MANAGER_LAUNCH",
        ...(refusal?.message === undefined ? {} : { message: refusal.message }),
        truthClass: "UNKNOWN",
      });
    }
    const prepared = prepareProjectManagerLaunch(
      entry,
      selectedProviderEnvironment(snapshot, projectStackLaunchOverlay(provider.variables)),
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
      // Server-owned: prepareProjectManagerLaunch dropped any caller value of these names.
      environment: Object.freeze({
        ...prepared.environment,
        MOE_OPERATOR_CHANNEL: String(operatorChannelAtLaunch(options.operatorChannelAvailable)),
        ...(options.catalogPath === undefined
          ? {} : { [PROJECT_CATALOG_ENV_KEY]: options.catalogPath }),
      }),
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
  // One flag for the pairing route AND every project launch: the opener used to bake a
  // snapshot taken here, so a project started after the console's EOF was told the
  // channel this route had already stopped reporting.
  let operatorChannelAvailable = options.operatorInput !== undefined;
  const runtime = dependencies.createRuntime({
    openBoundary: createProjectBoundaryOpener({
      assetRoot,
      catalogPath,
      environment: options.env,
      nodeExecutable: process.execPath,
      openBoundary: dependencies.openBoundary,
      operatorChannelAvailable: () => operatorChannelAvailable,
      root: options.root,
    }),
    // The same channel `moe start` discarded, and the manager hosts SEVERAL projects on one
    // console, so the project is named: without it the hosts' stderr would interleave into one
    // stream no operator could attribute.
    observeHostStderr: (entry, line) => { options.log(`[host ${entry.projectId}] ${line}`); },
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
      operatorChannelAvailable: () => operatorChannelAvailable,
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

  const operator = attachOperatorInput(options.operatorInput, async (line) => {
    const label = normalizeOperatorLine(line);
    if (CONFIRMATION_LABEL.test(label)) {
      const result = listener.approvePairing(label);
      if (!result.ok) disclose(result, options.log);
      return;
    }
    const project = PROJECT_INSTANCE_LABEL.exec(label)?.groups;
    if (project?.["instanceId"] !== undefined && project["label"] !== undefined) {
      const result = await runtime.approvePairing(project["instanceId"], project["label"]);
      if (!result.ok) disclose(result, options.log);
      return;
    }
    disclose(mainRefusal(PROJECT_MANAGER_OPERATOR_LINE_IGNORED), options.log);
  });
  // The pairing route reports the LIVE channel: a console that hit EOF or failed can no
  // longer take a typed label, so the flag follows the consumer's end, not only stop().
  void operator.ended.then(() => { operatorChannelAvailable = false; });
  // The drain never touched the console stdin, so `moe projects` stayed up after Ctrl-C
  // with HTTP closed and the runtime down (measured 2026-09-13); released on both exits.
  const released = async (code: number): Promise<number> => {
    await operator.release();
    return code;
  };
  let settle!: (code: number) => void;
  const completed = new Promise<number>((resolve) => { settle = resolve; });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    operatorChannelAvailable = false;
    void drain(listener, runtime, options.log).then(released).then(settle);
  };
  try {
    (options.onSignal ?? defaultSignalRegistration)(stop);
  } catch {
    disclose(mainRefusal(PROJECT_MANAGER_SIGNAL_REGISTRATION_FAILED), options.log);
    return await drain(listener, runtime, options.log).then(() => released(1));
  }
  if (options.operatorInput === undefined) {
    // Said here, before the banner: under piped stdio no other surface names the switch.
    disclose({
      code: PROJECT_MANAGER_OPERATOR_CHANNEL_ABSENT, layer: PROJECT_MANAGER_MAIN_LAYER,
      message: PROJECT_MANAGER_OPERATOR_CHANNEL_ABSENT_MESSAGE,
    }, options.log);
  }
  options.log("moe projects: project manager ready");
  options.log(`moe projects: ${listener.origin}`);
  options.log("moe projects: Ctrl-C stops the manager and every project runtime");
  return await completed;
}
