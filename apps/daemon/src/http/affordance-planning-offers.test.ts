/**
 * The per-goal planning offer ladder, pinned per lifecycle state — and pinned
 * against the wrapper's human-only skip list: every offered `approval.*` kind must
 * be one the agent wrapper refuses to staff, or the fleet would spawn an agent to
 * click Approve. The browser's plan-approval gate authorizes only against an
 * `approval.decide_intent` offer, so the DRAFT arm must mint one.
 */
import { describe, expect, it } from "vitest";

import type { NextAllowedCommand } from "@moe/contracts";

import { resolvePlanningOffers } from "./affordance-planning-offers.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger-vocabulary.js";
import { HUMAN_ONLY_STEPS } from "../orchestrator/agent-wrapper.js";

const PROJECT = "project-offers";
const GOAL_ID = "goal-offers-1";
const RUN_ID = "run-offers-1";

function ledgerWith(runLifecycle: string, goalLifecycle: string): DurableLedger {
  return {
    aggregates: new Map([
      [GOAL_ID, {
        currentVersion: 3,
        result: {
          goalId: GOAL_ID, lifecycle: goalLifecycle, planningRunRef: RUN_ID,
          projectId: PROJECT,
        },
      }],
      [RUN_ID, {
        currentVersion: 4,
        result: { state: { goalRef: GOAL_ID, lifecycle: runLifecycle } },
      }],
    ]),
    decisionCount: 0,
    kinds: new Set(),
  };
}

function offersFor(runLifecycle: string, goalLifecycle: string): readonly NextAllowedCommand[] {
  let minted = 0;
  const resolution = resolvePlanningOffers({
    ledger: ledgerWith(runLifecycle, goalLifecycle),
    mintId: () => `cmd-${(minted += 1)}`,
    projectId: PROJECT,
  });
  return resolution.offers;
}

describe("per-goal planning offers", () => {
  it("offers plan.propose on the run while the plan is not reviewable", () => {
    const offers = offersFor("DRAFTING", "DRAFT");
    expect(offers.map((entry) => entry.commandKind)).toEqual(["plan.propose"]);
    expect(offers[0]?.targetAggregateId).toBe(RUN_ID);
  });

  it("offers BOTH human approval kinds on a reviewable DRAFT goal's run", () => {
    // The browser gate (plan-approval.ts) authorizes only against a
    // `approval.decide_intent` offer; `approval.decide` stays for the seeded
    // journey. Both bind the RUN aggregate with the daemon's own identity.
    const offers = offersFor("PLAN_REVIEW", "DRAFT");
    expect(offers.map((entry) => entry.commandKind).sort()).toEqual([
      "approval.decide", "approval.decide_intent",
    ]);
    for (const entry of offers) {
      expect(entry.targetAggregateId).toBe(RUN_ID);
      expect(entry.expectedVersion).toBe(4);
      expect(typeof entry.commandId).toBe("string");
    }
    // Two distinct minted command ids: offers never share an identity.
    expect(new Set(offers.map((entry) => entry.commandId)).size).toBe(2);
  });

  it("offers goal.close on the goal once execution is enabled or closing", () => {
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      const offers = offersFor("PLAN_REVIEW", lifecycle);
      expect(offers.map((entry) => entry.commandKind)).toEqual(["goal.close"]);
      expect(offers[0]?.targetAggregateId).toBe(GOAL_ID);
    }
  });

  it("offers nothing for a lifecycle outside the ladder", () => {
    expect(offersFor("PLAN_REVIEW", "SOMETHING_ELSE")).toEqual([]);
  });

  it("every offered approval kind is one the wrapper refuses to staff", () => {
    // The skip list is the ONLY thing standing between an approval offer and the
    // wrapper minting an agent session to take it — approval kinds carry a
    // non-null agentCapabilitiesFor, so absence here is a staffed-approver leak.
    const offers = offersFor("PLAN_REVIEW", "DRAFT");
    const approvalKinds = offers
      .map((entry) => entry.commandKind as string)
      .filter((kind) => kind.startsWith("approval."));
    expect(approvalKinds.length).toBeGreaterThan(0);
    for (const kind of approvalKinds) {
      expect(HUMAN_ONLY_STEPS.has(kind), `${kind} missing from HUMAN_ONLY_STEPS`).toBe(true);
    }
  });
});
