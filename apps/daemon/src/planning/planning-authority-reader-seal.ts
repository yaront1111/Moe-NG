/**
 * The AUTHORITY-AGGREGATE side of the planning-authority read (task-47b2dbc6): from a verified run
 * identity to the bodies that run durably sealed, or the refusal that says which check answered.
 *
 * `planning-authority-reader-witness.ts` owns the goal side and hands the binding here. Neither
 * public reader may grow a second copy of this walk, because two copies can disagree about what
 * "approved" means. The chain, with its anchors:
 *
 *   {runId, authorityRef, bodiesDigest, envelopeDigest} — written by `durableActivationWitness`
 *     (approval-activation.ts:69-82), verified at decide by `verifyApprovedRunBinding`
 *     (approval-run-binding.ts:143-190)
 *   -> `planningAuthorityAggregateId(runId)` (planning-authority-persistence.ts:87)
 *   -> `PlanningAuthorityBodiesSealed` (persistence.ts:203-216) and
 *      `PlanningAuthorityEnvelopeSealed` (planning-authority-finalize.ts:176-183), each selected
 *      BY TYPE and required to be UNIQUE
 *   -> the `@moe/core` body codecs plus the writer's own framed `bodiesDigestOf` recompute.
 */
import { createHash } from "node:crypto";

import { decodeAcceptanceContractBytes, decodePlanRevisionBytes } from "@moe/core";
import type { AcceptanceContract, PlanRevision } from "@moe/core";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { decodePlanningAuthorityEnvelopeBytes } from "./planning-authority-envelope.js";
import { PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE } from "./planning-authority-finalize.js";
import { bodiesDigestOf, planningAuthorityAggregateId } from "./planning-authority-persistence.js";
import { readerPassthrough, readerRefusal } from "./planning-authority-reader-contract.js";
import type { PlanningAuthorityReaderRefusal } from "./planning-authority-reader-contract.js";
import {
  eventsOfType,
  payloadRecord,
  readAggregate,
  readApprovedRunWitness,
  refOf,
} from "./planning-authority-reader-witness.js";
import type { ApprovedRunBinding, JsonRecord } from "./planning-authority-reader-witness.js";

/**
 * The bodies event type, matched as a STRING because no site exports it — unlike the envelope
 * type, which `planning-authority-finalize.ts:48` DOES export and which is imported above rather
 * than restated. The literal lives unexported at `AUTHORITY_EVENT_TYPE`
 * (planning-authority-persistence.ts:38, the WRITER) and `BODIES_EVENT_TYPE`
 * (planning-authority-finalize.ts:50, approval-run-binding.ts:86). RENAME HAZARD, reported not
 * fixed: a rename at the writer nulls this selector and presents as a missing seal.
 */
const BODIES_EVENT_TYPE = "PlanningAuthorityBodiesSealed";

export interface SealedAuthority {
  readonly authorityRef: string;
  readonly contract: AcceptanceContract;
  readonly revision: PlanRevision;
  readonly runId: string;
}

interface SealedPayloads {
  readonly bodies: JsonRecord;
  readonly envelope: JsonRecord;
}

interface DecodedBodies {
  readonly contract: AcceptanceContract;
  readonly revision: PlanRevision;
}

const bytesOf = (record: JsonRecord, key: string): Uint8Array | null => {
  const value = refOf(record, key);
  return value === null ? null : new Uint8Array(Buffer.from(value, "base64"));
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Exactly one bodies event and exactly one envelope event, each selected BY TYPE and never by
 * index: both land on this same aggregate and their write order is unpinned, so a take-first read
 * names whichever arrived first and would read the envelope's fields while looking correct.
 */
function sealedPayloads(
  store: SqliteEventStore, authorityRef: string,
): SealedPayloads | PlanningAuthorityReaderRefusal {
  const events: readonly StoredEvent[] = readAggregate(store, authorityRef);
  const selected: Record<string, JsonRecord> = {};
  for (const [side, eventType] of [
    ["bodies", BODIES_EVENT_TYPE], ["envelope", PLANNING_AUTHORITY_ENVELOPE_EVENT_TYPE],
  ] as const) {
    const matches = eventsOfType(events, eventType);
    if (matches.length === 0) return readerRefusal("PLANNING_AUTHORITY_READER_SEAL_ABSENT", side);
    if (matches.length > 1) return readerRefusal("PLANNING_AUTHORITY_READER_SEAL_AMBIGUOUS", side);
    const payload = payloadRecord((matches[0] as StoredEvent).payload);
    if (payload === null) return readerRefusal("PLANNING_AUTHORITY_READER_SEAL_MALFORMED", side);
    selected[side] = payload;
  }
  return Object.freeze({
    bodies: selected["bodies"] as JsonRecord, envelope: selected["envelope"] as JsonRecord,
  });
}

/**
 * The bodies as they are ON DISK.
 *
 * The codecs decide admissibility, the carried digest and canonicality — each re-encodes and
 * byte-compares its own admitted content, so a second opinion here would be a fork and their
 * refusals travel out under `source` instead. The framed recompute, the WRITER's own function
 * imported rather than copied, decides the remaining question: whether those bytes are the bytes
 * the seal covers. A valid body substituted for another valid body passes every codec and is
 * caught here alone.
 */
function decodeBodies(bodies: JsonRecord): DecodedBodies | PlanningAuthorityReaderRefusal {
  const planBytes = bytesOf(bodies, "planRevisionBytesBase64");
  const contractBytes = bytesOf(bodies, "acceptanceContractBytesBase64");
  const sealedDigest = refOf(bodies, "bodiesDigest");
  if (planBytes === null || contractBytes === null || sealedDigest === null) {
    return readerRefusal("PLANNING_AUTHORITY_READER_SEAL_MALFORMED", "bodies");
  }
  const revision = decodePlanRevisionBytes(planBytes);
  if (!revision.ok) return readerPassthrough("PLANNING_AUTHORITY_READER_BODIES_INVALID", revision);
  const contract = decodeAcceptanceContractBytes(contractBytes);
  if (!contract.ok) return readerPassthrough("PLANNING_AUTHORITY_READER_BODIES_INVALID", contract);
  return bodiesDigestOf(planBytes, contractBytes) === sealedDigest
    ? Object.freeze({ contract: contract.contract, revision: revision.revision })
    : readerRefusal("PLANNING_AUTHORITY_READER_SEAL_DIGEST_MISMATCH", "bodies");
}

/**
 * The envelope is a CROSS-EVENT check and nothing else. Its codec has already proved it is
 * internally consistent; what no codec can see is an envelope that is perfectly valid but sealed
 * for a different run, project or revision than the bodies beside it.
 */
function envelopeAgrees(
  envelope: JsonRecord, binding: ApprovedRunBinding, revision: PlanRevision, projectId: string,
): PlanningAuthorityReaderRefusal | undefined {
  const bytes = bytesOf(envelope, "envelopeBytesBase64");
  const sealedDigest = refOf(envelope, "envelopeDigest");
  if (bytes === null || sealedDigest === null) {
    return readerRefusal("PLANNING_AUTHORITY_READER_SEAL_MALFORMED", "envelope");
  }
  if (sha256(bytes) !== sealedDigest) {
    return readerRefusal("PLANNING_AUTHORITY_READER_SEAL_DIGEST_MISMATCH", "envelope");
  }
  const decoded = decodePlanningAuthorityEnvelopeBytes(bytes);
  if (!decoded.ok) return readerPassthrough("PLANNING_AUTHORITY_READER_ENVELOPE_INVALID", decoded);
  const { bindings, submission } = decoded.envelope;
  const agrees = bindings.runId === binding.runId && bindings.projectId === projectId
    && bindings.revisionId === revision.revisionId
    && submission.graphRevisionRef === revision.graphBinding.graphRevisionRef;
  return agrees ? undefined : readerRefusal("PLANNING_AUTHORITY_READER_ENVELOPE_DIVERGED");
}

/**
 * The one locator both readers share.
 *
 * `authorityRef` is a LOCATOR, NOT EVIDENCE: the aggregate is DERIVED from `runId`, and a witness
 * whose ref names anything else is refused rather than followed. The digests are the evidence, and
 * they are checked three ways — witness against payload, then payload against a recompute over the
 * bytes actually on disk.
 */
export function locateSealedAuthority(
  store: SqliteEventStore, projectId: string, goalId: string,
): SealedAuthority | PlanningAuthorityReaderRefusal {
  const binding = readApprovedRunWitness(store, goalId);
  if ("ok" in binding) return binding;
  if (binding.authorityRef !== planningAuthorityAggregateId(binding.runId)) {
    return readerRefusal("PLANNING_AUTHORITY_READER_LOCATOR_MISMATCH");
  }
  const sealed = sealedPayloads(store, binding.authorityRef);
  if ("ok" in sealed) return sealed;
  if (refOf(sealed.bodies, "projectId") !== projectId) {
    return readerRefusal("PLANNING_AUTHORITY_READER_PROJECT_MISMATCH");
  }
  // The seal names the goal it was sealed FOR. Without this the run identity alone would carry
  // the read, and bodies sealed for a different goal would answer for this one.
  if (refOf(sealed.bodies, "goalRef") !== goalId) {
    return readerRefusal("PLANNING_AUTHORITY_READER_GOAL_MISMATCH");
  }
  if (refOf(sealed.bodies, "bodiesDigest") !== binding.bodiesDigest) {
    return readerRefusal("PLANNING_AUTHORITY_READER_WITNESS_DIGEST_MISMATCH", "bodies");
  }
  if (refOf(sealed.envelope, "envelopeDigest") !== binding.envelopeDigest) {
    return readerRefusal("PLANNING_AUTHORITY_READER_WITNESS_DIGEST_MISMATCH", "envelope");
  }
  const decoded = decodeBodies(sealed.bodies);
  if ("ok" in decoded) return decoded;
  const severed = envelopeAgrees(sealed.envelope, binding, decoded.revision, projectId);
  return severed ?? Object.freeze({
    authorityRef: binding.authorityRef,
    contract: decoded.contract,
    revision: decoded.revision,
    runId: binding.runId,
  });
}
