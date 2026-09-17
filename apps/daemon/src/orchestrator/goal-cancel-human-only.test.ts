import { expect, it } from "vitest";

import { agentCapabilitiesFor } from "../daemon-command-vocabulary.js";
import { HUMAN_ONLY_STEPS } from "./agent-spawn-contract.js";

/**
 * ABANDONING A PRODUCT IS A HUMAN ACT, AND THE WRAPPER MUST NOT PICK IT UP.
 *
 * `goal.cancel` landed on 2026-09-17 as an operator-only kind. Two of its three fences came for
 * free: dispatch refuses it for any non-operator principal, and the MCP exclusion is DERIVED
 * from the operator-only table so the kind was never advertised to a seat. `HUMAN_ONLY_STEPS`
 * is hand-kept and was not grown with it, so the wrapper staffed it — measured as a live
 * `SPAWNED` report for `goal.cancel@goal-live-1`.
 *
 * WHAT THAT COSTS is churn, not escalation: the staffed seat's dispatch is refused
 * OPERATOR_PRINCIPAL_REQUIRED, so every pass mints a session, spawns a real model, and burns an
 * attempt on an item that can never move. It is the shape the roster's own `goal.create`
 * comment records — "8 junk goals in minutes" — with the seat cost and none of the progress.
 *
 * Fenced the way its siblings are: membership in this roster, NOT a null capability.
 * `goal.close` and `goal.create` both keep their GOAL/WORK list and are held back here alone,
 * and a kind fenced two different ways from its siblings is a kind whose fence nobody can read.
 */

it("keeps goal.cancel off the wrapper's staffing surface", () => {
  expect(HUMAN_ONLY_STEPS.has("goal.cancel"), "goal.cancel missing from HUMAN_ONLY_STEPS")
    .toBe(true);
});

it("fences every goal act the same way, so the roster reads as one rule", () => {
  for (const kind of ["goal.cancel", "goal.close", "goal.create", "goal.create_with_source"]) {
    expect(HUMAN_ONLY_STEPS.has(kind), `${kind} missing from HUMAN_ONLY_STEPS`).toBe(true);
    // The fence is the roster alone. Asserted so a later edit cannot quietly move goal.cancel
    // onto a different mechanism from the siblings it is grouped with.
    expect(agentCapabilitiesFor(kind), `${kind} lost its capability list`).not.toBeNull();
  }
});

it("still staffs the ordinary work kinds, so the fence is not simply refusing everything", () => {
  expect(HUMAN_ONLY_STEPS.has("node.deliver")).toBe(false);
  expect(agentCapabilitiesFor("node.deliver")).not.toBeNull();
});
