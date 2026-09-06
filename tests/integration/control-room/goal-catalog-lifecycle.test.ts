import { afterEach, expect, it } from "vitest";

import { mapGoalCatalogAnswer } from "../../../apps/control-room/src/live/live-goal-catalog.js";
import { deriveGoalCatalog } from "../../../apps/control-room/src/v2/goals/goal-catalog-model.js";
import { readDurableLedger } from "../../../apps/daemon/src/bootstrap/bootstrap-ledger.js";
import {
  approvalPayload, closeStores, driveThrough, envelope, GOAL_ID, openStore, PROJECT_ID, send,
} from "../../../apps/daemon/src/bootstrap/bootstrap-test-fixtures.js";
import { readGoalCatalog } from "../../../apps/daemon/src/http/goal-catalog-read.js";

afterEach(closeStores);

it("does not present an execution-enabled goal as a draft from its creation-only catalog", () => {
  const store = openStore();
  driveThrough(store, "approval.decide");
  expect(send(store, envelope("approval.decide", 0, approvalPayload())).ok).toBe(true);
  expect(readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result)
    .toMatchObject({ lifecycle: "EXECUTION_ENABLED" });

  const answer = readGoalCatalog(store, PROJECT_ID);
  expect(answer.outcome).toBe("GOALS");
  const card = deriveGoalCatalog(mapGoalCatalogAnswer(200, answer)).goals[0];
  expect(card).toMatchObject({ goalId: GOAL_ID, state: "UNKNOWN" });
  expect(card?.comingOnlineFacts).toContainEqual({
    label: "Current state",
    reason: "The goal catalog does not include the current goal state.",
  });
});
