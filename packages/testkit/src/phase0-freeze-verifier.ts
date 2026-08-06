import {
  PHASE0_AUTHORIZATION_ASSURANCE,
  PHASE0_FREEZE_CANDIDATE_VERSION,
  PHASE0_FREEZE_REQUIRED_ACTION,
  PHASE0_FREEZE_VERDICT,
  PHASE0_MAX_AUTHORIZATION_BYTES,
  PHASE0_MAX_DOCUMENT_BYTES,
  PHASE0_REVIEW_RECEIPT_PREFIX,
  PHASE0_REVIEW_RECEIPT_VERSION,
  PHASE0_REVIEW_ASSURANCE,
  type Phase0EvidenceRole,
  type Phase0FreezeCandidate,
  type Phase0ReviewReceipt,
} from "@moe/contracts";

import { canonicalize } from "./canonical-json.js";
import { identifyEvidence, snapshotEvidenceBytes, type EvidenceIdentity } from "./evidence-digest.js";
import {
  decodeFreezeAuthorizationClaim,
  freezeError,
  parseCanonicalJsonRecord,
  requireCanonicalInstant,
  requireExactKeys,
  requireRecord,
  requireSha256,
} from "./phase0-freeze-codec.js";
import {
  verifyPhase0EvidenceManifest,
  type Phase0FreezeObjectReader,
} from "./phase0-evidence-manifest-verifier.js";

const REVIEWED_ROLES = Object.freeze([
  "benchmark-spec",
  "control-room-spec",
  "fable-review",
  "rebuild-charter",
  "rebuild-design",
] as const satisfies readonly Phase0EvidenceRole[]);

export interface EvaluatePhase0FreezeCandidateInput extends Phase0FreezeObjectReader {
  readonly authorizationClaimBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly now: () => string;
}

export interface EvaluatedPhase0FreezeCandidate {
  readonly candidate: Phase0FreezeCandidate;
  readonly candidateJson: string;
  readonly identity: EvidenceIdentity;
}

function decodeReviewText(bytes: Uint8Array): string {
  let snapshot: Uint8Array;
  try {
    snapshot = snapshotEvidenceBytes(bytes, PHASE0_MAX_DOCUMENT_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return freezeError("PHASE0_REVIEW_BYTES_LIMIT_EXCEEDED", "moe-review");
    }
    return freezeError("PHASE0_REVIEW_BYTES_INVALID", "moe-review");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
  } catch {
    return freezeError("PHASE0_REVIEW_UTF8_INVALID", "moe-review");
  }
  if (text.includes("\0")) {
    freezeError("PHASE0_REVIEW_UTF8_INVALID", "NUL");
  }
  return text;
}

function terminalReviewLines(text: string): readonly string[] {
  let body = text;
  if (body.endsWith("\r\n")) {
    body = body.slice(0, -2);
  } else if (body.endsWith("\n")) {
    body = body.slice(0, -1);
  }
  if (body.length === 0 || body.endsWith("\n") || body.endsWith("\r")) {
    return freezeError("PHASE0_REVIEW_VERDICT_INVALID", "trailing blank content");
  }
  const lines = body.split(/\r?\n/);
  const exactVerdicts = lines.filter(
    (line) => line === PHASE0_FREEZE_VERDICT || line === "NOT_FREEZE_READY",
  );
  if (
    lines.at(-1) !== PHASE0_FREEZE_VERDICT ||
    exactVerdicts.length !== 1 ||
    lines.length < 2
  ) {
    return freezeError("PHASE0_REVIEW_VERDICT_INVALID", "terminal verdict");
  }
  return lines;
}

function decodeReviewReceipt(
  reviewBytes: Uint8Array,
  readEvidence: (role: Phase0EvidenceRole) => Uint8Array,
): Phase0ReviewReceipt {
  const lines = terminalReviewLines(decodeReviewText(reviewBytes));
  const receiptLines = lines.filter((line) => line.startsWith(PHASE0_REVIEW_RECEIPT_PREFIX));
  const terminalReceiptLine = lines.at(-2)!;
  if (
    receiptLines.length !== 1 ||
    terminalReceiptLine !== receiptLines[0] ||
    !terminalReceiptLine.startsWith(PHASE0_REVIEW_RECEIPT_PREFIX)
  ) {
    return freezeError("PHASE0_REVIEW_RECEIPT_INVALID", "terminal receipt");
  }
  const receiptJson = terminalReceiptLine.slice(PHASE0_REVIEW_RECEIPT_PREFIX.length);
  const { record } = parseCanonicalJsonRecord(
    new TextEncoder().encode(receiptJson),
    "review-receipt",
  );
  requireExactKeys(
    record,
    ["inputSha256", "schemaVersion", "verdict"],
    "PHASE0_REVIEW_RECEIPT_INVALID",
    "keys",
  );
  if (
    record.schemaVersion !== PHASE0_REVIEW_RECEIPT_VERSION ||
    record.verdict !== PHASE0_FREEZE_VERDICT
  ) {
    freezeError("PHASE0_REVIEW_RECEIPT_INVALID", "fixed fields");
  }
  const inputSha256 = requireRecord(
    record.inputSha256,
    "PHASE0_REVIEW_RECEIPT_INVALID",
    "inputSha256",
  );
  requireExactKeys(
    inputSha256,
    REVIEWED_ROLES,
    "PHASE0_REVIEW_RECEIPT_INVALID",
    "inputSha256 keys",
  );
  const verifiedDigests = {} as Record<(typeof REVIEWED_ROLES)[number], string>;
  for (const role of REVIEWED_ROLES) {
    const claimedDigest = requireSha256(
      inputSha256[role],
      "PHASE0_REVIEW_RECEIPT_INVALID",
      role,
    );
    const bytes = readEvidence(role);
    if (identifyEvidence(bytes).digest !== claimedDigest) {
      freezeError("PHASE0_REVIEW_INPUT_DIGEST_MISMATCH", role);
    }
    verifiedDigests[role] = claimedDigest;
  }
  return Object.freeze({
    inputSha256: Object.freeze({ ...verifiedDigests }),
    schemaVersion: PHASE0_REVIEW_RECEIPT_VERSION,
    verdict: PHASE0_FREEZE_VERDICT,
  });
}

function compareTimes(capturedAt: string, claimedAt: string, evaluatedAt: string): void {
  if (capturedAt > claimedAt || claimedAt > evaluatedAt) {
    freezeError("PHASE0_FREEZE_TIME_INVALID", `${capturedAt}/${claimedAt}/${evaluatedAt}`);
  }
}

export async function evaluatePhase0FreezeCandidate(
  input: EvaluatePhase0FreezeCandidateInput,
): Promise<EvaluatedPhase0FreezeCandidate> {
  let authorizationClaimBytes: Uint8Array;
  try {
    authorizationClaimBytes = snapshotEvidenceBytes(
      input.authorizationClaimBytes,
      PHASE0_MAX_AUTHORIZATION_BYTES,
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return freezeError("PHASE0_AUTHORIZATION_BYTES_LIMIT_EXCEEDED", "authorization");
    }
    return freezeError("PHASE0_AUTHORIZATION_BYTES_INVALID", "authorization");
  }
  const authorizationIdentity = identifyEvidence(authorizationClaimBytes);
  const authorization = decodeFreezeAuthorizationClaim(authorizationClaimBytes);
  const verifiedManifest = await verifyPhase0EvidenceManifest(input.manifestBytes, input);
  if (verifiedManifest.identity.digest !== authorization.manifestSha256) {
    freezeError("PHASE0_MANIFEST_DIGEST_MISMATCH", "authorization pin");
  }

  const byRole = new Map(verifiedManifest.manifest.entries.map((entry) => [entry.role, entry]));
  const design = byRole.get("rebuild-design")!;
  const benchmark = byRole.get("benchmark-spec")!;
  const review = byRole.get("moe-review")!;
  if (design.sha256 !== authorization.designSha256) {
    freezeError("PHASE0_DESIGN_DIGEST_MISMATCH", design.sha256);
  }
  if (benchmark.sha256 !== authorization.benchmarkSha256) {
    freezeError("PHASE0_BENCHMARK_DIGEST_MISMATCH", benchmark.sha256);
  }
  if (review.sha256 !== authorization.reviewSha256) {
    freezeError("PHASE0_REVIEW_DIGEST_MISMATCH", review.sha256);
  }
  const reviewBytes = verifiedManifest.readEvidence("moe-review");
  decodeReviewReceipt(reviewBytes, (role) => verifiedManifest.readEvidence(role));

  const evaluatedAt = requireCanonicalInstant(
    input.now(),
    "PHASE0_FREEZE_TIME_INVALID",
    "evaluatedAt",
  );
  compareTimes(verifiedManifest.manifest.capturedAt, authorization.claimedAt, evaluatedAt);

  const finalManifest = await verifyPhase0EvidenceManifest(
    new TextEncoder().encode(verifiedManifest.manifestJson),
    input,
  );
  if (finalManifest.identity.digest !== verifiedManifest.identity.digest) {
    freezeError("PHASE0_MANIFEST_DIGEST_MISMATCH", "final verification");
  }
  const finalReviewBytes = finalManifest.readEvidence("moe-review");
  decodeReviewReceipt(finalReviewBytes, (role) => finalManifest.readEvidence(role));
  const finalByRole = new Map(finalManifest.manifest.entries.map((entry) => [entry.role, entry]));
  const finalDesign = finalByRole.get("rebuild-design")!;
  const finalBenchmark = finalByRole.get("benchmark-spec")!;
  const finalReview = finalByRole.get("moe-review")!;

  const candidate: Phase0FreezeCandidate = Object.freeze({
    authorizationClaim: Object.freeze({
      assurance: PHASE0_AUTHORIZATION_ASSURANCE,
      byteLength: authorizationIdentity.byteLength,
      claimedActor: authorization.claimedActor,
      claimedDecision: authorization.claimedDecision,
      objectPath: authorizationIdentity.objectPath,
      sha256: authorizationIdentity.digest,
    }),
    benchmarkSha256: finalBenchmark.sha256,
    designSha256: finalDesign.sha256,
    evaluatedAt,
    evaluation: "EVIDENCE_CONSISTENT",
    manifest: Object.freeze({
      byteLength: finalManifest.identity.byteLength,
      objectPath: finalManifest.identity.objectPath,
      sha256: finalManifest.identity.digest,
    }),
    requiredAction: PHASE0_FREEZE_REQUIRED_ACTION,
    reviewClaim: Object.freeze({
      assurance: PHASE0_REVIEW_ASSURANCE,
      byteLength: finalReview.byteLength,
      claimedVerdict: PHASE0_FREEZE_VERDICT,
      objectPath: finalReview.objectPath,
      sha256: finalReview.sha256,
    }),
    schemaVersion: PHASE0_FREEZE_CANDIDATE_VERSION,
    sourceHead: finalManifest.manifest.sourceBefore.head,
    targetRepository: finalManifest.manifest.targetRepository,
  });
  const candidateJson = canonicalize(candidate);
  const identity = identifyEvidence(new TextEncoder().encode(candidateJson));
  return Object.freeze({
    candidate,
    candidateJson,
    identity: Object.freeze({ ...identity }),
  });
}
