import { randomUUID } from "node:crypto";

import {
  createStoreDependencies, readStoreDependencyEnv,
} from "../../../apps/daemon/src/daemon-store-dependencies.js";

/**
 * Process-level e2e composition for the legacy hand-driven board.
 *
 * The browser's one shipped authority body is cryptographically pinned to goal-live-1/run-live-1;
 * arbitrary goal ids correctly refuse at the core digest fence. This provider changes no offer
 * eligibility, gate, handler or payload: it injects that one known command identity into the
 * production affordance mint seam until that goal is durably visible. The repeatable goal-create
 * route resumes independent identities after the fixture goal commits.
 */
const LIVE_COMMAND_ID = "live-1";
const LIVE_GOAL_ID = `goal-${LIVE_COMMAND_ID}`;
const LIVE_RUN_ID = `run-${LIVE_COMMAND_ID}`;
let liveGoalCommitted = false;

const production = createStoreDependencies({
  ...readStoreDependencyEnv(process.env),
  affordanceMintId: (kind) => kind === "goal.create" && !liveGoalCommitted
    ? LIVE_COMMAND_ID
    : randomUUID(),
});
const productionAffordances = production.affordances;
if (productionAffordances === undefined) {
  throw new Error("unreachable: the production store provider always wires affordances");
}

const provider = Object.freeze({
  ...production,
  affordances: () => {
    const port = productionAffordances();
    return Object.freeze({
      boundProjectId: port.boundProjectId,
      readSurface: () => {
        const surface = port.readSurface();
        if (surface.outcome === "SURFACE"
          && surface.planningGoalRefs[LIVE_RUN_ID] === LIVE_GOAL_ID) {
          liveGoalCommitted = true;
        }
        return surface;
      },
    });
  },
});

export default provider;
