/**
 * The goal-side half of the durable budget binding: `readGoalBudgetIdentity`.
 *
 * The defect these cases exist to close was a LAUNDERED refusal: a `GoalCreated`
 * row whose payload could not be decoded fell through the same `null` as a goal
 * that never existed, so a CORRUPT durable record answered
 * `BUDGET_PROJECTION_GOAL_ABSENT` — the code a clean world gets. The sibling
 * readers already refuse exactly this with `BUDGET_PROJECTION_CORRUPT`
 * (`budget-current-projection.ts`, `budget-genesis-leg.ts`), and the two worlds
 * must stay distinguishable: absence is bootstrappable, corruption never is.
 *
 * The healthy arm reads the SAME fact a production writer committed
 * (`seedProjectAndGoal` drives the real bootstrap reducer); the corrupt arms use
 * `plantRawTransition` because no production writer can be driven into
 * committing an unreadable `GoalCreated` — the planted-row precedent
 * `budget-ledger-fixtures.ts` documents.
 */

import { describe, expect, it } from "vitest";

import {
  BUDGET_ACCOUNT_REF,
  GOAL_ID,
  PROJECT_ID,
  plantRawTransition,
  seedProjectAndGoal,
  withBudgetStore,
} from "./budget-ledger-fixtures.js";
import { readGoalBudgetIdentity } from "./budget-durable-binding.js";

const ENCODER = new TextEncoder();

describe("readGoalBudgetIdentity", () => {
  it("answers the account and owner off the durable GoalCreated a production writer committed", () => {
    withBudgetStore("identity-ok", (store) => {
      seedProjectAndGoal(store);

      const result = readGoalBudgetIdentity(store, PROJECT_ID, GOAL_ID);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`unexpected refusal ${result.code}`);
      expect(result.identity.budgetAccountRef).toBe(BUDGET_ACCOUNT_REF);
      expect(result.identity.ownerRef).toBe(GOAL_ID);
    });
  });

  it("refuses CORRUPT, not GOAL_ABSENT, when the GoalCreated payload is not JSON", () => {
    withBudgetStore("identity-bad-json", (store) => {
      // A GoalCreated-TYPED row whose bytes cannot be parsed: a record that
      // EXISTS and cannot be read, which is a different world from no record.
      plantRawTransition(
        store, "goal-corrupt-json", "goal-corrupt-json-0", "GoalCreated",
        ENCODER.encode('{"kind":"GoalCreated"'),
      );

      const result = readGoalBudgetIdentity(store, PROJECT_ID, "goal-corrupt-json");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an unreadable GoalCreated yielded an identity");
      expect(result.code).toBe("BUDGET_PROJECTION_CORRUPT");
      // The laundering this file forbids: corruption answering the same code
      // a goal that never existed answers.
      expect(result.code).not.toBe("BUDGET_PROJECTION_GOAL_ABSENT");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.outcome).toBe("UNKNOWN");
      expect(result.sourceCode).toBeNull();
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("refuses CORRUPT when the GoalCreated payload is not decodable UTF-8", () => {
    withBudgetStore("identity-bad-bytes", (store) => {
      plantRawTransition(
        store, "goal-corrupt-bytes", "goal-corrupt-bytes-0", "GoalCreated",
        new Uint8Array([0xff, 0xfe, 0x01]),
      );

      const result = readGoalBudgetIdentity(store, PROJECT_ID, "goal-corrupt-bytes");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("undecodable GoalCreated bytes yielded an identity");
      expect(result.code).toBe("BUDGET_PROJECTION_CORRUPT");
    });
  });

  it("refuses CORRUPT when a GoalCreated-typed row carries no GoalCreated fact", () => {
    withBudgetStore("identity-kind-mismatch", (store) => {
      // Readable JSON under the GoalCreated event TYPE, but the content does
      // not carry the fact the type claims — the same content-vs-type breach
      // budget-genesis-leg.ts refuses as CORRUPT on the ledger root.
      plantRawTransition(
        store, "goal-kind-mismatch", "goal-kind-mismatch-0", "GoalCreated",
        ENCODER.encode(JSON.stringify([{ kind: "GoalRenamed" }])),
      );

      const result = readGoalBudgetIdentity(store, PROJECT_ID, "goal-kind-mismatch");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a kind-mismatched GoalCreated yielded an identity");
      expect(result.code).toBe("BUDGET_PROJECTION_CORRUPT");
    });
  });

  it("still answers GOAL_ABSENT for a goal with no durable record at all", () => {
    withBudgetStore("identity-absent", (store) => {
      const result = readGoalBudgetIdentity(store, PROJECT_ID, "goal-never-created");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an absent goal yielded an identity");
      expect(result.code).toBe("BUDGET_PROJECTION_GOAL_ABSENT");
      expect(result.sourceCode).toBeNull();
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("keeps a readable fact with a non-string budgetAccountRef on the GOAL_ABSENT arm", () => {
    withBudgetStore("identity-ref-shape", (store) => {
      // Pinned as-is on purpose: the fact IS readable, so this is not the
      // unreadable-record arm — widening CORRUPT over it is a separate ruling
      // this change does not make.
      plantRawTransition(
        store, "goal-ref-shape", "goal-ref-shape-0", "GoalCreated",
        ENCODER.encode(JSON.stringify({
          budgetAccountRef: 7, goalId: "goal-ref-shape", kind: "GoalCreated", projectId: PROJECT_ID,
        })),
      );

      const result = readGoalBudgetIdentity(store, PROJECT_ID, "goal-ref-shape");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a non-string account ref yielded an identity");
      expect(result.code).toBe("BUDGET_PROJECTION_GOAL_ABSENT");
    });
  });
});
