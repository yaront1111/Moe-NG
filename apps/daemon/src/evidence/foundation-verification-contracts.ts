/**
 * Durable verification receipt dispatch: this service's own vocabulary, the
 * identities a caller may name, and the shape of the one durable receipt row.
 *
 * Every code below is raised by THIS service and by nothing else. A refusal from
 * the attempt store, the verifier process wrapper, its supervisor or the evidence
 * builder travels through `carry*Refusal` with ITS OWN code and layer intact:
 * restamping would make a spawn failure indistinguishable from a stale candidate.
 */

import type {
  DeclaredInput, EvidenceReceipt, EvidenceRefusalLayer, ProviderRuntimeObservation,
  RunVerifierProcessRefused, RunnerEvidenceErrorCode, VerifierCapture, VerifierIdentity,
  VerifierProcessErrorCode, VerifierProcessLayer,
} from "@moe/runner";

import type { FoundationAttemptRefused } from "../work/foundation-attempt-contracts.js";

export const FOUNDATION_VERIFICATION_SCHEMA_VERSION = "moe-foundation-verification/1" as const;
export const FOUNDATION_VERIFICATION_RECIPE_VERSION =
  "moe-foundation-verification-recipe/1" as const;
export const FOUNDATION_VERIFICATION_RECEIPT_VERSION =
  "moe-foundation-verification-receipt/1" as const;

export const FOUNDATION_VERIFICATION_COMMAND_KIND = "foundation.verification" as const;

export const FOUNDATION_VERIFICATION_EVENT_TYPES = Object.freeze({
  ACTIVATED: "FoundationVerificationActivated",
  RECEIPTED: "FoundationVerificationReceipted",
  RECIPE_SEALED: "FoundationVerificationRecipeSealed",
} as const);

/** Ordered by when they can answer: REQUEST/IDENTITY/ACTIVATION are strictly
 *  before any process starts, EXECUTION interprets a run that already happened,
 *  RECEIPT covers writing the row and reading it back. */
export const FOUNDATION_VERIFICATION_LAYERS = Object.freeze([
  "DAEMON_VERIFICATION_REQUEST",
  "DAEMON_VERIFICATION_IDENTITY",
  "DAEMON_VERIFICATION_ACTIVATION",
  "DAEMON_VERIFICATION_EXECUTION",
  "DAEMON_VERIFICATION_RECEIPT",
] as const);
export type FoundationVerificationLayer = (typeof FOUNDATION_VERIFICATION_LAYERS)[number];

/**
 * Closed, and every member has exactly one producer in the sibling service.
 * Deliberately absent: any code for a failed spawn, timeout, output overflow or
 * receipt-binding fault. `VERIFIER_PROCESS_ERROR_CODES` and
 * `RUNNER_EVIDENCE_ERROR_CODES` already name those, and a second vocabulary for
 * one condition only makes the two indistinguishable.
 */
export const FOUNDATION_VERIFICATION_CODES = Object.freeze([
  "FOUNDATION_VERIFICATION_REQUEST_MALFORMED",
  "FOUNDATION_VERIFICATION_ATTEMPT_UNPROVEN",
  "FOUNDATION_VERIFICATION_RECIPE_UNRESOLVED",
  "FOUNDATION_VERIFICATION_RECIPE_SEAL_INVALID",
  "FOUNDATION_VERIFICATION_CANDIDATE_STALE",
  "FOUNDATION_VERIFICATION_ACTIVATION_UNCOMMITTED",
  "FOUNDATION_VERIFICATION_CANDIDATE_CHANGED",
  "FOUNDATION_VERIFICATION_REPLAY_CONFLICT",
  "FOUNDATION_VERIFICATION_CAPTURE_TRUNCATED",
  "FOUNDATION_VERIFICATION_EXECUTION_UNVERIFIED",
  "FOUNDATION_VERIFICATION_RECEIPT_AMBIGUOUS",
  "FOUNDATION_VERIFICATION_RECEIPT_UNREADABLE",
] as const);
export type FoundationVerificationCode = (typeof FOUNDATION_VERIFICATION_CODES)[number];

/** WHICH AUTHORITY refused, so a pass-through is provable rather than asserted. */
export const FOUNDATION_VERIFICATION_REFUSAL_SOURCES = Object.freeze([
  "DAEMON_VERIFICATION",
  "FOUNDATION_ATTEMPT",
  "VERIFIER_PROCESS",
  "RUNNER_SUPERVISOR",
  "RUNNER_EVIDENCE",
] as const);
export type FoundationVerificationRefusalSource =
  (typeof FOUNDATION_VERIFICATION_REFUSAL_SOURCES)[number];

export type FoundationVerificationRefused =
  | {
    readonly ok: false; readonly source: "DAEMON_VERIFICATION";
    readonly code: FoundationVerificationCode; readonly layer: FoundationVerificationLayer;
  }
  | {
    readonly ok: false; readonly source: "FOUNDATION_ATTEMPT";
    readonly code: string; readonly layer: string;
  }
  | {
    readonly ok: false; readonly source: "VERIFIER_PROCESS";
    readonly code: VerifierProcessErrorCode; readonly layer: VerifierProcessLayer;
  }
  | {
    readonly ok: false; readonly source: "RUNNER_SUPERVISOR";
    readonly code: string; readonly layer: string;
  }
  | {
    readonly ok: false; readonly source: "RUNNER_EVIDENCE";
    readonly code: RunnerEvidenceErrorCode; readonly layer: EvidenceRefusalLayer;
  };

export function refuseVerification(
  code: FoundationVerificationCode, layer: FoundationVerificationLayer,
): FoundationVerificationRefused {
  return Object.freeze({ code, layer, ok: false as const, source: "DAEMON_VERIFICATION" as const });
}

/** The store spells its layer `refusedBy`; the name changes, the value does not. */
export function carryAttemptRefusal(
  refused: FoundationAttemptRefused,
): FoundationVerificationRefused {
  return Object.freeze({
    code: refused.code, layer: refused.refusedBy, ok: false as const,
    source: "FOUNDATION_ATTEMPT" as const,
  });
}

/** Total over the wrapper's three-way refusal union; nothing is re-coded. */
export function carryWrapperRefusal(
  refused: RunVerifierProcessRefused,
): FoundationVerificationRefused {
  if (refused.source === "PROCESS") {
    return Object.freeze({
      code: refused.failure.code, layer: refused.failure.layer, ok: false as const,
      source: "VERIFIER_PROCESS" as const,
    });
  }
  if (refused.source === "EVIDENCE") {
    return Object.freeze({
      code: refused.failure.code, layer: refused.failure.layer, ok: false as const,
      source: "RUNNER_EVIDENCE" as const,
    });
  }
  return Object.freeze({
    code: refused.failure.code, layer: refused.failure.layer, ok: false as const,
    source: "RUNNER_SUPERVISOR" as const,
  });
}

export function carryEvidenceRefusal(
  code: RunnerEvidenceErrorCode, layer: EvidenceRefusalLayer,
): FoundationVerificationRefused {
  return Object.freeze({ code, layer, ok: false as const, source: "RUNNER_EVIDENCE" as const });
}

/**
 * IDENTITIES ONLY, and that is the whole point of this type.
 *
 * There is no field here for an input manifest, a result manifest, a runtime
 * observation, a recipe body or a receipt. A caller cannot present a
 * substitute for durable state because the substitute is not representable —
 * DoD 1 enforced by the type rather than by a validator that a later refactor
 * can quietly stop calling. `expectedRecordDigest` is the caller's belief about
 * WHICH durable record it is verifying, never a replacement for the record.
 */
export interface FoundationVerificationRequest {
  readonly attemptAggregateId: string;
  readonly candidateRoot: string;
  readonly expectedRecordDigest: string;
  readonly recipeAggregateId: string;
  readonly verificationId: string;
}

export const FOUNDATION_VERIFICATION_REQUEST_KEYS = Object.freeze([
  "attemptAggregateId", "candidateRoot", "expectedRecordDigest", "recipeAggregateId",
  "verificationId",
] as const);

/**
 * Declaring a recipe is not replacing durable state: it is how one is created.
 * From the sealed event onward the recipe is loaded by identity and never again
 * accepted from a caller.
 *
 * `runtimeObservation` lives here because the wrapper's launch gate demands a
 * PROVEN one and the durable attempt record carries only its DIGESTS
 * (quotedRuntimeDigest, freshRuntimeDigest), never the observation itself. What
 * the verifier runs and the runtime it runs on are sealed by the same event, so
 * the verify path can load both by identity instead of taking either from a
 * caller.
 */
export interface FoundationRecipeRegistration {
  readonly argv: readonly string[];
  readonly declaredInputs: readonly DeclaredInput[];
  readonly declaredOutputPaths: readonly string[];
  readonly recipeAggregateId: string;
  readonly runtimeObservation: ProviderRuntimeObservation;
  readonly verifierIdentity: VerifierIdentity;
}

export type FoundationRecipeOutcome =
  | { readonly ok: true; readonly recipeAggregateId: string; readonly sha256: string }
  | FoundationVerificationRefused;

/** PASSED and FAILED are both proven answers. UNKNOWN is not a verdict and has
 *  no member here: an unproven run refuses and writes no row at all. */
export const FOUNDATION_VERIFICATION_VERDICTS = Object.freeze(["PASSED", "FAILED"] as const);
export type FoundationVerificationVerdict = (typeof FOUNDATION_VERIFICATION_VERDICTS)[number];

export interface FoundationVerificationReceiptParts {
  readonly attemptAggregateId: string;
  readonly capture: VerifierCapture;
  readonly receipt: EvidenceReceipt;
  readonly recipeAggregateId: string;
  readonly recordDigest: string;
  readonly verdict: FoundationVerificationVerdict;
  readonly verificationId: string;
}

/** The durable row: the runner's immutable receipt, plus the stdout/stderr/exit
 *  bindings the receipt itself does not carry. Field order is irrelevant — the
 *  codec canonicalizes — but the field SET is what review and closure hash. */
export function verificationReceiptBody(
  parts: FoundationVerificationReceiptParts,
): Record<string, unknown> {
  const { capture, receipt } = parts;
  return {
    attemptAggregateId: parts.attemptAggregateId,
    completedAt: capture.completedAt,
    durationMs: capture.durationMs,
    exitCode: capture.exitCode,
    receipt: receipt as unknown as Record<string, unknown>,
    receiptSha256: receipt.sha256,
    recipeAggregateId: parts.recipeAggregateId,
    recipeSha256: receipt.recipeSha256,
    recordDigest: parts.recordDigest,
    recordVersion: FOUNDATION_VERIFICATION_RECEIPT_VERSION,
    signal: capture.signal,
    startedAt: capture.startedAt,
    stderrSha256: capture.stderr.sha256,
    stderrTruncated: capture.stderr.truncated,
    stdoutSha256: capture.stdout.sha256,
    stdoutTruncated: capture.stdout.truncated,
    verdict: parts.verdict,
    verificationId: parts.verificationId,
  };
}

export interface FoundationVerificationAnswer {
  readonly authority: "PROVEN_RECEIPT";
  readonly digest: string;
  readonly ok: true;
  readonly row: Record<string, unknown>;
  readonly verdict: FoundationVerificationVerdict;
}

export type FoundationVerificationOutcome =
  | FoundationVerificationAnswer
  | FoundationVerificationRefused;
