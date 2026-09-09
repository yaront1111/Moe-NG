/**
 * J5: THE OPERATOR REJECTS A PLAN, AND THE RE-STAFFED SEAT READS WHY - over REAL PROCESSES.
 *
 * `daemon-main.ts` runs as its own OS process on an ephemeral port. `agent-wrapper-main.ts` runs
 * as its own process, TWICE, and hosts the REAL MCP server. Every command travels the shipped
 * HTTP or MCP wire. The only double is the SEAT, and it goes through the same scoped bearer the
 * wrapper mints for a real `claude` and never touches the store.
 *
 * WHAT THIS TURNS INTO EVIDENCE, in the order the assertions read:
 *   1. A staffed compiler seat submits a decomposition it planned itself.
 *   2. The operator REJECTs it with a REASON over `approval.decide_intent`.
 *   3. The wrapper re-staffs the compiler step, and THE MISSION THAT SEAT ACTUALLY RECEIVED
 *      carries `PLAN REJECTED by the operator: <reason>` - read from the file the seat echoed,
 *      because what the daemon composed and what the seat received are different claims.
 *   4. The re-staffed seat plans a DIFFERENT decomposition, proved by the node keys the SEALED
 *      graph body carries on the successor run, not by the wrapper's stdout.
 *   5. The successor is offered for approval, the operator APPROVEs, and the activation event
 *      is read back off the goal's own event stream.
 *   6. Nothing survives: both daemons and both wrapper passes are gone.
 *
 * THE FIRST MISSION IS THE CONTROL. It is asserted to carry NO rejection sentence at all, so
 * arm 3 is a difference between two real missions rather than a substring that might have been
 * there all along.
 *
 * The wall-clock readings live HERE, in a `.test.ts` the harness determinism scan excludes, and
 * travel into the harness as parameters - the discipline the shipped seed's `clock` states.
 */
import { afterAll, describe, expect, it } from "vitest";

import { type DaemonHandle, killTree, pidIsAlive, startDaemon } from "./j1-loop-harness.js";
import { GOAL_ID } from "./multi-node-graph-harness.js";
import { removeMultiNodeScratches } from "./multi-node-reads.js";
import { daemonWire, readSurface } from "./multi-node-wire.js";
import {
  ACTIVATION_EVENT_TYPE,
  FIRST_NODE_KEY,
  GOAL_BRIEF,
  type J5Scratch,
  SECOND_NODE_KEY,
  activationEvents,
  createJ5Scratch,
  decidePlan,
  compilerMissions,
  preludeThroughGate1,
  runCompilerWrapper,
  sealedNodeKeysOf,
  writeCompilerShim,
} from "./j5-plan-reject-harness.js";
import { pidReaped } from "./orphan-reap.js";

/** Two real wrapper passes over real child processes: a tight timeout is a flake, not a signal. */
const JOURNEY_TIMEOUT_MS = 420_000;

/** The operator's own words. Spelled ONCE so the assertion cannot drift from what was sent. */
const REJECTION_REASON = "one node is not a decomposition; split the read from the page";
const OPERATOR_MARKER = "<<<OPERATOR INSTRUCTIONS";

const scratches: J5Scratch[] = [];
/**
 * Every daemon this file starts, reaped in teardown as well as in the body.
 *
 * The body's kill is what the orphan assertions need; this list is what a FAILING run needs. An
 * assertion that throws mid-arm skips the in-body kill, and on Windows a surviving daemon holds
 * its store file open, so the scratch removal that follows fails with EBUSY and leaves both a
 * live process and a temp tree behind. `killTree` is idempotent, so reaping twice costs nothing.
 */
const daemons: DaemonHandle[] = [];

afterAll(async () => {
  for (const daemon of daemons) await killTree(daemon.child);
  removeMultiNodeScratches(scratches);
});

/** The wrapper's own output is the only place a spawn refusal is stated. */
function wrapperMustSucceed(label: string, run: { code: number | null; output: string }): void {
  if (run.code !== 0) throw new Error(`${label} exited ${String(run.code)}: ${run.output}`);
}

describe("J5 plan rejection and re-plan over real processes", () => {
  it(
    "puts the operator's rejection reason in the re-staffed compiler seat's mission",
    async () => {
      const scratch = createJ5Scratch();
      scratches.push(scratch);
      const daemon = await startDaemon(scratch);
      daemons.push(daemon);
      const wire = daemonWire(daemon.origin, scratch.credential);
      const clock = { nowIso: new Date().toISOString(), nowMs: Date.now() };

      await preludeThroughGate1(scratch, wire, clock);
      const shim = writeCompilerShim(scratch);

      // ---- PASS 1: the wrapper staffs a compiler seat, which plans the first decomposition.
      const firstPass = await runCompilerWrapper(scratch, shim);
      wrapperMustSucceed("wrapper pass 1", firstPass);
      const afterFirst = compilerMissions(scratch);
      expect(afterFirst).toHaveLength(1);
      const firstMission = afterFirst[0] as string;
      // THE CONTROL, and it has to run before the rejection exists. A first mission that already
      // carried the sentence would make arm 3 vacuous; asserting it AFTER the reject could not
      // tell "the sentence arrived" from "the sentence was always there".
      expect(firstMission).not.toContain("PLAN REJECTED by the operator:");
      expect(firstMission).toContain(`goal "${GOAL_ID}"`);

      // ---- THE OPERATOR REJECTS, over the real HTTP wire under the durable HUMAN principal.
      const rejected = await decidePlan(
        wire, await readSurface(wire, scratch.projectId), "REJECT", REJECTION_REASON,
      );
      // The FIRST plan really was sealed on the run the operator rejected, so the rejection has
      // a decomposition to be about rather than being a decision over an empty run.
      expect(sealedNodeKeysOf(scratch, rejected.runId)).toContain(FIRST_NODE_KEY);
      expect(activationEvents(scratch)).toEqual([]);

      // ---- PASS 2: the wrapper RE-STAFFS the compiler step on the successor run.
      const secondPass = await runCompilerWrapper(scratch, shim);
      wrapperMustSucceed("wrapper pass 2", secondPass);
      const missions = compilerMissions(scratch);
      expect(missions).toHaveLength(2);
      const restaffed = missions[1] as string;

      // ---- ARM 3, the subject of this whole row: what the SEAT received, not what the daemon
      // composed. The sentence must sit INSIDE the fenced operator block, because outside it the
      // seat reads it as daemon-authored instruction rather than as the operator's own words.
      expect(restaffed).toContain(`PLAN REJECTED by the operator: ${REJECTION_REASON}.`);
      expect(restaffed).toContain("Submit a DIFFERENT decomposition that addresses it.");
      const open = restaffed.indexOf(OPERATOR_MARKER);
      const close = restaffed.indexOf("OPERATOR INSTRUCTIONS>>>");
      expect(open).toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(open);
      expect(restaffed.slice(open, close))
        .toContain(`PLAN REJECTED by the operator: ${REJECTION_REASON}.`);
      // THE GOAL'S OWN BRIEF SURVIVES BESIDE THE SENTENCE. The composer APPENDS; a composer that
      // replaced the brief would satisfy every assertion above while silently dropping the
      // operator's original instructions from the re-staffed seat's mission.
      const firstOpen = firstMission.indexOf(OPERATOR_MARKER);
      const firstBlock = firstMission
        .slice(firstOpen, firstMission.indexOf("OPERATOR INSTRUCTIONS>>>"));
      expect(firstBlock).toContain(GOAL_BRIEF);
      expect(restaffed.slice(open, close)).toContain(GOAL_BRIEF);

      // ---- ARM 4: a DIFFERENT decomposition, proved from the SEALED graph body.
      const successorSurface = await readSurface(wire, scratch.projectId);
      const approved = await decidePlan(wire, successorSurface, "APPROVE", null);
      expect(approved.runId).not.toBe(rejected.runId);
      const successorKeys = sealedNodeKeysOf(scratch, approved.runId);
      expect(successorKeys).toContain(SECOND_NODE_KEY);
      expect(successorKeys).not.toContain(FIRST_NODE_KEY);

      // ---- ARM 5: the APPROVE activated the goal, read off its own durable event stream.
      expect(activationEvents(scratch)).toEqual([ACTIVATION_EVENT_TYPE]);

      // ---- ARM 6: nothing survives. A leaked daemon holds its port and reds the NEXT e2e run,
      // where it reads as an unrelated flake.
      await killTree(daemon.child);
      expect(pidIsAlive(process.pid)).toBe(true);
      for (const pid of [daemon.pid, firstPass.pid, secondPass.pid]) {
        const alive = pid === undefined ? false : !(await pidReaped(pid));
        expect({ alive, pid }).toEqual({ alive: false, pid });
      }
    },
    JOURNEY_TIMEOUT_MS,
  );
});
