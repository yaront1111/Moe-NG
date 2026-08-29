import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
} from "@moe/store";
import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import {
  copyFixedBytes,
  exactDataArray,
  exactDataRecord,
} from "../documents/document-work-safe-value.js";

const encoder = new TextEncoder();
const BINDING_SCHEMA_VERSION = "moe-goal-planning-run-binding/1";
const AGGREGATE_DOMAIN = "moe.goal-planning-run-binding.aggregate.v1";
const EVENT_DOMAIN = "moe.goal-planning-run-binding.event.v1";
const BINDING_EVENT_TYPE = "GoalPlanningRunBound";
const GOAL_EVENT_TYPE = "GoalCreated";
const PLAN_EVENT_TYPE = "PlanProposed";
const PAGE_KEYS = Object.freeze(["hasMore", "items", "nextCursor"]);
const EVENT_KEYS = Object.freeze([
  "aggregateId", "aggregateSequence", "commandId", "committedAt", "decisionTrace",
  "domainSchemaVersion", "eventId", "eventType", "globalPosition", "metadata",
  "payloadCodecVersion", "payload", "recordVersion", "requestSha256",
]);
const TRACE_KEYS = Object.freeze([
  "commandId", "commandKind", "principalId", "projectId", "requestIdentityVersion",
  "requestSha256",
]);
const BINDING_KEYS = Object.freeze([
  "goalId", "planningRunRef", "projectId", "schemaVersion",
]);
const GOAL_EVENT_KEYS = Object.freeze([
  "brief", "budgetAccountRef", "commandId", "goalId", "kind", "planningRunRef", "prd",
  "projectId", "version", "witness",
]);
const LEGACY_GOAL_EVENT_KEYS = Object.freeze([
  "budgetAccountRef", "commandId", "goalId", "kind", "planningRunRef", "projectId",
  "version", "witness",
]);
const GOAL_RESULT_KEYS = Object.freeze([
  "activeGraphRevisionRef", "budgetAccountRef", "generation", "goalId", "graphEpoch",
  "lifecycle", "planningRunRef", "predecessorGoalRef", "projectId", "recoveryFacets",
  "schedulingControl", "version",
]);
const PLANNING_CREATED_KEYS = Object.freeze([
  "commandId", "goalRef", "kind", "runId", "runKind", "version",
]);
const PROJECT_READY_KEYS = Object.freeze(["projectReadyRef", "truthClass"]);
const HEX_64 = /^[0-9a-f]{64}$/u;

function digest(domain: string, values: readonly string[]): string {
  const hash = createHash("sha256").update(`${domain}\0`, "utf8");
  for (const value of values) {
    const bytes = encoder.encode(value);
    hash.update(`${String(bytes.byteLength)}:`, "ascii").update(bytes);
  }
  return hash.digest("hex");
}

export function goalPlanningRunBindingAggregateId(
  projectId: string,
  planningRunRef: string,
): string {
  return `goal-planning-run/${digest(AGGREGATE_DOMAIN, [projectId, planningRunRef])}`;
}

function goalPlanningRunBindingEventId(
  projectId: string,
  planningRunRef: string,
  goalId: string,
): string {
  return `goal-planning-run-bound/${digest(EVENT_DOMAIN, [projectId, planningRunRef, goalId])}`;
}

interface BindingTrace {
  readonly commandId: string;
  readonly commandKind: "goal.create" | "plan.propose";
  readonly principalId: string;
  readonly requestSha256: string;
}

export type GoalPlanningRunBindingReadResult =
  | { readonly kind: "ABSENT" }
  | { readonly goalId: string; readonly kind: "BOUND" }
  | { readonly kind: "UNREADABLE" };

function unreadable(): { readonly kind: "UNREADABLE" } {
  return Object.freeze({ kind: "UNREADABLE" as const });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function traceOf(value: unknown, projectId: string): BindingTrace | null {
  const trace = exactDataRecord(value, TRACE_KEYS);
  if (trace === null
    || !nonEmptyString(trace["commandId"])
    || (trace["commandKind"] !== "goal.create" && trace["commandKind"] !== "plan.propose")
    || !nonEmptyString(trace["principalId"])
    || trace["projectId"] !== projectId
    || trace["requestIdentityVersion"] !== COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    || typeof trace["requestSha256"] !== "string"
    || !HEX_64.test(trace["requestSha256"])) return null;
  return Object.freeze({
    commandId: trace["commandId"],
    commandKind: trace["commandKind"],
    principalId: trace["principalId"],
    requestSha256: trace["requestSha256"],
  });
}

function sameTrace(left: BindingTrace, value: unknown, projectId: string): boolean {
  const right = traceOf(value, projectId);
  return right !== null
    && right.commandId === left.commandId
    && right.commandKind === left.commandKind
    && right.principalId === left.principalId
    && right.requestSha256 === left.requestSha256;
}

function decodedRecord(bytes: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  const snapshot = copyFixedBytes(bytes);
  if (snapshot === null) return null;
  const decoded = decodeBoundedJsonBytes(snapshot);
  return decoded.ok ? exactDataRecord(decoded.value, keys) : null;
}

interface BoundFact {
  readonly eventId: string;
  readonly goalId: string;
  readonly trace: BindingTrace;
}

function bindingFact(
  value: unknown,
  aggregateId: string,
  projectId: string,
  planningRunRef: string,
): BoundFact | null {
  const event = exactDataRecord(value, EVENT_KEYS);
  if (event === null
    || event["aggregateId"] !== aggregateId
    || event["aggregateSequence"] !== 1
    || event["domainSchemaVersion"] !== BINDING_SCHEMA_VERSION
    || event["eventType"] !== BINDING_EVENT_TYPE
    || event["payloadCodecVersion"] !== OPAQUE_PAYLOAD_CODEC_VERSION
    || event["recordVersion"] !== EVENT_RECORD_VERSION) return null;
  const trace = traceOf(event["decisionTrace"], projectId);
  if (trace === null) return null;
  const payload = decodedRecord(event["payload"], BINDING_KEYS);
  if (payload === null
    || !nonEmptyString(payload["goalId"])
    || payload["planningRunRef"] !== planningRunRef
    || payload["projectId"] !== projectId
    || payload["schemaVersion"] !== BINDING_SCHEMA_VERSION) return null;
  const eventId = goalPlanningRunBindingEventId(projectId, planningRunRef, payload["goalId"]);
  if (event["eventId"] !== eventId) return null;
  return Object.freeze({ eventId, goalId: payload["goalId"], trace });
}

function goalCreatedFact(
  value: unknown,
  goalId: string,
  planningRunRef: string,
  projectId: string,
  trace: BindingTrace,
): boolean {
  const event = exactDataRecord(value, EVENT_KEYS);
  if (trace.commandKind !== "goal.create"
    || event === null
    || event["aggregateId"] !== goalId
    || event["aggregateSequence"] !== 1
    // GoalCreated currently uses the store's documented default schema, but
    // that default is deliberately not part of @moe/store's public surface.
    // The exact writer/decision/event join below is authoritative; accept only
    // a stored, non-empty schema marker here rather than duplicating a private
    // store literal that could drift from production.
    || !nonEmptyString(event["domainSchemaVersion"])
    || event["eventId"] !== `${trace.commandId}-${GOAL_EVENT_TYPE}`
    || event["eventType"] !== GOAL_EVENT_TYPE
    || event["payloadCodecVersion"] !== OPAQUE_PAYLOAD_CODEC_VERSION
    || event["recordVersion"] !== EVENT_RECORD_VERSION
    || !sameTrace(trace, event["decisionTrace"], projectId)) return false;
  const snapshot = copyFixedBytes(event["payload"]);
  if (snapshot === null) return false;
  const decoded = decodeBoundedJsonBytes(snapshot);
  if (!decoded.ok) return false;
  const facts = exactDataArray(decoded.value);
  if (facts === null || facts.length !== 1) return false;
  const fact = exactDataRecord(facts[0], GOAL_EVENT_KEYS)
    ?? exactDataRecord(facts[0], LEGACY_GOAL_EVENT_KEYS);
  const witness = fact === null ? null : exactDataRecord(fact["witness"], PROJECT_READY_KEYS);
  return fact !== null
    && witness !== null
    && nonEmptyString(witness["projectReadyRef"])
    && (witness["truthClass"] === "DAEMON_VERIFIED"
      || witness["truthClass"] === "HUMAN_APPROVED")
    && fact["commandId"] === trace.commandId
    && fact["goalId"] === goalId
    && fact["kind"] === GOAL_EVENT_TYPE
    && fact["planningRunRef"] === planningRunRef
    && fact["projectId"] === projectId
    && fact["version"] === 1
    && nonEmptyString(fact["budgetAccountRef"]);
}

function eventReceiptProves(
  store: SqliteEventStore,
  event: Readonly<Record<string, unknown>>,
  aggregateId: string,
  eventId: string,
): boolean {
  if (!nonEmptyString(event["commandId"])
    || typeof event["requestSha256"] !== "string"
    || !HEX_64.test(event["requestSha256"])) return false;
  const receipt = store.getCommandReceipt(event["commandId"]);
  return receipt !== null
    && receipt.aggregateId === aggregateId
    && receipt.commandId === event["commandId"]
    && receipt.previousVersion === 0
    && receipt.currentVersion === 1
    && receipt.requestSha256 === event["requestSha256"]
    && receipt.eventIds.includes(eventId);
}

export type GoalCreatedPlanningRunProof =
  | { readonly commandId: string; readonly kind: "PROVEN" }
  | { readonly kind: "ABSENT" }
  | { readonly kind: "UNREADABLE" };

/** Exact first-event proof used only to upgrade pre-binding durable history. */
export function readGoalCreatedPlanningRunProof(
  store: SqliteEventStore,
  projectId: string,
  goalId: string,
  planningRunRef: string,
): GoalCreatedPlanningRunProof {
  try {
    const version = store.getAggregateVersion(goalId);
    if (version === 0) return Object.freeze({ kind: "ABSENT" as const });
    if (!Number.isSafeInteger(version) || version < 1) return unreadable();
    const page = exactDataRecord(store.readAggregateEvents(goalId, 0, 1), PAGE_KEYS);
    if (page === null || page["nextCursor"] !== 1 || typeof page["hasMore"] !== "boolean") {
      return unreadable();
    }
    const events = exactDataArray(page["items"]);
    if (events === null || events.length !== 1) return unreadable();
    const event = exactDataRecord(events[0], EVENT_KEYS);
    if (event === null) return unreadable();
    const trace = traceOf(event["decisionTrace"], projectId);
    if (trace === null || trace.commandKind !== "goal.create"
      || !goalCreatedFact(event, goalId, planningRunRef, projectId, trace)
      || !eventReceiptProves(
        store, event, goalId, `${trace.commandId}-${GOAL_EVENT_TYPE}`,
      )) return unreadable();
    const decision = store.getCommandDecision({
      commandId: trace.commandId, principalId: trace.principalId, projectId,
    });
    if (decision === null
      || decision.effectDisposition !== "EFFECTS_COMMITTED"
      || decision.commandKind !== "goal.create"
      || decision.targetAggregateId !== goalId
      || decision.expectedVersion !== 0
      || decision.observedVersion !== 0
      || decision.previousVersion !== 0
      || decision.currentVersion !== 1
      || decision.requestSha256 !== trace.requestSha256
      || !decision.businessEventIds.includes(`${trace.commandId}-${GOAL_EVENT_TYPE}`)) {
      return unreadable();
    }
    const result = decodedRecord(decision.resultBytes, GOAL_RESULT_KEYS);
    if (result === null
      || result["goalId"] !== goalId
      || result["planningRunRef"] !== planningRunRef
      || result["projectId"] !== projectId
      || result["version"] !== 1
      || result["lifecycle"] !== "DRAFT") return unreadable();
    return Object.freeze({ commandId: trace.commandId, kind: "PROVEN" as const });
  } catch {
    return unreadable();
  }
}

function planDecisionProvesBackfill(
  store: SqliteEventStore,
  trace: BindingTrace,
  projectId: string,
  goalId: string,
  planningRunRef: string,
): boolean {
  if (trace.commandKind !== "plan.propose") return false;
  const decision = store.getCommandDecision({
    commandId: trace.commandId, principalId: trace.principalId, projectId,
  });
  if (decision === null
    || decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.commandKind !== "plan.propose"
    || decision.targetAggregateId !== planningRunRef
    || decision.expectedVersion !== 0
    || decision.observedVersion !== 0
    || decision.previousVersion !== 0
    || decision.currentVersion !== 1
    || decision.requestSha256 !== trace.requestSha256
    || !decision.businessEventIds.includes(`${trace.commandId}-${PLAN_EVENT_TYPE}`)) return false;
  const page = exactDataRecord(store.readAggregateEvents(planningRunRef, 0, 1), PAGE_KEYS);
  if (page === null || page["nextCursor"] !== 1 || typeof page["hasMore"] !== "boolean") {
    return false;
  }
  const events = exactDataArray(page["items"]);
  if (events === null || events.length !== 1) return false;
  const event = exactDataRecord(events[0], EVENT_KEYS);
  if (event === null
    || event["aggregateId"] !== planningRunRef
    || event["aggregateSequence"] !== 1
    || event["eventId"] !== `${trace.commandId}-${PLAN_EVENT_TYPE}`
    || event["eventType"] !== PLAN_EVENT_TYPE
    || !nonEmptyString(event["domainSchemaVersion"])
    || event["payloadCodecVersion"] !== OPAQUE_PAYLOAD_CODEC_VERSION
    || event["recordVersion"] !== EVENT_RECORD_VERSION
    || !sameTrace(trace, event["decisionTrace"], projectId)
    || !eventReceiptProves(
      store, event, planningRunRef, `${trace.commandId}-${PLAN_EVENT_TYPE}`,
    )) return false;
  const snapshot = copyFixedBytes(event["payload"]);
  if (snapshot === null) return false;
  const decoded = decodeBoundedJsonBytes(snapshot);
  if (!decoded.ok) return false;
  const facts = exactDataArray(decoded.value);
  if (facts === null || facts.length === 0) return false;
  const created = exactDataRecord(facts[0], PLANNING_CREATED_KEYS);
  return created !== null
    && created["goalRef"] === goalId
    && created["kind"] === "PlanningRunCreated"
    && created["runId"] === planningRunRef
    && created["version"] === 1;
}

type SingleBindingEventRead =
  | { readonly kind: "ABSENT" }
  | { readonly event: unknown; readonly kind: "EVENT" }
  | { readonly kind: "UNREADABLE" };

function readSingleBindingEvent(
  store: SqliteEventStore,
  aggregateId: string,
): SingleBindingEventRead {
  const page = exactDataRecord(store.readAggregateEvents(aggregateId, 0, 2), PAGE_KEYS);
  if (page === null) return unreadable();
  const items = exactDataArray(page["items"]);
  if (items === null) return unreadable();
  if (items.length === 0) {
    return page["hasMore"] === false && page["nextCursor"] === null
      ? Object.freeze({ kind: "ABSENT" as const })
      : unreadable();
  }
  return items.length === 1 && page["hasMore"] === false && page["nextCursor"] === 1
    ? Object.freeze({ event: items[0], kind: "EVENT" as const })
    : unreadable();
}

/**
 * Reads the shared run-owner aggregate and proves both sides of its join. New owners share the
 * exact goal.create decision; legacy owners share the first plan.propose decision that backfilled
 * the fence atomically, and independently prove the older exact GoalCreated row. The store's
 * decision reader validates every hidden leg roster and receipt in either case.
 */
export function readGoalPlanningRunBinding(
  store: SqliteEventStore,
  projectId: string,
  planningRunRef: string,
): GoalPlanningRunBindingReadResult {
  const aggregateId = goalPlanningRunBindingAggregateId(projectId, planningRunRef);
  try {
    const version = store.getAggregateVersion(aggregateId);
    if (!Number.isSafeInteger(version) || (version !== 0 && version !== 1)) return unreadable();
    const stored = readSingleBindingEvent(store, aggregateId);
    if (stored.kind === "ABSENT") return version === 0 ? stored : unreadable();
    if (stored.kind === "UNREADABLE" || version !== 1) return unreadable();
    const fact = bindingFact(stored.event, aggregateId, projectId, planningRunRef);
    if (fact === null) return unreadable();
    const bindingEvent = exactDataRecord(stored.event, EVENT_KEYS);
    if (bindingEvent === null
      || !eventReceiptProves(store, bindingEvent, aggregateId, fact.eventId)) return unreadable();
    const goal = readGoalCreatedPlanningRunProof(
      store, projectId, fact.goalId, planningRunRef,
    );
    if (goal.kind !== "PROVEN") return unreadable();
    if (fact.trace.commandKind === "goal.create") {
      // The goal decision read above also validates the binding suffix in its hidden leg roster.
      if (goal.commandId !== fact.trace.commandId) return unreadable();
    } else if (!planDecisionProvesBackfill(
      store, fact.trace, projectId, fact.goalId, planningRunRef,
    )) return unreadable();
    return Object.freeze({ goalId: fact.goalId, kind: "BOUND" as const });
  } catch {
    return unreadable();
  }
}

/**
 * A shared expected-version fence for the one-to-one goal/run binding. Two
 * different goal.create commands may target different goal aggregates and
 * therefore would not race at either primary aggregate; this leg makes them
 * contend on the planning run they both claim.
 */
export function goalPlanningRunBindingLeg(
  projectId: string,
  goalId: string,
  planningRunRef: string,
): ExpectedVersionDecisionLeg {
  const aggregateId = goalPlanningRunBindingAggregateId(projectId, planningRunRef);
  return Object.freeze({
    aggregateId,
    events: Object.freeze([Object.freeze({
      domainSchemaVersion: BINDING_SCHEMA_VERSION,
      eventId: goalPlanningRunBindingEventId(projectId, planningRunRef, goalId),
      eventType: BINDING_EVENT_TYPE,
      outbox: Object.freeze([]),
      payload: encoder.encode(JSON.stringify({
        goalId, planningRunRef, projectId, schemaVersion: BINDING_SCHEMA_VERSION,
      })),
    })]),
    expectedVersion: 0,
  });
}
