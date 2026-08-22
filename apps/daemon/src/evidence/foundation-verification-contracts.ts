/**
 * Durable verification receipt dispatch: this service's own vocabulary, the
 * identities a caller may name, and the shape of the one durable receipt row.
 * Every code below is raised by THIS service and by nothing else. A refusal from
 * the attempt store, the verifier process wrapper, its supervisor, the evidence
 * builder or the durable store travels through `carry*Refusal` with ITS OWN code
 * and layer intact: restamping would make a spawn failure indistinguishable from
 * a stale candidate, and a commit the store could not prove from one it refused.
 */

import type {
  DeclaredInput, EvidenceReceipt, EvidenceRefusalLayer, ProviderRuntimeObservation,
  RunVerifierProcessRefused, RunnerEvidenceErrorCode, VerifierCapture, VerifierIdentity,
  VerifierProcessErrorCode, VerifierProcessLayer,
} from "@moe/runner";
import type { DurableStoreError, DurableStoreErrorCode } from "@moe/store";

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
  REFUSED: "FoundationVerificationRefused",
} as const);

/** Ordered by when they can answer: REQUEST/IDENTITY/ACTIVATION are strictly
 *  before any process starts, RECEIPT covers writing the row and reading it back.
 *  No EXECUTION layer: every post-run refusal belongs to the wrapper, the
 *  evidence builder or the store and carries THEIRS, so ours would be an orphan. */
export const FOUNDATION_VERIFICATION_LAYERS = Object.freeze([
  "DAEMON_VERIFICATION_REQUEST",
  "DAEMON_VERIFICATION_IDENTITY",
  "DAEMON_VERIFICATION_ACTIVATION",
  "DAEMON_VERIFICATION_RECEIPT",
] as const);
export type FoundationVerificationLayer = (typeof FOUNDATION_VERIFICATION_LAYERS)[number];

/**
 * Closed, and every member has exactly one producer. The three *_UNCOMMITTED
 * codes mean ZERO rows were written AND THE STORE SAID SO: they answer only a
 * NO_BUSINESS_EFFECT decision, the store's returned expected-version rejection.
 * A store that THROWS is not that fact. OUTCOME_UNKNOWN may have landed the row,
 * STORE_BUSY may not have reached it, and the codes are the store's to name, so
 * a thrown fault travels under the DURABLE_STORE source with the store's own
 * code rather than being folded into "nothing was written". RECEIPT_AMBIGUOUS
 * means MORE THAN ONE row exists: one code for two opposite durable states tells
 * a reviewer nothing, so each keeps its own.
 *
 * RECIPE_CONFLICT and RECIPE_UNCOMMITTED are the two ways a recipe fails to
 * seal. A second registration under an already-sealed identity is answered from
 * the DURABLE recipe: the same sha256 is a replay and the first bytes answer,
 * a different one is a conflict and the first bytes stay. Neither writes a row.
 *
 * CANDIDATE_STALE and CANDIDATE_TREE_MISMATCH are two different facts about the
 * caller's request: the first says the caller's belief about WHICH record is
 * out of date, the second says the root it named does not hold the tree that
 * record sealed. Both answer before activation and write no row, so neither is
 * an UNKNOWN: the candidate was never run.
 *
 * Deliberately absent: spawn, timeout, output-overflow, receipt-binding,
 * truncated-capture, unverified-execution, candidate-changed and store-fault
 * codes. The wrapper refuses the moment a stream passes its bound and only ever
 * answers `ok` with disposition COMPLETED or FAILED, a durable attempt record is
 * IMMUTABLE, a second RECORDED event making the STORE refuse under ITS code, and
 * a store that cannot read or commit already names why, so each would be an
 * orphan. DoD 3 is met by carrying the producer's refusal, recording truncation
 * on the UNKNOWN row, and asserting no-authoritative-pass as a property.
 */
export const FOUNDATION_VERIFICATION_CODES = Object.freeze([
  "FOUNDATION_VERIFICATION_REQUEST_MALFORMED",
  "FOUNDATION_VERIFICATION_ATTEMPT_UNPROVEN",
  "FOUNDATION_VERIFICATION_RECIPE_UNRESOLVED",
  "FOUNDATION_VERIFICATION_RECIPE_SEAL_INVALID",
  "FOUNDATION_VERIFICATION_RECIPE_CONFLICT",
  "FOUNDATION_VERIFICATION_RECIPE_UNCOMMITTED",
  "FOUNDATION_VERIFICATION_CANDIDATE_STALE",
  "FOUNDATION_VERIFICATION_CANDIDATE_TREE_MISMATCH",
  "FOUNDATION_VERIFICATION_ACTIVATION_UNCOMMITTED",
  "FOUNDATION_VERIFICATION_REPLAY_CONFLICT",
  "FOUNDATION_VERIFICATION_RECEIPT_UNCOMMITTED",
  "FOUNDATION_VERIFICATION_RECEIPT_ABSENT",
  "FOUNDATION_VERIFICATION_RECEIPT_AMBIGUOUS",
  "FOUNDATION_VERIFICATION_RECEIPT_UNREADABLE",
] as const);
export type FoundationVerificationCode = (typeof FOUNDATION_VERIFICATION_CODES)[number];

/** WHICH AUTHORITY refused, so a pass-through is provable rather than asserted.
 *  DURABLE_STORE is the store itself: a read or commit it THREW on, carried with
 *  the store's code, under the layer name the command seam already gives it. */
export const FOUNDATION_VERIFICATION_REFUSAL_SOURCES = Object.freeze([
  "DAEMON_VERIFICATION",
  "FOUNDATION_ATTEMPT",
  "VERIFIER_PROCESS",
  "RUNNER_SUPERVISOR",
  "RUNNER_EVIDENCE",
  "DURABLE_STORE",
] as const);
export type FoundationVerificationRefusalSource =
  (typeof FOUNDATION_VERIFICATION_REFUSAL_SOURCES)[number];

interface RefusalOf<S, C, L> {
  readonly code: C; readonly layer: L; readonly ok: false; readonly source: S;
}

export type FoundationVerificationRefused =
  | RefusalOf<"DAEMON_VERIFICATION", FoundationVerificationCode, FoundationVerificationLayer>
  | RefusalOf<"FOUNDATION_ATTEMPT", string, string>
  | RefusalOf<"VERIFIER_PROCESS", VerifierProcessErrorCode, VerifierProcessLayer>
  | RefusalOf<"RUNNER_SUPERVISOR", string, string>
  | RefusalOf<"RUNNER_EVIDENCE", RunnerEvidenceErrorCode, EvidenceRefusalLayer>
  | RefusalOf<"DURABLE_STORE", DurableStoreErrorCode, "DURABLE_STORE">;

export function refuseVerification(
  code: FoundationVerificationCode, layer: FoundationVerificationLayer,
): FoundationVerificationRefused {
  return Object.freeze({ code, layer, ok: false as const, source: "DAEMON_VERIFICATION" as const });
}

/** A thrown store fault, verbatim. Whether the rows landed is the STORE's
 *  knowledge: OUTCOME_UNKNOWN says it cannot tell, and this service may not
 *  answer "nothing was written" on its behalf. The layer is the store's, spelled
 *  as the command seam and the session store already spell it, and is not a
 *  boundary constant of this module: the store, not this service, owns it. */
export function carryStoreRefusal(error: DurableStoreError): FoundationVerificationRefused {
  return Object.freeze({
    code: error.code, layer: "DURABLE_STORE" as const, ok: false as const,
    source: "DURABLE_STORE" as const,
  });
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
 * Four identities and one location. No field for an input manifest, result
 * manifest, runtime observation, recipe body or receipt: a substitute for
 * durable state is UNREPRESENTABLE here rather than validated away, so no later
 * refactor can stop calling the check. `expectedRecordDigest` is the caller's
 * belief about WHICH record it verifies, never a replacement.
 *
 * `candidateRoot` is the exception that proves why the rest are identities: it
 * is WHERE the recipe runs, and a location is the one thing durable state
 * cannot supply. It is therefore the one field that IS validated, bound byte
 * for byte to the record's sealed input manifest before activation, by
 * `bindCandidateTree`, because a root that is merely named is a tree the
 * caller chose, and a verdict over a caller-chosen tree binds to nothing. */
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
 * From the sealed event onward it is loaded by identity, never from a caller.
 * `runtimeObservation` lives here because the launch gate demands a PROVEN one
 * and the durable attempt record carries only its DIGESTS, never the observation
 * itself — so what runs and the runtime it runs on are sealed by one event.
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
  readonly candidateRoot: string;
  readonly capture: VerifierCapture;
  readonly receipt: EvidenceReceipt;
  readonly recipeAggregateId: string;
  readonly recordDigest: string;
  readonly verdict: FoundationVerificationVerdict;
  readonly verificationId: string;
}

/** The durable row: the runner's immutable receipt, plus the stdout/stderr/exit
 *  bindings the receipt itself does not carry. Field order is irrelevant — the
 *  codec canonicalizes — but the field SET is what review and closure hash.
 *  `candidateRoot` is in that set because it is WHAT WAS VERIFIED: a root that
 *  never reaches durable state is a root nothing can conflict with, so the
 *  replay clause in the sibling service would be unable to see it. */
export function verificationReceiptBody(
  parts: FoundationVerificationReceiptParts,
): Record<string, unknown> {
  const { capture, receipt } = parts;
  return {
    attemptAggregateId: parts.attemptAggregateId, candidateRoot: parts.candidateRoot,
    completedAt: capture.completedAt, durationMs: capture.durationMs,
    exitCode: capture.exitCode,
    receipt: receipt as unknown as Record<string, unknown>, receiptSha256: receipt.sha256,
    recipeAggregateId: parts.recipeAggregateId, recipeSha256: receipt.recipeSha256,
    recordDigest: parts.recordDigest, recordVersion: FOUNDATION_VERIFICATION_RECEIPT_VERSION,
    signal: capture.signal, startedAt: capture.startedAt, stderrSha256: capture.stderr.sha256,
    stderrTruncated: capture.stderr.truncated, stdoutSha256: capture.stdout.sha256,
    stdoutTruncated: capture.stdout.truncated, verdict: parts.verdict,
    verificationId: parts.verificationId,
  };
}

/** The honest UNKNOWN a refusal leaves once the activation is committed, so a
 *  verification never ends with no durable fact. Not a receipt, no verdict. The
 *  truncation flags are RECORDED, not dropped: a truncated stream whose tail
 *  happens to look green is how a false pass gets minted. */
export function verificationRefusalBody(
  verificationId: string, refused: FoundationVerificationRefused,
  capture: VerifierCapture | null,
): Record<string, unknown> {
  return {
    code: refused.code, layer: refused.layer, recordVersion: FOUNDATION_VERIFICATION_RECEIPT_VERSION,
    source: refused.source,
    stderrSha256: capture === null ? null : capture.stderr.sha256,
    stderrTruncated: capture === null ? null : capture.stderr.truncated,
    stdoutSha256: capture === null ? null : capture.stdout.sha256,
    stdoutTruncated: capture === null ? null : capture.stdout.truncated,
    truthClass: "UNKNOWN", verificationId,
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
