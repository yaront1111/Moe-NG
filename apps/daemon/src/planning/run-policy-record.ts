/**
 * The RUN-SCOPED `PolicyEvaluated` row: its address, its payload shape, and its refusal
 * vocabulary. Split from `run-policy-evaluation.ts` so derivation and record shaping stay apart
 * and neither file approaches the size rail — the same division `policy-risk-record.ts` and
 * `policy-risk-leg.ts` already use for the human-approved half of this ledger.
 *
 * ONE EVENT TYPE, TWO SUBJECTS. This row carries the SAME `PolicyEvaluated` type as
 * `policy.validate`'s caller-driven row, because a second type would fork the ledger and leave
 * the strict reader policing only one of them. What separates them is the ADDRESS: caller-driven
 * rows live on `${projectId}-policy`, which `policy-admission-reader.ts:62`,
 * `approval-policy-ref.ts:89` and `supersession-policy-decision.ts:81` scan newest-first and
 * FAIL CLOSED on. A run-scoped row landing there would sit at the head of all three scans, so it
 * lives on its own run-addressed aggregate instead and those scans see byte-identical input.
 *
 * THE EIGHT CALLER-DRIVEN KEYS ARE SPELLED IDENTICALLY, so one strict reader admits both shapes;
 * the three run-scoped keys carry the linkage a caller-driven row has no notion of.
 */
import type { JsonObject, JsonValue } from "@moe/contracts";
import { POLICY_RISK_TIERS, POLICY_SLICE_DIGEST_VERSION } from "@moe/core";
import type { PolicyRiskTier } from "@moe/core";

import {
  POLICY_DECISION_DIGEST_VERSION,
  POLICY_EVALUATION_TIME_SOURCE,
  POLICY_EVALUATOR_VERSION_SOURCE,
  decisionDigestFor,
} from "../bootstrap/bootstrap-policy-authority.js";

/** MODULE-PRIVATE literal, published only as a closed TYPE: the security roster counts exported
 *  column-zero `*_LAYER` constants, and `planning-graph-content-ingress.ts:28-30` sets the
 *  precedent for spelling the literal here and exporting the type. */
const LAYER = "DAEMON_RUN_POLICY" as const;
export type RunPolicyLayer = typeof LAYER;

/** The server action this evaluation's subject is. Never caller-selected. */
export const RUN_POLICY_ACTION = "plan.finalize" as const;
export const RUN_POLICY_EVENT_TYPE = "PolicyEvaluated" as const;
const AGGREGATE_PREFIX = "policy-run-evaluation:";

/**
 * The three keys a run-scoped row adds to the caller-driven eight. Named once, here, so the
 * writer below and the strict reader's roster cannot drift apart.
 */
export const RUN_POLICY_ROW_EXTRA_KEYS = Object.freeze([
  "graphNodeRevisionRefs", "riskAssessment", "runId",
] as const);

export const RUN_POLICY_EVALUATION_CODES = Object.freeze([
  "RUN_POLICY_GRAPH_UNAVAILABLE",
  "RUN_POLICY_INPUT_INVALID",
  "RUN_POLICY_NODE_UNADMITTED",
  "RUN_POLICY_POLICY_ABSENT",
  "RUN_POLICY_UNCLASSIFIABLE",
] as const);
export type RunPolicyEvaluationCode = (typeof RUN_POLICY_EVALUATION_CODES)[number];

export interface RunPolicyEvaluationRefused {
  readonly code: RunPolicyEvaluationCode;
  /** The fact ids derived from the sealed graph, so an operator sees what went unclassified. */
  readonly factIds: readonly string[];
  readonly layer: RunPolicyLayer;
  readonly ok: false;
}

export function runPolicyRefusal(
  code: RunPolicyEvaluationCode, factIds: readonly string[] = [],
): RunPolicyEvaluationRefused {
  return Object.freeze({
    code, factIds: Object.freeze([...factIds]), layer: LAYER, ok: false as const,
  });
}

export function runPolicyAggregateId(runId: string): string {
  return `${AGGREGATE_PREFIX}${runId}`;
}

export interface RunScopedLinkage {
  readonly riskTier: PolicyRiskTier | null;
  readonly runId: string;
}

/**
 * The run-scoped half of the strict read: `runId`, and the two summaries the row repeats.
 *
 * REPLAY-VERIFIED, NOT MERELY PRESENT. `graphNodeRevisionRefs` and `riskAssessment` are compared
 * against the values the reader's own independent replay of the evaluation produced, so a row
 * that states a tier its evidence does not derive is refused rather than believed. That is the
 * same discipline the surrounding reader applies to `action`, `decision` and `policyRevisionRef`.
 */
export function runScopedLinkage(
  row: Readonly<Record<string, unknown>>,
  replayed: Readonly<Record<string, unknown>>,
): RunScopedLinkage | null {
  const runId = row["runId"];
  if (typeof runId !== "string" || runId.length === 0) return null;
  const stated = row["graphNodeRevisionRefs"];
  const derived = replayed["graphNodeRevisionRefs"];
  if (!Array.isArray(stated) || !Array.isArray(derived)
    || stated.length !== derived.length
    || stated.some((ref, index) => ref !== derived[index])) return null;
  // Serialized comparison, so key ORDER is part of the match. Both sides originate in core's one
  // `assessRisk` literal, so an honest row always agrees; a row whose assessment was rebuilt by
  // anything else is refused. Fail-closed is the right side to err on for a risk tier.
  const assessment = row["riskAssessment"];
  if (JSON.stringify(assessment) !== JSON.stringify(replayed["riskAssessment"])) return null;
  const tier = (assessment as { readonly computedTier?: unknown } | null)?.computedTier;
  // A run-scoped row exists to carry a tier. `null` here means the writer produced a row the
  // evaluator refused to tier, which the writer has no branch for — so it is a refusal, not a
  // tier-less acceptance that a consumer might read as "no risk".
  if (typeof tier !== "string" || !POLICY_RISK_TIERS.some((entry) => entry === tier)) return null;
  return Object.freeze({ riskTier: tier as PolicyRiskTier, runId });
}

export interface RunPolicyRowInput {
  readonly evaluationInput: Record<string, unknown>;
  readonly graphContentHash: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly record: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly sliceRef: string;
}

/**
 * Composes the durable row and its digest.
 *
 * `decisionDigest` is removed from BOTH the evaluated input and the evaluated outcome before the
 * material is digested: core hands the supplied digest straight back
 * (`policy-evaluation.ts:200`), so folding it in would digest a value the evaluation did not
 * derive. `validatePolicy` removes exactly the same pair at :187-188 and the strict reader
 * replays with a zero digest, so all three agree on what the material is.
 */
export function buildRunPolicyRow(input: RunPolicyRowInput): JsonObject {
  const { decisionDigest: _suppliedInputDigest, ...verifiedInput } = input.evaluationInput;
  const { decisionDigest: _suppliedOutcomeDigest, ...verifiedOutcome } = input.record;
  const decisionMaterial = {
    projectId: input.projectId,
    serverSources: {
      evaluationTimeSource: POLICY_EVALUATION_TIME_SOURCE,
      evaluatorVersionSource: POLICY_EVALUATOR_VERSION_SOURCE,
      policySliceDigestVersion: POLICY_SLICE_DIGEST_VERSION,
      waiverResolutionStatus: "RESOLVED_EMPTY",
    },
    verifiedInput: verifiedInput as unknown as JsonValue,
    verifiedOutcome: verifiedOutcome as unknown as JsonValue,
  };
  return {
    decision: input.record["decision"],
    decisionDigest: decisionDigestFor(decisionMaterial as unknown as JsonValue),
    decisionDigestVersion: POLICY_DECISION_DIGEST_VERSION,
    decisionMaterial,
    graphNodeRevisionRefs: [input.graphContentHash],
    policyRef: input.sliceRef,
    principalId: input.principalId,
    projectId: input.projectId,
    riskAssessment: input.record["riskAssessment"],
    runId: input.runId,
    sliceRef: input.sliceRef,
  } as unknown as JsonObject;
}
