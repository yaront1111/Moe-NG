import type { SqliteEventStore } from "@moe/store";

import type { RecoveryIncarnationProof } from "./recovery-incarnation-contract.js";

/**
 * Vocabulary and shapes for proving that a freshly minted recovery incarnation
 * succeeds the one an interrupted restore started with.
 *
 * Split out of `recovery-succession.ts` purely to hold the per-file line cap,
 * for the same reason `recovery-incarnation-contract.ts` documents; the
 * succession service is the only intended consumer and re-publishes every
 * symbol here, so callers still see one module.
 *
 * The predecessor's private key is destroyed when its process dies. Nothing in
 * this file asks it to sign again: succession is proved from the durable fields
 * it left behind, and the SUCCESSOR signs the statement linking the two.
 */
export const RECOVERY_SUCCESSION_SCHEMA_VERSION = "moe-recovery-succession/1" as const;

export const RECOVERY_SUCCESSION_LAYER = "RECOVERY_SUCCESSION" as const;

export const RECOVERY_SUCCESSION_COMMAND_KIND = "recovery.succeed" as const;

export const RECOVERY_SUCCESSION_ERROR_CODES = Object.freeze([
  "RECOVERY_SUCCESSION_INPUT_INVALID",
  "RECOVERY_PREDECESSOR_NOT_FOUND",
  "RECOVERY_PREDECESSOR_UNVERIFIABLE",
  "RECOVERY_SUCCESSION_ALREADY_RECORDED",
  "RECOVERY_SUCCESSION_PROOF_UNAVAILABLE",
  "RECOVERY_INCARNATION_ANCHOR_UNAVAILABLE",
] as const);
export type RecoverySuccessionErrorCode = (typeof RECOVERY_SUCCESSION_ERROR_CODES)[number];

/**
 * The one command kind an incarnation binding is anchored under. A succession
 * can only name a predecessor that exists as one of these rows, which is what
 * turns "the caller says it held that incarnation" into a durable fact.
 */
export const RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND = "recovery.incarnate" as const;

/**
 * Every field is a string or a nested proof of strings, so the whole record
 * survives `JSON.stringify` with nothing left behind. There is deliberately no
 * key handle and no private key field: what a succession record must prove is
 * checkable from public bytes alone.
 */
export interface RecoverySuccessionRecord {
  readonly schemaVersion: typeof RECOVERY_SUCCESSION_SCHEMA_VERSION;
  readonly restoreCommandId: string;
  readonly predecessorIncarnationRef: string;
  readonly predecessorKeyEpochRef: string;
  readonly predecessorBindingDigest: string;
  readonly predecessorVerificationKeyFingerprint: string;
  readonly successorIncarnationRef: string;
  readonly successorKeyEpochRef: string;
  readonly successorBindingDigest: string;
  readonly successionDigest: string;
  readonly proof: RecoveryIncarnationProof;
}

export interface RecoverySuccessionRecorded {
  readonly ok: true;
  readonly outcome: "SUCCEEDED";
  readonly authority: "NONE";
  readonly record: RecoverySuccessionRecord;
}

export interface RecoverySuccessionRefused {
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly authority: "NONE";
  readonly layer: typeof RECOVERY_SUCCESSION_LAYER;
  readonly code: RecoverySuccessionErrorCode;
  readonly truth: "UNKNOWN";
  readonly reason: string;
}

export type RecoverySuccessionResult = RecoverySuccessionRecorded | RecoverySuccessionRefused;

/**
 * The ordered chain walked backwards from a current incarnation to the origin,
 * plus the restore command the whole chain descends from. `links` is ordered
 * newest-first; an unbroken chain ends at the incarnation that has no
 * predecessor record.
 */
export interface RecoverySuccessionChain {
  readonly ok: true;
  readonly originIncarnationRef: string;
  readonly restoreCommandId: string;
  readonly links: readonly RecoverySuccessionRecord[];
}

export type RecoverySuccessionChainResult = RecoverySuccessionChain | RecoverySuccessionRefused;

/**
 * The store is a parameter rather than a constructor dependency, matching
 * `reconcileOnRestart`: one service instance serves whichever handle the daemon
 * currently holds, and a reopened store after a crash is simply the next
 * argument rather than a reason to rebuild the key port.
 */
export interface RecoverySuccessionService {
  readonly succeed: (
    store: SqliteEventStore,
    request: unknown,
  ) => Promise<RecoverySuccessionResult>;
}

/**
 * Refusals are FIXED module constants, exactly as the incarnation contract
 * builds them. Nothing observed at the failure site reaches them, so a caught
 * provider message, a key byte or a stack frame has no path into evidence even
 * by accident.
 */
const refusal = (code: RecoverySuccessionErrorCode, reason: string): RecoverySuccessionRefused =>
  Object.freeze({
    authority: "NONE" as const,
    code,
    layer: RECOVERY_SUCCESSION_LAYER,
    ok: false as const,
    outcome: "REFUSED" as const,
    reason,
    truth: "UNKNOWN" as const,
  });

export const SUCCESSION_INPUT_INVALID = refusal(
  "RECOVERY_SUCCESSION_INPUT_INVALID",
  "A succession request must name exactly one predecessor incarnation and one restore command.",
);
export const SUCCESSION_PREDECESSOR_NOT_FOUND = refusal(
  "RECOVERY_PREDECESSOR_NOT_FOUND",
  "No durable binding for the named predecessor incarnation exists in this project.",
);
export const SUCCESSION_PREDECESSOR_UNVERIFIABLE = refusal(
  "RECOVERY_PREDECESSOR_UNVERIFIABLE",
  "The predecessor binding did not prove itself against its own published verification key.",
);
export const SUCCESSION_ALREADY_RECORDED = refusal(
  "RECOVERY_SUCCESSION_ALREADY_RECORDED",
  "This predecessor incarnation has already been succeeded; a chain cannot fork.",
);
export const SUCCESSION_PROOF_UNAVAILABLE = refusal(
  "RECOVERY_SUCCESSION_PROOF_UNAVAILABLE",
  "The successor could not produce a self-proving signature over the succession statement.",
);
export const SUCCESSION_ANCHOR_UNAVAILABLE = refusal(
  "RECOVERY_INCARNATION_ANCHOR_UNAVAILABLE",
  "The successor incarnation could not be anchored durably, so no succession was recorded.",
);

const HEX64 = /^[0-9a-f]{64}$/;
const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

/** Every field of a record that is a `digestOf` output and must read back as one. */
const RECORD_DIGEST_KEYS = Object.freeze([
  "predecessorBindingDigest",
  "predecessorIncarnationRef",
  "predecessorKeyEpochRef",
  "predecessorVerificationKeyFingerprint",
  "successionDigest",
  "successorBindingDigest",
  "successorIncarnationRef",
  "successorKeyEpochRef",
]);

const RECORD_KEYS = Object.freeze([
  "predecessorBindingDigest",
  "predecessorIncarnationRef",
  "predecessorKeyEpochRef",
  "predecessorVerificationKeyFingerprint",
  "proof",
  "restoreCommandId",
  "schemaVersion",
  "successionDigest",
  "successorBindingDigest",
  "successorIncarnationRef",
  "successorKeyEpochRef",
]);

/**
 * A bounded exact-shape decode, not a cast. A row that has drifted, been
 * truncated or gained a field reads as ABSENT rather than being admitted with
 * fields the reader would then be free to invent — which for a chain walk means
 * the walk stops at a broken row instead of continuing through it.
 */
export const decodeSuccessionRecord = (bytes: Uint8Array): RecoverySuccessionRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== RECORD_KEYS.length || !keys.every((key) => RECORD_KEYS.includes(key))) {
    return null;
  }
  // Every ref and digest is checked, not just the key set. A reader that trusts
  // only itself to have written the row is making an assumption about the
  // caller; the anchor decoder does not make it either.
  const fields = parsed as Record<string, unknown>;
  if (RECORD_DIGEST_KEYS.some((key) => !isHex64(fields[key]))) return null;
  if (typeof fields["restoreCommandId"] !== "string" || fields["restoreCommandId"].length === 0) {
    return null;
  }
  const record = parsed as unknown as RecoverySuccessionRecord;
  if (record.schemaVersion !== RECOVERY_SUCCESSION_SCHEMA_VERSION) return null;
  if (record.proof === null || typeof record.proof !== "object") return null;
  if (record.proof.verified !== true) return null;
  if (!isHex64(record.proof.challengeDigest)) return null;
  if (typeof record.proof.signatureHex !== "string" || record.proof.signatureHex.length === 0) {
    return null;
  }
  return Object.freeze(record);
};

/** Aggregate identity is keyed on the PREDECESSOR: see `successionAggregateId`. */
export const RECOVERY_SUCCESSION_AGGREGATE_PREFIX = "recovery-succession:" as const;

/**
 * Keyed on the predecessor, never the successor. A successor ref is freshly
 * minted and unique per attempt, so `expectedVersion: 0` against it would be
 * satisfied every time and would enforce nothing. Keyed on the predecessor,
 * the store itself refuses the second succession from one incarnation, which
 * is what makes fork prevention real rather than a read-then-write race.
 */
export const successionAggregateId = (predecessorIncarnationRef: string): string =>
  `${RECOVERY_SUCCESSION_AGGREGATE_PREFIX}${predecessorIncarnationRef}`;

/** Keyed on the incarnation itself: one incarnation, one anchor, forever. */
export const RECOVERY_INCARNATION_AGGREGATE_PREFIX = "recovery-incarnation:" as const;

export const incarnationAggregateId = (incarnationRef: string): string =>
  `${RECOVERY_INCARNATION_AGGREGATE_PREFIX}${incarnationRef}`;

/** The durable-write context both writers need; supplied by the daemon, not a caller. */
export interface RecoveryDurableWriteRequest {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
}

export interface RecoverySuccessionRequest extends RecoveryDurableWriteRequest {
  readonly backupGenerationDigest: string;
  /** The incarnation the interrupted restore was running under. */
  readonly predecessorIncarnationRef: string;
  /** The restore command the SUCCESSOR is minted for; the origin's is read from its anchor. */
  readonly restoreCommandId: string;
}

const SUCCESSION_REQUEST_KEYS = Object.freeze([
  "backupGenerationDigest",
  "correlationId",
  "decidedAt",
  "predecessorIncarnationRef",
  "principalId",
  "projectId",
  "restoreCommandId",
]);

const UNSAFE_ID = /[\s\p{Cc}\p{Cf}]/u;
const MAX_ID_CHARS = 200;

const isSafeId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_CHARS &&
  !UNSAFE_ID.test(value) &&
  value.normalize("NFC") === value;

const isDataProperty = (descriptor: PropertyDescriptor | undefined): boolean =>
  descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined;

/**
 * One synchronous read of own property DESCRIPTORS, before any await, exactly as
 * the incarnation contract does and for the same reason: an accessor or a proxy
 * must not be able to answer differently the second time, and a caller mutating
 * the request while the succession is in flight must not be able to move it.
 *
 * Extra keys are refused rather than ignored. A caller-supplied binding,
 * `keyHandle` or `successorIncarnationRef` is precisely what this service must
 * never accept, and dropping one silently would look like it had been honoured.
 */
export const snapshotSuccessionRequest = (value: unknown): RecoverySuccessionRequest | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== SUCCESSION_REQUEST_KEYS.length) return null;
  if (keys.some((key) => typeof key !== "string" || !SUCCESSION_REQUEST_KEYS.includes(key))) {
    return null;
  }
  if (SUCCESSION_REQUEST_KEYS.some((key) => !isDataProperty(descriptors[key]))) return null;

  const read = (key: string): unknown => descriptors[key]?.value;
  const backupGenerationDigest: unknown = read("backupGenerationDigest");
  const predecessorIncarnationRef: unknown = read("predecessorIncarnationRef");
  const correlationId: unknown = read("correlationId");
  const decidedAt: unknown = read("decidedAt");
  const principalId: unknown = read("principalId");
  const projectId: unknown = read("projectId");
  const restoreCommandId: unknown = read("restoreCommandId");

  if (typeof backupGenerationDigest !== "string" || !HEX64.test(backupGenerationDigest)) return null;
  // A ref is a digestOf output. Bounding its shape here means the aggregate id
  // this becomes cannot be steered by a caller-chosen prefix or separator.
  if (typeof predecessorIncarnationRef !== "string" || !HEX64.test(predecessorIncarnationRef)) {
    return null;
  }
  if (!isSafeId(correlationId) || !isSafeId(decidedAt)) return null;
  if (!isSafeId(principalId) || !isSafeId(projectId) || !isSafeId(restoreCommandId)) return null;

  return Object.freeze({
    backupGenerationDigest,
    correlationId,
    decidedAt,
    predecessorIncarnationRef,
    principalId,
    projectId,
    restoreCommandId,
  });
};
