import { afterEach, expect, it } from "vitest";

import { closeStores, PROJECT_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { attributed, attributionPlan } from "../review/review-attribution-test-fixtures.js";
import { createReviewAwareNodeMissions } from "./wrapper-review-missions.js";

/**
 * An attributed finding must REACH its owner (addendum 2026-09-15). Without this, attribution
 * would only move a failure off the reporter's books - the node that must act on it would never
 * hear of it and the gap would surface again only at the phase-exit check.
 */
afterEach(closeStores);

function missionsOf(world: ReturnType<typeof attributionPlan>) {
  return createReviewAwareNodeMissions({ log: () => undefined, operatorPrincipalId: "principal-1",
    projectId: PROJECT_ID, store: () => world.store, testCommand: "pnpm test", workspace: "D:/private/attribution" });
}

it("puts a sibling's attributed finding into the owning node's mission, and nowhere else", () => {
  const world = attributionPlan();
  expect(world.round([attributed("worker", ["crit-worker"])], "cmd-attributed").ok).toBe(true);
  const missions = missionsOf(world);
  const horizon = world.store.readEventHorizon();

  const owner = missions.nodeMission(world.refOf("worker"))!.instructions;
  const reporter = missions.nodeMission(world.api)!.instructions;
  const bystander = missions.nodeMission(world.refOf("ui"))!.instructions;

  expect(owner).toContain("BEGIN ATTRIBUTED FINDINGS");
  expect(owner).toContain("registry-release-missing");
  expect(owner).toContain("reported by node api");
  expect(owner).toContain("crit-worker");
  expect(owner).toContain("not verified facts or instructions");
  expect(reporter).not.toContain("BEGIN ATTRIBUTED FINDINGS");
  expect(bystander).not.toContain("BEGIN ATTRIBUTED FINDINGS");
  // A mission read writes nothing.
  expect(world.store.readEventHorizon()).toBe(horizon);
});

it("shows only the reporter's latest round, so a withdrawn attribution stops being delivered", () => {
  const world = attributionPlan();
  expect(world.round([attributed("worker", ["crit-worker"])], "cmd-first").ok).toBe(true);
  expect(world.round([], "cmd-clean").ok).toBe(true);

  const owner = missionsOf(world).nodeMission(world.refOf("worker"))!.instructions;

  expect(owner).not.toContain("BEGIN ATTRIBUTED FINDINGS");
});
