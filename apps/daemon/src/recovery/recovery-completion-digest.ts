import { createHash } from "node:crypto";

import type { RuntimeError } from "@moe/contracts";

/**
 * The canonical R3 recovery-completion digest and this layer's refusal vocabulary.
 *
 * THE DIGEST IS COMPUTED, NEVER ACCEPTED. Every preimage component is a fact the
 * daemon READ back out of the store — the reconciliation record, the installed
 * restore, the anchored incarnation, the project state — so a caller able to
 * spell the accepted digest still could not make one true. The approval binds to
 * it through its own `exactRevisionHash`, which the service recomputes and
 * compares rather than trusting either side.
 *
 * TWO SEPARATE DOMAINS: the completion digest covers the whole evidence tuple,
 * the coverage-proof digest only the configured classes and their ordered proofs
 * (core's `RecoveryCompletionWitness.coverageProofHash`). One shared tag would
 * let a coverage hash be presented where a completion hash is demanded.
 *
 * ORDER IS SIGNIFICANT AND IS NOT NORMALIZED. `recovery-inventory-codec` already
 * fixes one canonical order for a stored record, so a reordered tuple is a
 * DIFFERENT observation of the world rather than a re-spelling of the same one,
 * and sorting here would quietly certify it under the approved digest.
 *
 * EVERY COMPONENT IS LENGTH-FRAMED, because `"ab" + "c"` and `"a" + "bc"` would
 * otherwise share one preimage and an approval bound to either would authorize
 * both. The separator is `.` rather than a NUL: a NUL reads like the obvious
 * delimiter but is rejected downstream by the store's identifier validation
 * while every local test still passes.
 */

export const RECOVERY_COMPLETION_LAYER = "RECOVERY_COMPLETION" as const;

export const RECOVERY_COMPLETION_SCHEMA_VERSION = "moe-recovery-completion/1" as const;
export const RECOVERY_COMPLETION_COMMAND_KIND = "recovery.complete" as const;

export const RECOVERY_COMPLETION_DIGEST_DOMAIN = "moe-recovery-completion-digest/1" as const;
export const RECOVERY_COVERAGE_PROOF_DIGEST_DOMAIN = "moe-recovery-coverage-proof/1" as const;

/**
 * Sorted: the HTTP seam compares its payload allow-list ORDERED. `approval` is
 * the decision record, `command` the `approval.decide` command, and
 * `authentication` is a signed, single-use session presentation. The recovery
 * command's own identity — commandId, correlationId, decidedAt, principalId,
 * projectId — is assembled server-side by the registry and is deliberately not
 * expressible here. Neither is `expectedVersion`: the seam envelope already
 * carries the project-aggregate CAS assertion and every bootstrap command reads
 * it from there, so a second payload copy would give one number two spellings
 * and let the ignored one look honoured.
 */
export const RECOVERY_COMPLETE_PAYLOAD_KEYS = Object.freeze([
  "approval",
  "authentication",
  "command",
  "reconciliationDigest",
] as const);

/** @deprecated Timestamp-shaped refs are not authority; retained for source compatibility only. */
export const RECOVERY_STEP_UP_REF_PREFIX = "recovery-step-up/1:" as const;
/** @deprecated Recovery now uses the session proof's stricter 60-second freshness check. */
export const RECOVERY_STEP_UP_WINDOW_SECONDS = 300;

/**
 * Closed, and OWNED BY THIS MODULE. The recovery-inventory contract's
 * `RECOVERY_INVENTORY_UPSTREAM_CODES` is deliberately not extended: sibling
 * suites sweep that array, and inventory vocabulary is not completion
 * vocabulary. A refusal raised upstream keeps its own producer's code and layer
 * in `upstream` instead.
 */
export const RECOVERY_COMPLETION_CODES = Object.freeze([
  "RECOVERY_COMPLETION_REQUEST_MALFORMED",
  "RECOVERY_COMPLETION_EVIDENCE_ABSENT",
  "RECOVERY_COMPLETION_EVIDENCE_MISMATCH",
  "RECOVERY_COMPLETION_IDEMPOTENCY_CONFLICT",
  "RECOVERY_COMPLETION_DIGEST_MISMATCH",
  "RECOVERY_COMPLETION_APPROVAL_INVALID",
  "RECOVERY_COMPLETION_STALE",
  "RECOVERY_COMPLETION_STORE_UNAVAILABLE",
  "RECOVERY_RECONCILIATION_REQUIRED",
] as const);
export type RecoveryCompletionCode = (typeof RECOVERY_COMPLETION_CODES)[number];

/** The foreign refusal, VERBATIM. Flattening it would erase which layer refused. */
export interface RecoveryCompletionUpstream {
  readonly code: string;
  readonly layer: string;
}

export interface RecoveryCompletionProofEvidence {
  readonly class: string;
  readonly itemCount: number;
  readonly sourceProofDigest: string;
  readonly truth: string;
}

export interface RecoveryCompletionItemEvidence {
  readonly class: string;
  readonly disposition: string;
  readonly identity: string;
  readonly population: string;
  readonly quarantineRef: string | null;
  readonly sourceProofDigest: string;
}

/** The server-read tuple the R3 approval binds to; nothing on it is a caller assertion. */
export interface RecoveryCompletionEvidence {
  readonly anchorBindingDigest: string;
  readonly backupCursor: string;
  readonly backupGenerationDigest: string;
  readonly configuredClasses: readonly string[];
  readonly incarnationRef: string;
  readonly items: readonly RecoveryCompletionItemEvidence[];
  readonly keyEpochRef: string;
  readonly policyRevisionRef: string;
  readonly projectId: string;
  readonly projectTag: string;
  readonly proofs: readonly RecoveryCompletionProofEvidence[];
  readonly reconciliationRecordDigest: string;
  readonly restoreBindingSlot: string;
  readonly restoreCommandId: string;
  readonly restoreGenerationDigest: string;
}

const encoder = new TextEncoder();

/**
 * `<byteLength>.<utf8 bytes>.` — the length is measured in BYTES, not code
 * units, so a multi-byte identity cannot be framed as a shorter one.
 */
function frame(component: string): string {
  return `${encoder.encode(component).byteLength}.${component}.`;
}

/** A number is framed through its exact decimal spelling, never a float shape. */
function frameNumber(value: number): string {
  return frame(Number.isSafeInteger(value) ? value.toFixed(0) : `nonintegral:${String(value)}`);
}

/** `null` gets its own single-byte marker so it can never equal the string "null". */
function frameNullable(value: string | null): string {
  return value === null ? frame("n") : frame(`s${value}`);
}

function frameList(values: readonly string[]): string {
  return `${frame(String(values.length))}${values.map(frame).join("")}`;
}

function frameProofs(proofs: readonly RecoveryCompletionProofEvidence[]): string {
  return `${frame(String(proofs.length))}${proofs.map((proof) =>
    `${frame(proof.class)}${frame(proof.truth)}${frame(proof.sourceProofDigest)}` +
    `${frameNumber(proof.itemCount)}`).join("")}`;
}

function frameItems(items: readonly RecoveryCompletionItemEvidence[]): string {
  return `${frame(String(items.length))}${items.map((item) =>
    `${frame(item.class)}${frame(item.population)}${frame(item.identity)}` +
    `${frame(item.disposition)}${frame(item.sourceProofDigest)}` +
    `${frameNullable(item.quarantineRef)}`).join("")}`;
}

/**
 * The domain-FREE canonical bytes, exported so a suite can prove the domain tag
 * is load-bearing without reimplementing the canonicalization it is testing.
 * This is not an authority surface: it produces bytes, never a verdict.
 */
export function recoveryCompletionPreimage(evidence: RecoveryCompletionEvidence): Uint8Array {
  return encoder.encode(
    frame(RECOVERY_COMPLETION_SCHEMA_VERSION) +
    frame(evidence.projectId) +
    frame(evidence.projectTag) +
    frame(evidence.backupCursor) +
    frame(evidence.backupGenerationDigest) +
    frame(evidence.restoreBindingSlot) +
    frame(evidence.restoreCommandId) +
    frame(evidence.restoreGenerationDigest) +
    frame(evidence.incarnationRef) +
    frame(evidence.keyEpochRef) +
    frame(evidence.policyRevisionRef) +
    frame(evidence.anchorBindingDigest) +
    frameList(evidence.configuredClasses) +
    frameProofs(evidence.proofs) +
    frameItems(evidence.items) +
    frame(evidence.reconciliationRecordDigest),
  );
}

/** The one accepted R3 completion digest. Hex64, domain-separated, order-sensitive. */
export function recoveryCompletionDigest(evidence: RecoveryCompletionEvidence): string {
  return createHash("sha256")
    .update(encoder.encode(frame(RECOVERY_COMPLETION_DIGEST_DOMAIN)))
    .update(recoveryCompletionPreimage(evidence))
    .digest("hex");
}

/**
 * The narrower hash core's witness carries as `coverageProofHash`: the
 * configured class set plus its ordered proofs, under a DIFFERENT domain so it
 * can never be presented where the completion digest is demanded.
 */
export function recoveryCoverageProofDigest(
  configuredClasses: readonly string[],
  proofs: readonly RecoveryCompletionProofEvidence[],
): string {
  return createHash("sha256")
    .update(encoder.encode(
      frame(RECOVERY_COVERAGE_PROOF_DIGEST_DOMAIN) +
      frameList(configuredClasses) +
      frameProofs(proofs),
    ))
    .digest("hex");
}

export interface RecoveryCompletionRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: string;
  readonly error: RuntimeError | null;
  readonly kind: typeof RECOVERY_COMPLETION_COMMAND_KIND | null;
  readonly ok: false;
  readonly reason: string;
  readonly refusedBy: string;
  /**
   * The producer's own `{code, layer}` when a FOREIGN layer refused, `null` when
   * this layer did: a caller that cannot tell an inventory refusal from a
   * completion one cannot tell an unreconciled world from a mis-bound approval.
   */
  readonly upstream: RecoveryCompletionUpstream | null;
}

export interface RecoveryCompletionRefusalParts {
  readonly code: string;
  readonly error?: RuntimeError | null;
  readonly kind?: typeof RECOVERY_COMPLETION_COMMAND_KIND | null;
  readonly reason: string;
  readonly refusedBy?: string;
  readonly upstream?: RecoveryCompletionUpstream | null;
}

export function recoveryCompletionRefusal(
  parts: RecoveryCompletionRefusalParts,
): RecoveryCompletionRefused {
  return Object.freeze({
    advisoryOnly: true as const,
    authority: "NONE" as const,
    code: parts.code,
    error: parts.error ?? null,
    kind: parts.kind === undefined ? RECOVERY_COMPLETION_COMMAND_KIND : parts.kind,
    ok: false as const,
    reason: parts.reason,
    refusedBy: parts.refusedBy ?? RECOVERY_COMPLETION_LAYER,
    upstream: parts.upstream === undefined || parts.upstream === null
      ? null
      : Object.freeze({ code: parts.upstream.code, layer: parts.upstream.layer }),
  });
}
