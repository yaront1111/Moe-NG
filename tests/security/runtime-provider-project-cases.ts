/**
 * Executable hostile-case inventory for the project runtime slice.
 *
 * The sibling `*.security.ts` runner executes these exact `run` functions, while the
 * completeness gate reads their exported `{boundary, arm}` identities. Coverage therefore
 * cannot be earned by a comment, an unreachable ledger call, or a regex-shaped string.
 */

import { Readable, Writable } from "node:stream";

import {
  PROJECT_MANAGER_FILES_LAYER,
  PROJECT_MANAGER_ROOT_INVALID,
  createNodeProjectManagerFiles,
} from "../../apps/daemon/src/projects/project-manager-files.js";
import {
  PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH,
  PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE,
  PROJECT_MANAGER_LAUNCH_LAYER,
  prepareProjectManagerLaunch,
} from "../../apps/daemon/src/projects/project-manager-launch.js";
import type { ProjectManagerLaunchFs } from "../../apps/daemon/src/projects/project-manager-launch.js";
import {
  PROJECT_MANAGER_LOCAL_APP_DATA_INVALID,
  PROJECT_MANAGER_MAIN_LAYER,
  PROJECT_MANAGER_PLATFORM_UNSUPPORTED,
  runProjectManagerMain,
} from "../../apps/daemon/src/projects/project-manager-main.js";
import {
  PROJECT_RUNTIME_PROTOCOL_VIOLATION,
  PROJECT_RUNTIME_SUPERVISOR_LAYER,
  ProjectRuntimeSession,
} from "../../apps/daemon/src/projects/project-runtime-session.js";
import {
  PROJECT_SINGLE_ASSET_ROOT_MISSING,
  PROJECT_SINGLE_MAIN_LAYER,
  PROJECT_SINGLE_PLATFORM_UNSUPPORTED,
  runSingleProjectMain,
} from "../../apps/daemon/src/projects/project-single-main.js";
import {
  PROJECT_STACK_DAEMON_START_FAILED,
  PROJECT_STACK_HOST_LAYER,
  PROJECT_STACK_WRAPPER_START_FAILED,
  runProjectStackHost,
} from "../../apps/daemon/src/projects/project-stack-host.js";
import { decodeProjectStackHostLine } from "../../apps/daemon/src/projects/project-stack-protocol.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import { RUNTIME_BOUND as BOUND } from "./runtime-provider-ledger.js";
import type { Arm, Ledger } from "./runtime-provider-ledger.js";

const ENTRY = Object.freeze({
  configPath: "C:\\work\\alpha\\moe.config.json",
  instanceId: "11111111-1111-4111-8111-111111111111",
  projectId: "alpha",
  root: "C:\\work\\alpha",
  storePath: "C:\\work\\alpha\\store.sqlite",
  title: "Alpha",
});

const FILES_BOUNDARY = "PROJECT_MANAGER_FILES_LAYER";
const LAUNCH_BOUNDARY = "PROJECT_MANAGER_LAUNCH_LAYER";
const MANAGER_MAIN_BOUNDARY = "PROJECT_MANAGER_MAIN_LAYER";
const RUNTIME_BOUNDARY = "PROJECT_RUNTIME_SUPERVISOR_LAYER";
const SINGLE_MAIN_BOUNDARY = "PROJECT_SINGLE_MAIN_LAYER";
const STACK_HOST_BOUNDARY = "PROJECT_STACK_HOST_LAYER";

export type ProjectRuntimeBoundary =
  | typeof FILES_BOUNDARY
  | typeof LAUNCH_BOUNDARY
  | typeof MANAGER_MAIN_BOUNDARY
  | typeof RUNTIME_BOUNDARY
  | typeof SINGLE_MAIN_BOUNDARY
  | typeof STACK_HOST_BOUNDARY;

export interface ProjectRuntimeHostileCase {
  readonly arm: Arm;
  readonly boundary: ProjectRuntimeBoundary;
  readonly name: string;
  readonly run: (ledger: Ledger) => Promise<void>;
}

function refusalFromLog(lines: readonly string[], exitCode: number): unknown {
  if (exitCode !== 1 || lines.length !== 1) return Object.freeze({ admitted: true });
  const [code, layer, extra] = (lines[0] ?? "").split(" ");
  return code !== undefined && layer !== undefined && extra === undefined
    ? Object.freeze({ code, layer, ok: false as const })
    : Object.freeze({ admitted: true });
}

async function managerMainRefusal(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  const lines: string[] = [];
  const exitCode = await runProjectManagerMain({
    env,
    log: (line) => { lines.push(line); },
    onSignal: () => undefined,
    platform,
    root: "D:\\artifact",
  });
  return refusalFromLog(lines, exitCode);
}

async function singleMainRefusal(platform: string, assetRoot: string | null): Promise<unknown> {
  const lines: string[] = [];
  const exitCode = await runSingleProjectMain({
    dependencies: { resolveAssetRoot: () => assetRoot },
    env: {},
    log: (line) => { lines.push(line); },
    onSignal: () => undefined,
    platform,
    projectRoot: "C:\\work\\alpha",
    root: "D:\\artifact",
  });
  return refusalFromLog(lines, exitCode);
}

async function prematurePairingApproval(confirmationLabel: string): Promise<unknown> {
  const session = new ProjectRuntimeSession({
    instanceId: ENTRY.instanceId,
    onTerminal: () => undefined,
    onViolation: () => undefined,
    projectId: ENTRY.projectId,
    stdin: new Writable({ write: (_chunk, _encoding, done) => { done(); } }),
    stdout: Readable.from([]),
    storePath: ENTRY.storePath,
  });
  const answer = await session.approvePairing(confirmationLabel);
  await session.closed;
  return answer;
}

async function stackHostRefusal(stage: "DAEMON" | "WRAPPER"): Promise<unknown> {
  const lines: string[] = [];
  const daemon = Object.freeze({
    approvePairing: () => Object.freeze({ ok: true as const, state: "APPROVED" as const }),
    origin: "http://127.0.0.1:4100",
    shutdown: async () => Object.freeze({ ok: true }),
  });
  const exitCode = await runProjectStackHost({
    controls: Readable.from([]),
    incarnationId: "22222222-2222-4222-8222-222222222222",
    instanceId: ENTRY.instanceId,
    log: () => undefined,
    projectId: ENTRY.projectId,
    startDaemon: async () => {
      if (stage === "DAEMON") throw new Error("hostile daemon launch");
      return daemon;
    },
    startWrapper: () => { throw new Error("hostile wrapper launch"); },
    storePath: ENTRY.storePath,
    write: (line) => { lines.push(line); },
  });
  if (exitCode !== 1 || lines.length !== 1) return Object.freeze({ admitted: true });
  const decoded = decodeProjectStackHostLine(lines[0] ?? "");
  return decoded.ok && decoded.frame.kind === "START_REFUSED"
    ? Object.freeze({ code: decoded.frame.code, layer: decoded.frame.layer, ok: false as const })
    : decoded;
}

const files = createNodeProjectManagerFiles();
const filesExpected = { code: PROJECT_MANAGER_ROOT_INVALID, layer: PROJECT_MANAGER_FILES_LAYER };

const throwingFs: ProjectManagerLaunchFs = {
  canonicalDirectory: () => { throw new Error("unreadable"); },
  canonicalFile: () => { throw new Error("unreadable"); },
  readConfig: () => { throw new Error("unreadable"); },
};
const malformedFs: ProjectManagerLaunchFs = {
  canonicalDirectory: (path) => path,
  canonicalFile: (path) => path,
  readConfig: () => "{}",
};
const launchUnreadable = {
  code: PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE,
  layer: PROJECT_MANAGER_LAUNCH_LAYER,
};
const launchMismatch = {
  code: PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH,
  layer: PROJECT_MANAGER_LAUNCH_LAYER,
};
const managerUnsupported = {
  code: PROJECT_MANAGER_PLATFORM_UNSUPPORTED,
  layer: PROJECT_MANAGER_MAIN_LAYER,
};
const managerLocalData = {
  code: PROJECT_MANAGER_LOCAL_APP_DATA_INVALID,
  layer: PROJECT_MANAGER_MAIN_LAYER,
};
const runtimeExpected = {
  code: PROJECT_RUNTIME_PROTOCOL_VIOLATION,
  layer: PROJECT_RUNTIME_SUPERVISOR_LAYER,
};
const singleUnsupported = {
  code: PROJECT_SINGLE_PLATFORM_UNSUPPORTED,
  layer: PROJECT_SINGLE_MAIN_LAYER,
};
const singleAssets = {
  code: PROJECT_SINGLE_ASSET_ROOT_MISSING,
  layer: PROJECT_SINGLE_MAIN_LAYER,
};
const stackDaemon = {
  code: PROJECT_STACK_DAEMON_START_FAILED,
  layer: PROJECT_STACK_HOST_LAYER,
};
const stackWrapper = {
  code: PROJECT_STACK_WRAPPER_START_FAILED,
  layer: PROJECT_STACK_HOST_LAYER,
};

export const PROJECT_RUNTIME_HOSTILE_CASES: readonly ProjectRuntimeHostileCase[] = Object.freeze([
  {
    arm: "BEFORE", boundary: FILES_BOUNDARY,
    name: "a relative root cannot reach project filesystem authority",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => await files.register("relative"),
        async () => await files.create(""),
      );
      ledger.refused(FILES_BOUNDARY, "BEFORE", outcome.probe, filesExpected);
      ledger.refused(FILES_BOUNDARY, "BEFORE", outcome.effect, filesExpected);
    },
  },
  {
    arm: "AFTER", boundary: FILES_BOUNDARY,
    name: "a UNC or NUL root replay remains outside the local project boundary",
    async run(ledger) {
      const outcome = await probeAfter(
        BOUND,
        async () => await files.register("\\\\server\\share"),
        async () => await files.create("C:\\work\0escape"),
      );
      ledger.refused(FILES_BOUNDARY, "AFTER", outcome.effect, filesExpected);
      ledger.refused(FILES_BOUNDARY, "AFTER", outcome.probe, filesExpected);
    },
  },
  {
    arm: "RACE", boundary: FILES_BOUNDARY,
    name: "two invalid roots contend and neither creates configuration",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () => await files.create("."),
        async () => await files.register("\\\\server\\share"),
      );
      ledger.refusedSide(FILES_BOUNDARY, outcome.left, filesExpected);
      ledger.refusedSide(FILES_BOUNDARY, outcome.right, filesExpected);
    },
  },
  {
    arm: "BEFORE", boundary: LAUNCH_BOUNDARY,
    name: "an unreadable private config cannot produce a launch environment",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => prepareProjectManagerLaunch(ENTRY, {}, throwingFs),
        async () => prepareProjectManagerLaunch(
          ENTRY, { NODE_OPTIONS: "--require=attacker" }, throwingFs,
        ),
      );
      ledger.refused(LAUNCH_BOUNDARY, "BEFORE", outcome.probe, launchUnreadable);
      ledger.refused(LAUNCH_BOUNDARY, "BEFORE", outcome.effect, launchUnreadable);
    },
  },
  {
    arm: "AFTER", boundary: LAUNCH_BOUNDARY,
    name: "malformed config bytes cannot reuse catalog identity",
    async run(ledger) {
      const outcome = await probeAfter(
        BOUND,
        async () => prepareProjectManagerLaunch(ENTRY, {}, malformedFs),
        async () => prepareProjectManagerLaunch(
          ENTRY, { ANTHROPIC_API_KEY: "hostile" }, malformedFs,
        ),
      );
      ledger.refused(LAUNCH_BOUNDARY, "AFTER", outcome.effect, launchMismatch);
      ledger.refused(LAUNCH_BOUNDARY, "AFTER", outcome.probe, launchMismatch);
    },
  },
  {
    arm: "RACE", boundary: LAUNCH_BOUNDARY,
    name: "unreadable and mismatched configs remain distinct refusals",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () => prepareProjectManagerLaunch(ENTRY, {}, throwingFs),
        async () => prepareProjectManagerLaunch(ENTRY, {}, malformedFs),
      );
      ledger.refusedSide(LAUNCH_BOUNDARY, outcome.left, launchUnreadable);
      ledger.refusedSide(LAUNCH_BOUNDARY, outcome.right, launchMismatch);
    },
  },
  {
    arm: "BEFORE", boundary: MANAGER_MAIN_BOUNDARY,
    name: "an unsupported host starts no manager authority",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => await managerMainRefusal("linux", {}),
        async () => await managerMainRefusal("darwin", {}),
      );
      ledger.refused(MANAGER_MAIN_BOUNDARY, "BEFORE", outcome.probe, managerUnsupported);
      ledger.refused(MANAGER_MAIN_BOUNDARY, "BEFORE", outcome.effect, managerUnsupported);
    },
  },
  {
    arm: "AFTER", boundary: MANAGER_MAIN_BOUNDARY,
    name: "missing LOCALAPPDATA cannot be replaced with a default directory",
    async run(ledger) {
      const outcome = await probeAfter(
        BOUND,
        async () => await managerMainRefusal("win32", {}),
        async () => await managerMainRefusal("win32", { LOCALAPPDATA: "relative" }),
      );
      ledger.refused(MANAGER_MAIN_BOUNDARY, "AFTER", outcome.effect, managerLocalData);
      ledger.refused(MANAGER_MAIN_BOUNDARY, "AFTER", outcome.probe, managerLocalData);
    },
  },
  {
    arm: "RACE", boundary: MANAGER_MAIN_BOUNDARY,
    name: "host and directory failures contend without opening a listener",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () => await managerMainRefusal("linux", {}),
        async () => await managerMainRefusal("win32", {}),
      );
      ledger.refusedSide(MANAGER_MAIN_BOUNDARY, outcome.left, managerUnsupported);
      ledger.refusedSide(MANAGER_MAIN_BOUNDARY, outcome.right, managerLocalData);
    },
  },
  {
    arm: "BEFORE", boundary: RUNTIME_BOUNDARY,
    name: "pairing cannot be approved before the private channel is ready",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => await prematurePairingApproval("abcd-ef01-2345"),
        async () => await prematurePairingApproval("dcba-10fe-5432"),
      );
      ledger.refused(RUNTIME_BOUNDARY, "BEFORE", outcome.probe, runtimeExpected);
      ledger.refused(RUNTIME_BOUNDARY, "BEFORE", outcome.effect, runtimeExpected);
    },
  },
  {
    arm: "AFTER", boundary: RUNTIME_BOUNDARY,
    name: "replaying a premature approval stays a protocol violation",
    async run(ledger) {
      const outcome = await probeAfter(
        BOUND,
        async () => await prematurePairingApproval("abcd-ef01-2345"),
        async () => await prematurePairingApproval("dcba-10fe-5432"),
      );
      ledger.refused(RUNTIME_BOUNDARY, "AFTER", outcome.effect, runtimeExpected);
      ledger.refused(RUNTIME_BOUNDARY, "AFTER", outcome.probe, runtimeExpected);
    },
  },
  {
    arm: "RACE", boundary: RUNTIME_BOUNDARY,
    name: "two premature approvals contend and neither reaches the stack host",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () => await prematurePairingApproval("abcd-ef01-2345"),
        async () => await prematurePairingApproval("dcba-10fe-5432"),
      );
      ledger.refusedSide(RUNTIME_BOUNDARY, outcome.left, runtimeExpected);
      ledger.refusedSide(RUNTIME_BOUNDARY, outcome.right, runtimeExpected);
    },
  },
  {
    arm: "BEFORE", boundary: SINGLE_MAIN_BOUNDARY,
    name: "an unsupported host starts no compatibility runtime",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => await singleMainRefusal("linux", null),
        async () => await singleMainRefusal("darwin", null),
      );
      ledger.refused(SINGLE_MAIN_BOUNDARY, "BEFORE", outcome.probe, singleUnsupported);
      ledger.refused(SINGLE_MAIN_BOUNDARY, "BEFORE", outcome.effect, singleUnsupported);
    },
  },
  {
    arm: "AFTER", boundary: SINGLE_MAIN_BOUNDARY,
    name: "a missing asset root cannot be recovered from caller environment",
    async run(ledger) {
      const outcome = await probeAfter(
        BOUND,
        async () => await singleMainRefusal("win32", null),
        async () => await singleMainRefusal("win32", null),
      );
      ledger.refused(SINGLE_MAIN_BOUNDARY, "AFTER", outcome.effect, singleAssets);
      ledger.refused(SINGLE_MAIN_BOUNDARY, "AFTER", outcome.probe, singleAssets);
    },
  },
  {
    arm: "RACE", boundary: SINGLE_MAIN_BOUNDARY,
    name: "host and asset failures contend without opening a process boundary",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () => await singleMainRefusal("linux", null),
        async () => await singleMainRefusal("win32", null),
      );
      ledger.refusedSide(SINGLE_MAIN_BOUNDARY, outcome.left, singleUnsupported);
      ledger.refusedSide(SINGLE_MAIN_BOUNDARY, outcome.right, singleAssets);
    },
  },
  {
    arm: "BEFORE", boundary: STACK_HOST_BOUNDARY,
    name: "a throwing daemon launch emits one bounded start refusal",
    async run(ledger) {
      const outcome = await probeBefore(
        BOUND,
        async () => await stackHostRefusal("DAEMON"),
        async () => await stackHostRefusal("DAEMON"),
      );
      ledger.refused(STACK_HOST_BOUNDARY, "BEFORE", outcome.probe, stackDaemon);
      ledger.refused(STACK_HOST_BOUNDARY, "BEFORE", outcome.effect, stackDaemon);
    },
  },
  {
    arm: "AFTER", boundary: STACK_HOST_BOUNDARY,
    name: "a wrapper launch failure tears down the daemon and refuses startup",
    async run(ledger) {
      const outcome = await probeAfter(
        BOUND,
        async () => await stackHostRefusal("WRAPPER"),
        async () => await stackHostRefusal("WRAPPER"),
      );
      ledger.refused(STACK_HOST_BOUNDARY, "AFTER", outcome.effect, stackWrapper);
      ledger.refused(STACK_HOST_BOUNDARY, "AFTER", outcome.probe, stackWrapper);
    },
  },
  {
    arm: "RACE", boundary: STACK_HOST_BOUNDARY,
    name: "daemon and wrapper launch failures keep their own exact codes",
    async run(ledger) {
      const outcome = await probeRacing(
        BOUND,
        async () => await stackHostRefusal("DAEMON"),
        async () => await stackHostRefusal("WRAPPER"),
      );
      ledger.refusedSide(STACK_HOST_BOUNDARY, outcome.left, stackDaemon);
      ledger.refusedSide(STACK_HOST_BOUNDARY, outcome.right, stackWrapper);
    },
  },
]);
