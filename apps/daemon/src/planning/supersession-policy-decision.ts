import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readPolicyEvaluationAuthority } from
  "../bootstrap/bootstrap-policy-authority-reader.js";
import type { PolicyEvaluationAuthorityRefused } from
  "../bootstrap/bootstrap-policy-authority-reader.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";

export interface SupersessionPolicyDecision {
  readonly decisionDigest: string;
  readonly ok: true;
  readonly policyRef: string;
  readonly principalId: string;
  readonly scope: readonly string[];
}

type SupersessionPolicyDecisionCode =
  | "SUPERSESSION_POLICY_DECISION_ABSENT"
  | "SUPERSESSION_POLICY_DECISION_POLICY_REUSED"
  | "SUPERSESSION_POLICY_DECISION_SUBJECT_MISMATCH";

interface SupersessionPolicyDecisionRefused {
  readonly code: SupersessionPolicyDecisionCode;
  readonly layer: "DAEMON_SUPERSESSION_POLICY_DECISION";
  readonly ok: false;
}

export type SupersessionPolicyDecisionResult =
  | SupersessionPolicyDecision
  | SupersessionPolicyDecisionRefused
  | PolicyEvaluationAuthorityRefused;

const refused = (
  code: SupersessionPolicyDecisionCode,
): SupersessionPolicyDecisionRefused => Object.freeze({
  code, layer: "DAEMON_SUPERSESSION_POLICY_DECISION" as const, ok: false as const,
});

function payloadOf(event: StoredEvent): JsonObject | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  const value: JsonValue | undefined = decoded.ok ? decoded.value : undefined;
  return value === null || value === undefined || typeof value !== "object"
    || Array.isArray(value) ? null : value as JsonObject;
}

function policyEvents(store: SqliteEventStore, projectId: string): readonly StoredEvent[] {
  const aggregateId = policyAggregateId(projectId);
  try {
    return store.readEvents(aggregateId).filter((event) => event.aggregateId === aggregateId);
  } catch {
    return [];
  }
}

function isSupersessionSubject(
  action: string, refs: readonly string[], successorRevisionRef: string,
): boolean {
  return action === "graph.supersede"
    && refs.length === 1
    && refs[0] === successorRevisionRef;
}

function policyWasReused(
  events: readonly StoredEvent[], selectedIndex: number, sliceRef: string,
): boolean {
  for (const event of events.slice(selectedIndex + 1)) {
    if (event.eventType !== "PolicyInstalled") continue;
    const installedRef = payloadOf(event)?.["sliceRef"];
    if (typeof installedRef !== "string" || installedRef === sliceRef) return true;
  }
  return false;
}

export function readSupersessionPolicyDecision(
  store: SqliteEventStore,
  projectId: string,
  successorRevisionRef: string,
): SupersessionPolicyDecisionResult {
  const events = policyEvents(store, projectId);
  let sawVerifiedForeignSubject = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.eventType !== "PolicyEvaluated") continue;
    const payload = payloadOf(event);
    if (payload === null) return refused("SUPERSESSION_POLICY_DECISION_ABSENT");
    const authority = readPolicyEvaluationAuthority(
      payload, projectId, Date.parse(event.committedAt),
    );
    if (!authority.ok) return authority;
    if (!isSupersessionSubject(
      authority.action, authority.graphNodeRevisionRefs, successorRevisionRef,
    )) {
      sawVerifiedForeignSubject = true;
      continue;
    }
    if (policyWasReused(events, index, authority.sliceRef)) {
      return refused("SUPERSESSION_POLICY_DECISION_POLICY_REUSED");
    }
    return Object.freeze({
      decisionDigest: authority.decisionDigest,
      ok: true as const,
      policyRef: authority.policyRef,
      principalId: authority.principalId,
      scope: Object.freeze([...authority.scope]),
    });
  }
  return refused(sawVerifiedForeignSubject
    ? "SUPERSESSION_POLICY_DECISION_SUBJECT_MISMATCH"
    : "SUPERSESSION_POLICY_DECISION_ABSENT");
}
