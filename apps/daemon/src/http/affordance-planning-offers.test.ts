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
import type { GoalCloseReadiness } from "../goals/goal-close-readiness.js";
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

/**
 * A goal with NO Product Contract is the default here, so every arm written before the closure
 * gate existed keeps asserting exactly today's ladder.
 */
const NO_CONTRACT = (): GoalCloseReadiness["kind"] => "NO_CONTRACT";

/**
 * A goal that has landed NOTHING is the default, because that is what a goal looks like for
 * every moment between activation and its first commit. Publishing is offered off the opposite
 * fact, so an arm that wants the PUBLISH card must say so.
 */
const NOTHING_LANDED = (): boolean => false;

function resolutionFor(
  runLifecycle: string, goalLifecycle: string, lane: CompilerLanePort = LEGACY_LANE,
  closeReadiness: (goalId: string) => GoalCloseReadiness["kind"] = NO_CONTRACT,
  landedCommit: (goalId: string) => boolean = NOTHING_LANDED,
): PlanningOfferResolution {
  let minted = 0;
  return resolvePlanningOffers({
    closeReadiness,
    compilerLane: lane,
    landedCommit,
    ledger: ledgerWith(runLifecycle, goalLifecycle),
    mintId: () => `cmd-${(minted += 1)}`,
    projectId: PROJECT,
  });
}

function offersFor(
  runLifecycle: string, goalLifecycle: string, lane: CompilerLanePort = LEGACY_LANE,
  closeReadiness: (goalId: string) => GoalCloseReadiness["kind"] = NO_CONTRACT,
  landedCommit: (goalId: string) => boolean = NOTHING_LANDED,
): readonly NextAllowedCommand[] {
  return resolutionFor(runLifecycle, goalLifecycle, lane, closeReadiness, landedCommit).offers;
}

/** The readiness fact plus a record of every goal it was asked about. */
function readinessSpy(kind: GoalCloseReadiness["kind"]): {
  readonly asked: string[]; readonly fact: (goalId: string) => GoalCloseReadiness["kind"];
} {
  const asked: string[] = [];
  return { asked, fact: (goalId): GoalCloseReadiness["kind"] => { asked.push(goalId); return kind; } };
}

/** The landing fact plus a record of every goal it was asked about. */
function landingSpy(landed: boolean): {
  readonly asked: string[]; readonly fact: (goalId: string) => boolean;
} {
  const asked: string[] = [];
  return { asked, fact: (goalId): boolean => { asked.push(goalId); return landed; } };
}

const LANDED = (): boolean => true;

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
      // Set-equality: nothing has been landed yet, so there is nothing to publish and the
      // roster is the close alone. `repository.publish` arrives in the arm below.
      expect(offers.map((entry) => entry.commandKind)).toEqual(["goal.close"]);
      expect(offers[0]?.targetAggregateId).toBe(GOAL_ID);
    }
  });

  it("WITHHOLDS repository.publish until a node of the goal is landed as a commit", () => {
    // THE DEFECT THIS GATE CLOSES: a PUBLISH card was minted over "No node of this goal is
    // landed as a commit yet" (seen live on UnAI 2026-09-04). Set-equality, never
    // `not.toContain`: the arm must also show the rest of the ladder is untouched.
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      expect(offersFor("PLAN_REVIEW", lifecycle).map((entry) => entry.commandKind))
        .toEqual(["goal.close"]);
    }
    expect(offersFor("PLAN_REVIEW", "COMPLETED")).toEqual([]);
  });

  it("offers repository.publish once a commit has landed for the goal", () => {
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      const offers = offersFor("PLAN_REVIEW", lifecycle, LEGACY_LANE, NO_CONTRACT, LANDED);
      expect(offers.map((entry) => entry.commandKind)).toEqual(["goal.close", "repository.publish"]);
      expect(offers[0]?.targetAggregateId).toBe(GOAL_ID);
      // Publishing targets the goal's own publish aggregate, so its version fence never moves the goal's.
      expect(offers[1]?.targetAggregateId).toBe(`publish:${GOAL_ID}`);
    }
    const completed = offersFor("PLAN_REVIEW", "COMPLETED", LEGACY_LANE, NO_CONTRACT, LANDED);
    expect(completed.map((entry) => entry.commandKind)).toEqual(["repository.publish"]);
    expect(completed[0]?.targetAggregateId).toBe(`publish:${GOAL_ID}`);
  });

  it("gates the close and the publish INDEPENDENTLY", () => {
    // The two facts answer different questions — is the product finished, and is anything
    // committed — so each ladder entry must turn on its own and neither may mask the other.
    const combos: readonly [GoalCloseReadiness["kind"], boolean, readonly string[]][] = [
      ["NOT_READY", false, []],
      ["NOT_READY", true, ["repository.publish"]],
      ["READY", false, ["goal.close"]],
      ["READY", true, ["goal.close", "repository.publish"]],
    ];
    for (const [readiness, landed, expected] of combos) {
      expect(
        offersFor("PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, () => readiness, () => landed)
          .map((entry) => entry.commandKind),
        `${readiness}/${String(landed)}`,
      ).toEqual(expected);
    }
  });

  it("consults the landing fact ONLY for a goal that could be offered a publish", () => {
    // The fact walks the goal's graph AND the review ledger, so asking for a goal outside the
    // publishable lifecycles is pure cost on every surface poll.
    const unpublishable: readonly (readonly [string, string])[] = [
      ["DRAFTING", "DRAFT"], ["PLAN_REVIEW", "DRAFT"], ["PLAN_REVIEW", "SOMETHING_ELSE"],
    ];
    for (const [runLifecycle, goalLifecycle] of unpublishable) {
      const spy = landingSpy(true);
      offersFor(runLifecycle, goalLifecycle, LEGACY_LANE, NO_CONTRACT, spy.fact);
      expect(spy.asked, `${runLifecycle}/${goalLifecycle}`).toEqual([]);
    }
    // ...and exactly once, naming the GOAL aggregate, for each lifecycle that could.
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]) {
      const spy = landingSpy(true);
      offersFor("PLAN_REVIEW", lifecycle, LEGACY_LANE, NO_CONTRACT, spy.fact);
      expect(spy.asked, lifecycle).toEqual([GOAL_ID]);
    }
  });

  it("never consults the landing fact on the compiler ladder", () => {
    const laneOf = (facts: CompilerLaneFacts): CompilerLanePort =>
      Object.freeze({ factsFor: () => facts });
    for (const lane of [
      laneOf({ approvedGateRef: null, lane: "COMPILER" }),
      laneOf({ approvedGateRef: GATE_REF, lane: "COMPILER" }),
      laneOf({ lane: "WITHHELD" }),
    ]) {
      const spy = landingSpy(true);
      offersFor("DRAFTING", "DRAFT", lane, NO_CONTRACT, spy.fact);
      expect(spy.asked).toEqual([]);
    }
  });

  it("offers nothing for a lifecycle outside the ladder", () => {
    expect(offersFor("PLAN_REVIEW", "SOMETHING_ELSE")).toEqual([]);
  });

  it("WITHHOLDS goal.close while the goal's Product Contract has an unverified criterion", () => {
    // Set-equality, never subset: the point of the arm is that goal.close is GONE, and a
    // `toContain("repository.publish")` would pass just as happily with it still there. The
    // landing fact is held TRUE here so the roster is non-empty and the arm keeps showing
    // which entry survived rather than watching the whole ladder go dark.
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      expect(offersFor("PLAN_REVIEW", lifecycle, LEGACY_LANE, () => "NOT_READY", LANDED)
        .map((entry) => entry.commandKind)).toEqual(["repository.publish"]);
    }
  });

  it("WITHHOLDS goal.close when the coverage read cannot be completed", () => {
    // Fail closed. An unreadable coverage is not evidence the product is built, and offering a
    // close the command would refuse is the exact disagreement this gate exists to prevent.
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      expect(offersFor("PLAN_REVIEW", lifecycle, LEGACY_LANE, () => "UNREADABLE", LANDED)
        .map((entry) => entry.commandKind)).toEqual(["repository.publish"]);
    }
  });

  it("offers goal.close once every approved criterion is verified", () => {
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      const offers = offersFor("PLAN_REVIEW", lifecycle, LEGACY_LANE, () => "READY", LANDED);
      expect(offers.map((entry) => entry.commandKind)).toEqual(["goal.close", "repository.publish"]);
      expect(offers[0]?.targetAggregateId).toBe(GOAL_ID);
      expect(offers[1]?.targetAggregateId).toBe(`publish:${GOAL_ID}`);
    }
  });

  it("keeps publishing offered on a COMPLETED goal whatever readiness says", () => {
    // The close is over; publishing what was landed is not gated on criteria — only on there
    // being something landed to publish, which the second loop pins.
    for (const kind of ["NO_CONTRACT", "NOT_READY", "READY", "UNREADABLE"] as const) {
      expect(offersFor("PLAN_REVIEW", "COMPLETED", LEGACY_LANE, () => kind, LANDED)
        .map((entry) => entry.commandKind), kind).toEqual(["repository.publish"]);
      expect(offersFor("PLAN_REVIEW", "COMPLETED", LEGACY_LANE, () => kind), kind).toEqual([]);
    }
  });

  it("consults readiness ONLY for the goal it could offer to close", () => {
    // The coverage read walks the ledger, so asking for a goal that could not be offered a
    // close is pure cost on every surface poll.
    for (const [runLifecycle, goalLifecycle] of [
      ["DRAFTING", "DRAFT"], ["PLAN_REVIEW", "DRAFT"], ["PLAN_REVIEW", "COMPLETED"],
      ["PLAN_REVIEW", "SOMETHING_ELSE"],
    ]) {
      const spy = readinessSpy("READY");
      offersFor(runLifecycle as string, goalLifecycle as string, LEGACY_LANE, spy.fact);
      expect(spy.asked, `${runLifecycle}/${goalLifecycle}`).toEqual([]);
    }
    // ...and exactly once, naming the GOAL aggregate, for one that could.
    const spy = readinessSpy("READY");
    offersFor("PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, spy.fact);
    expect(spy.asked).toEqual([GOAL_ID]);
  });

  it("never consults readiness on the compiler ladder, which has no goal to close yet", () => {
    const laneOf = (facts: CompilerLaneFacts): CompilerLanePort =>
      Object.freeze({ factsFor: () => facts });
    for (const lane of [
      laneOf({ approvedGateRef: null, lane: "COMPILER" }),
      laneOf({ approvedGateRef: GATE_REF, lane: "COMPILER" }),
      laneOf({ lane: "WITHHELD" }),
    ]) {
      const spy = readinessSpy("READY");
      offersFor("DRAFTING", "DRAFT", lane, spy.fact);
      expect(spy.asked).toEqual([]);
    }
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
