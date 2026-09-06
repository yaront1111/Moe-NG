/**
 * A RECORDED DAEMON FRAME - the surface AFTER the operator approved the successor plan.
 *
 * Captured 2026-09-06 by a throwaway recorder under apps/daemon/src/http/ that drove the SAME
 * world `plan-reject-frames.fixture.ts` was recorded from (`rejectedWorld()` from
 * apps/daemon/src/planning/plan-reject-test-fixtures.ts), one step further: the compiler
 * replanned the successor and `approvePlan()` committed the APPROVE. It then called the
 * production seam `resolvePlanningOffers(...)` exactly as `affordance-read.ts:299-325` composes
 * it, and serialised its `offers`, `planningGoalRefs` and `compilerSteps` verbatim under the
 * three keys the browser's decoder reads. The recorder was deleted in the same step.
 *
 * ONLY THE PLANNING HALF IS RECORDED, and that is stated rather than hidden: the bootstrap
 * chrome `readSurface()` wraps around it throws at this HEAD for a reason foreign to this file
 * (`COMMAND_PREREQUISITES` has no row for the `deployment.*` kinds added to
 * BOOTSTRAP_COMMAND_KINDS by 5ab9640f), and `planSentBack` reads offers and bindings only.
 *
 * THE STATE IT PINS, and the whole reason it exists: after the approval the daemon still binds
 * the SUCCESSOR run to the goal - `planningGoalRefs` carries one ref per durable goal for the
 * goal's whole life - while offering NOTHING for it. Confirmed live on UnAI the same day, on
 * goal-c1d66d35-94ae-47c1-8ec5-4f5f44ddae34: `planningGoalRefs` bound
 * run-364badebfb47fdf2e0631b57, zero offers targeted the goal or any of its runs, and four
 * nodes were already working.
 *
 * REJECTED run "run-1", SUCCESSOR run "run-ab155dbf7a69b4415eb25141", goal "goal-1" - the same
 * three ids `plan-reject-frames.fixture.ts` recorded, because it is the same world.
 */

export const AFTER_APPROVE_FRAME: unknown = Object.freeze(
  {
    "nextAllowedCommands": [],
    "outcome": "SURFACE",
    "planningGoalRefs": {
      "run-ab155dbf7a69b4415eb25141": "goal-1"
    },
    "steps": []
  },
);
