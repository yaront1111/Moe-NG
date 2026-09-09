import { POLICY_AUTO_APPROVAL_TIERS, evaluatePolicy } from "@moe/core";
import type { PolicyAutoApprovalTier, PolicyReasonCode, PolicyRiskTier } from "@moe/core";
import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { POLICY_EVALUATOR_VERSION } from "../bootstrap/bootstrap-policy-authority.js";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { installedSlices } from "../bootstrap/bootstrap-policy-services.js";
import { policyAggregateId } from "../bootstrap/bootstrap-sequence.js";
import { evaluationChain, resolvePolicyWaivers } from "../bootstrap/policy-fact-resolver.js";
import { readRunPolicyEvaluation } from "../bootstrap/run-policy-selection.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import { sliceKindOf } from "../http/policy-read.js";
import { RELEASE_DECIDE_COMMAND_KIND } from "./release-decide-contracts.js";

/**
 * GATE 3 CLOSING ON MACHINE EVIDENCE: whether the daemon may decide `release.decide` itself,
 * under a standing operator opt-in, with no human in the loop.
 *
 * IT DECIDES NOTHING THE POLICY ENGINE DECIDES. `evaluatePolicy` (@moe/core, bare specifier) is
 * the authority for tier ranking, opt-in matching and the dominance lattice, and none of those is
 * reimplemented here. This module owns four things: which installed slice is the chain, which
 * durable row grounds the subject's tier, composing the evaluation input the daemon's established
 * way, and reading the engine's verdict back into a NAMED provenance.
 *
 * THE NEWEST INSTALLED EVALUATION SLICE GOVERNS, and that is deliberately stricter than picking
 * whichever slice happens to declare this gate's opt-in. `foldSlices` returns the LAST slice's
 * `optIns` (policy-composition.ts:161-166), so an operator who installs a fresh policy carrying
 * no opt-in has turned automatic release OFF; selecting the declaring slice instead would keep it
 * on across a policy replacement the operator meant as a reset. `policy.install` appends
 * `{...current, [sliceRef]: slice}` under a hex64 ref, so insertion order IS install order.
 *
 * THE TIER IS THE RUN'S, READ THROUGH THE DAEMON'S OWN SELECTOR. `readRunPolicyEvaluation` is
 * run-scoped and replay-verified -- the same source `approval-record-facts.ts:215-231` consumes --
 * so no tier this module publishes was computed here. An absent row is a YIELD, never a default:
 * `assessTier` answers ALLOW for a null tier at its own layer, leaving only the HOLD_UNKNOWN fold
 * between an unclassified goal and an unattended release, and this module does not lean on that.
 *
 * IT THROWS NOTHING AND IT WRITES NOTHING. Every refusal is a RETURNED value: a declined
 * automatic decision is the gate staying pending for a human, which is what it did before.
 */

/**
 * Why no automatic decision was taken, mapped to the surface that answered. Named `..._MAP` for
 * the reason `release-decide-contracts.ts` gives at length: both security scanners key on a
 * declared name ending LAYER/LAYERS/BOUNDARIES immediately before the `=`, so a `..._LAYERS` tail
 * would demand a roster backfill for a boundary this module does not introduce. `"CORE_REDUCER"`
 * is the value the daemon already attributes an engine refusal to (bootstrap-policy-services.ts),
 * and the same literal Gate 2 uses; `"RELEASE_AUTO_DECISION"` is this module answering first.
 */
export const RELEASE_AUTO_CODE_LAYER_MAP = Object.freeze({
  /** CORE: the outcome was not ALLOW. The engine's own `reasonCodes` travel with this. */
  RELEASE_AUTO_NOT_ALLOWED: "CORE_REDUCER",
  /** ALLOW, but the selected slice names no opt-in for this action to record as provenance. */
  RELEASE_AUTO_OPT_IN_UNNAMEABLE: "RELEASE_AUTO_DECISION",
  /** CORE: the composed input was structurally rejected (INPUT_INVALID). */
  RELEASE_AUTO_POLICY_INPUT_INVALID: "CORE_REDUCER",
  /** No installed EVALUATION slice, so there is no chain to evaluate. */
  RELEASE_AUTO_POLICY_UNRESOLVED: "RELEASE_AUTO_DECISION",
  /** ALLOW, but the tier is outside `POLICY_AUTO_APPROVAL_TIERS`. Unreachable while the engine
   *  holds; kept so this module refuses on its own authority rather than on trust. */
  RELEASE_AUTO_TIER_UNCOVERED: "RELEASE_AUTO_DECISION",
  /** No replay-verified run-policy row grounds this goal's tier. */
  RELEASE_AUTO_TIER_UNRESOLVED: "RELEASE_AUTO_DECISION",
} as const);

export type ReleaseAutoCode = keyof typeof RELEASE_AUTO_CODE_LAYER_MAP;

/** Derived, never restated: the roster IS the map's key set, sorted for a stable order. */
export const RELEASE_AUTO_CODES: readonly ReleaseAutoCode[] = Object.freeze(
  (Object.keys(RELEASE_AUTO_CODE_LAYER_MAP) as ReleaseAutoCode[]).sort(),
);

/**
 * What the record NAMES: the engine's own matched action, and the ceiling it was declared at.
 *
 * `tier` is a `PolicyAutoApprovalTier`, NARROWER than the engine's four. `PolicyAutoApprovalOptIn`
 * in @moe/core is already R0|R1, but a durable slice is JSON and could carry an R2 ceiling; that
 * is not an auto-approval declaration, so it is UNNAMEABLE here and the gate declines rather than
 * recording provenance the operator never expressed.
 */
export interface ReleaseAutoOptIn {
  readonly action: string;
  readonly tier: PolicyAutoApprovalTier;
}

export interface ReleaseAutoApproved {
  readonly ok: true;
  readonly optIn: ReleaseAutoOptIn;
  readonly reasonCodes: readonly PolicyReasonCode[];
  readonly sliceRef: string;
  readonly subjectTier: PolicyRiskTier;
}

export interface ReleaseAutoDeclined {
  readonly code: ReleaseAutoCode;
  readonly layer: (typeof RELEASE_AUTO_CODE_LAYER_MAP)[ReleaseAutoCode];
  readonly ok: false;
  /** The ENGINE's own reason codes when core answered. Empty when this module answered first. */
  readonly reasonCodes: readonly PolicyReasonCode[];
}

export type ReleaseAutoApproval = ReleaseAutoApproved | ReleaseAutoDeclined;

/** One declination, with the layer DERIVED from the code, so no call site can pair them wrong. */
export function releaseAutoDecline(
  code: ReleaseAutoCode, reasonCodes: readonly PolicyReasonCode[] = [],
): ReleaseAutoDeclined {
  return Object.freeze({
    code, layer: RELEASE_AUTO_CODE_LAYER_MAP[code], ok: false as const,
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

export interface ReleaseAutoApprovalRequest {
  /** ISO-8601, bound server-side, never a payload value. */
  readonly decidedAt: string;
  readonly goalId: string;
  /** The configured operator principal: the actor the evaluation is composed for. */
  readonly operatorPrincipalId: string;
  readonly projectId: string;
}

/** The LAST digest-addressed installed EVALUATION slice, or nothing. Selection, not judgement. */
function newestEvaluationSlice(
  store: SqliteEventStore, projectId: string,
): { readonly ref: string; readonly slice: JsonValue } | null {
  let selected: { readonly ref: string; readonly slice: JsonValue } | null = null;
  let installed: Readonly<Record<string, JsonValue>>;
  try {
    installed = installedSlices(
      stateOf(readDurableLedger(store, projectId), policyAggregateId(projectId)),
    );
  } catch {
    return null;
  }
  for (const ref of Object.keys(installed)) {
    const slice = installed[ref];
    if (slice !== undefined && sliceKindOf(ref, slice) === "EVALUATION") selected = { ref, slice };
  }
  return selected;
}

/** The goal's replay-verified planning-run tier, or null. NOTHING here derives a tier. */
function subjectTierOf(
  store: SqliteEventStore, projectId: string, goalId: string,
): { readonly runId: string; readonly tier: PolicyRiskTier } | null {
  const goal = readCriterionGoal(store, projectId, goalId);
  if (!goal.ok) return null;
  const runId = goal.graph.planningRunRef;
  if (runId === undefined || runId === "") return null;
  const evaluation = readRunPolicyEvaluation(store, { projectId, runId });
  if (!evaluation.ok || evaluation.evaluation.riskTier === null) return null;
  return { runId, tier: evaluation.evaluation.riskTier };
}

/**
 * The opt-in the engine matched, looked up for NAMING only. `assessTier` already required
 * `entry.action === action` before it returned ALLOW, so this find re-derives no decision: it
 * recovers WHICH declaration the operator made, because `foldSlices` and `tierRank` are private
 * to @moe/core and the folded entry is unreachable from here.
 */
function nameableOptIn(slice: JsonValue): ReleaseAutoOptIn | null {
  if (slice === null || typeof slice !== "object" || Array.isArray(slice)) return null;
  const optIns = (slice as Readonly<Record<string, JsonValue>>)["autoApprovalOptIns"];
  if (!Array.isArray(optIns)) return null;
  for (const entry of optIns) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Readonly<Record<string, JsonValue>>;
    const tier = POLICY_AUTO_APPROVAL_TIERS.find((one) => one === record["tier"]);
    if (record["action"] === RELEASE_DECIDE_COMMAND_KIND && tier !== undefined) {
      return Object.freeze({ action: RELEASE_DECIDE_COMMAND_KIND, tier });
    }
  }
  return null;
}

/** Whether the daemon may release this goal itself, composed against the durable store. */
export function evaluateReleaseAutoApproval(
  store: SqliteEventStore, request: ReleaseAutoApprovalRequest,
): ReleaseAutoApproval {
  const { decidedAt, goalId, operatorPrincipalId, projectId } = request;
  const selected = newestEvaluationSlice(store, projectId);
  if (selected === null) return releaseAutoDecline("RELEASE_AUTO_POLICY_UNRESOLVED");
  const subject = subjectTierOf(store, projectId, goalId);
  if (subject === null) return releaseAutoDecline("RELEASE_AUTO_TIER_UNRESOLVED");
  const evaluatedAtEpochMs = Date.parse(decidedAt);
  if (!Number.isSafeInteger(evaluatedAtEpochMs) || evaluatedAtEpochMs < 0) {
    return releaseAutoDecline("RELEASE_AUTO_POLICY_INPUT_INVALID");
  }
  const chain = evaluationChain(selected.slice);
  const waivers = resolvePolicyWaivers(store, {
    authenticatedPrincipal: operatorPrincipalId,
    evaluatedAction: RELEASE_DECIDE_COMMAND_KIND,
    evaluatedAtEpochMs,
    installedPolicyRevisionRef: selected.ref,
    installedSliceChain: chain,
    projectId,
    scope: [goalId],
  });
  const evaluated = evaluatePolicy({
    action: RELEASE_DECIDE_COMMAND_KIND,
    actor: operatorPrincipalId,
    callerRiskHint: null,
    decisionDigest: "0".repeat(64),
    evaluatedAtEpochMs,
    evaluatorVersion: POLICY_EVALUATOR_VERSION,
    facts: [{
      factId: `release.run_policy_tier:${subject.runId}`,
      tier: subject.tier,
      truthClass: "DAEMON_VERIFIED",
    }],
    graphNodeRevisionRefs: [],
    policyRevisionRef: selected.ref,
    requiredFactIds: [],
    scope: [goalId],
    sliceChain: chain,
    waivers: waivers.waivers,
  });
  if (!evaluated.ok) return releaseAutoDecline("RELEASE_AUTO_POLICY_INPUT_INVALID");
  const { record } = evaluated;
  if (record.decision !== "ALLOW") {
    return releaseAutoDecline("RELEASE_AUTO_NOT_ALLOWED", record.reasonCodes);
  }
  // THE SECOND GATE, not redundant with ALLOW by design: it re-asks the ceiling question against
  // the IMPORTED frozen constant, so an upstream widening cannot silently widen this gate and an
  // engine regression that let an R2 subject through would still be refused here.
  const tier = record.riskAssessment.effectiveTier;
  if (tier === null || !POLICY_AUTO_APPROVAL_TIERS.some((one) => one === tier)) {
    return releaseAutoDecline("RELEASE_AUTO_TIER_UNCOVERED", record.reasonCodes);
  }
  const optIn = nameableOptIn(selected.slice);
  if (optIn === null) {
    return releaseAutoDecline("RELEASE_AUTO_OPT_IN_UNNAMEABLE", record.reasonCodes);
  }
  return Object.freeze({
    ok: true as const, optIn, reasonCodes: Object.freeze([...record.reasonCodes]),
    sliceRef: selected.ref, subjectTier: tier,
  });
}
