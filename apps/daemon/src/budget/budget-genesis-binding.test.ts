/**
 * The genesis budget binding: what a project's budget identity is at the MOMENT OF APPROVAL,
 * before any graph is ACTIVE (task-1de7b81a).
 *
 * Every arm drives a REAL file-backed store seeded through production writers, and every refusal
 * arm pins the exact code AND the layer that refused — plus the `sourceCode`/`sourceLayer` it
 * was carried with, which is the whole point of the gate under test: the wrapper code
 * BUDGET_PROJECTION_GRAPH_UNAVAILABLE is raised for a clean empty project AND for a corrupt one,
 * so only the CARRIED upstream code can tell "nothing has been activated yet" from "the durable
 * history is unreadable". Admitting the wrapper alone would silently bootstrap over corruption.
 */

import { describe, expect, it } from "vitest";

import type { ApprovedRunBinding } from "../planning/approval-run-binding.js";
import { readBudgetBinding } from "./budget-durable-binding.js";
import type { BudgetBindingResult } from "./budget-durable-binding.js";
import { GENESIS_GRAPH_EPOCH, readGenesisBudgetBinding } from "./budget-genesis-binding.js";
import type { GenesisApprovedRun } from "./budget-genesis-binding.js";
import {
  BUDGET_ACCOUNT_REF,
  GOAL_ID,
  PROJECT_ID,
  seedActiveGraphWithoutBody,
  seedDurableBindings,
  seedProjectAndGoal,
  withBudgetStore,
} from "./budget-ledger-fixtures.js";

const VERIFIED_REVISION_REF = "graph-revision-approved-1";
const OTHER_REVISION_REF = "graph-revision-someone-else";

/**
 * The receipt `verifyApprovedRunBinding` returns. It is a LITERAL here because this module is
 * the consumer of that verification, not its subject: the production join between a real
 * approval and this input is driven end to end in `approval-activation.test.ts`.
 */
const RUN_BINDING: ApprovedRunBinding = Object.freeze({
  authorityRef: "authority-1",
  bodiesDigest: "a".repeat(64),
  envelopeDigest: "b".repeat(64),
  runId: "run-1",
});

const approvedRun = (
  verifiedGraphRevisionRef = VERIFIED_REVISION_REF,
): GenesisApprovedRun => ({ runBinding: RUN_BINDING, verifiedGraphRevisionRef });

function bound(result: BudgetBindingResult): Extract<BudgetBindingResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a binding, got ${result.code}`);
  return result;
}

function refused(result: BudgetBindingResult): Extract<BudgetBindingResult, { ok: false }> {
  if (result.ok) throw new Error("expected a refusal, got a binding");
  return result;
}

describe("readGenesisBudgetBinding (task-1de7b81a)", () => {
  it("returns the production reader's OWN answer unchanged once a graph is ACTIVE", () => {
    withBudgetStore("genesis-passthrough", (store) => {
      seedDurableBindings(store);

      const strict = readBudgetBinding(store, PROJECT_ID, GOAL_ID);
      const result = readGenesisBudgetBinding(store, PROJECT_ID, GOAL_ID, approvedRun());

      // toStrictEqual against the PRODUCTION reader's output, never a literal: the ordinary
      // post-ACTIVE path must be behaviourally identical to calling `readBudgetBinding` itself.
      expect(result).toStrictEqual(strict);
      expect(bound(result).binding.graphRevisionRef).not.toBe(VERIFIED_REVISION_REF);
    });
  });

  it("derives the binding from durable facts when no graph has ever been activated", () => {
    withBudgetStore("genesis-derives", (store) => {
      seedProjectAndGoal(store);
      // The precondition this arm rests on: the strict reader really cannot answer here.
      expect(refused(readBudgetBinding(store, PROJECT_ID, GOAL_ID)).sourceCode)
        .toBe("ACTIVE_GRAPH_ABSENT");

      const result = readGenesisBudgetBinding(store, PROJECT_ID, GOAL_ID, approvedRun());

      expect(bound(result).binding).toStrictEqual({
        budgetAccountRef: BUDGET_ACCOUNT_REF,
        goalRef: GOAL_ID,
        graphEpoch: GENESIS_GRAPH_EPOCH,
        graphRevisionRef: VERIFIED_REVISION_REF,
        ownerRef: GOAL_ID,
        projectId: PROJECT_ID,
      });
      expect(GENESIS_GRAPH_EPOCH).toBe(1);
    });
  });

  it("names the run that was VERIFIED, never another revision", () => {
    withBudgetStore("genesis-selector", (store) => {
      seedProjectAndGoal(store);

      const result = readGenesisBudgetBinding(
        store, PROJECT_ID, GOAL_ID, approvedRun(OTHER_REVISION_REF),
      );

      // No arm defaults or substitutes: the derivation binds the ref it was handed and nothing
      // else, so a caller that verified run X cannot end up with a root bound to run Y.
      expect(bound(result).binding.graphRevisionRef).toBe(OTHER_REVISION_REF);
    });
  });

  it("refuses a corrupt graph history instead of bootstrapping over it", () => {
    withBudgetStore("genesis-corrupt", (store) => {
      seedActiveGraphWithoutBody(store);

      const result = refused(readGenesisBudgetBinding(store, PROJECT_ID, GOAL_ID, approvedRun()));

      // The wrapper code is the SAME one the clean-empty world raises; only the carried upstream
      // code separates them, and it is forwarded UNRESTAMPED.
      expect(result.code).toBe("BUDGET_PROJECTION_GRAPH_UNAVAILABLE");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceCode).toBe("ACTIVE_GRAPH_BODY_UNAVAILABLE");
      expect(result.sourceLayer).toBe("ACTIVE_GRAPH_PROJECTION");
      expect(result.outcome).toBe("UNKNOWN");
    });
  });

  it("refuses GOAL_ABSENT when the goal has no durable GoalCreated", () => {
    withBudgetStore("genesis-no-goal", (store) => {
      const result = refused(
        readGenesisBudgetBinding(store, PROJECT_ID, "goal-never-created", approvedRun()),
      );

      expect(result.code).toBe("BUDGET_PROJECTION_GOAL_ABSENT");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceCode).toBeNull();
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("refuses SCOPE_FOREIGN when another project asks for this goal's genesis binding", () => {
    withBudgetStore("genesis-foreign", (store) => {
      seedProjectAndGoal(store);

      const result = refused(
        readGenesisBudgetBinding(store, "project-elsewhere", GOAL_ID, approvedRun()),
      );

      expect(result.code).toBe("BUDGET_PROJECTION_SCOPE_FOREIGN");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceLayer).toBeNull();
    });
  });
});
