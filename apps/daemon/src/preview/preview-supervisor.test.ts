/**
 * NO LEAKED PROCESS — the subject of this row, asserted BY PID and never by a flag.
 *
 * A flag proves the code BELIEVED it killed something. These arms ask the operating system.
 * Every arm checks TWO independent things, because on Windows they can disagree and the
 * disagreement is exactly the bug:
 *
 *   1. THE PID IS GONE. `probeProcessAlive` is the daemon's own liveness seam
 *      (orchestrator/process-runner-lifecycle.ts:47) — production code, not a helper written
 *      here — polled to a budget rather than sampled once, because `taskkill /T /F` returns when
 *      the kill is REQUESTED, not when the OS has reaped
 *      (tests/e2e/foundation/orphan-reap.ts:1-17 measures 68-100ms idle, longer under load).
 *      Sampling immediately grades the sampling instant, not the containment claim.
 *
 *   2. THE PORT IS FREE. This is the assertion that actually matters. The runner spawns with
 *      `shell: true`, so on Windows the direct child is `cmd.exe` and the SERVER is a
 *      GRANDCHILD — a bare `child.kill()` reaps the shell and leaves node holding the port. The
 *      pid check would pass; the next preview would still fail to bind. Only the port check
 *      sees it.
 *
 * The `tests/e2e/foundation` `pidReaped` helper the plan names cannot be imported here:
 * `apps/daemon/tsconfig.json` sets `"rootDir": "src"` and `"include": ["src/**\/*.ts"]`, so a
 * `tests/e2e/**` import is TS6059. `awaitPidGone` keeps its exact semantics (200 polls x 50ms,
 * answer false rather than throw) over the PRODUCTION probe instead.
 */
import { spawn as realSpawn } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { probeProcessAlive } from "../orchestrator/process-runner-lifecycle.js";
import {
  GOAL_ID, PROJECT_ID, driveThrough, openStore,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { seedLandingReceipt, seedReviewAcceptance } from "../goals/goal-closure-test-fixtures.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { startPreviewProcess } from "./preview-process.js";
import type { PreviewCapturePort, PreviewRunnerConfig } from "./preview-runner.js";
import { createPreviewSupervisor } from "./preview-supervisor.js";
import {
  LISTENING_SERVER, SILENT_BOUND_SERVER, awaitFixturePort, awaitPidGone, cleanupFixtureWorkspaces,
  fixtureWorkspace,
} from "./preview-test-fixtures.js";

type Store = ReturnType<typeof openStore>;

const SHA = "0123456789abcdef0123456789abcdef01234567";

afterEach(cleanupFixtureWorkspaces);

/** The daemon's own probe, wrapped so an unknown failure counts as ALIVE, never as gone. */
function alive(pid: number): boolean {
  try {
    return probeProcessAlive(pid);
  } catch {
    return true;
  }
}

/** Is anything still accepting on this port? The grandchild question, asked of the OS. */
function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (answer: boolean): void => { socket.destroy(); resolve(answer); };
    socket.setTimeout(1_000);
    socket.once("connect", () => { settle(true); });
    socket.once("timeout", () => { settle(false); });
    socket.once("error", () => { settle(false); });
  });
}

/** Polls the port free to the same budget the pid gets, for the same reap-latency reason. */
async function awaitPortFree(port: number, polls = 200): Promise<boolean> {
  for (let remaining = polls; remaining > 0; remaining -= 1) {
    if (!(await portAccepts(port))) return true;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return !(await portAccepts(port));
}

function landedWorld(): Store {
  const store = openStore();
  driveThrough(store, "goal.close");
  const graph = activeCompiledGraphs(store, PROJECT_ID).find((plan) => plan.goalRef === GOAL_ID);
  const ref = graph === undefined ? "node-a" : compiledExecutionRef(PROJECT_ID, graph, "node-a");
  seedReviewAcceptance(store, ref);
  seedLandingReceipt(store, ref, "COMMITTED");
  return store;
}

const noCapture: PreviewCapturePort = async () => [];

function serverWorkspace(): string {
  return fixtureWorkspace({
    files: { "server.mjs": LISTENING_SERVER },
    scripts: { preview: "node server.mjs" },
  });
}

function supervisorFor(store: Store, overrides: Partial<PreviewRunnerConfig> = {}) {
  return createPreviewSupervisor({
    capture: noCapture,
    clock: () => "2026-09-05T12:00:00.000Z",
    contractFacts: () => ({
      deploymentStatements: ["preview command: node server.mjs"], journeys: [],
    }),
    process: { startTimeoutMs: 30_000 },
    projectId: PROJECT_ID,
    store,
    ...overrides,
  });
}

/** Starts a real preview and returns what the arms need to interrogate the OS afterwards. */
async function startLive(supervisor: ReturnType<typeof supervisorFor>, workspace: string): Promise<{
  pid: number; port: number; receiptId: string;
}> {
  const result = await supervisor.start({ goalId: GOAL_ID, sha: SHA, workspace });
  if (!result.ok) throw new Error(`expected a start, got ${result.refusal.code}`);
  const { handle, receipt } = result.started;
  // The preconditions the arms below are only meaningful against: it really is up.
  expect(alive(handle.pid)).toBe(true);
  expect(await portAccepts(handle.port)).toBe(true);
  return { pid: handle.pid, port: handle.port, receiptId: receipt.receiptId };
}

describe("the preview process is gone afterwards", () => {
  it("ARM 1 — after APPROVE: the pid is gone AND the port is free", async () => {
    const supervisor = supervisorFor(landedWorld());
    const workspace = serverWorkspace();
    const live = await startLive(supervisor, workspace);

    expect(await supervisor.decide(live.receiptId, "APPROVE")).toBe(true);

    expect(await awaitPidGone(live.pid, alive)).toBe(true);
    // The one that catches a surviving grandchild: `shell: true` makes the direct child cmd.exe
    // on Windows, and the SERVER is one level below it.
    expect(await awaitPortFree(live.port)).toBe(true);
    expect(supervisor.active()).toStrictEqual([]);
  }, 120_000);

  it("ARM 2 — after REJECT: the pid is gone AND the port is free", async () => {
    // A rejection must stop the process exactly as an approval does. A runner that only cleaned
    // up on the happy path would leak on every rejected preview — the common case.
    const supervisor = supervisorFor(landedWorld());
    const workspace = serverWorkspace();
    const live = await startLive(supervisor, workspace);

    expect(await supervisor.decide(live.receiptId, "REJECT")).toBe(true);

    expect(await awaitPidGone(live.pid, alive)).toBe(true);
    expect(await awaitPortFree(live.port)).toBe(true);
    expect(supervisor.active()).toStrictEqual([]);
  }, 120_000);

  it("ARM 3 — after a forced START TIMEOUT: the pid is gone AND the port it bound is free", async () => {
    // The refusal path is the likeliest to leak, because nothing downstream holds a handle to
    // stop. `startPreviewProcess` is driven directly so the pid is observable: the runner
    // deliberately hands back no handle for a refusal.
    //
    // THE FIXTURE BINDS. `SILENT_SERVER` (no port, writes to stdout on a timer) is NOT a
    // discriminator here — measured in the step-8 drill, that arm stayed GREEN with the whole
    // cleanup path stubbed to a no-op, because destroying the parent's pipe ends gives it EPIPE
    // and it dies on its own. `SILENT_BOUND_SERVER` holds a real listening socket and never
    // writes after startup, so the port is only free if something actually killed it.
    const workspace = fixtureWorkspace({
      files: { "silent.mjs": SILENT_BOUND_SERVER }, scripts: { preview: "node silent.mjs" },
    });
    const pids: number[] = [];

    const result = await startPreviewProcess(
      { command: "node silent.mjs", port: null, workspace },
      {
        // The REAL spawn, wrapped only to observe the pid — the child is genuinely started, so
        // "it is gone afterwards" is a claim about a process that really existed.
        spawn: (file, args, options) => {
          const child = realSpawn(file, [...args], options);
          if (child.pid !== undefined && pids.length === 0) pids.push(child.pid);
          return child;
        },
        startTimeoutMs: 4_000,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a timeout refusal");
    expect(result.code).toBe("PREVIEW_START_TIMEOUT");
    expect(result.layer).toBe("RUNNER");
    const pid = pids[0];
    if (pid === undefined) throw new Error("the spawn was never observed");
    // The fixture really bound a port before the timeout fired; without this the port assertion
    // below would pass against a server that never listened.
    const bound = await awaitFixturePort(join(workspace, "port.txt"), 40);
    if (bound === null) throw new Error("the fixture never bound a port");

    expect(await awaitPidGone(pid, alive)).toBe(true);
    expect(await awaitPortFree(bound)).toBe(true);
  }, 120_000);

  it("ARM 4 — after DAEMON SHUTDOWN: every live preview is gone", async () => {
    // The composition DOES allow this arm: `createPreviewSupervisor` owns the live roster, so
    // the daemon has one thing to close. Two previews are open at once so the arm proves the
    // sweep, not a single lucky stop.
    const supervisor = supervisorFor(landedWorld());
    const first = await startLive(supervisor, serverWorkspace());
    const secondStore = landedWorld();
    const secondSupervisor = supervisorFor(secondStore);
    const second = await startLive(secondSupervisor, serverWorkspace());
    expect(supervisor.active()).toHaveLength(1);

    await supervisor.close();
    await secondSupervisor.close();

    for (const live of [first, second]) {
      expect(await awaitPidGone(live.pid, alive)).toBe(true);
      expect(await awaitPortFree(live.port)).toBe(true);
    }
    expect(supervisor.active()).toStrictEqual([]);
  }, 180_000);

  it("refuses to leave a preview running that started after shutdown began", async () => {
    // The race a roster-based sweep would otherwise miss: `close()` has already swept, and a
    // start that was in flight would join an empty roster nobody will sweep again.
    const supervisor = supervisorFor(landedWorld());
    await supervisor.close();

    const result = await supervisor.start({
      goalId: GOAL_ID, sha: SHA, workspace: serverWorkspace(),
    });

    if (!result.ok) throw new Error(`expected a start, got ${result.refusal.code}`);
    expect(supervisor.active()).toStrictEqual([]);
    expect(await awaitPidGone(result.started.handle.pid, alive)).toBe(true);
    expect(await awaitPortFree(result.started.handle.port)).toBe(true);
  }, 120_000);

  it("a decision naming no live preview reports so rather than pretending it stopped one", async () => {
    const supervisor = supervisorFor(landedWorld());
    expect(await supervisor.decide("not-a-receipt", "APPROVE")).toBe(false);
  });

  it("two CONCURRENT starts of the same revision spawn ONE server, not two", async () => {
    // Without the in-flight guard both calls pass the landed gate and both spawn; the second
    // cannot bind the port the first took and refuses PREVIEW_START_TIMEOUT — a preview that
    // failed for no reason the operator could act on. The receipt's idempotence does not prevent
    // it: that dedupes the RECORD, by which time two processes are already running.
    const supervisor = supervisorFor(landedWorld());
    const workspace = serverWorkspace();
    const [first, second] = await Promise.all([
      supervisor.start({ goalId: GOAL_ID, sha: SHA, workspace }),
      supervisor.start({ goalId: GOAL_ID, sha: SHA, workspace }),
    ]);

    if (!first.ok) throw new Error(`first refused ${first.refusal.code}`);
    if (!second.ok) throw new Error(`second refused ${second.refusal.code}`);
    // ONE preview, one pid, one port — the second call joined the first rather than racing it.
    expect(second.started.handle.pid).toBe(first.started.handle.pid);
    expect(second.started.handle.port).toBe(first.started.handle.port);
    expect(supervisor.active()).toHaveLength(1);

    await supervisor.close();
    expect(await awaitPidGone(first.started.handle.pid, alive)).toBe(true);
    expect(await awaitPortFree(first.started.handle.port)).toBe(true);
  }, 120_000);
});
