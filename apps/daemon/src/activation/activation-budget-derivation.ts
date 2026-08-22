/**
 * What DURABLE authority says an activation may reserve.
 *
 * This module COMPOSES and decides nothing. The account comes from the goal's own
 * `GoalCreated`; the revision and epoch from the current ACTIVE graph; the amounts from the
 * durable node definition carried in that graph's own content; the gate WITNESS FIELD from the
 * node's stated policy. No caller supplies a view, a balance, a coverage claim or a
 * reservation — task rail 1 lives in the shape of `DeriveActivationBudgetInput`, because a key
 * the signature cannot carry is a key no call site can forward.
 *
 * TWO DOORS, ONE FUNCTION (ruling comment-e62d1751 on task-e194c5f6). `runEffectActivateCommand`
 * has two production callers:
 *   DOOR 1 `foundation.dispatch` (foundation-attempt-service.ts:218) already holds a nodeKey it
 *          computed and graph-validated at :192, and passes it here as a DAEMON-INTERNAL
 *          argument. It is never a payload key: the caller would then be asserting which node's
 *          money to spend, which is authority by proxy.
 *   DOOR 2 the registered `effect.activate` command (daemon-command-registry.ts:202) has no such
 *          caller and no upstream node validation at all.
 * Both doors resolve the node the SAME way — off `readCurrentActiveGraph`. The optional argument
 * is a CROSS-CHECK, never an input that decides anything. One function rather than two branches
 * is deliberate: two paths could drift apart under a later edit while each door's own tests
 * still passed, which is the two-copies-of-one-rule failure this codebase has paid for before.
 *
 * THE BEARING RULE IS UNCONDITIONAL — `bearing.length > 1` always refuses. That is the DISPATCH
 * form (`foundation-attempt-contracts.ts:161`, which has no EXPANSION exemption), NOT core's
 * form (`planning-run-submission.ts:158` exempts EXPANSION runs). The two layers genuinely
 * differ, and an activation reached through either door follows the stricter one.
 *
 * UPSTREAM REFUSALS TRAVEL UNRESTAMPED. A binding, projection or graph refusal is forwarded with
 * its own code and layer; this module never offers a second opinion on someone else's fault.
 */

import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import type { BudgetCurrentProjection } from "../budget/budget-current-projection.js";
import { budgetProjectionRefusal } from "../budget/budget-ledger-contracts.js";
import type { BudgetRefusal } from "../budget/budget-ledger-contracts.js";
import {
  ACTIVE_GRAPH_PROJECTION_LAYER,
  readCurrentActiveGraph,
} from "../planning/active-graph-projection.js";

import { ACTIVATION_INGRESS_LAYER } from "./activation-ingress-contracts.js";

import type { AdmissionGate, NodeAdmissionAmount, NodeDefinition } from "@moe/scheduler";
import { NODE_ADMISSION_GATE_POLICY_WITNESS } from "@moe/scheduler";
import {
  COMMAND_DECISION_IDENTITY_VERSION,
  COMMAND_DECISION_RECORD_VERSION,
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_DECISION_RESULT_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  EXPECTED_VERSION_DECISION_COVERAGE,
} from "@moe/store";
import type {
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
  ExpectedVersionDecisionLeg,
  SqliteEventStore,
} from "@moe/store";

/**
 * This module's OWN faults, distinct from anything upstream. Ambiguity and absence are separate
 * codes on purpose: one graph names too many execution nodes and the other names none, and a
 * single code would make a malformed graph indistinguishable from an over-decomposed one.
 */
export const ACTIVATION_BUDGET_DERIVATION_CODES = Object.freeze([
  "ACTIVATION_BUDGET_NODE_ABSENT",
  "ACTIVATION_BUDGET_NODE_AMBIGUOUS",
  "ACTIVATION_BUDGET_NODE_MISMATCH",
  "ACTIVATION_BUDGET_AUTHORITY_ABSENT",
  "ACTIVATION_BUDGET_METER_UNFUNDED",
] as const);

export type ActivationBudgetDerivationCode =
  (typeof ACTIVATION_BUDGET_DERIVATION_CODES)[number];

export interface DeriveActivationBudgetInput {
  /**
   * OPTIONAL, and absent on every production route. Neither door carries a goal: the ingress
   * request names a project, and the goal this activation spends against is a DURABLE fact of
   * the current ACTIVE graph. A caller may still name one, and then it is checked rather than
   * trusted — `readBudgetBinding` refuses SCOPE_FOREIGN when it disagrees with the graph.
   */
  readonly goalRef?: string;
  /** DOOR 1 ONLY, and a cross-check rather than an input. Absent on the registry door. */
  readonly nodeKey?: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface ActivationBudgetAuthority {
  readonly accountId: string;
  readonly amounts: readonly NodeAdmissionAmount[];
  readonly expectedVersion: number;
  readonly gateWitnessField: keyof AdmissionGate;
  readonly goalRef: string;
  readonly graphEpoch: number;
  readonly graphRevisionRef: string;
  readonly nodeKey: string;
  readonly ownerRef: string;
}

export interface ActivationBudgetRefused {
  readonly code: ActivationBudgetDerivationCode;
  readonly layer: typeof ACTIVATION_INGRESS_LAYER;
  readonly ok: false;
}

export type DeriveActivationBudgetResult =
  | { readonly ok: true; readonly value: ActivationBudgetAuthority }
  | ActivationBudgetRefused
  | BudgetRefusal;

const refuse = (code: ActivationBudgetDerivationCode): ActivationBudgetRefused =>
  Object.freeze({ code, layer: ACTIVATION_INGRESS_LAYER, ok: false as const });

/**
 * THE one execution-bearing node, or this module's own refusal. Unconditional: an EXPANSION run
 * gets no exemption here, because the door that admits an activation does not grant one.
 */
function resolveNodeKey(
  bearingKeys: readonly string[], stated: string | undefined,
): string | ActivationBudgetRefused {
  if (bearingKeys.length > 1) return refuse("ACTIVATION_BUDGET_NODE_AMBIGUOUS");
  const [only] = bearingKeys;
  if (only === undefined) return refuse("ACTIVATION_BUDGET_NODE_ABSENT");
  // DOOR 1: the durable graph decides, the argument is only allowed to agree with it.
  if (stated !== undefined && stated !== only) return refuse("ACTIVATION_BUDGET_NODE_MISMATCH");
  return only;
}

/**
 * Every meter the amounts name must hold a DURABLE POSITION in this account's projection. A
 * meter the projection does not carry at all has no authority whatsoever behind it, so it can
 * never be spent from — synthesising a zero position for it is exactly the "unknown reads as
 * available" fault, and this is the rule that forbids it.
 *
 * THE COVERAGE VERDICT IS DELIBERATELY NOT THE GATE HERE, and that is a correction to this
 * plan's step-3(d) wording, measured rather than assumed. `coverageOf` reports UNKNOWN whenever
 * `openHoldCount > 0` — i.e. from the moment ONE activation holds on the meter. Gating
 * admission on it therefore admits exactly one attempt per meter per project and refuses every
 * concurrent one, which is the opposite of what this epic exists to make safe; it was measured
 * as `ACTIVATION_BUDGET_COVERAGE_UNKNOWN` on the second activation of four in
 * `activation-slot-occupancy.test.ts`.
 *
 * Coverage answers "how much of the consumption was MEASURED", which is a settlement question
 * and is why `refundable` is null unless it is COMPLETE. Whether a hold may be taken is
 * `reserveForAdmission`'s decision alone, and it decides on the CONSERVED buckets, which are
 * exact at every coverage — its `BUDGET_RESERVATION_INSUFFICIENT_AVAILABLE` travels out of here
 * unrestamped. Re-deciding it here would be the second opinion task rail 1 forbids.
 */
function fundedMeters(
  projection: BudgetCurrentProjection, amounts: readonly NodeAdmissionAmount[],
): boolean {
  return amounts.every((amount) =>
    projection.meters.some((entry) => entry.meter === amount.meter));
}

export function deriveActivationBudget(
  input: DeriveActivationBudgetInput,
): DeriveActivationBudgetResult {
  const { goalRef, nodeKey, projectId, store } = input;
  const graph = readCurrentActiveGraph(store, projectId);
  if (!graph.ok) {
    // PRECEDENCE, AND IT IS LOAD-BEARING. A caller that NAMED a goal still goes through the
    // projection, so a world whose goal was never created answers GOAL_ABSENT instead of being
    // masked by the graph's failure — the two are different worlds and one may not stand in for
    // the other. With no goal named, the graph is the ONLY thing that could name one, so its own
    // code and layer are the answer, built by the binding family's own constructor rather than
    // restamped into this module's vocabulary.
    return goalRef === undefined
      ? budgetProjectionRefusal(
        "BUDGET_PROJECTION_GRAPH_UNAVAILABLE", graph.code, ACTIVE_GRAPH_PROJECTION_LAYER,
      )
      : (readCurrentBudgetLedger(store, projectId, goalRef) as BudgetRefusal);
  }
  const bearingKeys = graph.snapshot.nodes
    .filter((node) => node.executionBearing)
    .map((node) => node.nodeKey);
  const resolved = resolveNodeKey(bearingKeys, nodeKey);
  if (typeof resolved !== "string") return resolved;

  // The goal is a DURABLE fact of the ACTIVE graph, not a caller's claim. A named goal is not
  // preferred to it either: `readBudgetBinding` refuses SCOPE_FOREIGN when the two disagree.
  const resolvedGoal = goalRef ?? graph.provenance.goalRef;
  const projection = readCurrentBudgetLedger(store, projectId, resolvedGoal);
  if (!projection.ok) return projection;

  const definition = graph.content.nodeAuthority.definitions
    .find((entry: NodeDefinition) => entry.nodeKey === resolved);
  if (definition === undefined) return refuse("ACTIVATION_BUDGET_AUTHORITY_ABSENT");
  if (!fundedMeters(projection, definition.admissionAmounts)) {
    return refuse("ACTIVATION_BUDGET_METER_UNFUNDED");
  }

  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      accountId: projection.binding.budgetAccountRef,
      // The PRODUCER'S own array, forwarded. Rebuilding it here would be a second unauthorised
      // opinion about how much this node may spend.
      amounts: definition.admissionAmounts,
      expectedVersion: projection.headVersion,
      // The POLICY resolves to the AdmissionGate FIELD durable facts must witness. It is an
      // obligation to satisfy later, never a grant to honour here.
      gateWitnessField: NODE_ADMISSION_GATE_POLICY_WITNESS[definition.admissionGatePolicy],
      goalRef: projection.binding.goalRef,
      graphEpoch: projection.binding.graphEpoch,
      graphRevisionRef: projection.binding.graphRevisionRef,
      nodeKey: resolved,
      ownerRef: projection.binding.ownerRef,
    }),
  });
}

/**
 * THE CAPTURE SEAM — how the budget hold rides the activation's decision.
 *
 * `reserveBudgetForAdmission(store, input, commit)` takes an INJECTABLE `BudgetCommitPort`
 * (budget-ledger-holds.ts:169) and `commitBudgetTransition` hands that port a fully-built
 * `CommitExpectedVersionDecisionInput` (budget-ledger-commit.ts:173-195). Injecting a port that
 * RECORDS that input instead of writing it is the designed extension point: no `budget/`
 * producer file is edited, and the ledger's own writer still owns every arithmetic decision.
 *
 * WHY A SYNTHETIC RESPONSE IS UNAVOIDABLE, AND WHY IT IS NOT A FABRICATED RECEIPT.
 * The writer INSPECTS what the port returns: `effectDisposition !== "EFFECTS_COMMITTED"` makes
 * it refuse, and `disposition === "REPLAYED"` makes it answer from prior bytes. So a capturing
 * port must answer "accepted" or the writer reports a conflict that never happened — which
 * would invert the signal, since every money check (`reserveForAdmission`, the gate, the
 * conservation lines) has ALREADY passed by the time the commit port is reached.
 *
 * The honesty guarantee is STRUCTURAL, not textual: this function hands back a LEG, and a leg
 * is not durable until `commitActivationLedgerRecord` puts it in `legs[]`. If that commit
 * refuses, both aggregates stay where they were. Nothing here reports success to a caller — it
 * reports "this is what the ledger would write, fenced at this version". The sentinel digests
 * below exist so that a synthetic decision can never be mistaken for a stored one if it ever
 * escaped this module, which it does not: it is created and consumed inside `captureBudgetLeg`.
 */
const CAPTURE_SENTINEL = "0".repeat(64);

interface CapturedLeg {
  readonly input: CommitExpectedVersionDecisionInput;
}

function acceptedResponse(
  input: CommitExpectedVersionDecisionInput,
): CommandDecisionResponse {
  return {
    decision: {
      auditEventId: null,
      businessEventIds: input.events.map((event) => event.eventId),
      commandKind: input.commandKind,
      correlationSha256: CAPTURE_SENTINEL,
      coverage: EXPECTED_VERSION_DECISION_COVERAGE,
      currentVersion: input.expectedVersion + 1,
      decidedAt: input.decidedAt,
      decisionId: `capture:${input.targetAggregateId}`,
      decisionIdentityVersion: COMMAND_DECISION_IDENTITY_VERSION,
      decisionPosition: 0n,
      decisionSha256: CAPTURE_SENTINEL,
      effectDisposition: "EFFECTS_COMMITTED",
      effectIdentityVersion: COMMAND_EFFECT_IDENTITY_VERSION,
      effectSha256: CAPTURE_SENTINEL,
      expectedVersion: input.expectedVersion,
      key: input.key,
      observedVersion: input.expectedVersion,
      outboxMessageIds: [],
      previousVersion: input.expectedVersion,
      recordVersion: COMMAND_DECISION_RECORD_VERSION,
      replayRequestSha256: CAPTURE_SENTINEL,
      requestIdentityVersion: COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
      requestSha256: CAPTURE_SENTINEL,
      resultBytes: input.committedResultBytes,
      resultCode: "EFFECTS_COMMITTED",
      resultSha256: CAPTURE_SENTINEL,
      resultVersion: COMMAND_DECISION_RESULT_VERSION,
      targetAggregateId: input.targetAggregateId,
    },
    disposition: "DECIDED",
    historical: false,
    requiresAffordanceRefresh: false,
  };
}

/**
 * Runs `reserve` against a capturing port and returns the leg it would have written.
 *
 * `reserve` is the PRODUCTION writer, passed in rather than imported, so this module composes
 * the ledger instead of knowing it. A refusal is forwarded untouched — the money checks all run
 * inside that writer, ahead of the commit port, so a refusal here is a real refusal.
 */
export function captureBudgetLeg<R extends { readonly ok: boolean }>(
  reserve: (commit: {
    commitExpectedVersionDecision(
      input: CommitExpectedVersionDecisionInput,
    ): CommandDecisionResponse;
  }) => R,
): { readonly leg: ExpectedVersionDecisionLeg; readonly result: R } | { readonly result: R } {
  const captured: CapturedLeg[] = [];
  const result = reserve({
    commitExpectedVersionDecision(input: CommitExpectedVersionDecisionInput) {
      captured.push({ input });
      return acceptedResponse(input);
    },
  });
  const [only] = captured;
  if (!result.ok || only === undefined) return { result };
  return {
    leg: {
      aggregateId: only.input.targetAggregateId,
      events: only.input.events,
      expectedVersion: only.input.expectedVersion,
    },
    result,
  };
}
