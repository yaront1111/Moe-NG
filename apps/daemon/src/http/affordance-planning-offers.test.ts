/**
 * The per-goal planning offer ladder, pinned per lifecycle state — and pinned
 * against the wrapper's human-only skip list: every offered `approval.*` kind must
 * be one the agent wrapper refuses to staff, or the fleet would spawn an agent to
 * click Approve. The browser's plan-approval gate authorizes only against an
 * `approval.decide_intent` offer, so the DRAFT arm must mint one.
 *
 * COMPILER LADDER (source-bound goals): pre-Gate-1 the goal offers the Product
 * Contract writer and WITHHOLDS `plan.propose`; post-Gate-1 it offers design until
 * present/skipped, then decomposition; an unreadable binding offers NOTHING. The lane port
 * is stubbed per arm — `affordance-compiler-lane.test.ts` proves the production
 * detection over a real store.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject, NextAllowedCommand } from "@moe/contracts";

import type { CompilerLaneFacts, CompilerLanePort } from "./affordance-compiler-lane.js";
import { resolvePlanningOffers } from "./affordance-planning-offers.js";
import { commandFamilyFacts } from "../daemon-command-families.js";
import type { WiredCommandKind } from "../daemon-command-vocabulary.js";
import { designAggregateId } from "../design/design-contracts.js";
import type { PreviewReceiptState } from "../preview/preview-daemon-edge.js";
import { previewAggregateId } from "../preview/preview-receipt-contracts.js";
import { releaseDossierAggregateId } from "../release/release-dossier-contracts.js";
import type { PlanningOfferResolution } from "./affordance-planning-offers.js";
import type { DurableAggregate, DurableLedger } from "../bootstrap/bootstrap-ledger-vocabulary.js";
import type { GoalCloseReadiness } from "../goals/goal-close-readiness.js";
import { HUMAN_ONLY_STEPS } from "../orchestrator/agent-wrapper.js";

const PROJECT = "project-offers";
const GOAL_ID = "goal-offers-1";
const RUN_ID = "run-offers-1";
/** The REVISION run a REJECT mints. The goal's `planningRunRef` never moves to it. */
const SUCCESSOR_ID = "run-offers-1-successor";

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

/**
 * A goal with NO preview receipt is the default, because that is what every goal looks like
 * until a preview has actually run for it. The decision card is offered off the opposite fact,
 * so an arm that wants it must say so.
 */
const NO_PREVIEW = (): PreviewReceiptState | null => null;

/**
 * A goal whose run was REJECTED and whose CURRENT run is its successor. The goal's own
 * `planningRunRef` STAYS on the rejected run: it is immutable, and the whole point of the
 * `currentRun` fact is that consumers RESOLVE past it rather than rewrite it.
 *
 * `successorState` is `null` for the shape child 1's rejection actually leaves behind - the
 * successor is created by a SECONDARY decision leg, which `readDurableLedger` (keyed on
 * `decision.targetAggregateId`) cannot see, so the ladder reads no state and no version for it.
 */
function ledgerWithSuccessor(
  successorState: JsonObject | null,
  goalLifecycle = "DRAFT",
): DurableLedger {
  const aggregates = new Map<string, DurableAggregate>([
    [GOAL_ID, {
      currentVersion: 3,
      result: {
        goalId: GOAL_ID, lifecycle: goalLifecycle, planningRunRef: RUN_ID, projectId: PROJECT,
      },
    }],
    [RUN_ID, {
      currentVersion: 6,
      result: { state: { goalRef: GOAL_ID, lifecycle: "REJECTED" } },
    }],
  ]);
  if (successorState !== null) {
    aggregates.set(SUCCESSOR_ID, { currentVersion: 9, result: { state: successorState } });
  }
  return { aggregates, decisionCount: 0, kinds: new Set() };
}

function resolutionOver(
  ledger: DurableLedger, currentRun: (planningRunRef: string) => string,
  lane: CompilerLanePort = LEGACY_LANE,
): PlanningOfferResolution {
  let minted = 0;
  return resolvePlanningOffers({
    closeReadiness: NO_CONTRACT,
    compilerLane: lane,
    currentRun,
    designState: () => "PRESENT",
    landedCommit: NOTHING_LANDED,
    ledger,
    previewReceipt: NO_PREVIEW,
    mintId: () => `cmd-${(minted += 1)}`,
    projectId: PROJECT,
  });
}

function resolutionFor(
  runLifecycle: string, goalLifecycle: string, lane: CompilerLanePort = LEGACY_LANE,
  closeReadiness: (goalId: string) => GoalCloseReadiness["kind"] = NO_CONTRACT,
  landedCommit: (goalId: string) => boolean = NOTHING_LANDED,
  previewReceipt?: (goalId: string) => PreviewReceiptState | null,
  designState: (goalId: string) => "ABSENT" | "PRESENT" | "SKIPPED" = () => "PRESENT",
): PlanningOfferResolution {
  let minted = 0;
  return resolvePlanningOffers({
    closeReadiness,
    compilerLane: lane,
    // A goal whose run was never rejected IS its own current run: the identity fact keeps every
    // arm written before the resolver existed asserting exactly today's ladder.
    currentRun: (planningRunRef) => planningRunRef,
    designState,
    landedCommit,
    ledger: ledgerWith(runLifecycle, goalLifecycle),
    previewReceipt: previewReceipt ?? NO_PREVIEW,
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
      expect(offers.map((entry) => entry.commandKind))
        .toEqual(["goal.close", "repository.publish", "release.decide"]);
      expect(offers[0]?.targetAggregateId).toBe(GOAL_ID);
      // Publishing targets the goal's own publish aggregate, so its version fence never moves the goal's.
      expect(offers[1]?.targetAggregateId).toBe(`publish:${GOAL_ID}`);
    }
    const completed = offersFor("PLAN_REVIEW", "COMPLETED", LEGACY_LANE, NO_CONTRACT, LANDED);
    expect(completed.map((entry) => entry.commandKind))
      .toEqual(["repository.publish", "release.decide"]);
    expect(completed[0]?.targetAggregateId).toBe(`publish:${GOAL_ID}`);
  });

  it("gates the close and the publish INDEPENDENTLY", () => {
    // The two facts answer different questions — is the product finished, and is anything
    // committed — so each ladder entry must turn on its own and neither may mask the other.
    // `release.decide` rides the LANDING fact with publish, deliberately: both are decisions
    // about committed bytes, so they turn on together and neither is gated on readiness.
    const combos: readonly [GoalCloseReadiness["kind"], boolean, readonly string[]][] = [
      ["NOT_READY", false, []],
      ["NOT_READY", true, ["repository.publish", "release.decide"]],
      ["READY", false, ["goal.close"]],
      ["READY", true, ["goal.close", "repository.publish", "release.decide"]],
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
        .map((entry) => entry.commandKind)).toEqual(["repository.publish", "release.decide"]);
    }
  });

  it("WITHHOLDS goal.close when the coverage read cannot be completed", () => {
    // Fail closed. An unreadable coverage is not evidence the product is built, and offering a
    // close the command would refuse is the exact disagreement this gate exists to prevent.
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      expect(offersFor("PLAN_REVIEW", lifecycle, LEGACY_LANE, () => "UNREADABLE", LANDED)
        .map((entry) => entry.commandKind)).toEqual(["repository.publish", "release.decide"]);
    }
  });

  it("offers goal.close once every approved criterion is verified", () => {
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      const offers = offersFor("PLAN_REVIEW", lifecycle, LEGACY_LANE, () => "READY", LANDED);
      expect(offers.map((entry) => entry.commandKind))
        .toEqual(["goal.close", "repository.publish", "release.decide"]);
      expect(offers[0]?.targetAggregateId).toBe(GOAL_ID);
      expect(offers[1]?.targetAggregateId).toBe(`publish:${GOAL_ID}`);
    }
  });

  it("keeps publishing offered on a COMPLETED goal whatever readiness says", () => {
    // The close is over; publishing what was landed is not gated on criteria — only on there
    // being something landed to publish, which the second loop pins.
    for (const kind of ["NO_CONTRACT", "NOT_READY", "READY", "UNREADABLE"] as const) {
      expect(offersFor("PLAN_REVIEW", "COMPLETED", LEGACY_LANE, () => kind, LANDED)
        .map((entry) => entry.commandKind), kind)
        .toEqual(["repository.publish", "release.decide"]);
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

  function designResolution(approved: boolean, state: "ABSENT" | "PRESENT" | "SKIPPED") {
    return resolutionFor("DRAFTING", "DRAFT", laneOf({
      approvedGateRef: approved ? GATE_REF : null, lane: "COMPILER",
    }), NO_CONTRACT, NOTHING_LANDED, NO_PREVIEW, () => state);
  }

  /** `kind@targetAggregateId` per offer, IN ORDER: a Set of kinds cannot tell a design offer
   *  fenced on the design aggregate from one fenced on the goal, and the second is the
   *  non-dispatchable shape this ladder already shipped once. */
  const offered = (resolution: PlanningOfferResolution): readonly string[] =>
    resolution.offers.map((entry) => `${entry.commandKind}@${entry.targetAggregateId}`);

  it("design rung: approved=false offers only the revision writer, whatever the design says", () => {
    for (const state of ["ABSENT", "PRESENT", "SKIPPED"] as const) {
      expect(offered(designResolution(false, state)))
        .toEqual([`product_contract.propose_revision@${GOAL_ID}`]);
    }
  });

  it("design rung: ABSENT offers the design alone, and staffs it", () => {
    const resolution = designResolution(true, "ABSENT");
    expect(offered(resolution)).toEqual([`design.submit@${designAggregateId(GOAL_ID)}`]);
    expect(resolution.compilerSteps).toEqual([
      { aggregateId: designAggregateId(GOAL_ID), kind: "design.submit" },
    ]);
  });

  // THE ARM THIS ROW EXISTS FOR, and both halves belong in ONE arm: the resubmit is OFFERED to
  // the operator and NOT staffed. Split across two arms, one can rot green while the other
  // passes — an offered-and-staffed resubmit is an infinite design loop, and an
  // unoffered-and-unstaffed one is the defect this row fixes.
  it("design rung: PRESENT offers the resubmit AND the decomposition, but staffs only the latter", () => {
    const resolution = designResolution(true, "PRESENT");
    expect(offered(resolution)).toEqual([
      `design.submit@${designAggregateId(GOAL_ID)}`,
      `planning.submit_decomposition@${GOAL_ID}`,
    ]);
    expect(resolution.compilerSteps).toEqual([
      { aggregateId: GOAL_ID, kind: "planning.submit_decomposition" },
    ]);
  });

  it("design rung: SKIPPED is never offered a design again", () => {
    const resolution = designResolution(true, "SKIPPED");
    expect(offered(resolution)).toEqual([`planning.submit_decomposition@${GOAL_ID}`]);
    expect(resolution.compilerSteps).toEqual([
      { aggregateId: GOAL_ID, kind: "planning.submit_decomposition" },
    ]);
  });

  it("fences the design offer on the design aggregate, not the advanced goal", () => {
    const resolution = designResolution(true, "ABSENT");
    expect(resolution.offers).toHaveLength(1);
    expect(resolution.offers[0]).toMatchObject({
      commandKind: "design.submit", expectedVersion: 0,
      targetAggregateId: designAggregateId(GOAL_ID),
    });
    expect(resolution.compilerSteps).toEqual([
      { aggregateId: designAggregateId(GOAL_ID), kind: "design.submit" },
    ]);
  });

  it("uses each offered kind's production family schema, not its staffing lane", () => {
    const resolutions = [
      designResolution(false, "ABSENT"), designResolution(true, "ABSENT"),
      designResolution(true, "PRESENT"), resolutionFor("DRAFTING", "DRAFT"),
      resolutionFor("PLAN_REVIEW", "DRAFT"),
      resolutionFor("PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT,
        () => true, () => "STARTED"),
    ];
    const offers = resolutions.flatMap((resolution) => resolution.offers);
    expect(offers.length).toBeGreaterThan(0);
    expect(new Set(offers.map((entry) => entry.commandKind))).toEqual(new Set([
      "approval.decide", "approval.decide_intent", "design.submit", "goal.close", "plan.propose",
      "planning.submit_decomposition", "product_contract.propose_revision",
      "preview.decide", "release.decide", "repository.publish",
    ]));
    for (const entry of offers) {
      expect(entry.inputSchemaVersion, entry.commandKind)
        .toBe(commandFamilyFacts(entry.commandKind as WiredCommandKind).schemaVersion);
    }
  });

  it("reads the design fact once only for an approved, not yet reviewable compiler goal", () => {
    for (const [run, facts, expected] of [
      ["DRAFTING", { lane: "LEGACY" }, []],
      ["DRAFTING", { lane: "WITHHELD" }, []],
      ["DRAFTING", { lane: "COMPILER", approvedGateRef: null }, []],
      ["PLAN_REVIEW", { lane: "COMPILER", approvedGateRef: GATE_REF }, []],
      ["DRAFTING", { lane: "COMPILER", approvedGateRef: GATE_REF }, [GOAL_ID]],
    ] as const) {
      const asked: string[] = [];
      resolutionFor(run, "DRAFT", laneOf(facts), NO_CONTRACT, NOTHING_LANDED, NO_PREVIEW,
        (goalId) => { asked.push(goalId); return "ABSENT"; });
      expect(asked, run).toEqual(expected);
    }
  });

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

  it("offers NOTHING while a citing revision awaits Gate 1: the human's turn, no seat", () => {
    const resolution = resolutionFor("DRAFTING", "DRAFT", laneOf({
      approvedGateRef: null, lane: "COMPILER",
      pendingRevision: { contractId: "contract-widget", revisionId: "revision-0001" },
    }));
    expect(resolution.offers).toEqual([]);
    expect(resolution.compilerSteps).toEqual([]);
    // The explicit "none pending" reads exactly like the absent field.
    expect(offersFor("DRAFTING", "DRAFT",
      laneOf({ approvedGateRef: null, lane: "COMPILER", pendingRevision: null }))
      .map((entry) => entry.commandKind)).toEqual(["product_contract.propose_revision"]);
  });

  it("offers the dispatcher AND the resubmit once Gate 1 is approved and a design exists", () => {
    const resolution = resolutionFor("DRAFTING", "DRAFT",
      laneOf({ approvedGateRef: GATE_REF, lane: "COMPILER" }));
    expect(offered(resolution)).toEqual([
      `design.submit@${designAggregateId(GOAL_ID)}`,
      `planning.submit_decomposition@${GOAL_ID}`,
    ]);
    // Only the decomposition is staffed; the resubmit waits for an operator.
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

  /**
   * task-5f883e4e: the must-be-human-only direction, spelled as an EXPLICIT ROSTER.
   *
   * The arm above at `every offered approval kind is one the wrapper refuses to staff` reads
   * its subjects from `offers.filter(kind => kind.startsWith("approval."))`, so it can only
   * ever see `approval.*` members. Every non-approval kind in the set — `goal.close`,
   * `repository.publish`, the environment pair, `preview.decide` — satisfies it VACUOUSLY,
   * because the filter never yields them. That makes this file look like bidirectional
   * coverage while one direction is blind to most of what it guards.
   *
   * The kinds are named here rather than derived from the set: derivation would make the
   * assertion `set.has(x) for x in set`, which is a tautology. This roster is the independent
   * side, so a deletion from `HUMAN_ONLY_STEPS` reddens.
   *
   * This is MEMBERSHIP only. The behavioural proof — that `runOnce()` actually skips the kind
   * when the surface offers it READY — lives in `agent-wrapper.test.ts`, against the one
   * production consumer (`agent-wrapper.ts:353`). Both are wanted: a test that read
   * `HUMAN_ONLY_STEPS.has()` alone would restate the constant instead of proving the wrapper
   * obeys it, and the wrapper arm alone would not say WHICH kinds the roster is required
   * to carry.
   */
  it("names every non-approval kind that must be human-only, which the filtered arm cannot see", () => {
    for (const kind of [
      "environment.set_variable", "environment.unset_variable",
      "goal.close", "goal.create", "goal.create_with_source",
      // BOTH halves of the preview act. ASKING for one spawns a dev server on the daemon's host
      // and drives a browser at it, so a seat able to staff it would be running the product on
      // the operator's machine on its own say-so. The BIDIRECTIONAL half of this fence -- that
      // every SERVED operator kind is also fenced, enumerated from the dispatch seam's handled
      // kinds rather than from a roster constant -- lives in
      // `preview/preview-start-command.test.ts`, which composes a real registry; this file is
      // store-free and can only state the explicit roster.
      "preview.decide", "preview.start",
      "repository.publish",
    ]) {
      expect(HUMAN_ONLY_STEPS.has(kind), `${kind} missing from HUMAN_ONLY_STEPS`).toBe(true);
    }
  });
});

/**
 * AFTER A REJECT THE LADDER FOLLOWS THE SUCCESSOR, not the goal's immutable `planningRunRef`.
 *
 * The rejected run is not PLAN_REVIEW, so a ladder still keyed on the immutable ref would offer
 * the compiler for a goal whose current run is already reviewable, and would keep minting
 * `approval.decide_intent` against the run the operator just rejected — the exact stale card the
 * browser would then dispatch. Every arm here is set-equality on `commandKind@target`, because a
 * subset assertion cannot see an offer that should have disappeared.
 */
describe("the offer ladder resolves the goal's CURRENT run", () => {
  const roster = (resolution: PlanningOfferResolution): string[] => resolution.offers
    .map((entry) => `${entry.commandKind}@${entry.targetAggregateId}`).sort();
  const compilerLane = (facts: CompilerLaneFacts): CompilerLanePort =>
    Object.freeze({ factsFor: (): CompilerLaneFacts => facts });

  it("targets the approval offers at the SUCCESSOR once it is reviewable", () => {
    const resolution = resolutionOver(
      ledgerWithSuccessor({ goalRef: GOAL_ID, lifecycle: "PLAN_REVIEW" }),
      () => SUCCESSOR_ID,
    );
    expect(roster(resolution)).toEqual([
      `approval.decide@${SUCCESSOR_ID}`, `approval.decide_intent@${SUCCESSOR_ID}`,
    ]);
    // The version an offer fences on is the SUCCESSOR's, not the rejected run's (6) and not the
    // goal's (3): a card carrying the wrong run's version would refuse on dispatch.
    for (const entry of resolution.offers) expect(entry.expectedVersion).toBe(9);
    // EXACT map, not `toContain`: the rejected run's key must be GONE, or the surface's
    // authority map would still bind a run nobody may act on to this goal.
    expect(resolution.planningGoalRefs).toEqual({ [SUCCESSOR_ID]: GOAL_ID });
  });

  it("offers the compiler for the goal while the successor is created but not yet proposed", () => {
    // The shape child 1 actually leaves: the successor rides a secondary decision leg, so the
    // durable ledger holds NO record for it at all. Not reviewable -> the compiler ladder.
    const resolution = resolutionOver(
      ledgerWithSuccessor(null), () => SUCCESSOR_ID,
      compilerLane({ approvedGateRef: GATE_REF, lane: "COMPILER" }),
    );
    // `resolutionOver` leaves designState at its PRESENT default, so the resubmit rides along
    // — and `roster` sorts, hence design.submit first.
    expect(roster(resolution)).toEqual([
      `design.submit@${designAggregateId(GOAL_ID)}`,
      `planning.submit_decomposition@${GOAL_ID}`,
    ]);
    expect(resolution.compilerSteps).toEqual([
      { aggregateId: GOAL_ID, kind: "planning.submit_decomposition" },
    ]);
    // The binding still names the goal, so the wrapper can staff the step against the run the
    // dispatcher will actually compile.
    expect(resolution.planningGoalRefs).toEqual({ [SUCCESSOR_ID]: GOAL_ID });
  });

  it("offers NOTHING when the current run is bound to a DIFFERENT goal", () => {
    // The run->goal binding check has to move with the resolution: applying it to the immutable
    // ref while OFFERING against the successor would mint cards for a run this goal does not own.
    const resolution = resolutionOver(
      ledgerWithSuccessor({ goalRef: "goal-somebody-else", lifecycle: "PLAN_REVIEW" }),
      () => SUCCESSOR_ID,
    );
    expect(roster(resolution)).toEqual([]);
    expect(resolution.planningGoalRefs).toEqual({});
    expect(resolution.compilerSteps).toEqual([]);
  });

  it("still binds the IMMUTABLE ref when no rejection has moved the run", () => {
    // The identity case, asserted as a case rather than assumed: `refs` keys on whatever
    // `currentRun` answers, so a goal that was never rejected keys on its own ref.
    const resolution = resolutionFor("PLAN_REVIEW", "DRAFT");
    expect(roster(resolution)).toEqual([
      `approval.decide@${RUN_ID}`, `approval.decide_intent@${RUN_ID}`,
    ]);
    expect(resolution.planningGoalRefs).toEqual({ [RUN_ID]: GOAL_ID });
  });
});

/**
 * THE PRODUCT-PREVIEW DECISION CARD (task-dd86f35e, DoD 4).
 *
 * A goal is offered `preview.decide` only when a preview really RAN for it — a STARTED receipt.
 * No receipt and a REFUSED receipt both WITHHOLD, fail closed: an operator handed a Decide card
 * for a preview that never became answerable would be judging a product that is not there, the
 * same defect the PUBLISH card had before `landedCommit` gated it (seen live on UnAI 2026-09-04).
 *
 * EVERY ARM IS SET-EQUALITY on `commandKind@target`, never a subset, because the two withholding
 * arms are exactly the ones a subset assertion cannot see: an offer that should have DISAPPEARED
 * still satisfies `toContain` on everything else.
 *
 * THE RECEIPT STATE IS A FACT HERE, as `landedCommit` and `closeReadiness` are, and the ladder
 * stays pure. Its PRODUCTION derivation — `createPreviewReceiptReader` over receipts written by
 * `recordPreviewReceipt`, the runner's own writer — is proven over a REAL store in
 * `preview/preview-daemon-edge.test.ts`, the same split `affordance-compiler-lane.test.ts` makes
 * for the compiler lane.
 */
describe("the preview decision card", () => {
  const PREVIEW_TARGET = previewAggregateId(GOAL_ID);
  /** Every arm here holds LANDED, so the release rung fires alongside publish in each roster. */
  const RELEASE_TARGET = releaseDossierAggregateId(GOAL_ID);
  const roster = (resolution: PlanningOfferResolution): string[] => resolution.offers
    .map((entry) => `${entry.commandKind}@${entry.targetAggregateId}`).sort();
  const started = (): PreviewReceiptState | null => "STARTED";
  const refused = (): PreviewReceiptState | null => "REFUSED";

  it("offers preview.decide at the goal's preview aggregate once a preview has STARTED", () => {
    const resolution = resolutionFor(
      "PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT, LANDED, started,
    );
    expect(roster(resolution)).toEqual([
      `goal.close@${GOAL_ID}`,
      `preview.decide@${PREVIEW_TARGET}`,
      `release.decide@${RELEASE_TARGET}`,
      `repository.publish@publish:${GOAL_ID}`,
    ]);
  });

  it("WITHHOLDS it when no preview has ever run for the goal", () => {
    const resolution = resolutionFor(
      "PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT, LANDED, NO_PREVIEW,
    );
    expect(roster(resolution)).toEqual([
      `goal.close@${GOAL_ID}`, `release.decide@${RELEASE_TARGET}`,
      `repository.publish@publish:${GOAL_ID}`,
    ]);
  });

  it("WITHHOLDS it when the preview was REFUSED, which is a record and not an absence", () => {
    const resolution = resolutionFor(
      "PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT, LANDED, refused,
    );
    expect(roster(resolution)).toEqual([
      `goal.close@${GOAL_ID}`, `release.decide@${RELEASE_TARGET}`,
      `repository.publish@publish:${GOAL_ID}`,
    ]);
  });

  it("offers it on a CLOSING and a COMPLETED goal, and never on a DRAFT one", () => {
    for (const lifecycle of ["CLOSING", "COMPLETED"]) {
      const resolution = resolutionFor(
        "PLAN_REVIEW", lifecycle, LEGACY_LANE, NO_CONTRACT, LANDED, started,
      );
      expect(roster(resolution), lifecycle).toContain(`preview.decide@${PREVIEW_TARGET}`);
    }
    // A DRAFT goal is still being approved: there is nothing built, so there is nothing to
    // preview, and the ladder must not reach the receipt fact at all (asserted below).
    expect(roster(resolutionFor(
      "PLAN_REVIEW", "DRAFT", LEGACY_LANE, NO_CONTRACT, LANDED, started,
    ))).toEqual([`approval.decide@${RUN_ID}`, `approval.decide_intent@${RUN_ID}`]);
  });

  it("asks for the receipt state LAZILY, only for a goal that could be offered the card", () => {
    // Same discipline `closeReadiness` and `landedCommit` are held to: the fact is a ledger read
    // per goal, so a surface poll over many goals must not pay it for goals that cannot be
    // offered a decision (the 2026-09-05 affordances hot-path incident).
    const asked: string[] = [];
    const spy = (goalId: string): PreviewReceiptState | null => {
      asked.push(goalId);
      return "STARTED";
    };
    resolutionFor("PLAN_REVIEW", "DRAFT", LEGACY_LANE, NO_CONTRACT, LANDED, spy);
    expect(asked).toEqual([]);
    resolutionFor("DRAFTING", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT, LANDED, spy);
    expect(asked).toEqual([]);
    resolutionFor("PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT, LANDED, spy);
    expect(asked).toEqual([GOAL_ID]);
  });

  it("fences the card on the PREVIEW aggregate's version, never the goal's", () => {
    // The goal aggregate sits at version 3 in this fixture. A decide committed against the goal
    // would overwrite the goal's own durable result in `readDurableLedger` (last write wins per
    // targetAggregateId) and the goal would vanish from this very surface, so the card must
    // carry the preview aggregate's version — 0 here, because no receipt decision is in the
    // fixture ledger.
    const resolution = resolutionFor(
      "PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT, LANDED, started,
    );
    const card = resolution.offers.find((entry) => entry.commandKind === "preview.decide");
    expect(card?.targetAggregateId).toBe(PREVIEW_TARGET);
    expect(card?.expectedVersion).toBe(0);
    expect(resolution.offers.find((entry) => entry.commandKind === "goal.close")?.expectedVersion)
      .toBe(3);
  });
});

/**
 * THE RELEASE DECISION CARD (task-21209552, DoD 1-4).
 *
 * `release.decide` is offered off exactly one fact — a landed commit — and off NOTHING ELSE.
 * The withholding horn is deliberate and written at the offer site: a goal with no landed
 * commit has no sha, and `release-decide-service.ts:182` keys the release receipt by it, so
 * there is no release object to decide. PAST that point the surface withholds nothing, because
 * the service's own refusals NAME what is missing (`unverified evidence for: ${criteria}` at
 * :160-161, RELEASE_REMOTE_MISSING at :146, the absent dossier at :169) and an absent card
 * would replace a precise diagnostic with silence. That is the OPPOSITE of `goal.close`, which
 * withholds because its refusal says nothing the operator could act on.
 *
 * EVERY ARM IS SET-EQUALITY on `commandKind@target`. A `not.toContain("release.decide")` would
 * pass just as happily against a surface that emitted a DIFFERENTLY-NAMED release offer, which
 * is exactly the regression a subset assertion cannot see.
 *
 * THE TARGET IS COMPUTED BY CALLING `releaseDossierAggregateId`, never spelled. The command
 * fences on that function's output (`release-decide-command.ts:47`, RELEASE_TARGET_INVALID), so
 * a test that writes `release:goal-offers-1` on both sides agrees with a drifted contract.
 */
describe("the release decision card", () => {
  const RELEASE_TARGET = releaseDossierAggregateId(GOAL_ID);
  const roster = (resolution: PlanningOfferResolution): string[] => resolution.offers
    .map((entry) => `${entry.commandKind}@${entry.targetAggregateId}`).sort();

  it("offers release.decide at the goal's RELEASE aggregate once a commit has landed", () => {
    const resolution = resolutionFor(
      "PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT, LANDED,
    );
    // BY VALUE, and the value is DERIVED: the expected target is the contract function's own
    // output, so this arm reds if the ladder and the command ever disagree about the key.
    const card = resolution.offers.find((entry) => entry.commandKind === "release.decide");
    expect(card?.targetAggregateId).toBe(RELEASE_TARGET);
    expect(card?.targetAggregateId).not.toBe(GOAL_ID);
    // Both directions, as a SET: what appeared, and that nothing else moved.
    expect(roster(resolution)).toEqual([
      `goal.close@${GOAL_ID}`,
      `release.decide@${RELEASE_TARGET}`,
      `repository.publish@publish:${GOAL_ID}`,
    ]);
    // The release verdict is an OPERATOR affordance. `release.decide` is in neither
    // COMPILER_OFFER_KINDS nor COMPILER_SCHEMA_KINDS, so it must never become staffable work:
    // a compilerStep here would have the wrapper spawn an agent to decide the release.
    expect(resolution.compilerSteps).toEqual([]);
  });

  it("WITHHOLDS it, with publish, while nothing is landed for the goal", () => {
    // ONE fact, TWO kinds. Asserting both together is what makes a regression that ungates
    // only one of them visible — each alone would still satisfy a per-kind absence check.
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING"]) {
      expect(roster(resolutionFor("PLAN_REVIEW", lifecycle)), lifecycle)
        .toEqual([`goal.close@${GOAL_ID}`]);
    }
    expect(roster(resolutionFor("PLAN_REVIEW", "COMPLETED"))).toEqual([]);
  });

  it("offers it on CLOSING and COMPLETED goals, and never before anything is built", () => {
    for (const lifecycle of ["CLOSING", "COMPLETED"]) {
      expect(roster(resolutionFor(
        "PLAN_REVIEW", lifecycle, LEGACY_LANE, NO_CONTRACT, LANDED,
      )), lifecycle).toContain(`release.decide@${RELEASE_TARGET}`);
    }
    // A DRAFT goal has nothing built, so the landing fact is never even asked and no release
    // card can appear however the fact would have answered.
    expect(roster(resolutionFor("PLAN_REVIEW", "DRAFT", LEGACY_LANE, NO_CONTRACT, LANDED)))
      .toEqual([`approval.decide@${RUN_ID}`, `approval.decide_intent@${RUN_ID}`]);
  });

  it("is NOT gated on close readiness: an unfinished product may still be released", () => {
    // The horn, asserted rather than described. An operator whose evidence is incomplete must
    // still reach the command, because only its refusal names the unverified criterion ids.
    for (const kind of ["NOT_READY", "UNREADABLE"] as const) {
      expect(roster(resolutionFor(
        "PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, () => kind, LANDED,
      )), kind).toEqual([
        `release.decide@${RELEASE_TARGET}`, `repository.publish@publish:${GOAL_ID}`,
      ]);
    }
  });

  it("fences the card on the RELEASE aggregate's version, never the goal's", () => {
    // The goal sits at version 3 in this fixture. A decide committed against the goal would
    // overwrite the goal's own durable result (`readDurableLedger` keeps the last committed
    // result per targetAggregateId) and the goal would vanish from this surface entirely, so
    // the card must carry the release aggregate's version — 0 here, no dossier in the fixture.
    const resolution = resolutionFor(
      "PLAN_REVIEW", "EXECUTION_ENABLED", LEGACY_LANE, NO_CONTRACT, LANDED,
    );
    const card = resolution.offers.find((entry) => entry.commandKind === "release.decide");
    expect(card?.expectedVersion).toBe(0);
    expect(resolution.offers.find((entry) => entry.commandKind === "goal.close")?.expectedVersion)
      .toBe(3);
  });

  it("asks the landing fact ONCE per goal, for publish and release together", () => {
    // Both rungs read the same fact, and the fact walks the goal's graph AND the review ledger.
    // A second call would double that walk on every surface poll for every built goal — the
    // 2026-09-05 affordances hot-path incident, re-entered through a rung that merely looked
    // like an independent gate.
    for (const lifecycle of ["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]) {
      const spy = landingSpy(true);
      offersFor("PLAN_REVIEW", lifecycle, LEGACY_LANE, NO_CONTRACT, spy.fact);
      expect(spy.asked, lifecycle).toEqual([GOAL_ID]);
    }
  });
});
