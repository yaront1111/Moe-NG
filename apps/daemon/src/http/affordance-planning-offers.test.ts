/**
 * The per-goal planning offer ladder, pinned per lifecycle state — and pinned
 * against the wrapper's human-only skip list: every offered `approval.*` kind must
 * be one the agent wrapper refuses to staff, or the fleet would spawn an agent to
 * click Approve. The browser's plan-approval gate authorizes only against an
 * `approval.decide_intent` offer, so the DRAFT arm must mint one.
 *
 * COMPILER LADDER (source-bound goals): pre-Gate-1 the goal offers the Product
 * Contract writer and WITHHOLDS `plan.propose`; post-Gate-1 it offers the
 * decomposition dispatcher; an unreadable binding offers NOTHING. The lane port
 * is stubbed per arm — `affordance-compiler-lane.test.ts` proves the production
 * detection over a real store.
 */
import { describe, expect, it } from "vitest";

import type { NextAllowedCommand } from "@moe/contracts";

import type { CompilerLaneFacts, CompilerLanePort } from "./affordance-compiler-lane.js";
import { resolvePlanningOffers } from "./affordance-planning-offers.js";
import type { PlanningOfferResolution } from "./affordance-planning-offers.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger-vocabulary.js";
import { HUMAN_ONLY_STEPS } from "../orchestrator/agent-wrapper.js";

const PROJECT = "project-offers";
const GOAL_ID = "goal-offers-1";
const RUN_ID = "run-offers-1";

const LEGACY_LANE: CompilerLanePort = Object.freeze({
  factsFor: (): CompilerLaneFacts => Object.freeze({ lane: "LEGACY" as const }),
});

const GATE_REF = Object.freeze({
  contractId: "contract-offers-1",
  revisionDigest: "d".repeat(64),
  revisionId: "rev-offers-1",
});

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

function resolutionFor(
  runLifecycle: string, goalLifecycle: string, lane: CompilerLanePort = LEGACY_LANE,
): PlanningOfferResolution {
  let minted = 0;
  return resolvePlanningOffers({
    compilerLane: lane,
    ledger: ledgerWith(runLifecycle, goalLifecycle),
    mintId: () => `cmd-${(minted += 1)}`,
    projectId: PROJECT,
  });
}

function offersFor(
  runLifecycle: string, goalLifecycle: string, lane: CompilerLanePort = LEGACY_LANE,
): readonly NextAllowedCommand[] {
  return resolutionFor(runLifecycle, goalLifecycle, lane).offers;
}

describe("per-goal planning offers", () => {
  it("offers plan.propose on the run while the plan is not reviewable", () => {
    const resolution = resolutionFor("DRAFTING", "DRAFT");
    expect(resolution.offers.map((entry) => entry.commandKind)).toEqual(["plan.propose"]);
    expect(resolution.offers[0]?.targetAggregateId).toBe(RUN_ID);
    expect(resolution.compilerSteps).toEqual([]);
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
      expect(offers.map((entry) => entry.commandKind)).toEqual(["goal.close", "repository.publish"]);
      expect(offers[0]?.targetAggregateId).toBe(GOAL_ID);
      // Publishing targets the goal's own publish aggregate, so its version fence never moves the goal's.
      expect(offers[1]?.targetAggregateId).toBe(`publish:${GOAL_ID}`);
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

describe("the compiler ladder on a source-bound goal", () => {
  const laneOf = (facts: CompilerLaneFacts): CompilerLanePort =>
    Object.freeze({ factsFor: () => facts });

  it("offers the writer and WITHHOLDS plan.propose before Gate 1", () => {
    const resolution = resolutionFor("DRAFTING", "DRAFT",
      laneOf({ approvedGateRef: null, lane: "COMPILER" }));
    expect(resolution.offers.map((entry) => entry.commandKind))
      .toEqual(["product_contract.propose_revision"]);
    // On the GOAL aggregate at its own version — the writer's provenance join
    // re-reads the goal, so the run carries nothing yet.
    expect(resolution.offers[0]?.targetAggregateId).toBe(GOAL_ID);
    expect(resolution.offers[0]?.expectedVersion).toBe(3);
    expect(resolution.offers[0]?.inputSchemaVersion).toBe("moe-product-contract-compiler/1");
    // The wrapper staffs this: one READY compiler step, same identity as the offer.
    expect(resolution.compilerSteps).toEqual([
      { aggregateId: GOAL_ID, kind: "product_contract.propose_revision" },
    ]);
  });

  it("offers the dispatcher instead once Gate 1 approved a citing revision", () => {
    const resolution = resolutionFor("DRAFTING", "DRAFT",
      laneOf({ approvedGateRef: GATE_REF, lane: "COMPILER" }));
    expect(resolution.offers.map((entry) => entry.commandKind))
      .toEqual(["planning.submit_decomposition"]);
    expect(resolution.offers[0]?.targetAggregateId).toBe(GOAL_ID);
    expect(resolution.compilerSteps).toEqual([
      { aggregateId: GOAL_ID, kind: "planning.submit_decomposition" },
    ]);
  });

  it("offers NOTHING for a binding that fails integrity — never the legacy lane", () => {
    const resolution = resolutionFor("DRAFTING", "DRAFT", laneOf({ lane: "WITHHELD" }));
    expect(resolution.offers).toEqual([]);
    expect(resolution.compilerSteps).toEqual([]);
  });

  it("hands the goal back to the approval arms once the compiled run is reviewable", () => {
    // The dispatcher drove the chain to PLAN_REVIEW: the compiler lane is done
    // and the same two human approval wires appear that every goal gets.
    const offers = offersFor("PLAN_REVIEW", "DRAFT",
      laneOf({ approvedGateRef: GATE_REF, lane: "COMPILER" }));
    expect(offers.map((entry) => entry.commandKind).sort()).toEqual([
      "approval.decide", "approval.decide_intent",
    ]);
  });

  it("keeps both compiler kinds staffable — the wrapper must NOT skip them", () => {
    for (const kind of ["planning.submit_decomposition", "product_contract.propose_revision"]) {
      expect(HUMAN_ONLY_STEPS.has(kind), `${kind} wrongly human-only`).toBe(false);
    }
  });
});
