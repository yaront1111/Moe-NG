/**
 * The genesis budget root, CAPTURED as a leg and never separately committed (task-1de7b81a).
 *
 * The three properties the governor's Option-B ruling made binding, each asserted here rather
 * than argued: the amounts are a bidirectionally complete zero denominator; the path is
 * once-only, enforced by the writer's OWN guard; and nothing this module does is durable — the
 * leg is bytes waiting for someone else's decision, so a refusal leaves the store untouched.
 */

import { NODE_ADMISSION_METERS } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import type { ApprovedRunBinding } from "../planning/approval-run-binding.js";
import { GENESIS_AMOUNTS, buildGenesisBudgetLeg } from "./budget-genesis-leg.js";
import type { GenesisLegResult } from "./budget-genesis-leg.js";
import { deriveBudgetAggregateId } from "./budget-ledger-contracts.js";
import {
  BUDGET_ACCOUNT_REF,
  GOAL_ID,
  PROJECT_ID,
  advanceActiveGraph,
  rawCounts,
  seedActiveGraphWithoutBody,
  seedDurableBindings,
  seedProjectAndGoal,
  withBudgetStore,
} from "./budget-ledger-fixtures.js";

const VERIFIED_REVISION_REF = "graph-revision-approved-1";
const AGGREGATE = deriveBudgetAggregateId(PROJECT_ID, BUDGET_ACCOUNT_REF);

const RUN_BINDING: ApprovedRunBinding = Object.freeze({
  authorityRef: "authority-1",
  bodiesDigest: "a".repeat(64),
  envelopeDigest: "b".repeat(64),
  runId: "run-1",
});

const legInput = (commandId = "cmd-approve") => ({
  approvedRun: { runBinding: RUN_BINDING, verifiedGraphRevisionRef: VERIFIED_REVISION_REF },
  context: {
    commandId,
    correlationId: "corr-approve",
    decidedAt: "2026-08-23T00:00:00.000Z",
    principalId: "principal-1",
  },
  goalRef: GOAL_ID,
  projectId: PROJECT_ID,
});

function built(result: GenesisLegResult): Extract<GenesisLegResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a leg, got ${result.code}`);
  return result;
}

function refused(result: GenesisLegResult): Extract<GenesisLegResult, { ok: false }> {
  if (result.ok) throw new Error("expected a refusal, got a leg");
  return result;
}

/** Commits the captured leg the way the approve path will: as somebody else's decision. */
function commitAsSecondaryLeg(store: SqliteEventStore, result: Extract<GenesisLegResult, { ok: true }>): void {
  store.commitExpectedVersionDecisionLegs({
    commandKind: "test.commit-genesis",
    committedResultBytes: new TextEncoder().encode("{}"),
    correlationId: "corr-approve",
    decidedAt: "2026-08-23T00:00:00.000Z",
    key: { commandId: `commit-${result.digest.slice(0, 8)}`, principalId: "principal-1", projectId: PROJECT_ID },
    legs: [
      {
        aggregateId: GOAL_ID,
        events: [{ eventId: `primary-${result.digest.slice(0, 8)}`, eventType: "TestPrimary", payload: new TextEncoder().encode("{}") }],
        expectedVersion: store.getAggregateVersion(GOAL_ID),
      },
      result.leg,
    ],
    requestBytes: new TextEncoder().encode("request"),
  });
}

describe("buildGenesisBudgetLeg (task-1de7b81a)", () => {
  it("denominates the root in the WHOLE admission meter roster, every amount zero", () => {
    // BOTH directions. A denominator that shrank to the meters it happens to iterate would pass
    // a one-way check while leaving a meter permanently unfundable.
    expect(GENESIS_AMOUNTS.map((amount) => amount.meter).slice().sort())
      .toStrictEqual(NODE_ADMISSION_METERS.slice().sort());
    expect(NODE_ADMISSION_METERS.every(
      (meter) => GENESIS_AMOUNTS.some((amount) => amount.meter === meter))).toBe(true);
    expect(GENESIS_AMOUNTS.length).toBeGreaterThan(0);
    expect(GENESIS_AMOUNTS.every((amount) => amount.amount === 0)).toBe(true);
  });

  it("builds a leg whose record is the zero root bound to the VERIFIED revision", () => {
    withBudgetStore("genesis-leg-builds", (store) => {
      seedProjectAndGoal(store);

      const result = built(buildGenesisBudgetLeg(store, legInput()));

      expect(result.leg.aggregateId).toBe(AGGREGATE);
      expect(result.leg.expectedVersion).toBe(0);
      expect(result.record.transition).toBe("ROOT_AUTHORIZED");
      expect(result.record.authorization.amounts).toStrictEqual(GENESIS_AMOUNTS);
      expect(result.record.binding).toStrictEqual({
        budgetAccountRef: BUDGET_ACCOUNT_REF,
        goalRef: GOAL_ID,
        graphEpoch: 1,
        graphRevisionRef: VERIFIED_REVISION_REF,
        ownerRef: GOAL_ID,
        projectId: PROJECT_ID,
      });
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/u);
    });
  });

  it("writes NOTHING durable — the leg is bytes until another decision commits it", () => {
    withBudgetStore("genesis-leg-not-durable", (store) => {
      seedProjectAndGoal(store);
      const before = rawCounts(store, AGGREGATE);

      built(buildGenesisBudgetLeg(store, legInput()));

      expect(rawCounts(store, AGGREGATE)).toStrictEqual(before);
      expect(before.events).toBe(0);
    });
  });

  it("an authorized-zero root is durably DISTINGUISHABLE from never having been authorized", () => {
    withBudgetStore("genesis-leg-zero-vs-absent", (store) => {
      seedProjectAndGoal(store);
      const result = built(buildGenesisBudgetLeg(store, legInput()));
      // Absence: the state the store is in before anyone commits the leg.
      expect(store.readEvents(AGGREGATE)).toHaveLength(0);

      commitAsSecondaryLeg(store, result);

      // Presence: a zero-amount root is a RECORD, not an empty one, so a later reader can tell
      // "authorized nothing" from "was never authorized" — the distinction `amounts: []` erases.
      expect(store.readEvents(AGGREGATE)).toHaveLength(1);
      expect(store.getAggregateVersion(AGGREGATE)).toBe(1);
    });
  });

  it("refuses the SECOND genesis with the writer's own once-only code and layer", () => {
    withBudgetStore("genesis-leg-once-only", (store) => {
      seedProjectAndGoal(store);
      commitAsSecondaryLeg(store, built(buildGenesisBudgetLeg(store, legInput())));

      const second = refused(buildGenesisBudgetLeg(store, legInput("cmd-approve-2")));

      expect(second.code).toBe("BUDGET_LEDGER_ALREADY_AUTHORIZED");
      expect(second.layer).toBe("BUDGET_LEDGER");
      expect(second.outcome).toBe("REFUSED");
    });
  });

  it("forwards the binding reader's refusal for a corrupt graph history, unrestamped", () => {
    withBudgetStore("genesis-leg-corrupt", (store) => {
      seedActiveGraphWithoutBody(store);

      const result = refused(buildGenesisBudgetLeg(store, legInput()));

      expect(result.code).toBe("BUDGET_PROJECTION_GRAPH_UNAVAILABLE");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceCode).toBe("ACTIVE_GRAPH_BODY_UNAVAILABLE");
      expect(result.sourceLayer).toBe("ACTIVE_GRAPH_PROJECTION");
    });
  });

  it("is UNREACHABLE past graph epoch 1: an epoch-2 world binds epoch 2, never the literal", () => {
    withBudgetStore("genesis-leg-epoch-two", (store) => {
      const predecessor = seedDurableBindings(store);
      const successor = advanceActiveGraph(store, predecessor);
      expect(successor.graphEpoch).toBe(2);

      const result = built(buildGenesisBudgetLeg(store, legInput()));

      // THE EPOCH GUARD. Genesis derives `graphEpoch: 1` and the caller's verified revision; a
      // path that stayed available once a graph is ACTIVE would bind a root to epoch 1 in an
      // epoch-2 world and the once-only guard would make that wrong binding permanent.
      expect(result.record.binding.graphEpoch).toBe(successor.graphEpoch);
      expect(result.record.binding.graphRevisionRef).toBe(successor.revisionId);
      expect(result.record.binding.graphRevisionRef).not.toBe(VERIFIED_REVISION_REF);
    });
  });
});
