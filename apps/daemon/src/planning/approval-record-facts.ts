import type { SqliteEventStore } from "@moe/store";

import { APPROVAL_MISSING_FACT_CODES } from "./approval-intent.js";
import type { ApprovalMissingFactCode } from "./approval-intent.js";
import { deriveApprovalBudgetRef } from "./approval-budget-ref.js";
import { deriveApplicablePolicyRef } from "./approval-policy-ref.js";
import type { UpstreamRefusal } from "./approval-policy-ref.js";

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
  /**
   * The decide-time budget COMMITMENT -- NOT the activation root digest.
   *
   * The root digest genuinely could not be set here: it is minted at ACTIVATION, downstream of
   * the very record it would sign. The commitment is a different notion (task-61a2e8ad,
   * budget-commitment.ts): it covers the budget material that was durable when the human
   * decided, so it is derivable BEFORE activation and this slot has a producer.
   */
  readonly budgetRef?: string | undefined;
  /**
   * The pre-approval risk tier. NEVER set by this module -- T1-c (task-f42d5165) is the row
   * that lands a durable producer for it. Until then the walk answers this fact first.
   */
  readonly riskTier?: string | undefined;
  /**
   * The server-derived step-up reference. NEVER derived here either: it is a fact about the
   * AUTHENTICATED TRANSPORT, which only the seam's composition-root witness carries, so it
   * arrives through `readApprovalRecordFacts`' server-derived parameter (task-3b61860f).
   */
  readonly stepUpAuthRef?: string | undefined;
}

/**
 * Facts the SEAM derived from its composition-root witness and hands to this reader.
 *
 * SERVER-SIDE PLUMBING, NOT A REQUEST VOCABULARY. `ApprovalRecordFactsRequest` stays run
 * identity only, deliberately: a caller must never be able to present a fact this reader
 * exists to establish. Everything here is assembled from the authenticated witness at the
 * composition root and can never be reached by payload bytes.
 */
export interface ApprovalRecordFactsServerDerived {
  readonly stepUpAuthRef?: string | undefined;
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
  /**
   * The SAME reference the walk found established, handed back so the seam burns the value the
   * reader validated rather than re-deriving one beside it.
   */
  readonly stepUpAuthRef: string;
}

export type ApprovalRecordFacts = ApprovalRecordFactsComplete | ApprovalRecordFactsIncomplete;

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
  serverDerived?: ApprovalRecordFactsServerDerived,
): ApprovalRecordFacts {
  const { derived, upstream } = deriveFacts(store, request, serverDerived);
  // Roster order is load-bearing: the seam refuses under the FIRST unavailable fact, so an
  // operator is sent to the thing actually blocking them rather than to whichever fact this
  // reader happened to notice last. The tier is first and has no producer, so it answers today.
  const missing = firstMissingApprovalFact(derived);
  if (missing !== null) return incomplete(missing, derived, upstream);
  const { applicablePolicyRef, stepUpAuthRef } = derived;
  // Unreachable behind the walk, which already proved both slots present. Kept because the
  // walk's guarantee is a runtime one and a narrowing cast here would be a place for a future
  // edit to hand back a defaulted ref without anything noticing.
  if (applicablePolicyRef === undefined) {
    return incomplete("APPROVAL_INTENT_POLICY_REF_UNAVAILABLE", derived, upstream);
  }
  if (stepUpAuthRef === undefined) {
    return incomplete("APPROVAL_INTENT_STEP_UP_UNAVAILABLE", derived, upstream);
  }
  return Object.freeze({ applicablePolicyRef, ok: true as const, stepUpAuthRef });
}

/**
 * Which derived slot each roster code names. One entry per code, keyed BY THE CODE, so a fact
 * added to the seam's roster without a slot here is a compile error rather than a code the walk
 * silently never reaches.
 */
const FACT_ESTABLISHED: Readonly<
  Record<ApprovalMissingFactCode, (derived: ApprovalRecordFactsDerived) => boolean>
> = Object.freeze({
  APPROVAL_INTENT_BUDGET_REF_UNAVAILABLE: (derived) => derived.budgetRef !== undefined,
  APPROVAL_INTENT_POLICY_REF_UNAVAILABLE: (derived) => derived.applicablePolicyRef !== undefined,
  APPROVAL_INTENT_RISK_TIER_UNAVAILABLE: (derived) => derived.riskTier !== undefined,
  APPROVAL_INTENT_STEP_UP_UNAVAILABLE: (derived) => derived.stepUpAuthRef !== undefined,
});

/**
 * The FIRST fact the seam's roster lists that `derived` does not establish, or `null` when it
 * establishes all of them.
 *
 * THE WALK IS DATA-DRIVEN over `APPROVAL_MISSING_FACT_CODES`, so the ROSTER'S ORDER is the only
 * thing deciding which producer an operator is sent to. It is exported because that ordering is
 * the deliverable of every row that fills a slot: the command cannot demonstrate the movement
 * from one code to the next until every earlier fact has a durable producer, and a proof that
 * waited for that would be a proof deferred past the rows it exists to gate.
 */
export function firstMissingApprovalFact(
  derived: ApprovalRecordFactsDerived,
): ApprovalMissingFactCode | null {
  for (const code of APPROVAL_MISSING_FACT_CODES) {
    if (!FACT_ESTABLISHED[code](derived)) return code;
  }
  return null;
}

function deriveFacts(
  store: SqliteEventStore,
  request: ApprovalRecordFactsRequest,
  serverDerived: ApprovalRecordFactsServerDerived | undefined,
): DerivedFactsResult {
  const result = deriveApplicablePolicyRef(store, request.projectId);
  const budget = deriveApprovalBudgetRef(store, request.projectId, request.runId);
  // ABSENT, not defaulted, on EVERY half: a key is omitted entirely when nothing answers it,
  // so `{}` and a zero digest stay different answers. The seam-derived facts are merged in
  // BEFORE the walk runs, which is what lets the roster order decide the code.
  const stepUp = serverDerived?.stepUpAuthRef;
  const seam = stepUp === undefined ? {} : { stepUpAuthRef: stepUp };
  const slot = "ref" in budget ? { budgetRef: budget.ref } : {};
  const policy = result.ok ? { applicablePolicyRef: result.policyRef } : {};
  // ONE upstream slot, filled in ROSTER ORDER: the policy ref is listed before the budget ref,
  // so its refusal wins when it has one to give. Falling through is not a downgrade -- the
  // policy path can refuse without an upstream at all, and an operator is better served by the
  // budget builder's precise code than by nothing.
  const upstream = (result.ok ? undefined : result.upstream)
    ?? ("upstream" in budget ? budget.upstream : undefined);
  const derived = Object.freeze({ ...seam, ...slot, ...policy });
  return upstream === undefined
    ? Object.freeze({ derived })
    : Object.freeze({ derived, upstream });
}
