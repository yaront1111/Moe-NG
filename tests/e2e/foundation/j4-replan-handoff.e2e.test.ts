/**
 * J4 over REAL PROCESSES: rejection, re-plan and safe handoff, driven through the shipped
 * command surfaces against a real daemon holding the exclusive seeded node.
 *
 * DESIGN LINE 1101 — "Findings link evidence to required changes. Delta approval shows changed
 * hashes and invalidated/carry-forward nodes. Three-round counter is visible and escalation is
 * explicit. Old plans, attempts, receipts, and reviews remain readable."
 *
 * THE REJECTION IS EARNED, NOT STAGED. The `fail-verify` agent writes a well-formed but WRONG
 * deliverable and reports a CLEAN round; the daemon's own verifier runs the node's test over
 * exactly those bytes, disagrees, and records the failing round itself. So the findings are
 * production's, their evidence digest is the real captured output of a real failing run, and
 * nothing in this file authors a finding.
 *
 * THE RE-PLAN IS THE PRODUCTION COMMAND. `qualification.replan` goes out over the seed's own
 * wire and envelope builder at a version read from the daemon's own affordance surface — a
 * hand-rolled POST would be a second client whose answers prove nothing about the first.
 *
 * WHAT THIS FILE DOES NOT CLAIM, stated so no reader infers it. The step's "new attempt with a
 * fresh captureRef/worktree" is NOT asserted here and cannot be from any real-process journey:
 * no shipped client dispatches `foundation.dispatch` (`buildDemoSeedPlan` plans nine commands,
 * none foundation; the kind is registry-reachable but ASYNC-ONLY), so no attempt is reserved
 * and no worktree is derived. That clause is tier-cited to the landed behavioural test —
 * `apps/daemon/src/work/foundation-capture-lifecycle.test.ts:525` "keeps immutable captureRefs
 * and distinct worktrees per attempt" — under the same disposition step 4's in-flight clause
 * received, and the client-ingress prerequisite stays pinned to its owner,
 * task-a9fd91c373c244c78df97945965a8038. This is the identical unreachability, not a new one.
 */
import { afterAll, describe, expect, it } from "vitest";

import { readReviewLedger } from "@moe/daemon";

import { claimOwners, durableLines, durableReadback } from "./foundation-readback.js";
import { OPERATOR_PRINCIPAL, removeScratches, withStore } from "./j1-ledger-view.js";
import {
  type DaemonHandle,
  type J1Scratch,
  NODE_REF,
  createJ1Scratch,
  killTree,
  pidIsAlive,
  runSeed,
  runWrapper,
  startDaemon,
} from "./j1-loop-harness.js";
import { pidReaped } from "./orphan-reap.js";
import { seedConfigFor, replayCommand } from "./j3-crash-harness.js";
import {
  deltaNode,
  readAffordanceSurface,
  replanCommand,
  stepFor,
  workspaceDigest,
} from "./j4-replan-harness.js";
import { J4_REJECTION_ROUTES } from "./journey-spec.js";

const ARM_TIMEOUT_MS = 240_000;
/** The design's typed implementation-only rejection route, transcribed at journey-spec.ts. */
const IMPLEMENTATION_ONLY_ROUTE = "REJECT_IMPLEMENTATION";
const SUCCESSOR_PLAN_REF = "plan-j4-successor-1";

const scratches: J1Scratch[] = [];
/**
 * Every daemon this file starts, reaped in teardown as well as in the body.
 *
 * The body's kill is what the orphan assertions need; this list is what a FAILING run needs.
 * An assertion that throws mid-arm skips the in-body kill entirely, and on Windows a surviving
 * daemon holds its store file open, so the scratch removal that follows fails with EBUSY and
 * leaves both a live process and a temp tree behind. `killTree` is idempotent, so reaping
 * twice on the green path costs nothing.
 */
const daemons: DaemonHandle[] = [];

afterAll(async () => {
  for (const daemon of daemons) await killTree(daemon.child);
  removeScratches(scratches);
});

/** The review ledger for the exclusive node, folded through the daemon's own read model. */
function reviewLedger(scratch: J1Scratch) {
  return withStore(scratch, (store) => readReviewLedger(store, scratch.projectId, NODE_REF));
}

describe("J4 rejection, re-plan and safe handoff over real processes", () => {
  it(
    "rejects a failing attempt, classifies the delta, and leaves exactly one owner",
    async () => {
      const scratch = createJ1Scratch();
      scratches.push(scratch);
      const daemon = await startDaemon(scratch);
      daemons.push(daemon);
      const seed = await runSeed(scratch, daemon.origin);
      if (seed.code !== 0) throw new Error(`seed failed (${String(seed.code)}): ${seed.output}`);
      const config = seedConfigFor(scratch, daemon.origin);

      // The node's bytes BEFORE the attempt, measured rather than assumed: `math.mjs` does not
      // exist yet, so this digest is over the workspace the agent was handed.
      const beforeDigest = workspaceDigest(scratch);

      // NEGATIVE CONTROL, and it has to run FIRST. With no round recorded there is nothing a
      // re-plan succeeds, and the daemon must say so by name. Run after the rejection instead
      // and this arm could never distinguish "refused because there is no round" from "refused
      // because something else was wrong".
      const beforeReplan = durableReadback(scratch);
      const withoutRound = await replayCommand(config, replanCommand({
        expectedVersion: 0,
        nodes: [deltaNode(NODE_REF)],
        ordinal: 1,
        subjectRef: NODE_REF,
        successorPlanRef: SUCCESSOR_PLAN_REF,
      }));
      // The literal code AND the layer that refused: two claims, because a second layer
      // starting to answer first would leave a bare "it was refused" green.
      expect(withoutRound.refusal).toMatchObject({
        code: "REVIEW_REPLAN_WITHOUT_ROUND",
        layer: "DAEMON_PREREQUISITE",
        stage: "DISPATCH",
      });
      expect(withoutRound.outcome).not.toBe("ACCEPTED");
      // Nothing durable followed the refusal, read back byte for byte.
      const afterRefusal = durableReadback(scratch);
      expect(beforeReplan.readable).toBe(true);
      expect(beforeReplan.decisionCount).toBeGreaterThan(0);
      expect(afterRefusal).toEqual(beforeReplan);

      // THE ATTEMPT: a wrong deliverable, submitted as clean.
      const wrapper = await runWrapper(scratch, "fail-verify");
      if (wrapper.code !== 0) {
        throw new Error(`wrapper exited ${String(wrapper.code)}: ${wrapper.output}`);
      }
      expect(wrapper.output).toContain("arm=fail-verify: multiply is wrong");

      // The bytes actually changed, so the delta below classifies a real change.
      const afterDigest = workspaceDigest(scratch);
      expect(afterDigest).not.toBe(beforeDigest);

      // THE DAEMON'S OWN VERDICT, from the durable ledger: the verifier's failing round, its
      // typed implementation-only route, and its finding carrying the captured run as
      // evidence. `verifier-test-failed` is production's rule id, not this file's.
      const rejected = reviewLedger(scratch);
      expect(rejected.unreadable).toBe(false);
      expect(rejected.accepted).toBeUndefined();
      const latest = rejected.rounds[rejected.rounds.length - 1];
      expect(latest?.routing.route).toBe(IMPLEMENTATION_ONLY_ROUTE);
      expect(J4_REJECTION_ROUTES[0]).toContain("implementation-only");
      // THE AGENT CLAIMED CLEAN AND THE DAEMON DISAGREED, which is the whole arm. Round 1 is
      // the agent's own ACCEPT-routed submission under its scoped session principal; the
      // rejecting round is a different principal entirely. Measured, not assumed: the failing
      // round is dispatched by the daemon under the OPERATOR identity, while the verifier's
      // own principal (`daemon:node-verifier`) appears on the RECEIPT path, which a rejected
      // attempt never reaches. Asserting the receipt principal here would be asserting a
      // record that only exists on acceptance.
      const claimed = rejected.rounds[0];
      expect(claimed?.routing.route).toBe("ACCEPT");
      expect(latest?.principalId).not.toBe(claimed?.principalId);
      expect(latest?.principalId).toBe(OPERATOR_PRINCIPAL);
      const record = latest?.lineage.records[latest.lineage.records.length - 1];
      expect(record?.finding.ruleId).toBe("verifier-test-failed");
      expect(record?.finding.severity).toBe("MAJOR");
      expect(record?.finding.subject).toEqual({ kind: "NODE", locator: NODE_REF });
      // "Findings link evidence to required changes": the detail names the exit code and the
      // sha256 of the output the verifier actually captured over the agent's bytes.
      expect(record?.finding.detail).toMatch(/^verifier run exited [1-9]\d* \(output sha256 [0-9a-f]{64}\)/u);

      // The surface routes the node back to workable — the design's implementation-only
      // rejection, read from the daemon's own affordance surface rather than inferred.
      const afterRejection = await readAffordanceSurface(config);
      expect(afterRejection.outcome).toBe("SURFACE");
      const rejectedStep = stepFor(afterRejection, NODE_REF);
      expect(rejectedStep?.status).toBe("READY");
      expect(rejectedStep?.missing).toEqual([]);

      // Everything the ledger holds before the re-plan, so history can be proved append-only.
      const before = durableLines(scratch);

      // RE-PLAN 1 — carry authority is unavailable, so the daemon conservatively invalidates.
      const invalidating = await replayCommand(config, replanCommand({
        expectedVersion: rejectedStep?.version ?? -1,
        nodes: [deltaNode(NODE_REF)],
        ordinal: 2,
        subjectRef: NODE_REF,
        successorPlanRef: SUCCESSOR_PLAN_REF,
      }));
      expect(invalidating.refusal).toBeNull();
      expect(invalidating.outcome).toBe("ACCEPTED");
      const invalidated = reviewLedger(scratch).delta;
      expect(invalidated?.successorPlanRef).toBe(SUCCESSOR_PLAN_REF);
      expect(invalidated?.classifications).toEqual([{
        classification: "INVALIDATED",
        nodeRef: NODE_REF,
        reasonCodes: [
          "CARRY_EVIDENCE_FACT_UNREADABLE",
          "dependenciesPresent",
          "environmentClosureUnchanged",
          "policySliceUnchanged",
          "predecessorResultUnchanged",
        ],
        sourceHash: "",
        targetHash: "",
      }]);

      // RE-PLAN 2 — the same production command remains available and fail-closed.
      const carrySurface = await readAffordanceSurface(config);
      const carrying = await replayCommand(config, replanCommand({
        expectedVersion: stepFor(carrySurface, NODE_REF)?.version ?? -1,
        nodes: [deltaNode(NODE_REF)],
        ordinal: 3,
        subjectRef: NODE_REF,
        successorPlanRef: SUCCESSOR_PLAN_REF,
      }));
      expect(carrying.refusal).toBeNull();
      expect(carrying.outcome).toBe("ACCEPTED");
      const secondDelta = reviewLedger(scratch).delta;
      expect(secondDelta?.classifications).toEqual([{
        classification: "INVALIDATED",
        nodeRef: NODE_REF,
        reasonCodes: [
          "CARRY_EVIDENCE_FACT_UNREADABLE",
          "dependenciesPresent",
          "environmentClosureUnchanged",
          "policySliceUnchanged",
          "predecessorResultUnchanged",
        ],
        sourceHash: "",
        targetHash: "",
      }]);
      // Both replans completed, but neither caller invocation gained carry authority.
      const produced = [invalidated, secondDelta]
        .map((record) => record?.classifications[0]?.classification ?? "NONE")
        .map((classification) => classification.toLowerCase().replaceAll("_", "-"));
      expect(produced).toEqual(["invalidated", "invalidated"]);

      // "Old plans, attempts, receipts, and reviews remain readable" — asserted as APPEND-ONLY
      // history: every line the ledger held before the re-plans is still there, in order, byte
      // for byte. A digest comparison could only say "different", which every honest append is.
      const after = durableLines(scratch);
      expect(after.readable).toBe(true);
      expect(after.events.slice(0, before.events.length)).toEqual(before.events);
      expect(after.decisions.slice(0, before.decisions.length)).toEqual(before.decisions);
      expect(after.decisions.length).toBeGreaterThan(before.decisions.length);

      // SAFE HANDOFF: exactly one owner in the durable record, and the claim is RELEASED
      // rather than abandoned OPEN. Two rows here would be the duplicate authority DoD 3 bars.
      const owners = claimOwners(scratch);
      // eslint-disable-next-line no-console
      console.log(`J4 HANDOFF ${JSON.stringify({
        classifications: [invalidated?.classifications[0]?.classification,
          secondDelta?.classifications[0]?.classification],
        owners, rounds: rejected.rounds.length, storePath: scratch.storePath,
      })}`);
      expect(owners).toHaveLength(1);
      expect(owners[0]?.status).toBe("RELEASED");
      expect(new Set(owners.map((owner) => owner.claimedBy)).size).toBe(1);
      expect(owners[0]?.claimedBy).not.toBe(OPERATOR_PRINCIPAL);

      await killTree(daemon.child);
      expect(pidIsAlive(process.pid)).toBe(true);
      for (const pid of [daemon.pid, wrapper.pid]) {
        const alive = pid === undefined ? false : !(await pidReaped(pid));
        expect({ alive, pid }).toEqual({ alive: false, pid });
      }
    },
    ARM_TIMEOUT_MS,
  );
});
