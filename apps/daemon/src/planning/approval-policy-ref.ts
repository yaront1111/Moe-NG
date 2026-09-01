import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readPolicyEvaluationAuthority } from "../bootstrap/bootstrap-policy-authority-reader.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";

/**
 * The DURABLE POLICY REF half of the approval record facts (split out of
 * `approval-record-facts.ts` by task-3b61860f when the roster walk pushed that file past the
 * 250-line bar). The seam is a real responsibility line, not an arbitrary cut: everything here
 * answers "which policy authority does durable state assert for this project", while
 * `approval-record-facts.ts` keeps "which roster fact is missing and what does the reader hand
 * back". Nothing here reads a caller value, a clock or a file.
 */

/** The answering source's own diagnosis, forwarded by the reader rather than restamped. */
export type UpstreamRefusal = Readonly<{ code: string; layer: string }>;

type ApplicablePolicyRefResult =
  | Readonly<{ ok: true; policyRef: string }>
  | Readonly<{ ok: false; upstream?: UpstreamRefusal | undefined }>;

type SupersessionSelectorRefusalCode =
  | "SUPERSESSION_POLICY_DECISION_ABSENT"
  | "SUPERSESSION_POLICY_DECISION_POLICY_REUSED";

function policyEvents(store: SqliteEventStore, projectId: string): readonly StoredEvent[] {
  const aggregateId = policyAggregateId(projectId);
  try {
    return store.readEvents(aggregateId).filter((event) => event.aggregateId === aggregateId);
  } catch {
    return [];
  }
}

function policyPayload(event: StoredEvent): JsonObject | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  const value: JsonValue | undefined = decoded.ok ? decoded.value : undefined;
  return value === null || value === undefined || typeof value !== "object"
    || Array.isArray(value) ? null : value as JsonObject;
}

function policyWasReused(
  events: readonly StoredEvent[], selectedIndex: number, sliceRef: string,
): boolean {
  for (const event of events.slice(selectedIndex + 1)) {
    if (event.eventType !== "PolicyInstalled") continue;
    const installedRef = policyPayload(event)?.["sliceRef"];
    if (typeof installedRef !== "string" || installedRef === sliceRef) return true;
  }
  return false;
}

function supersessionRefusal(code: SupersessionSelectorRefusalCode): ApplicablePolicyRefResult {
  return Object.freeze({
    ok: false as const,
    upstream: Object.freeze({ code, layer: "DAEMON_SUPERSESSION_POLICY_DECISION" }),
  });
}

/**
 * The policy ref of the NEWEST REPLAY-VERIFIED `PolicyEvaluated` for this project.
 *
 * THE SELECTION IS THE ONE PRODUCTION ALREADY TRUSTS. `readSupersessionPolicyDecision`
 * (supersession-policy-decision.ts:76-112) walks the project's policy events NEWEST-FIRST. Its
 * newest `PolicyEvaluated` candidate must bounded-decode and independently replay through
 * `readPolicyEvaluationAuthority`; a decode or authority refusal hard-stops rather than falling
 * back to stale authority. A later `PolicyInstalled` that reuses the selected slice also
 * refuses. This mirrors that rule and reads `policyRef` off the very same verified authority,
 * which is what makes this the SAME notion the fence at
 * graph-supersede-approval-binding.ts:94 compares against rather than a third one.
 *
 * THE ONE THING IT DOES NOT MIRROR, deliberately: that function additionally requires the
 * decision's SUBJECT to be a `graph.supersede` over one matching successor ref
 * (supersession-policy-decision.ts:57-62). A plan approval is never a supersede subject — the
 * harness's verified decision is `action: "plan.approve"` with no refs — so applying that
 * filter here would refuse every honest plan approval. It is a fence pointed at a different
 * question, not a stricter one.
 *
 * It is NEVER `approvalPolicyHash(approvalPolicyMaterial(...))`: that digest answers the
 * activation binding's separately-versioned question, and no production path compares it, so
 * deriving from it would invent a third notion that agrees today and drifts tomorrow.
 */
export function deriveApplicablePolicyRef(
  store: SqliteEventStore,
  projectId: string,
): ApplicablePolicyRefResult {
  const events = policyEvents(store, projectId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.eventType !== "PolicyEvaluated") continue;
    const payload = policyPayload(event);
    if (payload === null) return supersessionRefusal("SUPERSESSION_POLICY_DECISION_ABSENT");
    const authority = readPolicyEvaluationAuthority(
      payload, projectId, Date.parse(event.committedAt),
    );
    if (!authority.ok) {
      return Object.freeze({
        ok: false as const,
        upstream: Object.freeze({ code: authority.code, layer: authority.layer }),
      });
    }
    if (policyWasReused(events, index, authority.sliceRef)) {
      return supersessionRefusal("SUPERSESSION_POLICY_DECISION_POLICY_REUSED");
    }
    return Object.freeze({ ok: true as const, policyRef: authority.policyRef });
  }
  return Object.freeze({ ok: false as const });
}

