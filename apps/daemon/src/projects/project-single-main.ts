import { randomUUID } from "node:crypto";
import { win32 } from "node:path";

import { openWindowsProjectStackBoundary } from "@moe/runner";
import type { WindowsProjectStackRequest } from "@moe/runner";

import { controlRoomAssetRoot } from "../orchestrator/moe-up-spawn.js";
import { consumePairingOperatorLines } from "../http/pairing-operator-channel.js";
import type { PairingOperatorInput } from "../http/pairing-operator-channel.js";
import { createNodeProjectManagerFiles } from "./project-manager-files.js";
import type { ProjectManagerFilesPort } from "./project-manager-files.js";
import { createProjectBoundaryOpener } from "./project-manager-main.js";
import { createProjectRuntimeSupervisor } from "./project-runtime-supervisor.js";
import type {
  ProjectRuntimeBoundary,
  ProjectRuntimeBoundaryUnknown,
  ProjectRuntimeSupervisor,
  ProjectRuntimeSupervisorOptions,
} from "./project-runtime-supervisor.js";

export const PROJECT_SINGLE_MAIN_LAYER = "PROJECT_SINGLE_MAIN" as const;
export const PROJECT_SINGLE_PLATFORM_UNSUPPORTED = "PROJECT_SINGLE_PLATFORM_UNSUPPORTED" as const;
export const PROJECT_SINGLE_ASSET_ROOT_MISSING = "PROJECT_SINGLE_ASSET_ROOT_MISSING" as const;
export const PROJECT_SINGLE_INSTANCE_ID_INVALID = "PROJECT_SINGLE_INSTANCE_ID_INVALID" as const;
export const PROJECT_SINGLE_SIGNAL_REGISTRATION_FAILED =
  "PROJECT_SINGLE_SIGNAL_REGISTRATION_FAILED" as const;

type ProjectBoundaryOpener = (
  request: WindowsProjectStackRequest,
) => ProjectRuntimeBoundary | ProjectRuntimeBoundaryUnknown;

export interface ProjectSingleMainDependencies {
  readonly createFiles: () => ProjectManagerFilesPort;
  readonly createRuntime: (options: ProjectRuntimeSupervisorOptions) => ProjectRuntimeSupervisor;
  readonly mintUuid: () => string;
  readonly openBoundary: ProjectBoundaryOpener;
  readonly resolveAssetRoot: (root: string) => string | null;
}

export interface ProjectSingleMainOptions {
  readonly dependencies?: Partial<ProjectSingleMainDependencies>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly operatorInput?: PairingOperatorInput | undefined;
  readonly onSignal?: (handler: () => void) => void;
  readonly platform?: string;
  readonly projectRoot: string;
  readonly root: string;
}

const DEFAULT_DEPENDENCIES: ProjectSingleMainDependencies = Object.freeze({
  createFiles: createNodeProjectManagerFiles,
  createRuntime: (options: ProjectRuntimeSupervisorOptions) => createProjectRuntimeSupervisor(options),
  mintUuid: randomUUID,
  openBoundary: (request: WindowsProjectStackRequest) => openWindowsProjectStackBoundary(request),
  resolveAssetRoot: controlRoomAssetRoot,
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function disclose(value: Readonly<{ readonly code: string; readonly layer: string }>,
  log: (line: string) => void): void {
  log(`${value.code} ${value.layer}`);
}

function refusal(code: string): Readonly<{
  readonly code: string; readonly layer: typeof PROJECT_SINGLE_MAIN_LAYER;
}> {
  return Object.freeze({ code, layer: PROJECT_SINGLE_MAIN_LAYER });
}

function defaultSignals(handler: () => void): void {
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

/** `moe start` compatibility, backed by the same native store lock as the manager. */
export async function runSingleProjectMain(options: ProjectSingleMainOptions): Promise<number> {
  const dependencies: ProjectSingleMainDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };
  if ((options.platform ?? process.platform) !== "win32") {
    disclose(refusal(PROJECT_SINGLE_PLATFORM_UNSUPPORTED), options.log);
    return 1;
  }
  const assetRoot = dependencies.resolveAssetRoot(options.root);
  if (assetRoot === null) {
    disclose(refusal(PROJECT_SINGLE_ASSET_ROOT_MISSING), options.log);
    return 1;
  }
  const prepared = await dependencies.createFiles().register(options.projectRoot);
  if (!prepared.ok) {
    disclose(prepared, options.log);
    return 1;
  }
  let instanceId: string;
  try { instanceId = dependencies.mintUuid(); }
  catch {
    disclose(refusal(PROJECT_SINGLE_INSTANCE_ID_INVALID), options.log);
    return 1;
  }
  if (!UUID_V4.test(instanceId)) {
    disclose(refusal(PROJECT_SINGLE_INSTANCE_ID_INVALID), options.log);
    return 1;
  }
  const runtime = dependencies.createRuntime({
    openBoundary: createProjectBoundaryOpener({
      assetRoot,
      environment: options.env,
      nodeExecutable: process.execPath,
      openBoundary: dependencies.openBoundary,
      root: options.root,
    }),
  });
  let signal!: () => void;
  const signalled = new Promise<"SIGNAL">((resolve) => {
    let fired = false;
    signal = (): void => {
      if (fired) return;
      fired = true;
      resolve("SIGNAL");
    };
  });
  try { (options.onSignal ?? defaultSignals)(signal); }
  catch {
    disclose(refusal(PROJECT_SINGLE_SIGNAL_REGISTRATION_FAILED), options.log);
    return 1;
  }
  const entry = Object.freeze({
    ...prepared.project,
    instanceId,
    title: win32.basename(prepared.project.root) || prepared.project.projectId,
  });
  const started = await runtime.start(entry);
  if (!started.ok) {
    disclose(started, options.log);
    return 1;
  }
  const opened = await runtime.open(instanceId);
  if (!opened.ok || !("origin" in opened)) {
    disclose(opened, options.log);
    const shutdown = await runtime.shutdown();
    if (!shutdown.ok) disclose(shutdown, options.log);
    return 1;
  }
  if (options.operatorInput !== undefined) {
    void consumePairingOperatorLines(options.operatorInput, async (line) => {
      if (/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u.test(line)) {
        await runtime.approvePairing(instanceId, line);
      }
    });
  }
  options.log("moe start: project runtime ready");
  options.log(`moe start: ${opened.origin}`);
  options.log("moe start: Ctrl-C stops this project runtime");

  const outcome = await Promise.race([
    runtime.wait(instanceId).then((result) => ({ kind: "COMPLETED" as const, result })),
    signalled.then(() => ({ kind: "SIGNAL" as const })),
  ]);
  if (outcome.kind === "SIGNAL") {
    const shutdown = await runtime.shutdown();
    if (!shutdown.ok) { disclose(shutdown, options.log); return 1; }
    return 0;
  }
  if (!outcome.result.ok) {
    disclose(outcome.result, options.log);
    return 1;
  }
  return outcome.result.exitCode;
}
