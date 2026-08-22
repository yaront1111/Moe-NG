import { decodeBoundedJsonBytes } from "@moe/contracts";
import {
  decodeAcceptanceContractBytes,
  decodePlanRevisionBytes,
  deriveAcceptanceContractDigest,
  derivePlanRevisionDigest,
  encodeAcceptanceContract,
  encodePlanRevision,
} from "@moe/core";
import type {
  AcceptanceContract, AcceptanceContractRefusal, PlanRevision, PlanRevisionRefusal,
} from "@moe/core";

import {
  canonicalText,
  ENVELOPE_KEYS,
  exactRecord,
  exceeded,
  malformed,
  PLANNING_AUTHORITY_ENVELOPE_LIMITS,
  PLANNING_AUTHORITY_ENVELOPE_VERSION,
  readBindings,
  readSubmission,
  refuse,
  refused,
} from "./planning-authority-envelope-contract.js";
import type {
  PlanningAuthorityAdmitResult,
  PlanningAuthorityBindings,
  PlanningAuthorityEncodeResult,
  PlanningAuthorityEnvelope,
  PlanningAuthorityEnvelopeCode,
  PlanningAuthorityEnvelopeRefusal,
  PlanningAuthoritySubmission,
} from "./planning-authority-envelope-contract.js";

/**
 * The daemon-owned planning-authority envelope: the closed, versioned payload that carries the
 * CANONICAL plan-revision and acceptance-contract BODIES next to the run's sealed planning
 * evidence, so a later approval can read content instead of the hash/ref-only `PlanProposed`
 * body (`planning-services.ts:117-127`).
 *
 * This module owns exactly one decision: whether the two bodies, the bindings and the reducer's
 * sealed submission all name the same plan. Body admission, canonicalization and digest belong
 * to `@moe/core`, and its refusals pass through VERBATIM — restamping a `PLAN_REVISION_*` or
 * `ACCEPTANCE_CONTRACT_*` code into this vocabulary would hide which authority answered. There
 * is no local hashing here: a second digest opinion is a fork.
 */
const encoder = new TextEncoder();

function canonicalBytes(envelope: PlanningAuthorityEnvelope): PlanningAuthorityEncodeResult {
  const bytes = encoder.encode(canonicalText(envelope));
  return bytes.byteLength > PLANNING_AUTHORITY_ENVELOPE_LIMITS.maxBytes
    ? exceeded() : Object.freeze({ bytes, ok: true as const });
}

/**
 * Encode-then-decode through the published core codecs: the round trip is what verifies the
 * carried digest and the canonical form, and it hands back the core's own deeply frozen record.
 */
function readRevision(value: unknown): PlanRevision | PlanRevisionRefusal {
  const encoded = encodePlanRevision(value);
  if (!encoded.ok) return encoded;
  const decoded = decodePlanRevisionBytes(encoded.bytes);
  return decoded.ok ? decoded.revision : decoded;
}

function readContract(value: unknown): AcceptanceContract | AcceptanceContractRefusal {
  const encoded = encodeAcceptanceContract(value);
  if (!encoded.ok) return encoded;
  const decoded = decodeAcceptanceContractBytes(encoded.bytes);
  return decoded.ok ? decoded.contract : decoded;
}

/**
 * JSON, not a delimiter join: a criterion id may legally contain any separator character, so
 * `["a b"]` and `["a", "b"]` collapse to the same joined string and one roster silently satisfies
 * the other. JSON escaping keeps the encoding injective.
 */
const criterionRoster = (ids: readonly string[]): string => JSON.stringify([...ids].sort());

/**
 * Every cross-binding in one fixed-order table, one exact code each. Both digests are
 * RECOMPUTED here through the core derivations, so a caller-carried digest never decides
 * anything: recomputation wins, and a body whose own digest field disagrees has already been
 * refused above with the CORE's code and layer rather than this module's.
 */
function severedBinding(
  bindings: PlanningAuthorityBindings, submission: PlanningAuthoritySubmission,
  revision: PlanRevision, contract: AcceptanceContract,
): PlanningAuthorityEnvelopeRefusal | undefined {
  const planDigest = derivePlanRevisionDigest(revision);
  const criteriaDigest = deriveAcceptanceContractDigest(contract);
  if (!planDigest.ok || !criteriaDigest.ok) return malformed();
  const checks: readonly (readonly [PlanningAuthorityEnvelopeCode, string, string])[] = [
    ["PLANNING_AUTHORITY_PROJECT_MISMATCH", bindings.projectId, submission.projectId],
    ["PLANNING_AUTHORITY_GOAL_MISMATCH", bindings.goalRef, submission.goalRef],
    ["PLANNING_AUTHORITY_RUN_MISMATCH", bindings.runId, submission.runId],
    ["PLANNING_AUTHORITY_REVISION_MISMATCH", bindings.revisionId, revision.revisionId],
    ["PLANNING_AUTHORITY_GRAPH_REVISION_MISMATCH", revision.graphBinding.graphRevisionRef,
      submission.graphRevisionRef],
    ["PLANNING_AUTHORITY_APPLICABILITY_MISMATCH", contract.applicability.graphRevisionRef,
      submission.graphRevisionRef],
    ["PLANNING_AUTHORITY_GRAPH_CONTENT_MISMATCH", revision.graphBinding.graphContentHash,
      submission.sealedHashes.graphContentHash],
    ["PLANNING_AUTHORITY_SUBMISSION_HASH_MISMATCH", planDigest.planHash,
      submission.sealedHashes.planHash],
    ["PLANNING_AUTHORITY_CRITERIA_DIGEST_MISMATCH", criteriaDigest.criteriaDigest,
      submission.criteriaDigest],
    ["PLANNING_AUTHORITY_CRITERIA_BINDING_MISMATCH",
      criterionRoster(contract.obligations.map((obligation) => obligation.criterionId)),
      criterionRoster(revision.affectedCriterionIds)],
  ];
  for (const [code, left, right] of checks) if (left !== right) return refuse(code);
  return undefined;
}

export function admitPlanningAuthorityEnvelope(value: unknown): PlanningAuthorityAdmitResult {
  const record = exactRecord(value, ENVELOPE_KEYS);
  if (record === undefined) return malformed();
  if (record["version"] !== PLANNING_AUTHORITY_ENVELOPE_VERSION) {
    return refuse("PLANNING_AUTHORITY_ENVELOPE_VERSION_UNSUPPORTED");
  }
  const bindings = readBindings(record["bindings"]);
  if (refused(bindings)) return bindings;
  const submission = readSubmission(record["submission"]);
  if (refused(submission)) return submission;
  const planRevision = readRevision(record["planRevision"]);
  if ("ok" in planRevision) return planRevision;
  const acceptanceContract = readContract(record["acceptanceContract"]);
  if ("ok" in acceptanceContract) return acceptanceContract;
  const limits = PLANNING_AUTHORITY_ENVELOPE_LIMITS;
  if (planRevision.affectedCriterionIds.length > limits.maxCriterionIds
    || acceptanceContract.obligations.length > limits.maxCriterionIds) return exceeded();
  const severed = severedBinding(bindings, submission, planRevision, acceptanceContract);
  if (severed !== undefined) return severed;
  const envelope = Object.freeze({
    acceptanceContract, bindings, planRevision, submission,
    version: PLANNING_AUTHORITY_ENVELOPE_VERSION,
  });
  const bounded = canonicalBytes(envelope);
  return bounded.ok ? Object.freeze({ envelope, ok: true as const }) : bounded;
}

export function encodePlanningAuthorityEnvelope(value: unknown): PlanningAuthorityEncodeResult {
  const admitted = admitPlanningAuthorityEnvelope(value);
  return admitted.ok ? canonicalBytes(admitted.envelope) : admitted;
}

function decodeFailure(code: string): PlanningAuthorityEnvelopeRefusal {
  if (code === "JSON_DUPLICATE_KEY") return refuse("PLANNING_AUTHORITY_ENVELOPE_DUPLICATE_KEY");
  if (code === "JSON_BODY_LIMIT_EXCEEDED" || code === "JSON_DEPTH_LIMIT_EXCEEDED"
    || code === "JSON_STRING_LIMIT_EXCEEDED") return exceeded();
  return refuse("PLANNING_AUTHORITY_ENVELOPE_BYTES_INVALID");
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

/**
 * Never trusts a stored digest: the admitted content is re-encoded and byte-compared with the
 * input, so a semantically-equal but non-canonical encoding is refused rather than adopted.
 */
export function decodePlanningAuthorityEnvelopeBytes(
  bytes: unknown,
): PlanningAuthorityAdmitResult {
  const decoded = decodeBoundedJsonBytes(bytes);
  if (!decoded.ok) return decodeFailure(decoded.code);
  if (decoded.value === null || typeof decoded.value !== "object"
    || Array.isArray(decoded.value)) {
    return refuse("PLANNING_AUTHORITY_ENVELOPE_BYTES_INVALID");
  }
  const admitted = admitPlanningAuthorityEnvelope(decoded.value);
  if (!admitted.ok) return admitted;
  const reencoded = canonicalBytes(admitted.envelope);
  if (!reencoded.ok) return reencoded;
  return sameBytes(new Uint8Array(bytes as Uint8Array), reencoded.bytes)
    ? admitted : refuse("PLANNING_AUTHORITY_ENVELOPE_NONCANONICAL");
}

export {
  PLANNING_AUTHORITY_ENVELOPE_CODES,
  PLANNING_AUTHORITY_ENVELOPE_LIMITS,
  PLANNING_AUTHORITY_ENVELOPE_VERSION,
} from "./planning-authority-envelope-contract.js";
export type {
  PlanningAuthorityAdmitResult,
  PlanningAuthorityBindings,
  PlanningAuthorityEncodeResult,
  PlanningAuthorityEnvelope,
  PlanningAuthorityEnvelopeCode,
  PlanningAuthorityEnvelopeLayer,
  PlanningAuthorityEnvelopeRefusal,
  PlanningAuthorityRefusal,
  PlanningAuthoritySubmission,
} from "./planning-authority-envelope-contract.js";
