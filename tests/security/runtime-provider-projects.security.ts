/** Hostile coverage for project filesystem, launch and process-lifecycle boundaries. */

import { Readable, Writable } from "node:stream";

import { describe, it } from "vitest";

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
import {
  RUNTIME_BOUND as BOUND,
  RUNTIME_PROVIDER_PARTITION,
  createLedger,
  describeSliceInvariants,
} from "./runtime-provider-ledger.js";

const OWNED = RUNTIME_PROVIDER_PARTITION.PROJECTS;
const ledger = createLedger();

const ENTRY = Object.freeze({
  configPath: "C:\\work\\alpha\\moe.config.json",
  instanceId: "11111111-1111-4111-8111-111111111111",
  projectId: "alpha",
  root: "C:\\work\\alpha",
  storePath: "C:\\work\\alpha\\store.sqlite",
  title: "Alpha",
});

function refusalFromLog(lines: readonly string[], exitCode: number): unknown {
  if (exitCode !== 1 || lines.length !== 1) return Object.freeze({ admitted: true });
  const [code, layer, extra] = (lines[0] ?? "").split(" ");
  return code !== undefined && layer !== undefined && extra === undefined
    ? Object.freeze({ code, layer, ok: false as const })
    : Object.freeze({ admitted: true });
}

async function managerMainRefusal(platform: string, env: Readonly<Record<string, string | undefined>>) {
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

async function singleMainRefusal(platform: string, assetRoot: string | null) {
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

async function unreadyApprovalRefusal(confirmationLabel: string): Promise<unknown> {
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

describe("PROJECT_MANAGER_FILES_LAYER", () => {
  const boundary = "PROJECT_MANAGER_FILES_LAYER";
  const expected = { code: PROJECT_MANAGER_ROOT_INVALID, layer: PROJECT_MANAGER_FILES_LAYER };
  const files = createNodeProjectManagerFiles();

  it("BEFORE - a relative root cannot reach project filesystem authority", async () => {
    const outcome = await probeBefore(BOUND, async () => await files.register("relative"), async () => await files.create(""));
    ledger.refused(boundary, "BEFORE", outcome.probe, expected);
    ledger.refused(boundary, "BEFORE", outcome.effect, expected);
  });

  it("AFTER - a UNC or NUL root replay remains outside the local project boundary", async () => {
    const outcome = await probeAfter(BOUND, async () => await files.register("\\\\server\\share"), async () => await files.create("C:\\work\0escape"));
    ledger.refused(boundary, "AFTER", outcome.effect, expected);
    ledger.refused(boundary, "AFTER", outcome.probe, expected);
  });

  it("RACE - two invalid roots contend and neither creates configuration", async () => {
    const outcome = await probeRacing(BOUND, async () => await files.create("."), async () => await files.register("\\\\server\\share"));
    ledger.refusedSide(boundary, outcome.left, expected);
    ledger.refusedSide(boundary, outcome.right, expected);
  });
});

describe("PROJECT_MANAGER_LAUNCH_LAYER", () => {
  const boundary = "PROJECT_MANAGER_LAUNCH_LAYER";
  const unreadable = { code: PROJECT_MANAGER_LAUNCH_CONFIG_UNREADABLE, layer: PROJECT_MANAGER_LAUNCH_LAYER };
  const mismatch = { code: PROJECT_MANAGER_LAUNCH_CONFIG_MISMATCH, layer: PROJECT_MANAGER_LAUNCH_LAYER };
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

  it("BEFORE - an unreadable private config cannot produce a launch environment", async () => {
    const outcome = await probeBefore(BOUND, async () => prepareProjectManagerLaunch(ENTRY, {}, throwingFs), async () => prepareProjectManagerLaunch(ENTRY, { NODE_OPTIONS: "--require=attacker" }, throwingFs));
    ledger.refused(boundary, "BEFORE", outcome.probe, unreadable);
    ledger.refused(boundary, "BEFORE", outcome.effect, unreadable);
  });

  it("AFTER - malformed config bytes cannot reuse catalog identity", async () => {
    const outcome = await probeAfter(BOUND, async () => prepareProjectManagerLaunch(ENTRY, {}, malformedFs), async () => prepareProjectManagerLaunch(ENTRY, { ANTHROPIC_API_KEY: "hostile" }, malformedFs));
    ledger.refused(boundary, "AFTER", outcome.effect, mismatch);
    ledger.refused(boundary, "AFTER", outcome.probe, mismatch);
  });

  it("RACE - unreadable and mismatched configs remain distinct refusals", async () => {
    const outcome = await probeRacing(BOUND, async () => prepareProjectManagerLaunch(ENTRY, {}, throwingFs), async () => prepareProjectManagerLaunch(ENTRY, {}, malformedFs));
    ledger.refusedSide(boundary, outcome.left, unreadable);
    ledger.refusedSide(boundary, outcome.right, mismatch);
  });
});

describe("PROJECT_MANAGER_MAIN_LAYER", () => {
  const boundary = "PROJECT_MANAGER_MAIN_LAYER";
  const unsupported = { code: PROJECT_MANAGER_PLATFORM_UNSUPPORTED, layer: PROJECT_MANAGER_MAIN_LAYER };
  const localData = { code: PROJECT_MANAGER_LOCAL_APP_DATA_INVALID, layer: PROJECT_MANAGER_MAIN_LAYER };

  it("BEFORE - an unsupported host starts no manager authority", async () => {
    const outcome = await probeBefore(BOUND, async () => await managerMainRefusal("linux", {}), async () => await managerMainRefusal("darwin", {}));
    ledger.refused(boundary, "BEFORE", outcome.probe, unsupported);
    ledger.refused(boundary, "BEFORE", outcome.effect, unsupported);
  });

  it("AFTER - missing LOCALAPPDATA cannot be replaced with a default directory", async () => {
    const outcome = await probeAfter(BOUND, async () => await managerMainRefusal("win32", {}), async () => await managerMainRefusal("win32", { LOCALAPPDATA: "relative" }));
    ledger.refused(boundary, "AFTER", outcome.effect, localData);
    ledger.refused(boundary, "AFTER", outcome.probe, localData);
  });

  it("RACE - host and directory failures contend without opening a listener", async () => {
    const outcome = await probeRacing(BOUND, async () => await managerMainRefusal("linux", {}), async () => await managerMainRefusal("win32", {}));
    ledger.refusedSide(boundary, outcome.left, unsupported);
    ledger.refusedSide(boundary, outcome.right, localData);
  });
});

describe("PROJECT_RUNTIME_SUPERVISOR_LAYER", () => {
  const boundary = "PROJECT_RUNTIME_SUPERVISOR_LAYER";
  const expected = { code: PROJECT_RUNTIME_PROTOCOL_VIOLATION, layer: PROJECT_RUNTIME_SUPERVISOR_LAYER };

  it("BEFORE - pairing cannot be approved before the private channel is ready", async () => {
    const outcome = await probeBefore(BOUND, async () => await unreadyApprovalRefusal("0000-0000-0001"), async () => await unreadyApprovalRefusal("0000-0000-0002"));
    ledger.refused(boundary, "BEFORE", outcome.probe, expected);
    ledger.refused(boundary, "BEFORE", outcome.effect, expected);
  });

  it("AFTER - replaying an unready approval stays a protocol violation", async () => {
    const outcome = await probeAfter(BOUND, async () => await unreadyApprovalRefusal("0000-0000-0003"), async () => await unreadyApprovalRefusal("0000-0000-0004"));
    ledger.refused(boundary, "AFTER", outcome.effect, expected);
    ledger.refused(boundary, "AFTER", outcome.probe, expected);
  });

  it("RACE - two premature approvals contend and neither reaches the stack host", async () => {
    const outcome = await probeRacing(BOUND, async () => await unreadyApprovalRefusal("0000-0000-0005"), async () => await unreadyApprovalRefusal("0000-0000-0006"));
    ledger.refusedSide(boundary, outcome.left, expected);
    ledger.refusedSide(boundary, outcome.right, expected);
  });
});

describe("PROJECT_SINGLE_MAIN_LAYER", () => {
  const boundary = "PROJECT_SINGLE_MAIN_LAYER";
  const unsupported = { code: PROJECT_SINGLE_PLATFORM_UNSUPPORTED, layer: PROJECT_SINGLE_MAIN_LAYER };
  const assets = { code: PROJECT_SINGLE_ASSET_ROOT_MISSING, layer: PROJECT_SINGLE_MAIN_LAYER };

  it("BEFORE - an unsupported host starts no compatibility runtime", async () => {
    const outcome = await probeBefore(BOUND, async () => await singleMainRefusal("linux", null), async () => await singleMainRefusal("darwin", null));
    ledger.refused(boundary, "BEFORE", outcome.probe, unsupported);
    ledger.refused(boundary, "BEFORE", outcome.effect, unsupported);
  });

  it("AFTER - a missing asset root cannot be recovered from caller environment", async () => {
    const outcome = await probeAfter(BOUND, async () => await singleMainRefusal("win32", null), async () => await singleMainRefusal("win32", null));
    ledger.refused(boundary, "AFTER", outcome.effect, assets);
    ledger.refused(boundary, "AFTER", outcome.probe, assets);
  });

  it("RACE - host and asset failures contend without opening a process boundary", async () => {
    const outcome = await probeRacing(BOUND, async () => await singleMainRefusal("linux", null), async () => await singleMainRefusal("win32", null));
    ledger.refusedSide(boundary, outcome.left, unsupported);
    ledger.refusedSide(boundary, outcome.right, assets);
  });
});

describe("PROJECT_STACK_HOST_LAYER", () => {
  const boundary = "PROJECT_STACK_HOST_LAYER";
  const daemon = { code: PROJECT_STACK_DAEMON_START_FAILED, layer: PROJECT_STACK_HOST_LAYER };
  const wrapper = { code: PROJECT_STACK_WRAPPER_START_FAILED, layer: PROJECT_STACK_HOST_LAYER };

  it("BEFORE - a throwing daemon launch emits one bounded start refusal", async () => {
    const outcome = await probeBefore(BOUND, async () => await stackHostRefusal("DAEMON"), async () => await stackHostRefusal("DAEMON"));
    ledger.refused(boundary, "BEFORE", outcome.probe, daemon);
    ledger.refused(boundary, "BEFORE", outcome.effect, daemon);
  });

  it("AFTER - a wrapper launch failure tears down the daemon and refuses startup", async () => {
    const outcome = await probeAfter(BOUND, async () => await stackHostRefusal("WRAPPER"), async () => await stackHostRefusal("WRAPPER"));
    ledger.refused(boundary, "AFTER", outcome.effect, wrapper);
    ledger.refused(boundary, "AFTER", outcome.probe, wrapper);
  });

  it("RACE - daemon and wrapper launch failures keep their own exact codes", async () => {
    const outcome = await probeRacing(BOUND, async () => await stackHostRefusal("DAEMON"), async () => await stackHostRefusal("WRAPPER"));
    ledger.refusedSide(boundary, outcome.left, daemon);
    ledger.refusedSide(boundary, outcome.right, wrapper);
  });
});

describeSliceInvariants("project runtime", ledger, OWNED, [], 0);
