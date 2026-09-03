import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { PRODUCT_CONTRACT_COMPILER_SCHEMA_VERSION }
  from "../product-contract/product-contract-command-contracts.js";
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
  readonly compilerLane: CompilerLanePort;
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

function offersForGoal(input: PlanningOfferInput, goal: DurableGoal): readonly NextAllowedCommand[] {
  if (!planReviewable(input.ledger, goal.planningRunRef)) {
    // THE COMPILER LADDER. A source-bound goal is compiled, never hand-planned:
    // `plan.propose` is WITHHELD (the wrapper staffing the demo payload against
    // a real PRD is the race this closes) and the goal offers the writer until
    // Gate 1 approves a revision citing its source, the dispatcher after. Both
    // target the GOAL aggregate — the compiled chain drives the run itself. A
    // binding that fails integrity offers NOTHING (fail closed, never legacy).
    const facts = input.compilerLane.factsFor(goal.goalId);
    if (facts.lane === "WITHHELD") return [];
    if (facts.lane === "COMPILER") {
      return facts.approvedGateRef === null
        ? [offer(input, "product_contract.propose_revision", goal.goalId)]
        : [offer(input, "planning.submit_decomposition", goal.goalId)];
    }
    return [offer(input, "plan.propose", goal.planningRunRef)];
  }
  const lifecycle = goal.state["lifecycle"];
  if (lifecycle === "DRAFT") {
    // Both human approval wires ride the same reviewable run: `approval.decide`
    // carries the seeded approve-and-activate journey, `approval.decide_intent`
    // is the only kind the browser's plan-approval gate authorizes against.
    return [
      offer(input, "approval.decide", goal.planningRunRef),
      offer(input, "approval.decide_intent", goal.planningRunRef),
    ];
  }
  // Publishing is offered on every goal whose graph has been activated (its work may be
  // landed locally), targeting the goal's publish aggregate so the decision's own version
  // fence never moves the goal's.
  const publish = offer(input, "repository.publish", `publish:${goal.goalId}`);
  if (lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING") {
    return [offer(input, "goal.close", goal.goalId), publish];
  }
  if (lifecycle === "COMPLETED") return [publish];
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
    const run = record(record(stateOf(input.ledger, goal.planningRunRef))?.["state"]);
    const bound = run?.["goalRef"];
    if (typeof bound === "string"
      && (bound !== goal.goalId
        || !durableGoalMatches(input.ledger, bound, input.projectId, goal.planningRunRef))) continue;
    refs[goal.planningRunRef] = goal.goalId;
    for (const minted of offersForGoal(input, goal)) {
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
