import type { DatabaseSync } from "node:sqlite";

import { DurableStoreError } from "./store-contracts.js";
import type { DecisionIdentities } from "./decision-ledger-canonical.js";
import type { DecisionLegsPlan } from "./decision-ledger-fences.js";

const COLLIDING_DECISION_ID_QUERY =
  "SELECT 1 AS value FROM command_decisions WHERE decision_id = ?";

function receiptCommandIds(
  identities: DecisionIdentities,
  legsPlan: DecisionLegsPlan | null,
): readonly string[] {
  return legsPlan === null
    ? [identities.receiptCommandId]
    : legsPlan.legs.flatMap((legPlan) =>
        legPlan.kind === "APPEND" ? [legPlan.commitInput.commandId] : []);
}

export function assertDecisionNamespaceFree(
  database: Pick<DatabaseSync, "prepare">,
  receiptExists: (commandId: string) => boolean,
  identities: DecisionIdentities,
  legsPlan: DecisionLegsPlan | null,
): void {
  const collidingDecision = database
    .prepare(COLLIDING_DECISION_ID_QUERY)
    .get(identities.decisionId);
  if (collidingDecision !== undefined) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "a scoped command decision ID collides with a different composite key",
    );
  }
  for (const receiptCommandId of receiptCommandIds(identities, legsPlan)) {
    if (receiptExists(receiptCommandId)) {
      throw new DurableStoreError(
        "DURABLE_ID_CONFLICT",
        "the internal decision receipt ID is already occupied",
      );
    }
  }
}
