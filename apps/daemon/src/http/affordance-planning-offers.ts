import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";

const REVIEWABLE_LIFECYCLE = "PLAN_REVIEW";

type JsonRecord = Readonly<Record<string, unknown>>;

interface DurableGoal {
  readonly goalId: string;
  readonly planningRunRef: string;
  readonly state: JsonRecord;
}

export interface PlanningOfferResolution {
  readonly offers: readonly NextAllowedCommand[];
  readonly planningGoalRefs: Readonly<Record<string, string>>;
}

export interface PlanningOfferInput {
  readonly ledger: DurableLedger;
  readonly mintId: () => string;
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
  kind: "approval.decide" | "goal.close" | "plan.propose",
  aggregateId: string,
): NextAllowedCommand {
  return Object.freeze({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: input.mintId(),
    commandKind: kind,
    expectedVersion: versionOf(input.ledger, aggregateId),
    inputSchemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    targetAggregateId: aggregateId,
  });
}

function offerForGoal(input: PlanningOfferInput, goal: DurableGoal): NextAllowedCommand | null {
  if (!planReviewable(input.ledger, goal.planningRunRef)) {
    return offer(input, "plan.propose", goal.planningRunRef);
  }
  const lifecycle = goal.state["lifecycle"];
  if (lifecycle === "DRAFT") return offer(input, "approval.decide", goal.planningRunRef);
  if (lifecycle === "EXECUTION_ENABLED" || lifecycle === "CLOSING") {
    return offer(input, "goal.close", goal.goalId);
  }
  return null;
}

export function resolvePlanningOffers(input: PlanningOfferInput): PlanningOfferResolution {
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
    const next = offerForGoal(input, goal);
    if (next !== null) offers.push(next);
  }
  return Object.freeze({
    offers: Object.freeze(offers),
    planningGoalRefs: Object.freeze(refs),
  });
}
