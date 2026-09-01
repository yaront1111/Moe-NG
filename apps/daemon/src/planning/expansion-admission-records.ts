/**
 * The durable record of ONE approved expansion binding: the proposal identity the scheduler
 * admission minted, the preparation identity core froze, and the approval identity core's manual
 * approval bound — and NOTHING ELSE.
 *
 * WHY EXACTLY THREE MEMBERS. Fewer makes the binding unverifiable: each identity is a digest
 * over its own inputs, so a reader can re-derive and compare only the ones that are present.
 * More is scope leak, and the leak is not cosmetic — a stored copy of the admitted facts, the
 * funding facts or the decided approval record would be a SECOND authority beside the identity
 * that covers it, and the second one is the one a later reader would trust without re-deriving.
 * The decoder enforces the arity in both directions, so a record with a fourth member decodes as
 * nothing at all.
 *
 * WHY `expectedVersion: 0`. One ACTIVE hold mints at most one approved binding. A second
 * decision naming the same hold is fenced by the store and refused, rather than overwriting the
 * first — an approved expansion that could be silently replaced is exactly the stale authority
 * this slice exists to prevent.
 *
 * WHAT IT DOES NOT WRITE. No child run, lease, effect, resource, slot, graph mutation or
 * activation. This slice ends at the binding; atomic child activation is a separate capability.
 */

import { DurableStoreError } from "@moe/store";
import type { CommandDecisionResponse, SqliteEventStore } from "@moe/store";

import {
  expansionAdmissionRefusal, upstreamFace,
} from "./expansion-admission-contracts.js";
import type { ExpansionAdmissionRefusal } from "./expansion-admission-contracts.js";

export const EXPANSION_APPROVAL_EVENT_TYPE = "ExpansionApprovalBindingRecorded";
export const EXPANSION_APPROVAL_AGGREGATE_NAMESPACE = "expansion-approval";
export const EXPANSION_APPROVAL_COMMAND_KIND = "graph.admit_expansion";

/** The complete record. Exact arity, checked on the way in and on the way out. */
export const EXPANSION_APPROVAL_RECORD_KEYS = Object.freeze([
  "approvalIdentity", "preparationIdentity", "proposalIdentity",
] as const);

export interface ExpansionApprovalRecord {
  readonly approvalIdentity: string;
  readonly preparationIdentity: string;
  readonly proposalIdentity: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function expansionApprovalAggregatePrefix(projectId: string): string {
  return `${EXPANSION_APPROVAL_AGGREGATE_NAMESPACE}:${projectId}:`;
}

export function expansionApprovalAggregateId(projectId: string, holdId: string): string {
  return `${expansionApprovalAggregatePrefix(projectId)}${holdId}`;
}

export function expansionApprovalEventId(commandId: string): string {
  return `${commandId}:expansion-approval`;
}

export function encodeExpansionApprovalRecord(record: ExpansionApprovalRecord): Uint8Array {
  return encoder.encode(JSON.stringify({
    approvalIdentity: record.approvalIdentity,
    preparationIdentity: record.preparationIdentity,
    proposalIdentity: record.proposalIdentity,
  }));
}

function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key))
    ? value as Record<string, unknown> : null;
}

/** Returns the three identities, or `null` for bytes carrying anything more, less or other. */
export function decodeExpansionApprovalRecord(
  bytes: Uint8Array,
): ExpansionApprovalRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return null;
  }
  const record = exactly(parsed, EXPANSION_APPROVAL_RECORD_KEYS);
  if (record === null) return null;
  if (!EXPANSION_APPROVAL_RECORD_KEYS.every(
    (key) => typeof record[key] === "string" && (record[key] as string).length > 0,
  )) return null;
  return Object.freeze({
    approvalIdentity: record["approvalIdentity"] as string,
    preparationIdentity: record["preparationIdentity"] as string,
    proposalIdentity: record["proposalIdentity"] as string,
  });
}

export interface ExpansionApprovalCommitInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly holdId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly record: ExpansionApprovalRecord;
  readonly requestBytes: Uint8Array;
}

export type ExpansionApprovalCommitResult =
  | {
    readonly aggregateId: string;
    readonly decision: CommandDecisionResponse;
    readonly disposition: "DECIDED" | "REPLAYED";
    readonly ok: true;
  }
  | ExpansionAdmissionRefusal;

function refuseThrown(error: unknown, aggregateId: string): ExpansionAdmissionRefusal {
  if (!(error instanceof DurableStoreError)) {
    return expansionAdmissionRefusal("EXPANSION_ADMISSION_RECORD_UNAVAILABLE");
  }
  const face = upstreamFace(error.code, "DURABLE_STORE",
    { component: "DURABLE_STORE", target: aggregateId });
  if (error.code === "EXPECTED_VERSION_CONFLICT" || error.code === "DURABLE_ID_CONFLICT"
    || error.code === "IDEMPOTENCY_CONFLICT") {
    return expansionAdmissionRefusal("EXPANSION_ADMISSION_RECORD_CONFLICT", face);
  }
  return expansionAdmissionRefusal("EXPANSION_ADMISSION_RECORD_UNAVAILABLE", face);
}

/** Commits the ONE approved binding for a hold, or names exactly why it could not. */
export function commitExpansionApproval(
  store: SqliteEventStore,
  input: ExpansionApprovalCommitInput,
): ExpansionApprovalCommitResult {
  const aggregateId = expansionApprovalAggregateId(input.projectId, input.holdId);
  const payload = encodeExpansionApprovalRecord(input.record);
  let response: CommandDecisionResponse;
  try {
    response = store.commitExpectedVersionDecisionLegs({
      commandKind: EXPANSION_APPROVAL_COMMAND_KIND,
      committedResultBytes: payload,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt,
      key: {
        commandId: input.commandId,
        principalId: input.principalId,
        projectId: input.projectId,
      },
      legs: [{
        aggregateId,
        events: [{
          eventId: expansionApprovalEventId(input.commandId),
          eventType: EXPANSION_APPROVAL_EVENT_TYPE,
          payload,
        }],
        expectedVersion: 0,
      }],
      requestBytes: input.requestBytes,
    });
  } catch (error) {
    return refuseThrown(error, aggregateId);
  }
  // A fenced decision is RETURNED, not thrown: the store writes a NO_BUSINESS_EFFECT record and
  // appends nothing. Reading "it did not throw" as success is how a second binding would be
  // reported as recorded while no event was written at all.
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return expansionAdmissionRefusal("EXPANSION_ADMISSION_RECORD_CONFLICT",
      upstreamFace(response.decision.resultCode, "DURABLE_STORE",
        { component: "DURABLE_STORE", target: aggregateId }));
  }
  return Object.freeze({
    aggregateId, decision: response, disposition: response.disposition, ok: true as const,
  });
}
