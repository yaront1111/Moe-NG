import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonValue, RuntimeError } from "@moe/contracts";
import { identifyReplayRequest } from "@moe/store";
import type {
  CommandDecisionKey,
  CommandDecisionRecord,
  EventDraft,
  ExpectedVersionDecisionLeg,
  SqliteEventStore,
} from "@moe/store";

import { BOOTSTRAP_COMMAND_KINDS } from "./bootstrap-contracts.js";
import { conflictError } from "./bootstrap-conflict-error.js";
import { unmetPrerequisites } from "./bootstrap-sequence.js";
import type { BootstrapCommandKind, BootstrapRequest } from "./bootstrap-contracts.js";

/**
 * Re-exported so the conflict decode has ONE public name even though it lives in its own module
 * (this file is already near the line cap). Every commit seam that can receive a store conflict
 * imports the same function; a second copy of the decode would drift.
 */
export { conflictError } from "./bootstrap-conflict-error.js";

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

import type {
  DurableAggregate, DurableLedger, ServiceOutcome, ServiceRefused, ServiceRefusedBy,
} from "./bootstrap-ledger-vocabulary.js";

/** Re-exported so every existing importer keeps reading its whole surface from this module. */
export {
  PREREQUISITE_REFUSAL_CODES, SERVICE_REFUSED_BY, humanReviewWitness,
} from "./bootstrap-ledger-vocabulary.js";
export type {
  CommandHandler,
  DurableAggregate,
  DurableLedger,
  HandlerContext,
  HandlerTable,
  HumanReviewWitness, HumanReviewWitnessTransport,
  PrerequisiteRefusalCode,
  ServiceAccepted,
  ServiceOutcome,
  ServiceRefused,
  ServiceRefusedBy,
} from "./bootstrap-ledger-vocabulary.js";
import { decisionsOf } from "../decision-ledger-memo.js";

const LEDGER_PAGE_SIZE = 200;
const encoder = new TextEncoder();

export function decisionKey(request: BootstrapRequest): CommandDecisionKey {
  return {
    commandId: request.commandId,
    principalId: request.principalId,
    projectId: request.projectId,
  };
}

/**
 * The canonical request bytes of a command: the exact preimage every commit seam writes and the
 * exact preimage the replay proof re-derives. It exists as ONE function because two copies of a
 * byte construction drift silently — and a drifted copy here would refuse honest replays.
 */
function requestBytesOf(request: BootstrapRequest): Uint8Array {
  return encoder.encode(JSON.stringify({ kind: request.kind, payload: request.payload }));
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
  for (const decision of decisionsOf(store, LEDGER_PAGE_SIZE)) {
    if (decision.key.projectId !== projectId) continue;
    decisionCount += 1;
    if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
    kinds.add(decision.commandKind);
    aggregates.set(decision.targetAggregateId, {
      currentVersion: decision.currentVersion,
      result: decodeResult(decision.resultBytes),
    });
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
  return unmetPrerequisites(kind, ledger.kinds);
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

/**
 * The store does not throw on a version mismatch: it writes a NO_BUSINESS_EFFECT audit row and
 * reports the conflict in `resultCode`. Reporting that as an accepted decision would be a
 * fail-open — authority claimed for a command that committed nothing — so the store's own code is
 * surfaced under its own layer. Reachable when a concurrent writer moves the head between the
 * ledger read and the commit, and on a MULTI-LEG decision when ANY leg's fence is stale.
 */
function decided(
  request: BootstrapRequest,
  response: { readonly decision: CommandDecisionRecord; readonly disposition: "DECIDED" | "REPLAYED" },
): ServiceOutcome {
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse(
      request.kind, response.decision.resultCode, "DURABLE_STORE",
      conflictError(response.decision),
    );
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
    requestBytes: requestBytesOf(request),
    targetAggregateId: plan.aggregateId,
  });
  return decided(request, response);
}

/**
 * The MULTI-LEG variant of the same seam, for a command whose business effect spans two
 * aggregates. `legs[0]` is the primary and is built exactly as the single-aggregate path builds
 * its only leg, so the decision record a reader sees is identical in shape either way; the extra
 * legs are fenced and appended inside the SAME decision, which is what makes "one cannot survive
 * without the other" a property of the store rather than of a call site.
 *
 * Existing single-aggregate callers are deliberately NOT rerouted through this: they have no
 * second leg, and an empty `extraLegs` would only add a code path that never runs.
 */
export function commitAcceptedLegs(
  store: SqliteEventStore,
  request: BootstrapRequest,
  plan: CommitPlan,
  extraLegs: readonly ExpectedVersionDecisionLeg[],
): ServiceOutcome {
  return decided(request, store.commitExpectedVersionDecisionLegs({
    commandKind: request.kind,
    committedResultBytes: encoder.encode(JSON.stringify(plan.result)),
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    key: decisionKey(request),
    legs: [
      {
        aggregateId: plan.aggregateId, events: [eventDraft(request, plan)],
        expectedVersion: plan.expectedVersion,
      },
      ...extraLegs,
    ],
    requestBytes: requestBytesOf(request),
  }));
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
  // No same-bytes evidence, no replay: a refused decision's receipt commits the rejection audit
  // payload, so its `replayRequestSha256` is null and nothing here could prove the resubmit is
  // the command that was decided. Falling through is not a fail-open — the command is decided
  // again from scratch — and it must stay AHEAD of the byte compare below, which reads a digest
  // only an accepted decision carries.
  if (existing.effectDisposition !== "EFFECTS_COMMITTED") return null;
  // The key does not cover the payload either, so a caller reusing a commandId under the SAME
  // kind with DIFFERENT bytes would otherwise be handed the earlier result as an accepted
  // replay: authority for a command never decided with those bytes. The store's own conflict arm
  // cannot catch it, because this short-circuit answers before any store write. Recomputed from
  // the STORED decision's own fence, so the resubmitted bytes are the only free variable and a
  // match is byte equality — an honest replay still matches after its aggregates have advanced.
  if (identifyReplayRequest(existing, requestBytesOf(request)) !== existing.replayRequestSha256) {
    return refuse(request.kind, "BOOTSTRAP_COMMAND_BYTES_CONFLICT", "DAEMON_PREREQUISITE");
  }
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
