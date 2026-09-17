import { randomUUID } from "node:crypto";
import { win32 } from "node:path";

import { openWindowsProjectStackBoundary } from "@moe/runner";
import type { WindowsProjectStackRequest } from "@moe/runner";

import { controlRoomAssetRoot } from "../orchestrator/moe-up-spawn.js";
import type { PairingOperatorInput } from "../http/pairing-operator-channel.js";
import { createNodeProjectManagerFiles } from "./project-manager-files.js";
import type { ProjectManagerFilesPort } from "./project-manager-files.js";
import { createProjectBoundaryOpener } from "./project-manager-main.js";
import {
  CONFIRMATION_LABEL,
  attachOperatorInput,
  normalizeOperatorLine,
} from "./project-operator-input.js";
import { createProjectRuntimeSupervisor } from "./project-runtime-supervisor.js";
import type {
  ProjectRuntimeBoundary,
  ProjectRuntimeBoundaryUnknown,
  ProjectRuntimeSupervisor,
  ProjectRuntimeSupervisorOptions,
} from "./project-runtime-supervisor.js";
import { wrapperLogPath } from "./project-wrapper-log.js";

export const PROJECT_SINGLE_MAIN_LAYER = "PROJECT_SINGLE_MAIN" as const;
export const PROJECT_SINGLE_PLATFORM_UNSUPPORTED = "PROJECT_SINGLE_PLATFORM_UNSUPPORTED" as const;
export const PROJECT_SINGLE_ASSET_ROOT_MISSING = "PROJECT_SINGLE_ASSET_ROOT_MISSING" as const;
export const PROJECT_SINGLE_INSTANCE_ID_INVALID = "PROJECT_SINGLE_INSTANCE_ID_INVALID" as const;
export const PROJECT_SINGLE_SIGNAL_REGISTRATION_FAILED =
  "PROJECT_SINGLE_SIGNAL_REGISTRATION_FAILED" as const;
/** A typed line that is not a confirmation label; the line itself is never echoed. */
export const PROJECT_SINGLE_OPERATOR_LINE_IGNORED = "PROJECT_SINGLE_OPERATOR_LINE_IGNORED" as const;
/** The runtime ended on its own (a proven native exit), not on Ctrl-C. */
export const PROJECT_SINGLE_RUNTIME_ENDED = "PROJECT_SINGLE_RUNTIME_ENDED" as const;
/** No console is attached: nothing in this process reads a typed pairing label. */
export const PROJECT_SINGLE_OPERATOR_CHANNEL_ABSENT = "PROJECT_SINGLE_OPERATOR_CHANNEL_ABSENT" as const;
export const PROJECT_SINGLE_OPERATOR_CHANNEL_ABSENT_MESSAGE =
  "moe start: no operator terminal; pairing labels cannot be typed here - relaunch from a console or with --operator-stdin";

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

/** `CODE LAYER` first, so a script's match is stable; the detail, when carried, on its own line. */
function disclose(
  value: Readonly<{ readonly code: string; readonly layer: string; readonly message?: string }>,
  log: (line: string) => void,
): void {
  log(`${value.code} ${value.layer}`);
  if (value.message !== undefined) log(value.message);
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
      // Measured, like daemon-main.ts: the hosted daemon can only report what THIS
      // process consumes, and it used to assert a channel whatever the console was.
      operatorChannelAvailable: () => options.operatorInput !== undefined,
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
  const operator = attachOperatorInput(options.operatorInput, async (line) => {
    const label = normalizeOperatorLine(line);
    if (!CONFIRMATION_LABEL.test(label)) {
      disclose(refusal(PROJECT_SINGLE_OPERATOR_LINE_IGNORED), options.log);
      return;
    }
    // Answer the operator, but never echo the label: it is a bearer until consumed.
    // Before this the console stayed silent on both outcomes (measured 2026-09-13).
    const result = await runtime.approvePairing(instanceId, label);
    if (result.ok) options.log("moe start: pairing approved");
    else disclose(result, options.log);
  });
  if (options.operatorInput === undefined) {
    // Said here, before the banner: under piped stdio no other surface names the switch.
    disclose({
      code: PROJECT_SINGLE_OPERATOR_CHANNEL_ABSENT, layer: PROJECT_SINGLE_MAIN_LAYER,
      message: PROJECT_SINGLE_OPERATOR_CHANNEL_ABSENT_MESSAGE,
    }, options.log);
  }
  try {
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
    // A self-ending runtime (a wrapper death, MOE_WRAPPER_ONCE, a host crash) is proven at
    // the supervisor but was never SAID here: the prompt returned right after the Ctrl-C
    // line (measured 2026-09-13). The host's stderr is drained by design, so the only
    // durable console is the wrapper log, and nothing on screen named it.
    disclose({
      code: PROJECT_SINGLE_RUNTIME_ENDED, layer: PROJECT_SINGLE_MAIN_LAYER,
      message: `moe start: project runtime ended with exit ${String(outcome.result.exitCode)}; `
        + `the wrapper console is in ${wrapperLogPath(prepared.project.root)}`,
    }, options.log);
    return outcome.result.exitCode;
  } finally {
    // The console stdin is released on EVERY path out of here, a throwing wait() or
    // shutdown() included: a surviving handle keeps the process alive after the runtime
    // is proven down, and the exit code is never seen.
    await operator.release();
  }
}
