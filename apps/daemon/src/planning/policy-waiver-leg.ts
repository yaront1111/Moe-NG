import type { ExpectedVersionDecisionLeg, SqliteEventStore, StoredEvent } from "@moe/store";

import {
  DAEMON_POLICY_WAIVER, POLICY_WAIVER_EVENT_TYPES,
  buildPolicyWaiverGrant, buildPolicyWaiverRevoke, decodePolicyWaiverRecord,
  policyWaiverAggregateIdFor, policyWaiverRefusal, policyWaiverTupleKeyFor,
  type PolicyWaiverGrantInput, type PolicyWaiverGrantRecord,
  type PolicyWaiverRecordCode, type PolicyWaiverRefusal,
  type PolicyWaiverRevokeInput, type PolicyWaiverWriterCode,
} from "../bootstrap/policy-waiver-record.js";

export type PolicyWaiverGrantSemanticInput = Omit<PolicyWaiverGrantInput, "supersedesWaiverRef">;
export type PolicyWaiverRevokeSemanticInput = Omit<PolicyWaiverRevokeInput, "revokedWaiverRef">;
export type PolicyWaiverLegInput = Readonly<
  | { expectedVersion: number; kind: "GRANT"; value: PolicyWaiverGrantSemanticInput }
  | { expectedVersion: number; kind: "REVOKE"; value: PolicyWaiverRevokeSemanticInput }
>;

export interface FoldedPolicyWaiverGrant {
  readonly record: Readonly<PolicyWaiverGrantRecord>;
  readonly revoked: boolean;
  readonly superseded: boolean;
}
export interface PolicyWaiverFoldAccepted {
  readonly aggregateId: string;
  readonly grants: readonly Readonly<FoldedPolicyWaiverGrant>[];
  readonly observedVersion: number;
  readonly ok: true;
}
type FoldRefusalCode = PolicyWaiverRecordCode | "POLICY_WAIVER_RECORD_MISSING";
export type PolicyWaiverFoldResult = PolicyWaiverFoldAccepted | PolicyWaiverRefusal<FoldRefusalCode>;
export interface PolicyWaiverLegAccepted {
  readonly leg: ExpectedVersionDecisionLeg;
  readonly ok: true;
}
type LegRefusalCode = FoldRefusalCode | PolicyWaiverWriterCode;
export type PolicyWaiverLegResult = PolicyWaiverLegAccepted | PolicyWaiverRefusal<LegRefusalCode>;
export type PolicyWaiverEventReader = Pick<SqliteEventStore, "readEvents">;

interface MutableGrant {
  record: Readonly<PolicyWaiverGrantRecord>;
  revoked: boolean;
  superseded: boolean;
}

const unreadable = () => policyWaiverRefusal("POLICY_WAIVER_RECORD_UNREADABLE");
const conflict = () => policyWaiverRefusal("POLICY_WAIVER_RECORD_CONFLICT");

function eventRecord(event: StoredEvent) {
  if (!POLICY_WAIVER_EVENT_TYPES.some((value) => value === event.eventType)) return null;
  return event.eventType === "PolicyWaiverGranted.v1"
    ? decodePolicyWaiverRecord(event.eventType, event.payload)
    : decodePolicyWaiverRecord("PolicyWaiverRevoked.v1", event.payload);
}

function historyShapeAccepted(
  aggregateId: string, event: StoredEvent, index: number, eventIds: Set<string>,
): boolean {
  if (event.aggregateId !== aggregateId || event.aggregateSequence !== index + 1
    || eventIds.has(event.eventId)) return false;
  eventIds.add(event.eventId);
  return true;
}

function freezeFold(aggregateId: string, grants: readonly MutableGrant[], observedVersion: number):
PolicyWaiverFoldAccepted {
  const snapshot = Object.freeze(grants.map(({ record, revoked, superseded }) =>
    Object.freeze({ record, revoked, superseded })));
  return Object.freeze({ aggregateId, grants: snapshot, observedVersion, ok: true as const });
}

export function foldPolicyWaiverEvents(
  aggregateId: string, events: readonly StoredEvent[],
): PolicyWaiverFoldResult {
  const eventIds = new Set<string>();
  const approvalRefs = new Set<string>();
  const waiverRefs = new Set<string>();
  const latest = new Map<string, number>();
  const grants: MutableGrant[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined || !historyShapeAccepted(aggregateId, event, index, eventIds)) return unreadable();
    const decoded = eventRecord(event);
    if (decoded === null || !decoded.ok
      || policyWaiverAggregateIdFor(decoded.record) !== aggregateId
      || approvalRefs.has(decoded.record.humanApprovalRef)) return unreadable();
    approvalRefs.add(decoded.record.humanApprovalRef);
    const tupleKey = policyWaiverTupleKeyFor(decoded.record);
    const priorIndex = latest.get(tupleKey);
    const prior = priorIndex === undefined ? undefined : grants[priorIndex];
    if (event.eventType === "PolicyWaiverGranted.v1") {
      if (!("waiverRef" in decoded.record) || waiverRefs.has(decoded.record.waiverRef)) return unreadable();
      if (decoded.record.supersedesWaiverRef !== (prior?.record.waiverRef ?? null)) return conflict();
      waiverRefs.add(decoded.record.waiverRef);
      // Revocation ends authority, not lineage: the next grant still supersedes this predecessor.
      if (prior !== undefined) prior.superseded = true;
      latest.set(tupleKey, grants.length);
      grants.push({ record: decoded.record, revoked: false, superseded: false });
    } else {
      if (!("revokedWaiverRef" in decoded.record)) return unreadable();
      if (prior === undefined) return policyWaiverRefusal("POLICY_WAIVER_RECORD_MISSING");
      if (prior.revoked || decoded.record.revokedWaiverRef !== prior.record.waiverRef) return conflict();
      prior.revoked = true;
    }
  }
  return freezeFold(aggregateId, grants, events.length);
}

function currentGrant(
  folded: PolicyWaiverFoldAccepted, value: PolicyWaiverLegInput["value"],
): Readonly<FoldedPolicyWaiverGrant> | undefined {
  const key = policyWaiverTupleKeyFor(value);
  return folded.grants.findLast((candidate) =>
    !candidate.superseded && policyWaiverTupleKeyFor(candidate.record) === key);
}

function buildRecord(folded: PolicyWaiverFoldAccepted, input: PolicyWaiverLegInput) {
  const current = currentGrant(folded, input.value);
  if (input.kind === "GRANT") {
    return buildPolicyWaiverGrant({ ...input.value,
      supersedesWaiverRef: current?.record.waiverRef ?? null });
  }
  if (current === undefined) return policyWaiverRefusal("POLICY_WAIVER_RECORD_MISSING");
  if (current.revoked) return conflict();
  return buildPolicyWaiverRevoke({ ...input.value, revokedWaiverRef: current.record.waiverRef });
}

/** The fold and expectedVersion share this one read; no later probe can race it. */
export function buildPolicyWaiverLeg(
  store: PolicyWaiverEventReader, input: PolicyWaiverLegInput,
): PolicyWaiverLegResult {
  const aggregateId = policyWaiverAggregateIdFor(input.value);
  let events: readonly StoredEvent[];
  try { events = Object.freeze(Array.from(store.readEvents(aggregateId))); }
  catch { return unreadable(); }
  const folded = foldPolicyWaiverEvents(aggregateId, events);
  if (!folded.ok) return folded;
  if (input.expectedVersion !== folded.observedVersion) {
    return policyWaiverRefusal("POLICY_WAIVER_EXPECTED_VERSION_CONFLICT");
  }
  const built = buildRecord(folded, input);
  if (!built.ok) return built;
  const event = Object.freeze({ eventId: `${input.value.commandId}-${built.eventType}`,
    eventType: built.eventType, payload: built.bytes });
  const leg = Object.freeze({ aggregateId, events: Object.freeze([event]),
    expectedVersion: folded.observedVersion });
  return Object.freeze({ leg, ok: true as const });
}

export { DAEMON_POLICY_WAIVER };
