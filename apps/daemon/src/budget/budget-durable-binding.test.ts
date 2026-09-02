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

/**
 * The named tamper roster this row exists to make mechanically visible.
 *
 * Every entry is one DURABLE-RECORD tamper of a `GoalCreated`-TYPED row — the
 * record EXISTS and cannot be trusted — and every entry must answer the SAME
 * `BUDGET_PROJECTION_CORRUPT` at `BUDGET_CURRENT_PROJECTION`. Naming and
 * counting the roster is the point: the three arms used to be three unrelated
 * `it` blocks, so nothing asserted that the corrupt-byte axis was covered at
 * all, and only one of the three pinned the refusing LAYER.
 */
const GOAL_CREATED_TAMPER_ROSTER: readonly (readonly [string, string, Uint8Array])[] = [
  // Bytes that are not JSON at all.
  ["malformed JSON", "goal-corrupt-json", ENCODER.encode('{"kind":"GoalCreated"')],
  // Bytes that are not decodable UTF-8, so the decode fails before the parse.
  ["invalid UTF-8", "goal-corrupt-bytes", new Uint8Array([0xff, 0xfe, 0x01])],
  // Readable JSON under the GoalCreated event TYPE whose content does not carry
  // the fact the type claims — the content-vs-type breach budget-genesis-leg.ts
  // refuses as CORRUPT on the ledger root.
  [
    "GoalCreated type carrying a GoalRenamed fact",
    "goal-kind-mismatch",
    ENCODER.encode(JSON.stringify([{ kind: "GoalRenamed" }])),
  ],
];

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

  it("TASK-F8 refuses every named GoalCreated tamper as CORRUPT at the projection layer", () => {
    // Non-vacuity, asserted BEFORE the walk: a roster that silently generated
    // nothing would satisfy every assertion below without executing one.
    expect(GOAL_CREATED_TAMPER_ROSTER.length).toBe(3);
    const graded: string[] = [];

    for (const [label, goalRef, payload] of GOAL_CREATED_TAMPER_ROSTER) {
      withBudgetStore(`identity-tamper-${goalRef}`, (store) => {
        plantRawTransition(store, goalRef, `${goalRef}-0`, "GoalCreated", payload);

        const result = readGoalBudgetIdentity(store, PROJECT_ID, goalRef);

        expect([label, result.ok]).toEqual([label, false]);
        if (result.ok) throw new Error(`${label} yielded an identity`);
        // The exact code AND the refusing layer, per arm — not merely "refused".
        expect([label, result.code, result.layer]).toEqual([
          label, "BUDGET_PROJECTION_CORRUPT", "BUDGET_CURRENT_PROJECTION",
        ]);
        // The laundering this file forbids: corruption answering the same code
        // a goal that never existed answers.
        expect([label, result.code]).not.toEqual([label, "BUDGET_PROJECTION_GOAL_ABSENT"]);
        expect([label, result.outcome, result.sourceCode, result.sourceLayer]).toEqual([
          label, "UNKNOWN", null, null,
        ]);
        graded.push(label);
      });
    }

    // The bodies RAN: a `withBudgetStore` that never invoked its callback would
    // leave this empty while every assertion above stayed unexecuted.
    expect(graded).toEqual(GOAL_CREATED_TAMPER_ROSTER.map(([label]) => label));
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
