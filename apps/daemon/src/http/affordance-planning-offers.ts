import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION }
  from "../product-contract/product-contract-command-contracts.js";
import type { GoalCloseReadiness } from "../goals/goal-close-readiness.js";
import type { CompilerLanePort } from "./affordance-compiler-lane.js";

const REVIEWABLE_LIFECYCLE = "PLAN_REVIEW";

const COMPILER_OFFER_KINDS = Object.freeze([
  "planning.submit_decomposition", "product_contract.propose_revision",
] as const);
type CompilerOfferKind = (typeof COMPILER_OFFER_KINDS)[number];

type JsonRecord = Readonly<Record<string, unknown>>;

interface DurableGoal {
  readonly goalId: string;
  readonly planningRunRef: string;
  readonly state: JsonRecord;
}

export interface PlanningOfferResolution {
  /** Compiler-lane work the WRAPPER staffs: one entry per offered compiler kind,
   *  targeted at the goal aggregate, surfaced by affordance-read as READY steps. */
  readonly compilerSteps: readonly {
    readonly aggregateId: string; readonly kind: CompilerOfferKind;
  }[];
  readonly offers: readonly NextAllowedCommand[];
  readonly planningGoalRefs: Readonly<Record<string, string>>;
}

export interface PlanningOfferInput {
  /**
   * Whether this goal's approved Product Contract has any criterion the coverage read does not
   * call VERIFIED. A FACT rather than a store handle, and LAZY: the ladder stays pure, the
   * coverage walk happens only for a goal that could actually be offered a close, and a later
   * gate (landing, say) adds its own fact here rather than reaching for the store.
   */
  readonly closeReadiness: (goalId: string) => GoalCloseReadiness["kind"];
  readonly compilerLane: CompilerLanePort;
  /**
   * The goal's CURRENT planning run, resolved from its IMMUTABLE `planningRunRef`.
   *
   * A goal carries one `planningRunRef` for life, so after a REJECT mints a REVISION successor
   * every read that starts at the goal would otherwise land on the run the operator just
   * rejected: the ladder would keep offering `approval.decide_intent` against it and would never
   * offer the compiler the successor needs. A FACT, not a store handle, for the same reason
   * `closeReadiness` and `landedCommit` are - the ladder stays pure and the chain walk is the
   * composition root's to supply.
   */
  readonly currentRun: (planningRunRef: string) => string;
  /**
   * Whether any node of this goal has been landed as a commit. A FACT and LAZY for the same
   * reasons as `closeReadiness` above: the ladder stays pure, and the goal's graph walk plus
   * the review-ledger read happen only for a goal that could actually be offered a publish.
   */
  readonly landedCommit: (goalId: string) => boolean;
  readonly ledger: DurableLedger;
  readonly mintId: (kind: string) => string;
  readonly projectId: string;
}

export function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function durableGoalMatches(
  ledger: DurableLedger,
  aggregateId: string,
  projectId: string,
  runId: string,
): boolean {
  const goal = record(stateOf(ledger, aggregateId));
  return goal?.["goalId"] === aggregateId
    && goal["planningRunRef"] === runId
    && goal["projectId"] === projectId;
}

export function planningGoalRef(
  ledger: DurableLedger,
  projectId: string,
  runId: string,
): string | null {
  const run = record(record(stateOf(ledger, runId))?.["state"]);
  const bound = run?.["goalRef"];
  if (typeof bound === "string") {
    return durableGoalMatches(ledger, bound, projectId, runId) ? bound : null;
  }
  const candidates: string[] = [];
  for (const [aggregateId] of ledger.aggregates) {
    if (durableGoalMatches(ledger, aggregateId, projectId, runId)) candidates.push(aggregateId);
  }
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function planReviewable(ledger: DurableLedger, runId: string): boolean {
  const run = record(record(stateOf(ledger, runId))?.["state"]);
  return run?.["lifecycle"] === REVIEWABLE_LIFECYCLE;
}

function durableGoals(ledger: DurableLedger, projectId: string): readonly DurableGoal[] {
  const goals: DurableGoal[] = [];
  for (const [aggregateId] of ledger.aggregates) {
    const state = record(stateOf(ledger, aggregateId));
    if (state?.["goalId"] !== aggregateId || state["projectId"] !== projectId) continue;
    const planningRunRef = state["planningRunRef"];
    if (typeof planningRunRef !== "string") continue;
    goals.push({ goalId: aggregateId, planningRunRef, state });
  }
  return goals.sort((left, right) => left.goalId.localeCompare(right.goalId));
}

function offer(
  input: PlanningOfferInput,
  kind: CompilerOfferKind
    | "approval.decide" | "approval.decide_intent" | "goal.close" | "plan.propose"
    | "repository.publish",
  aggregateId: string,
): NextAllowedCommand {
  return Object.freeze({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: input.mintId(kind),
    commandKind: kind,
    expectedVersion: versionOf(input.ledger, aggregateId),
    inputSchemaVersion: COMPILER_OFFER_KINDS.some((compiler) => compiler === kind)
      ? PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION
      : BOOTSTRAP_SCHEMA_VERSION,
    targetAggregateId: aggregateId,
  });
}

/** `runId` is the goal's CURRENT run, resolved once by the caller and used at every run site. */
function offersForGoal(
  input: PlanningOfferInput, goal: DurableGoal, runId: string,
): readonly NextAllowedCommand[] {
  if (!planReviewable(input.ledger, runId)) {
    // THE COMPILER LADDER. A source-bound goal is compiled, never hand-planned:
    // `plan.propose` is WITHHELD (the wrapper staffing the demo payload against
    // a real PRD is the race this closes) and the goal offers the writer until
    // Gate 1 approves a revision citing its source, the dispatcher after. Both
    // target the GOAL aggregate — the compiled chain drives the run itself. A
    // binding that fails integrity offers NOTHING (fail closed, never legacy).
    const facts = input.compilerLane.factsFor(goal.goalId);
    if (facts.lane === "WITHHELD") return [];
    if (facts.lane === "COMPILER") {
      if (facts.approvedGateRef !== null) {
        return [offer(input, "planning.submit_decomposition", goal.goalId)];
      }
      // A revision awaiting Gate 1 is the human's turn: nothing to staff until they decide.
      return (facts.pendingRevision ?? null) === null
        ? [offer(input, "product_contract.propose_revision", goal.goalId)]
        : [];
    }
    return [offer(input, "plan.propose", runId)];
  }
  const lifecycle = goal.state["lifecycle"];
  if (lifecycle === "DRAFT") {
    // Both human approval wires ride the same reviewable run: `approval.decide`
    // carries the seeded approve-and-activate journey, `approval.decide_intent`
    // is the only kind the browser's plan-approval gate authorizes against.
    return [
      offer(input, "approval.decide", runId),
      offer(input, "approval.decide_intent", runId),
    ];
  }
  // Publishing is offered only once at least one node of the goal is landed as a commit — a
  // goal with nothing to push gets no PUBLISH card. The surface used to mint one for every
  // activated goal, so an operator was handed a Publish control directly above the words "No
  // node of this goal is landed as a commit yet" (seen live on UnAI 2026-09-04). Targets the
  // goal's publish aggregate so the decision's own version fence never moves the goal's; read
  // here rather than above so the landing walk is skipped for a goal that could not publish.
  const publish = lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING"
    || lifecycle === "COMPLETED"
    ? (input.landedCommit(goal.goalId)
      ? [offer(input, "repository.publish", `publish:${goal.goalId}`)]
      : [])
    : [];
  if (lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING") {
    // A goal is offered to close only when its product is DONE: every approved criterion of its
    // Product Contract is verified. A goal with no contract — the seed/Foundation journey — is
    // offered exactly as it always was, because this gate has nothing to say about it. An
    // unreadable coverage WITHHOLDS (fail closed): it is not evidence the work is finished, and
    // the surface must never offer a close the command would refuse. Read here rather than
    // above so the coverage walk is skipped for every goal that could not be offered one.
    const readiness = input.closeReadiness(goal.goalId);
    return readiness === "NO_CONTRACT" || readiness === "READY"
      ? [offer(input, "goal.close", goal.goalId), ...publish]
      : [...publish];
  }
  if (lifecycle === "COMPLETED") return [...publish];
  return [];
}

export function resolvePlanningOffers(input: PlanningOfferInput): PlanningOfferResolution {
  const compilerSteps: { aggregateId: string; kind: CompilerOfferKind }[] = [];
  const offers: NextAllowedCommand[] = [];
  const refs: Record<string, string> = {};
  const goals = durableGoals(input.ledger, input.projectId);
  const runCounts = new Map<string, number>();
  for (const goal of goals) {
    runCounts.set(goal.planningRunRef, (runCounts.get(goal.planningRunRef) ?? 0) + 1);
  }
  for (const goal of goals) {
    if (runCounts.get(goal.planningRunRef) !== 1) continue;
    // ONE resolution per goal per surface read, used by the ladder AND by the binding below,
    // so the run an offer targets and the run the authority map binds cannot disagree.
    const current = input.currentRun(goal.planningRunRef);
    const run = record(record(stateOf(input.ledger, current))?.["state"]);
    const bound = run?.["goalRef"];
    // The RUN side of the binding moves to the current run; the GOAL side keeps the immutable
    // ref, because that is the field the goal's own durable record carries and it never moves.
    if (typeof bound === "string"
      && (bound !== goal.goalId
        || !durableGoalMatches(input.ledger, bound, input.projectId, goal.planningRunRef))) continue;
    refs[current] = goal.goalId;
    for (const minted of offersForGoal(input, goal, current)) {
      offers.push(minted);
      const kind = COMPILER_OFFER_KINDS.find((compiler) => compiler === minted.commandKind);
      if (kind !== undefined) {
        compilerSteps.push(Object.freeze({ aggregateId: minted.targetAggregateId, kind }));
      }
    }
  }
  return Object.freeze({
    compilerSteps: Object.freeze(compilerSteps),
    offers: Object.freeze(offers),
    planningGoalRefs: Object.freeze(refs),
  });
}
