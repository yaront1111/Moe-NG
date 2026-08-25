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
 * Reads the latest sealed v2 policy decision and proves no later install reused its address.
 * The v2 temporal cutover is owned by the strict reader: its exact refusal passes through with
 * the DAEMON_POLICY_AUTHORITY layer, while missing/unreadable event selection is this boundary's
 * own source-absence refusal. New writers prohibit reuse; legacy/imported history fails closed.
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
  let latestIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.eventType === "PolicyEvaluated") latestIndex = index;
  }
  const latest = events[latestIndex];
  if (latest === undefined) return refused("ADMISSION_GATE_POLICY_SOURCE_ABSENT");
  const payload = payloadOf(latest);
  if (payload === null) return refused("ADMISSION_GATE_POLICY_SOURCE_ABSENT");
  const authority = readPolicyEvaluationAuthority(
    payload, input.projectId, Date.parse(latest.committedAt),
  );
  if (!authority.ok) return authority;
  if (authority.action !== "effect.activate"
    || authority.principalId !== input.principalId
    || authority.graphNodeRevisionRefs.length !== 1
    || authority.graphNodeRevisionRefs[0] !== input.graphRevisionRef
    || authority.scope.length !== 1
    || authority.scope[0] !== input.nodeKey
    || authority.policyRef !== input.policySliceHash) {
    return refused("ADMISSION_GATE_SUBJECT_MISMATCH");
  }
  for (const event of events.slice(latestIndex + 1)) {
    if (event.eventType !== "PolicyInstalled") continue;
    const installed = payloadOf(event);
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
