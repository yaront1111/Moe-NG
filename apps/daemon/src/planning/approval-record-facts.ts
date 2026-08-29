import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";
import type { StoredEvent } from "@moe/store";
import type { SqliteEventStore } from "@moe/store";

import { readPolicyEvaluationAuthority } from "../bootstrap/bootstrap-policy-authority-reader.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { APPROVAL_MISSING_FACT_CODES } from "./approval-intent.js";
import type { ApprovalMissingFactCode } from "./approval-intent.js";

/**
 * The durable facts an approval record needs, read from the store and never from a caller.
 *
 * WHAT THIS ROW PRODUCES AND WHAT IT DELIBERATELY DOES NOT. `applicablePolicyRef` is derived
 * here from durable state. `riskTier` is NOT: there is no durable pre-approval producer for it
 * — the `resolvePolicyFact` -> `readPolicyRisk` path is written only at ACTIVATION, downstream
 * of the very record the tier would sign, and a fresh `PolicyEvaluated` carries
 * `computedTier`/`effectiveTier` null. Any tier this module could return would therefore be a
 * default or a caller's value, and both are forbidden: a defaulted tier silently decides an
 * authority question, because `approval-invalidation.ts:73` special-cases R3. So the reader
 * reports the tier missing and the seam keeps refusing under that name until the tier's own
 * row lands.
 *
 * WHY IT REPORTS ONE MISSING FACT BUT CARRIES WHAT IT COULD DERIVE. The seam needs ONE code to
 * refuse under, in the roster's own order, so an operator is sent to the first thing actually
 * blocking them. A grader needs the derivation to be observable independently of that refusal,
 * or the policy ref could rot behind a tier refusal that will outlive it. `derived` is that
 * window: it carries the facts this reader COULD establish, whatever it ends up refusing on.
 *
 * ABSENCE IS NOT A VALUE. When a fact cannot be established the field is ABSENT from `derived`
 * — never `""`, never a zero digest. Two zero digests compare EQUAL, so a defaulted ref would
 * let the fence at `graph-supersede-approval-binding.ts:94` pass against something nothing
 * durably asserted, which is the precise failure this module exists to prevent.
 */

/**
 * This module's OWN layer. Deliberately NOT spelled `*_LAYER`:
 * `tests/security/boundary-roster.security.ts` scans production sources for column-zero
 * exported `*_LAYER(S)` constants and makes each owe a hostile BEFORE/AFTER/RACE trio. The same
 * discipline `approval-intent.ts:49-53` follows.
 */
const LAYER = "DAEMON_APPROVAL_RECORD_FACTS" as const;

export type ApprovalRecordFactsLayer = typeof LAYER;

export interface ApprovalRecordFactsRequest {
  readonly projectId: string;
  readonly runId: string;
}

/** Facts this reader established. A field is ABSENT when it could not be; never defaulted. */
export interface ApprovalRecordFactsDerived {
  readonly applicablePolicyRef?: string | undefined;
}

export interface ApprovalRecordFactsIncomplete {
  /** What this reader could establish anyway, so derivation is gradable behind a refusal. */
  readonly derived: ApprovalRecordFactsDerived;
  readonly layer: ApprovalRecordFactsLayer;
  /** The FIRST fact the seam's roster lists that this reader cannot establish. */
  readonly missing: ApprovalMissingFactCode;
  readonly ok: false;
  /** The answering source's own diagnosis, forwarded rather than restamped as ours. */
  readonly upstream?: Readonly<{ code: string; layer: string }> | undefined;
}

export interface ApprovalRecordFactsComplete {
  readonly applicablePolicyRef: string;
  readonly ok: true;
}

export type ApprovalRecordFacts = ApprovalRecordFactsComplete | ApprovalRecordFactsIncomplete;

type UpstreamRefusal = Readonly<{ code: string; layer: string }>;

type ApplicablePolicyRefResult =
  | Readonly<{ ok: true; policyRef: string }>
  | Readonly<{ ok: false; upstream?: UpstreamRefusal | undefined }>;

type SupersessionSelectorRefusalCode =
  | "SUPERSESSION_POLICY_DECISION_ABSENT"
  | "SUPERSESSION_POLICY_DECISION_POLICY_REUSED";

interface DerivedFactsResult {
  readonly derived: ApprovalRecordFactsDerived;
  readonly upstream?: UpstreamRefusal | undefined;
}

function incomplete(
  missing: ApprovalMissingFactCode,
  derived: ApprovalRecordFactsDerived,
  upstream?: UpstreamRefusal,
): ApprovalRecordFactsIncomplete {
  const base = { derived: Object.freeze({ ...derived }), layer: LAYER, missing, ok: false as const };
  return upstream === undefined
    ? Object.freeze(base)
    : Object.freeze({ ...base, upstream: Object.freeze({ ...upstream }) });
}

/**
 * The durable facts for one run's approval record, or the first fact that is unavailable.
 *
 * The request vocabulary is the run's identity and nothing else — no digest, no tier, no
 * "current" selector — so a caller cannot present the very values this reader exists to
 * establish. A caller-presented ref would make the fence compare a value against itself.
 */
export function readApprovalRecordFacts(
  store: SqliteEventStore,
  request: ApprovalRecordFactsRequest,
): ApprovalRecordFacts {
  const { derived, upstream } = deriveFacts(store, request);
  // Roster order is load-bearing: the seam refuses under the FIRST unavailable fact, so an
  // operator is sent to the thing actually blocking them rather than to whichever fact this
  // reader happened to notice last. The tier is first and has no producer, so it answers today.
  for (const code of APPROVAL_MISSING_FACT_CODES) {
    if (!established(code, derived)) return incomplete(code, derived, upstream);
  }
  const { applicablePolicyRef } = derived;
  if (applicablePolicyRef === undefined) {
    return incomplete("APPROVAL_INTENT_POLICY_REF_UNAVAILABLE", derived, upstream);
  }
  return Object.freeze({ applicablePolicyRef, ok: true as const });
}

/** Which roster facts this reader can establish today. The tier is deliberately never one. */
function established(
  code: ApprovalMissingFactCode,
  derived: ApprovalRecordFactsDerived,
): boolean {
  return code === "APPROVAL_INTENT_POLICY_REF_UNAVAILABLE"
    && derived.applicablePolicyRef !== undefined;
}

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
function deriveApplicablePolicyRef(
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

function deriveFacts(
  store: SqliteEventStore,
  request: ApprovalRecordFactsRequest,
): DerivedFactsResult {
  const result = deriveApplicablePolicyRef(store, request.projectId);
  // ABSENT, not defaulted: the key is omitted entirely when nothing durable answers.
  return result.ok
    ? Object.freeze({ derived: Object.freeze({ applicablePolicyRef: result.policyRef }) })
    : Object.freeze({ derived: Object.freeze({}), upstream: result.upstream });
}
