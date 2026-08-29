/**
 * The DECIDE-TIME budget commitment (task-61a2e8ad, governor ruling A in comment-87ad84c1).
 *
 * WHAT THIS IS FOR. `budgetRef` on an approval record used to be the ACTIVATION digest, which a
 * decide-time reader cannot know: the root is minted at activation. Ruling A makes the record
 * commit instead to the budget MATERIAL visible at decide time, and makes activation bind back
 * by recomputing that commitment from its own reads.
 *
 * THE RULING'S CONDITION 1 IS THE ONE THESE ARMS EXIST TO ENFORCE: the commitment and
 * `resolveApprovalBudgetRoot` must consume ONE canonical material builder. Two hand-maintained
 * material lists is exactly the digest-mirror drift this board has been burned by, and it is
 * invisible to any arm that only checks each side against a literal. So arm D compares the two
 * PRODUCTION surfaces to each other rather than to a fixture.
 *
 * Every arm drives a REAL file-backed store seeded through production writers, reusing the same
 * fixtures `budget-genesis-binding.test.ts` and `budget-genesis-leg.test.ts` already use.
 */

import { createHash } from "node:crypto";

import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import type { ApprovedRunBinding } from "../planning/approval-run-binding.js";
import {
  BUDGET_COMMITMENT_CODES, budgetCommitmentDigest, budgetCommitmentMaterial,
  verifyBudgetCommitment,
} from "./budget-commitment.js";
import type { BudgetCommitmentMaterialResult } from "./budget-commitment.js";
import { GENESIS_AMOUNTS, resolveApprovalBudgetRoot } from "./budget-genesis-leg.js";
import {
  GOAL_ID, PROJECT_ID, seedProjectAndGoal, withBudgetStore,
} from "./budget-ledger-fixtures.js";

const VERIFIED_REVISION_REF = "graph-revision-approved-1";
/** Test-side literals on purpose: importing them from the module under test would make every
 *  assertion a fixed point a hardcoded return could satisfy. */
const LAYER = "DAEMON_PREREQUISITE";
const MISMATCH_CODE = "BOOTSTRAP_BUDGET_COMMITMENT_MISMATCH";
const MALFORMED_CODE = "BUDGET_COMMITMENT_REF_MALFORMED";
const UNAVAILABLE_CODE = "BUDGET_COMMITMENT_MATERIAL_UNAVAILABLE";
const HEX64 = /^[0-9a-f]{64}$/u;

const RUN_BINDING: ApprovedRunBinding = Object.freeze({
  authorityRef: "authority-1",
  bodiesDigest: "a".repeat(64),
  envelopeDigest: "b".repeat(64),
  runId: "run-1",
});

const query = (goalRef = GOAL_ID, projectId = PROJECT_ID) => ({
  approvedRun: { runBinding: RUN_BINDING, verifiedGraphRevisionRef: VERIFIED_REVISION_REF },
  goalRef,
  projectId,
});

const legInput = (commandId = "cmd-approve") => ({
  ...query(),
  context: {
    commandId,
    correlationId: "corr-approve",
    decidedAt: "2026-08-23T00:00:00.000Z",
    principalId: "principal-1",
  },
});

function material(result: BudgetCommitmentMaterialResult) {
  if (!result.ok) throw new Error(`expected material, got ${result.code}`);
  return result.material;
}

describe("task-61a2e8ad: the decide-time budget commitment", () => {
  it("A: DETERMINISM - the same store yields the same material and the same 64-hex digest", () => {
    withBudgetStore("commitment-determinism", (store: SqliteEventStore) => {
      seedProjectAndGoal(store);

      const first = material(budgetCommitmentMaterial(store, query()));
      const second = material(budgetCommitmentMaterial(store, query()));

      expect(first).toEqual(second);
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.projectId).toBe(PROJECT_ID);
      expect(first.goalRef).toBe(GOAL_ID);
      expect(first.binding.graphRevisionRef).toBe(VERIFIED_REVISION_REF);
      expect(first.amounts).toEqual(GENESIS_AMOUNTS);

      const digest = budgetCommitmentDigest(first);
      expect(digest).toMatch(HEX64);
      expect(budgetCommitmentDigest(second)).toBe(digest);
    });
  });

  it("B: ONE FIELD, ONE DIGEST - every committed field moves it", () => {
    withBudgetStore("commitment-fields", (store: SqliteEventStore) => {
      seedProjectAndGoal(store);
      const base = material(budgetCommitmentMaterial(store, query()));
      const baseDigest = budgetCommitmentDigest(base);

      // A NAMED roster with its own length assertion: a sweep that silently produced zero
      // cases would pass while testing nothing, and this is the arm most at risk of that.
      const mutations: readonly { readonly name: string; readonly next: () => unknown }[] = [
        { name: "projectId", next: () => ({ ...base, projectId: "project-other" }) },
        { name: "goalRef", next: () => ({ ...base, goalRef: "goal-other" }) },
        { name: "binding.budgetAccountRef", next: () => ({ ...base, binding: { ...base.binding, budgetAccountRef: "account-other" } }) },
        { name: "binding.goalRef", next: () => ({ ...base, binding: { ...base.binding, goalRef: "goal-other" } }) },
        { name: "binding.graphEpoch", next: () => ({ ...base, binding: { ...base.binding, graphEpoch: base.binding.graphEpoch + 1 } }) },
        { name: "binding.graphRevisionRef", next: () => ({ ...base, binding: { ...base.binding, graphRevisionRef: "graph-revision-other" } }) },
        { name: "binding.ownerRef", next: () => ({ ...base, binding: { ...base.binding, ownerRef: "owner-other" } }) },
        { name: "binding.projectId", next: () => ({ ...base, binding: { ...base.binding, projectId: "project-other" } }) },
        { name: "amounts", next: () => ({ ...base, amounts: base.amounts.map((entry, index) => (index === 0 ? { ...entry, amount: 1 } : entry)) }) },
      ];
      expect(mutations).toHaveLength(9);

      for (const mutation of mutations) {
        const moved = budgetCommitmentDigest(mutation.next() as typeof base);
        expect(moved, `${mutation.name} must move the digest`).not.toBe(baseDigest);
      }
      // The nine must also be distinct from EACH OTHER: a digest that moved for every input but
      // collapsed two of them would satisfy the loop above while losing a fact.
      expect(new Set(mutations.map((m) => budgetCommitmentDigest(m.next() as typeof base))).size)
        .toBe(9);
    });
  });

  it("C: DOMAIN SEPARATION - it is neither a bare hash of the material nor the root digest", () => {
    withBudgetStore("commitment-domain", (store: SqliteEventStore) => {
      seedProjectAndGoal(store);
      const built = material(budgetCommitmentMaterial(store, query()));
      const digest = budgetCommitmentDigest(built);

      // Not an untagged hash of the obvious serialization: if it were, any other surface
      // hashing the same material the same way would collide with a commitment.
      const untagged = createHash("sha256").update(JSON.stringify(built), "utf8").digest("hex");
      expect(digest).not.toBe(untagged);

      // And NOT the root digest. These are different notions - the commitment covers decide-time
      // material, the root covers the durable record activation mints - and the whole point of
      // ruling A is that the record commits to the FORMER. Aliasing them would make the
      // bind-back check vacuous.
      const root = resolveApprovalBudgetRoot(store, legInput());
      if (!root.ok) throw new Error(`fixture root refused: ${root.code}`);
      expect(digest).not.toBe(root.digest);
    });
  });

  it("D: ONE SHARED BUILDER - the root resolver and the commitment see the same material", () => {
    withBudgetStore("commitment-shared-builder", (store: SqliteEventStore) => {
      seedProjectAndGoal(store);
      const built = material(budgetCommitmentMaterial(store, query()));

      const root = resolveApprovalBudgetRoot(store, legInput());
      if (!root.ok) throw new Error(`fixture root refused: ${root.code}`);

      // RULING CONDITION 1, asserted between two PRODUCTION surfaces rather than against a
      // fixture. Comparing each side to a literal would let both drift together; comparing them
      // to each other is what makes a second hand-maintained material list impossible to hide.
      expect(root.record.binding).toEqual(built.binding);
      expect(root.record.authorization.amounts).toEqual(built.amounts);
    });
  });

  it("E: ABSENCE REFUSES with the reader's own code carried, never a zero digest", () => {
    withBudgetStore("commitment-absent", (store: SqliteEventStore) => {
      // No goal seeded at all, so the binding reader cannot answer.
      const result = budgetCommitmentMaterial(store, query("goal-never-created"));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.code).toBe(UNAVAILABLE_CODE);
      expect(result.layer).toBe(LAYER);
      // The upstream reader's OWN code travels unrestamped: collapsing it here would make
      // "no such goal" indistinguishable from "the durable history is unreadable".
      expect(result.upstream).not.toBeNull();
      expect(typeof result.upstream?.code).toBe("string");
      expect((result.upstream?.code ?? "").length).toBeGreaterThan(0);
      expect(typeof result.upstream?.layer).toBe("string");
    });
  });

  it("F: BIND-BACK - the matching commitment passes and any other 64-hex refuses by name", () => {
    withBudgetStore("commitment-bindback", (store: SqliteEventStore) => {
      seedProjectAndGoal(store);
      const expected = budgetCommitmentDigest(material(budgetCommitmentMaterial(store, query())));

      expect(verifyBudgetCommitment(store, query(), expected)).toEqual({ ok: true });

      const other = verifyBudgetCommitment(store, query(), "c".repeat(64));
      expect(other).toEqual({ code: MISMATCH_CODE, layer: LAYER, ok: false });

      // A MALFORMED ref is a DIFFERENT answer from a mismatched one: an arm that only checked
      // "it refused" could not tell a caller who sent garbage from one who sent a stale digest.
      const malformed = verifyBudgetCommitment(store, query(), "not-a-digest");
      expect(malformed).toEqual({ code: MALFORMED_CODE, layer: LAYER, ok: false });
    });
  });

  it("publishes a frozen refusal roster with no duplicates", () => {
    expect(Object.isFrozen(BUDGET_COMMITMENT_CODES)).toBe(true);
    expect(new Set(BUDGET_COMMITMENT_CODES).size).toBe(BUDGET_COMMITMENT_CODES.length);
    for (const code of [MISMATCH_CODE, MALFORMED_CODE, UNAVAILABLE_CODE]) {
      expect(BUDGET_COMMITMENT_CODES).toContain(code);
    }
  });
});
