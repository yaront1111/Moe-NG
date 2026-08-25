import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { AdmissionGate } from "@moe/scheduler";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readPolicyEvaluationAuthority } from
  "../bootstrap/bootstrap-policy-authority-reader.js";
import type { PolicyEvaluationAuthorityRefused } from
  "../bootstrap/bootstrap-policy-authority-reader.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";

type PolicyAdmissionOwnCode =
  | "ADMISSION_GATE_POLICY_SOURCE_ABSENT"
  | "ADMISSION_GATE_SUBJECT_MISMATCH"
  | "ADMISSION_GATE_WITNESS_ABSENT";

interface PolicyAdmissionOwnRefused {
  readonly code: PolicyAdmissionOwnCode;
  readonly layer: "DAEMON_ADMISSION_GATE";
  readonly ok: false;
}

export type PolicyAdmissionReadResult =
  | { readonly gate: AdmissionGate; readonly ok: true }
  | PolicyAdmissionOwnRefused
  | PolicyEvaluationAuthorityRefused;

const refused = (code: PolicyAdmissionOwnCode): PolicyAdmissionOwnRefused => Object.freeze({
  code, layer: "DAEMON_ADMISSION_GATE" as const, ok: false as const,
});

function payloadOf(event: StoredEvent): JsonObject | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  const value: JsonValue | undefined = decoded.ok ? decoded.value : undefined;
  return value === null || value === undefined || typeof value !== "object"
    || Array.isArray(value) ? null : value as JsonObject;
}

function policyEvents(store: SqliteEventStore, aggregateId: string): readonly StoredEvent[] {
  try {
    return store.readEvents(aggregateId).filter((event) => event.aggregateId === aggregateId);
  } catch {
    return [];
  }
}

/**
 * Reads the newest sealed v2 decision for this exact subject and proves no later install reused
 * its address. A strictly verified foreign-subject row is skipped: one node's later evaluation
 * cannot mask another node's authority. An unreadable or unverifiable row is never skipped,
 * because its subject cannot be trusted; its exact fail-closed refusal remains authoritative.
 * New writers prohibit address reuse, while legacy/imported history fails closed.
 */
export function readPolicyAdmission(input: {
  readonly graphRevisionRef: string;
  readonly nodeKey: string;
  readonly policySliceHash: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}): PolicyAdmissionReadResult {
  const aggregateId = policyAggregateId(input.projectId);
  const events = policyEvents(input.store, aggregateId);
  let sawVerifiedForeignSubject = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate?.eventType !== "PolicyEvaluated") continue;
    const payload = payloadOf(candidate);
    if (payload === null) return refused("ADMISSION_GATE_POLICY_SOURCE_ABSENT");
    const authority = readPolicyEvaluationAuthority(
      payload, input.projectId, Date.parse(candidate.committedAt),
    );
    if (!authority.ok) return authority;
    if (authority.action !== "effect.activate"
      || authority.principalId !== input.principalId
      || authority.graphNodeRevisionRefs.length !== 1
      || authority.graphNodeRevisionRefs[0] !== input.graphRevisionRef
      || authority.scope.length !== 1
      || authority.scope[0] !== input.nodeKey
      || authority.policyRef !== input.policySliceHash) {
      sawVerifiedForeignSubject = true;
      continue;
    }
    for (const laterEvent of events.slice(index + 1)) {
      if (laterEvent.eventType !== "PolicyInstalled") continue;
      const installed = payloadOf(laterEvent);
      const installedRef = installed?.["sliceRef"];
      if (typeof installedRef !== "string" || installedRef === authority.sliceRef) {
        return refused("ADMISSION_GATE_WITNESS_ABSENT");
      }
    }
    return Object.freeze({
      gate: Object.freeze({
        allowance: Object.freeze({
          decisionRef: authority.decisionDigest,
          outcome: authority.decision,
        }),
        approval: null,
      }),
      ok: true as const,
    });
  }
  return refused(sawVerifiedForeignSubject
    ? "ADMISSION_GATE_SUBJECT_MISMATCH"
    : "ADMISSION_GATE_POLICY_SOURCE_ABSENT");
}
