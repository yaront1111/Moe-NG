/**
 * THE DEMO SEED'S POLICY SLICES: the validatable evaluation slice, the reviewer calibration, and
 * the verifier's own evaluation input.
 *
 * Split out of `demo-seed-payloads.ts` (task-a888038d) because that file was already 411 lines,
 * past the 400 split threshold, before this row added the risk-classification table it now needs.
 * Fix by SUBTRACTION: these three bodies are one concern — what the seed DECLARES about policy —
 * and nothing else in the payload module reads them. `demo-seed-payloads.ts` re-exports them, so
 * no consumer's import moves.
 *
 * No clock and no random id here either: two builds over one input are byte-identical, as the
 * demo seed promises.
 */
import { derivePolicySliceDigest } from "@moe/core";

import { REVIEWER_CALIBRATION_SLICE_REF } from "../review/reviewer-calibration-record.js";
import { VERIFIER_POLICY_SLICE_REF } from "../review/verifier-authority-provider.js";
import { NODE_VERIFIER_PRINCIPAL_ID } from "../review/verifier-receipt-contracts.js";
import type { DemoSeedInput } from "./demo-seed-plan.js";

const DEMO_VERIFIED = "DAEMON_VERIFIED" as const;
/**
 * The verifier's ACTION and the risk tier the demo claims for it. Both are pinned as literals
 * because neither is exported: `verifier-authority-provider.ts` and `verifier-receipt-contracts.ts`
 * hold their own private `"integration.accept_output"` and compare the EVALUATED record against
 * it twice - once before the receipt is written and once when its bytes are decoded again. A
 * mismatch here is not a type error, it is `null` authority, so the seed test grades this slice
 * by calling the provider rather than by re-reading the string.
 */
const DEMO_ACCEPTANCE_ACTION = "integration.accept_output";
const DEMO_ACCEPTANCE_TIER = "R0";

function hex64(label: string): string {
  const cleaned = label.replace(/[^0-9a-f]/gu, "");
  return (cleaned.length > 0 ? cleaned : "0").repeat(64).slice(0, 64);
}


/**
 * A FIXED stamp, not a reading. This module has no clock by construction (two builds over one
 * input must be byte-identical, or a second seed run is a new policy body instead of a replay),
 * and `validateEvaluationInput` only requires a safe non-negative integer.
 */
const DEMO_POLICY_EVALUATED_AT_EPOCH_MS = 1_760_000_000_000;

/**
 * The one policy address a caller can NAME in `policy.validate`: `evaluatePolicy` requires a
 * 64-hex `policyRevisionRef`, and the value here mirrors the development payload table's
 * The same digest algorithm the bootstrap ingress enforces; no caller-chosen label can stand in
 * for the slice bytes this demo installs.
 */
/**
 * `riskClassifications` is MANDATORY here since task-a888038d, not decoration. The finalize
 * terminal derives the sealed graph's node-property fact ids and refuses
 * `RUN_POLICY_UNCLASSIFIABLE` when no installed policy classifies them — so a seed installing an
 * empty table would seal nothing and the demo would stop one command before approval. The four
 * ids are the production derivation over `journeyAuthority`'s node, which states the same
 * capability, scopes and resource whichever node ref the seed names.
 */
const VALIDATABLE_POLICY_CANDIDATE = Object.freeze({
  autoApprovalOptIns: [],
  riskClassifications: [
    { factId: "node.capability:capability-implement", tier: "R1" },
    { factId: "node.read_scope:services/api/src", tier: "R0" },
    { factId: "node.resource:resource-a", tier: "R0" },
    { factId: "node.write_scope:services/api/src/node", tier: "R2" },
    // THE COMPILED LANE's closed risk vocabulary (COMPILED_NODE_RISK_PROFILE,
    // compiled-authority-contracts.ts): the dispatcher states exactly these
    // facts on every compiled node, so classifying them here is what keeps a
    // real PRD-compiled plan from parking RUN_POLICY_UNCLASSIFIABLE at
    // finalize. Widening the profile means widening this table with it.
    { factId: "node.read_scope:workspace", tier: "R0" },
    { factId: "node.resource:workspace", tier: "R0" },
    { factId: "node.write_scope:workspace", tier: "R2" },
  ],
  rules: [],
  sliceRef: "pending-demo-policy-slice",
});
const VALIDATABLE_POLICY_DIGEST = derivePolicySliceDigest(VALIDATABLE_POLICY_CANDIDATE);
if (!VALIDATABLE_POLICY_DIGEST.ok) throw new Error("demo validatable policy slice is invalid");
export const DEMO_VALIDATABLE_POLICY_REF = VALIDATABLE_POLICY_DIGEST.digest;

/**
 * The validatable policy slice. The verifier and calibration slices below live at deliberately
 * NON-hex addresses so they can never be named as policy revisions — but the seeded surface
 * still offers `policy.validate` as a READY step, and the mission hint an agent receives names
 * `DEMO_VALIDATABLE_POLICY_REF`. Live run 2026-08-20: without this install every input shape
 * refused BOOTSTRAP_POLICY_UNKNOWN at DAEMON_PREREQUISITE, and the wrapper respawned an agent
 * at the unsatisfiable step every pass. Installing the hinted address makes the offered step
 * completable; it grants nothing (no rules, no opt-ins).
 */
export function validatablePolicySlice(): Record<string, unknown> {
  return {
    autoApprovalOptIns: VALIDATABLE_POLICY_CANDIDATE.autoApprovalOptIns,
    riskClassifications: VALIDATABLE_POLICY_CANDIDATE.riskClassifications,
    rules: VALIDATABLE_POLICY_CANDIDATE.rules,
    sliceRef: DEMO_VALIDATABLE_POLICY_REF,
  };
}

/**
 * The reviewer calibration the demo DECLARES, at the well-known address its reader owns.
 *
 * Design 15.3 calls these "caller-supplied durable facts", and this seed is the caller - but
 * `sentinelPassed: true` still asserts a sentinel corpus the demo never ran, exactly as
 * `modelSnapshotKind: "UNKNOWN"` below refuses to assert a `claude --version` the demo never
 * took. The difference is reachability: `qualifyReviewerForAcceptance` refuses
 * REVIEWER_CALIBRATION_UNPROVEN on a failed sentinel, an UNKNOWN staleness or an empty corpus,
 * so an honest-but-unproven record makes COMMITTED unreachable and the demo cannot run at all.
 * The claim is therefore made SELF-DECLARING in the durable bytes: `corpusRevision` names the
 * demo seed as the declarer, so anything reading this record back - including the verifier
 * receipt that carries it - can see the calibration came from the bootstrap and not from a
 * measured corpus. A real deployment installs its own slice at the same ref and overwrites it.
 */
export function reviewerCalibrationSlice(input: Pick<DemoSeedInput, "projectId">): Record<string, unknown> {
  return {
    corpusRevision: `${input.projectId}-demo-seed-declared-corpus-1`,
    sentinelPassed: true,
    sliceRef: REVIEWER_CALIBRATION_SLICE_REF,
    staleness: "CURRENT",
  };
}

/**
 * The verifier's policy slice: a complete `PolicyEvaluationInput` plus its ADDRESS.
 *
 * `readVerifierPolicy` strips `sliceRef` and hands the remaining thirteen keys to the core's
 * `evaluatePolicy`, then requires ALLOW for this action and this actor; anything else is `null`
 * authority. ALLOW needs all four layers to agree, which is why each field below is load-bearing:
 * one DAEMON_VERIFIED tier-bearing fact (without it the risk layer is RISK_TIER_UNCLASSIFIABLE
 * and folds to HOLD_UNKNOWN), no required facts and no rules (nothing to hold or deny), and an
 * auto-approval opt-in naming THIS action at a tier at least as high as the derived one (design
 * 710: an R0/R1 action still needs an explicit opt-in, so manual stays the default).
 *
 * The install address is human-readable on purpose. `policy.install` stores any JsonObject, and
 * `evaluatePolicy` refuses a `policyRevisionRef` that is not 64 hex - so a slice living at a
 * non-hex ref can never be named as a policy revision by a caller who notices it installed.
 */
export function verifierPolicySlice(input: Pick<DemoSeedInput, "projectId">): Record<string, unknown> {
  return {
    action: DEMO_ACCEPTANCE_ACTION,
    actor: NODE_VERIFIER_PRINCIPAL_ID,
    callerRiskHint: null,
    decisionDigest: hex64("dec1de"),
    evaluatedAtEpochMs: DEMO_POLICY_EVALUATED_AT_EPOCH_MS,
    evaluatorVersion: "demo-seed-policy-1",
    facts: [{
      factId: `${input.projectId}-demo-acceptance-risk`,
      tier: DEMO_ACCEPTANCE_TIER,
      truthClass: DEMO_VERIFIED,
    }],
    graphNodeRevisionRefs: [],
    policyRevisionRef: hex64("acce97"),
    requiredFactIds: [],
    scope: [],
    sliceChain: [{
      autoApprovalOptIns: [{ action: DEMO_ACCEPTANCE_ACTION, tier: DEMO_ACCEPTANCE_TIER }],
      rules: [],
      sliceRef: hex64("511ce"),
    }],
    sliceRef: VERIFIER_POLICY_SLICE_REF,
    waivers: [],
  };
}
