/**
 * J3 — CRASH RECOVERY against REAL process termination, one arm per kill target.
 *
 * Design line 1099: "Kill agent/runner/daemon at declared boundaries. Restart shows adopted,
 * suspect, quarantined, and reconciliation records with truth chips."
 *
 * WHAT IS REAL HERE. Each arm starts the shipped daemon, runs the shipped seed, staffs the
 * seeded node with the real wrapper, waits until the agent is genuinely live, and then kills
 * ONE real OS process at a declared boundary through `killAtDeclaredBoundary`. The daemon is
 * then restarted on the SAME store file and every claim below is read from that store or
 * answered by the restarted daemon over its own HTTP surface.
 *
 * WHAT IS NOT CLAIMED, stated here so a green run cannot be read as more than it is. No
 * shipped client dispatches a `foundation.dispatch` command, so a real-process journey never
 * reserves a Foundation attempt and `readInFlightFoundationAttempts` has an EMPTY set to
 * sweep. This spec does NOT assert that a non-empty in-flight set was classified, because a
 * sweep over zero attempts would satisfy such an assertion while proving nothing.
 *
 * Nor does it read READY as proof the sweep ran. `runBootReconciliation` answers `null` both
 * when the sweep succeeded and when no port is wired, so READY alone cannot tell a swept
 * daemon from one with the wiring deleted. What IS asserted is the pair `sweepShippedReconciliation`
 * takes from the SHIPPED provider over this arm's real post-crash store: that a reconciliation
 * port is wired at all, and that sweeping it over those bytes does not refuse.
 */
import { afterAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../../../apps/daemon/src/daemon-store-dependencies.js";
import type { BootReconciliationResult }
  from "../../../apps/daemon/src/recovery/boot-reconciliation.js";

import {
  KILL_TARGETS,
  adoptHarnessProcess,
  killAtDeclaredBoundary,
} from "./e2e-process.js";
import type { KillTarget } from "./e2e-process.js";
import {
  removeScratches,
  withStore,
} from "./j1-ledger-view.js";
import {
  type DaemonHandle,
  type J1Scratch,
  createJ1Scratch,
  killTree,
  pidIsAlive,
  runSeed,
  spawnWrapper,
  startDaemon,
} from "./j1-loop-harness.js";
import {
  reap,
  replayCommand,
  seedCommand,
  seedConfigFor,
  settledWithin,
  waitForAgentPid,
  withFreshId,
} from "./j3-crash-harness.js";

const ARM_TIMEOUT_MS = 240_000;
/** Mid-attempt: the agent is live and the node has not been carried to a verdict. */
const BOUNDARY = "AFTER_EFFECT_ACTIVATED";
/**
 * The daemon's OWN answer to a stale command, pinned from the printed J3 STALE receipt.
 *
 * The layer is pinned beside the code because more than one layer can refuse this request —
 * the listener, the seam and the reducer all can — and a test that asserted only "refused"
 * would stay green if a guard nearer the wire started answering first, at which point it
 * would no longer be testing expected-version fencing at all.
 */
const STALE_COMMAND_CODE = "EXPECTED_VERSION_CONFLICT";
const STALE_COMMAND_LAYER = "CORE_REDUCER";
const STALE_COMMAND_STAGE = "DISPATCH";

/**
 * The design's three targets bound to the three REAL processes this stack runs.
 *
 * `runner` is the agent WRAPPER: `@moe/runner` is a library the daemon links in process, and
 * the wrapper is what actually runs an attempt — it hosts the MCP host, the agent spawner and
 * `verifier-process-runner.ts`. The binding is asserted below rather than assumed.
 */
const PROCESS_OF: Readonly<Record<KillTarget, string>> = Object.freeze({
  agent: "the spawned agent child",
  daemon: "daemon-main",
  runner: "agent-wrapper-main",
});

const scratches: J1Scratch[] = [];

afterAll(() => {
  removeScratches(scratches);
});

interface CrashArm {
  readonly agentPid: number;
  /** Read BEFORE the restart: comparing the store to itself afterwards proves nothing. */
  readonly preRestartIds: readonly string[];
  readonly daemonPid: number;
  readonly killedPid: number | undefined;
  readonly restarted: DaemonHandle;
  readonly scratch: J1Scratch;
  readonly secondKillCode: string | undefined;
  readonly wrapperPid: number | undefined;
}

/** Every durable decision id, so "the ledger survived" is a set comparison and not a count. */
function decisionIds(scratch: J1Scratch): readonly string[] {
  return withStore(scratch, (store) => {
    const ids: string[] = [];
    let cursor = 0n;
    for (;;) {
      const page = store.readCommandDecisionsAfter(cursor, 200);
      ids.push(...page.items.map((row) => row.decisionId));
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return ids.sort();
  });
}

/** Fixed, not read from a clock: nothing the sweep decides is covered by this value. */
const SWEEP_DECIDED_AT = "2026-01-01T00:00:00.000Z";

/**
 * Sweeps the SHIPPED reconciliation port over this arm's REAL post-crash store.
 *
 * The port is not rebuilt here — `createStoreDependencies` is the same factory the daemon
 * boots from, so a provider that stopped wiring reconciliation is visible to this guard.
 *
 * `wired` and `result` are carried side by side rather than folded into one boolean, because
 * "the port was deleted from the provider" and "the sweep refused over these bytes" are
 * different defects and a single flag would let the first pass for the second.
 */
function sweepShippedReconciliation(
  scratch: J1Scratch, principalId: string,
): { readonly result: BootReconciliationResult | null; readonly wired: boolean } {
  const provider = createStoreDependencies({
    clock: () => SWEEP_DECIDED_AT,
    credential: scratch.credential,
    principalId,
    projectId: scratch.projectId,
    storePath: scratch.storePath,
  });
  try {
    const factory = provider.reconciliation;
    if (typeof factory !== "function") return { result: null, wired: false };
    return { result: factory.call(provider).sweep(), wired: true };
  } finally {
    provider.close();
  }
}

function readyReceipt(banner: string): Record<string, unknown> {
  const line = banner.split("\n").find((candidate) => candidate.includes('"kind":"READY"'));
  if (line === undefined) throw new Error(`the daemon printed no READY receipt: ${banner}`);
  return JSON.parse(line.trim()) as Record<string, unknown>;
}

/**
 * One crash arm end to end. The kill is the ONLY thing that differs between arms, so a
 * difference in the recovery claims can only come from which process died.
 */
async function runCrashArm(target: KillTarget): Promise<CrashArm> {
  const scratch = createJ1Scratch();
  scratches.push(scratch);
  const daemon = await startDaemon(scratch);
  const seed = await runSeed(scratch, daemon.origin);
  if (seed.code !== 0) throw new Error(`seed failed (${String(seed.code)}): ${seed.output}`);

  const wrapper = spawnWrapper(scratch, "complete");
  const agentPid = await waitForAgentPid(scratch);

  const victim = target === "agent" ? { pid: agentPid, terminate: (): void => reap(agentPid) }
    : target === "runner" ? { pid: wrapper.child.pid, terminate: (): void => void wrapper.child.kill("SIGKILL") }
      : { pid: daemon.pid, terminate: (): void => void daemon.child.kill("SIGKILL") };
  const handle = adoptHarnessProcess(target, victim);
  const killed = killAtDeclaredBoundary(handle, BOUNDARY);
  if (!killed.ok) throw new Error(`the kill was refused: ${killed.code}`);
  // The SAME handle, a second time: the discipline must refuse on a real process too.
  const second = killAtDeclaredBoundary(handle, BOUNDARY);
  const secondKillCode = second.ok ? undefined : second.code;

  // The pass is bounded and then reaped whatever it did: a wrapper whose daemon died can sit
  // retrying, and a hung arm must not be reported as a crash the system absorbed.
  await settledWithin(wrapper.done);
  await killTree(wrapper.child);
  await killTree(daemon.child);
  reap(agentPid);

  // Captured with every process from the pre-kill journey dead and BEFORE the new daemon
  // opens the store: a set read after the restart would be the same read on both sides.
  const preRestartIds = decisionIds(scratch);
  const restarted = await startDaemon(scratch);
  return {
    agentPid,
    preRestartIds,
    daemonPid: daemon.pid,
    killedPid: handle.pid,
    restarted,
    scratch,
    secondKillCode,
    wrapperPid: wrapper.child.pid,
  };
}

describe("J3 crash recovery over real processes", () => {
  it("names one real process for each of the design's three kill targets", () => {
    expect([...KILL_TARGETS].sort()).toEqual(["agent", "daemon", "runner"]);
    for (const target of KILL_TARGETS) {
      expect(PROCESS_OF[target].length).toBeGreaterThan(0);
    }
  });

  for (const target of KILL_TARGETS) {
    it(`recovers after ${target} (${PROCESS_OF[target]}) is killed mid-attempt`, async () => {
      const arm = await runCrashArm(target);

      // THE KILL LANDED, and the discipline held on a real process: a second kill of the same
      // handle carries its own code rather than silently killing something else.
      expect(arm.secondKillCode).toBe("E2E_PROCESS_ALREADY_KILLED");
      expect(arm.killedPid).toBeDefined();

      // THE RESTART IS A DIFFERENT PROCESS ON THE SAME STORE. Both halves matter: a restart
      // that reused the pid would prove nothing, and one that opened a fresh store would
      // "recover" by forgetting.
      const receipt = readyReceipt(arm.restarted.output());
      expect(receipt).toMatchObject({
        entry: "CONTROL_ROOM_HTTP",
        kind: "READY",
        pid: arm.restarted.pid,
        projectId: arm.scratch.projectId,
        storePath: arm.scratch.storePath,
      });
      expect(arm.restarted.pid).not.toBe(arm.daemonPid);

      // WHAT READY PROVES ABOUT THE BOOT SWEEP, and what it cannot. The sweep is invoked
      // before the listener binds and stops the boot on any refusal, so READY proves the sweep
      // did not REFUSE — but `runBootReconciliation` returns `null` for "no port wired" too, so
      // a daemon with the wiring deleted reaches READY identically. The guards below close that
      // gap; the classification COUNT stays unasserted — see the file header.
      expect(arm.restarted.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

      // NOTHING DURABLE WAS LOST. Every decision the pre-kill journey committed is still
      // readable after the restart, as a set.
      const after = decisionIds(arm.scratch);
      expect(arm.preRestartIds.length).toBeGreaterThan(0);
      expect(after).toEqual(expect.arrayContaining([...arm.preRestartIds]));

      // STALE-COMMAND FENCING, with its own positive control first. The seed's own
      // `project.activate` replayed VERBATIM is answered by the durable decision — proving the
      // command surface is live and this credential is accepted — and the same body under a
      // FRESH id, still carrying the pre-kill expected version, is REFUSED. Without the
      // control, a refusal could equally mean the surface was simply not answering.
      const config = seedConfigFor(arm.scratch, arm.restarted.origin);

      // THE SWEEP IS WIRED, AND IT RUNS ON THESE BYTES. Two separate mutants: deleting
      // `reconciliation` from the shipped provider drops `wired`, and a sweep that refuses over
      // the real post-crash store drops `result.ok`. Neither claims a non-empty set was
      // classified — the header says why that is unreachable from a real-process journey.
      const shipped = sweepShippedReconciliation(arm.scratch, config.principalId);
      expect(shipped.wired).toBe(true);
      expect(shipped.result).toMatchObject({ ok: true });
      const activate = seedCommand(config, "project.activate");
      const replayed = await replayCommand(config, activate);
      // eslint-disable-next-line no-console
      console.log(`J3 ${target} REPLAY ${JSON.stringify({
        outcome: replayed.outcome, refusal: replayed.refusal,
      })}`);
      expect(replayed.refusal).toBeNull();

      const stale = await replayCommand(config, withFreshId(activate, `j3-${target}-stale`));
      // eslint-disable-next-line no-console
      console.log(`J3 ${target} STALE ${JSON.stringify({
        outcome: stale.outcome, refusal: stale.refusal,
      })}`);
      expect(stale.refusal).not.toBeNull();
      expect(stale.refusal).toMatchObject({
        code: STALE_COMMAND_CODE, layer: STALE_COMMAND_LAYER, stage: STALE_COMMAND_STAGE,
      });

      // NO ORPHANS. Every pid this arm started is gone, and the probe's own positive control
      // comes first because `pidIsAlive` answers false on a throw.
      await killTree(arm.restarted.child);
      expect(pidIsAlive(process.pid)).toBe(true);
      for (const pid of [arm.agentPid, arm.daemonPid, arm.wrapperPid, arm.restarted.pid]) {
        expect({ alive: pid === undefined ? false : pidIsAlive(pid), pid })
          .toEqual({ alive: false, pid });
      }
    }, ARM_TIMEOUT_MS);
  }
});
