import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue, RuntimeError } from "@moe/contracts";
import { APPROVAL_AUTHORITY_LAYERS } from "@moe/core";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  EventDraft,
  SqliteEventStore,
} from "@moe/store";

import { BOOTSTRAP_COMMAND_KINDS } from "./bootstrap-contracts.js";
import { COMMAND_PREREQUISITES } from "./bootstrap-sequence.js";
import type { BootstrapCommandKind, BootstrapRequest } from "./bootstrap-contracts.js";

/** Re-exported so a service imports its whole composition surface from one module. */
export {
  COMMAND_PREREQUISITES,
  aggregateIdFor,
  payloadObject,
  payloadRef,
} from "./bootstrap-sequence.js";

/**
 * The durable half of the bootstrap composition: a read-only view over committed command
 * decisions, plus the single commit seam every service funnels through.
 *
 * The ledger is the only source of prior state. Nothing here reads a file, a clock, or a
 * caller-supplied snapshot, which is what makes the bootstrap sequence command-driven —
 * a project reaches READY only if the register, bind and probe commands are themselves
 * durably recorded.
 */

/** The layer that answered. Three layers can refuse, so evidence must name which one did. */
export const SERVICE_REFUSED_BY = Object.freeze([
  "DAEMON_INGRESS",
  "DAEMON_PREREQUISITE",
  "CORE_REDUCER",
  "DURABLE_STORE",
  ...APPROVAL_AUTHORITY_LAYERS,
] as const);

export type ServiceRefusedBy = (typeof SERVICE_REFUSED_BY)[number];

/** Refusals owned by the daemon's durable-sequence gate; core codes are never restated here. */
export const PREREQUISITE_REFUSAL_CODES = Object.freeze([
  "BOOTSTRAP_PAYLOAD_INVALID",
  "BOOTSTRAP_PREREQUISITE_MISSING",
  "BOOTSTRAP_EXPECTED_VERSION_STALE",
  "BOOTSTRAP_POLICY_UNKNOWN",
  "BOOTSTRAP_REVISION_HASH_MISMATCH",
  "BOOTSTRAP_COMMAND_ID_REUSED",
] as const);

export type PrerequisiteRefusalCode = (typeof PREREQUISITE_REFUSAL_CODES)[number];

export interface DurableAggregate {
  readonly currentVersion: number;
  readonly result: JsonValue;
}

export interface DurableLedger {
  readonly aggregates: ReadonlyMap<string, DurableAggregate>;
  readonly decisionCount: number;
  readonly kinds: ReadonlySet<string>;
}

export interface ServiceAccepted {
  readonly advisoryOnly: false;
  readonly authority: "DURABLE_DECISION";
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly kind: BootstrapCommandKind;
  readonly ok: true;
}

export interface ServiceRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly kind: BootstrapCommandKind | null;
  readonly ok: false;
  readonly refusedBy: ServiceRefusedBy;
}

export type ServiceOutcome = ServiceAccepted | ServiceRefused;

export interface HandlerContext {
  readonly ledger: DurableLedger;
  readonly request: BootstrapRequest;
  readonly store: SqliteEventStore;
}

export type CommandHandler = (context: HandlerContext) => ServiceOutcome;

export type HandlerTable = Readonly<Partial<Record<BootstrapCommandKind, CommandHandler>>>;

const LEDGER_PAGE_SIZE = 200;
const encoder = new TextEncoder();

export function decisionKey(request: BootstrapRequest): CommandDecisionKey {
  return {
    commandId: request.commandId,
    principalId: request.principalId,
    projectId: request.projectId,
  };
}

function decodeResult(bytes: Uint8Array): JsonValue {
  const decoded = decodeBoundedJsonBytes(bytes);
  return decoded.ok ? decoded.value : null;
}

/**
 * Folds every committed decision for this project into current aggregate state.
 *
 * Only `EFFECTS_COMMITTED` decisions count: the store's `NO_BUSINESS_EFFECT` audit rows record
 * that a command was refused, and treating one as prior state would let a refusal satisfy a
 * prerequisite.
 */
export function readDurableLedger(store: SqliteEventStore, projectId: string): DurableLedger {
  const aggregates = new Map<string, DurableAggregate>();
  const kinds = new Set<string>();
  let decisionCount = 0;
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, LEDGER_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId) continue;
      decisionCount += 1;
      if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      kinds.add(decision.commandKind);
      aggregates.set(decision.targetAggregateId, {
        currentVersion: decision.currentVersion,
        result: decodeResult(decision.resultBytes),
      });
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return Object.freeze({ aggregates, decisionCount, kinds });
}

export function refuse(
  kind: BootstrapCommandKind | null,
  code: string,
  refusedBy: ServiceRefusedBy,
  error: RuntimeError | null = null,
): ServiceRefused {
  return Object.freeze({
    advisoryOnly: true as const,
    authority: "NONE" as const,
    code,
    error,
    kind,
    ok: false as const,
    refusedBy,
  });
}

/** A core reducer refused: its own code is surfaced unchanged so the layer stays identifiable. */
export function refuseFromCore(kind: BootstrapCommandKind, error: RuntimeError): ServiceRefused {
  return refuse(kind, error.code, "CORE_REDUCER", error);
}

export function missingPrerequisites(
  ledger: DurableLedger,
  kind: BootstrapCommandKind,
): readonly BootstrapCommandKind[] {
  const required: readonly BootstrapCommandKind[] = COMMAND_PREREQUISITES[kind];
  return required.filter((entry) => !ledger.kinds.has(entry));
}

export function versionOf(ledger: DurableLedger, aggregateId: string): number {
  return ledger.aggregates.get(aggregateId)?.currentVersion ?? 0;
}

export function stateOf(ledger: DurableLedger, aggregateId: string): JsonValue | undefined {
  return ledger.aggregates.get(aggregateId)?.result;
}

export interface CommitPlan {
  readonly aggregateId: string;
  readonly eventPayload: JsonValue;
  readonly eventType: string;
  readonly expectedVersion: number;
  readonly result: JsonValue;
}

function eventDraft(request: BootstrapRequest, plan: CommitPlan): EventDraft {
  return {
    eventId: `${request.commandId}-${plan.eventType}`,
    eventType: plan.eventType,
    payload: encoder.encode(JSON.stringify(plan.eventPayload)),
  };
}

/**
 * The single durable seam. Every accepted command commits exactly one decision here, so the
 * "one durable terminal decision" property is a property of this function rather than of nine
 * separate call sites.
 */
export function commitAccepted(
  store: SqliteEventStore,
  request: BootstrapRequest,
  plan: CommitPlan,
): ServiceOutcome {
  const response = store.commitExpectedVersionDecision({
    commandKind: request.kind,
    committedResultBytes: encoder.encode(JSON.stringify(plan.result)),
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [eventDraft(request, plan)],
    expectedVersion: plan.expectedVersion,
    key: decisionKey(request),
    requestBytes: encoder.encode(JSON.stringify({ kind: request.kind, payload: request.payload })),
    targetAggregateId: plan.aggregateId,
  });
  // The store does not throw on a version mismatch: it writes a NO_BUSINESS_EFFECT audit row
  // and reports the conflict in `resultCode`. Reporting that as an accepted decision would be
  // a fail-open — authority claimed for a command that committed nothing — so the store's own
  // code is surfaced under its own layer. Reachable when a concurrent writer moves the head
  // between the ledger read and this commit.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse(request.kind, response.decision.resultCode, "DURABLE_STORE");
  }
  return Object.freeze({
    advisoryOnly: false as const,
    authority: "DURABLE_DECISION" as const,
    decision: response.decision,
    disposition: response.disposition,
    kind: request.kind,
    ok: true as const,
  });
}

/**
 * Idempotent replay lookup, which MUST run before any core reducer.
 *
 * The reducers compare `expectedVersion` against current version and reject a mismatch, so an
 * identical second request would be refused by the core and could never reach the store to be
 * recognised as a replay.
 */
export function replayOf(
  store: SqliteEventStore,
  request: BootstrapRequest,
): ServiceOutcome | null {
  const existing = store.getCommandDecision(decisionKey(request));
  if (existing === null) return null;
  // The decision key is (commandId, principalId, projectId) and does NOT include the kind, so
  // reusing a commandId under a different kind would otherwise return the earlier command's
  // decision as an accepted replay of this one — authority for a command never decided. The
  // short-circuit happens before any store write, so the store's own command-id guard never
  // sees it; this check is the only thing standing there.
  if (existing.commandKind !== request.kind) {
    return refuse(request.kind, "BOOTSTRAP_COMMAND_ID_REUSED", "DAEMON_PREREQUISITE");
  }
  if (existing.effectDisposition !== "EFFECTS_COMMITTED") return null;
  return Object.freeze({
    advisoryOnly: false as const,
    authority: "DURABLE_DECISION" as const,
    decision: existing,
    disposition: "REPLAYED" as const,
    kind: request.kind,
    ok: true as const,
  });
}

export const BOOTSTRAP_KIND_COUNT = BOOTSTRAP_COMMAND_KINDS.length;
