import type {
  AffordancePort, AffordanceSurface, AffordanceSurfaceResult, ChainStep,
} from "../http/affordance-contract.js";
import { OPERATOR_ACTIVATION_STEPS } from "./agent-spawn-contract.js";

/**
 * THE SURFACE AS THE WRAPPER MAY STAFF IT.
 *
 * `/affordances/read` is ONE surface serving two readers with different questions. The
 * operator's board asks "what stands where?", so every bootstrap kind is a step at its status
 * and the activation chain sits READY with its offers until the browser commits it. The
 * wrapper asks "what may a seat take?", and had been reading the board's answer as its own.
 * MEASURED 2026-09-13 on a real project: it spawned claude seats on `project.register`,
 * `policy.install` and the rest of the chain before the operator had activated the project,
 * and on `plan.propose@run-live-1`; each seat was refused inside claude and exited, about 28 s
 * per seat, three attempts per item per wrapper process.
 *
 * This view withholds exactly two shapes and rewrites nothing else:
 *
 *  1. Every step of `OPERATOR_ACTIVATION_STEPS`, UNTIL the project is activated: while the
 *     surface's `project.activate` step is not COMMITTED (BLOCKED on a fresh project, READY
 *     mid-chain) the chain is the browser's to drive and no seat takes any of it. Once it is
 *     committed the chain passes through again. COMMITTED is monotonic (bootstrap-ledger.ts
 *     never drops a kind) and the other five are prerequisites of `project.activate` or of its
 *     receipts, so the only chain step that can be READY after activation is a
 *     `policy.validate` the activator did not send. The browser always sends it before
 *     `project.activate` (activation-port.ts); the shipped seed (demo-seed-plan.ts) does not,
 *     BY DESIGN: demo-seed-policy.ts installs the hinted validatable slice so that an agent
 *     seat can complete the offered step, and the J3 crash-recovery e2e (foundation lane)
 *     depends on it: its ONCE pass is deterministic only because a READY `policy.validate`
 *     is always there to staff (measured 2026-09-13: withheld unconditionally, "the agent
 *     never wrote its pid file" on every CI host). So a project activated without
 *     `policy.validate` spends up to `maxItemAttempts` seats on it per wrapper process;
 *     that is main's behaviour before this view and not the measured finding. The roster's
 *     own comment says why it is not folded into `HUMAN_ONLY_STEPS`.
 *  2. A READY `plan.propose` step the surface does not OFFER at that run. The bootstrap loop
 *     (affordance-read.ts:333) deliberately pushes no generic offer for `plan.propose`; the only
 *     offer comes from the per-goal ladder (affordance-planning-offers.ts `offersForGoal`),
 *     which mints one for a durable goal's CURRENT run only while that goal is not source-bound
 *     and its plan is not yet reviewable. The chain STEP, though, is minted for every project:
 *     at the sole legacy subject when one resolves, else at `DEFAULT_RUN_SUBJECT`
 *     ("run-live-1"), a run no goal owns once real goals exist (`refsOfGoal` names a goal's run
 *     `run-<its subject>`). A `plan.propose` step with no offer at its run is therefore never
 *     work: the seeded demo goal (goal-live-1 / run-live-1) keeps its offer and is staffed
 *     exactly as before, while the orphan default subject is not. Keyed on the OFFER rather
 *     than on `planningGoalRefs` for the case in between: a source-bound goal's run IS in the
 *     refs, and staffing the demo payload against a real PRD is the race the ladder closed
 *     (affordance-planning-offers.ts, "A source-bound goal is compiled, never hand-planned").
 *
 * The other five kinds the bootstrap loop leaves unoffered (`approval.decide`, `goal.close`,
 * `repository.publish`, `deployment.deploy`, `deployment.set_target`) are all in
 * `HUMAN_ONLY_STEPS`, so the offer rule is stated for `plan.propose` alone and NOT generalised
 * to every step: `node.deliver`'s offer is `review.submit` at the node ref, a mapping this view
 * has no business restating.
 *
 * The board keeps its rows. This is the WRAPPER's read, composed in `agent-wrapper-main.ts`;
 * the MCP host the seats read through still gets the raw port.
 */

const LEGACY_PLANNING_KIND = "plan.propose";
const ACTIVATION_KIND = "project.activate";

function offeredAt(surface: AffordanceSurface, step: ChainStep): boolean {
  return surface.nextAllowedCommands.some((entry) =>
    entry.commandKind === step.kind && entry.targetAggregateId === step.aggregateId);
}

/** The chain has been driven to its end: `project.activate` is committed on this surface. */
function activated(surface: AffordanceSurface): boolean {
  return surface.steps.some((step) => step.kind === ACTIVATION_KIND && step.status === "COMMITTED");
}

/** The steps of one surface a seat may be staffed onto; the rest is the board's business. */
export function staffableSteps(surface: AffordanceSurface): readonly ChainStep[] {
  const chainIsTheBrowsers = !activated(surface);
  return Object.freeze(surface.steps.filter((step) => {
    if (chainIsTheBrowsers && OPERATOR_ACTIVATION_STEPS.has(step.kind)) return false;
    if (step.kind === LEGACY_PLANNING_KIND && step.status === "READY") {
      return offeredAt(surface, step);
    }
    return true;
  }));
}

/**
 * The port the wrapper watches: the same project, the same refusals, the same offers and
 * planning material, and only the STAFFABLE steps. A refused read passes through untouched.
 */
export function staffingSurfaceOf(port: AffordancePort): AffordancePort {
  return Object.freeze({
    boundProjectId: port.boundProjectId,
    readSurface: (): AffordanceSurfaceResult => {
      const surface = port.readSurface();
      if (surface.outcome !== "SURFACE") return surface;
      return Object.freeze({ ...surface, steps: staffableSteps(surface) });
    },
  });
}
