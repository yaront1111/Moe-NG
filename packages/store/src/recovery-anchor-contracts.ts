/**
 * Vocabulary for the two-slot recovery anchor.
 *
 * taskRail 2: the anchor is bootstrap SELECTION metadata. It records which
 * restored slot a fresh reader should open, and it records — as data — that the
 * restored authority was revoked and that the project is quiesced. It never
 * enacts either. Lifecycle authority stays with the selected database and the
 * reducer, which is why this package still declares no dependencies.
 */
import type { RecoveryBindingSlot, RecoveryInstallRefused } from "./recovery-install-contracts.js";

export const RECOVERY_ANCHOR_CODEC_VERSION = "moe-recovery-anchor/1" as const;
export const RECOVERY_ANCHOR_LAYER = "RECOVERY_ANCHOR" as const;

/** The anchor lives beside the slots it selects, never inside one of them. */
export const RECOVERY_ANCHOR_FILE_NAME = "recovery-anchor.json" as const;
export const RECOVERY_ANCHOR_SLOTS_DIR_NAME = "slots" as const;
export const RECOVERY_ANCHOR_DATABASE_NAME = "database.sqlite" as const;

/**
 * Each slot carries its OWN persistence proof, because a fresh reader after a
 * crash usually has to verify the slot the install was NOT writing. This
 * manifest is not the anchor and never carries the anchor's identity.
 */
export const RECOVERY_ANCHOR_SLOT_MANIFEST_NAME = "slot-manifest.json" as const;
export const RECOVERY_ANCHOR_SLOT_MANIFEST_VERSION = "moe-recovery-slot/1" as const;

export interface RecoveryAnchorSlotManifest {
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly payloadDigests: Readonly<Record<string, string>>;
  readonly slotManifestVersion: typeof RECOVERY_ANCHOR_SLOT_MANIFEST_VERSION;
}

export const RECOVERY_ANCHOR_STATES = Object.freeze(["PREPARED", "INSTALLED"] as const);
export type RecoveryAnchorState = (typeof RECOVERY_ANCHOR_STATES)[number];

/** Re-exported under a local name so this module owns its own slot vocabulary. */
export type RecoveryBindingSlotName = RecoveryBindingSlot;

/**
 * The ordered boundaries an install crosses: the DoD 3 injection surface and
 * the order the ordering test compares against, so the two cannot disagree.
 */
export const RECOVERY_ANCHOR_FAULT_POINTS = Object.freeze([
  "PREPARE",
  "INACTIVE_INSTALL",
  "TRANSACTION",
  "FILE_FSYNC",
  "DIRECTORY_PERSISTENCE",
  "VERIFICATION",
  "SWITCH",
  "INSTALLED_MARKER",
] as const);
export type RecoveryAnchorFaultPoint = (typeof RECOVERY_ANCHOR_FAULT_POINTS)[number];

/** What an unfinished or unverifiable restore still permits. Never mutation. */
export const RECOVERY_ANCHOR_ALLOWED_OPERATIONS = Object.freeze([
  "INSPECT",
  "RESUME",
  "DISCARD",
] as const);
export type RecoveryAnchorOperation = (typeof RECOVERY_ANCHOR_ALLOWED_OPERATIONS)[number];

/**
 * Anchor-level faults only. Anything the install layer already models keeps its
 * RECOVERY_INSTALL_* code and RECOVERY_INSTALL_TRANSACTION layer — two
 * vocabularies meaning "refused" is how a test stops pinning WHICH layer
 * answered.
 */
export const RECOVERY_ANCHOR_REASON_CODES = Object.freeze([
  "RECOVERY_ANCHOR_REQUEST_INVALID",
  "RECOVERY_ANCHOR_CODEC_VERSION_UNSUPPORTED",
  "RECOVERY_ANCHOR_DIGEST_MISMATCH",
  "RECOVERY_ANCHOR_COMMAND_MISMATCH",
  "RECOVERY_ANCHOR_INCARNATION_REUSED",
  "RECOVERY_ANCHOR_DATABASE_MISMATCH",
  "RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN",
  "RECOVERY_ANCHOR_SLOT_UNVERIFIABLE",
  "RECOVERY_ANCHOR_RECOVERY_REQUIRED",
] as const);
export type RecoveryAnchorReasonCode = (typeof RECOVERY_ANCHOR_REASON_CODES)[number];

/** One restored object destined for the inactive slot. */
export interface RecoveryAnchorArtifact {
  readonly bytes: Uint8Array;
  readonly logicalPath: string;
}

export interface RecoveryAnchorPayload {
  readonly artifacts: readonly RecoveryAnchorArtifact[];
  readonly databaseBytes: Uint8Array;
}

/**
 * The one versioned anchor record. `preparedIdentity` is the FENCE — it binds
 * command, generation digest, incarnation, key epoch and prepared timestamp,
 * and survives PREPARED -> INSTALLED unchanged so a resume can prove it is the
 * same attempt. `anchorDigest` covers the whole record including state and
 * slot, so perturbing anything at all moves it.
 */
export interface RecoveryAnchorRecord {
  readonly anchorCodecVersion: typeof RECOVERY_ANCHOR_CODEC_VERSION;
  readonly anchorDigest: string;
  readonly currentSlot: RecoveryBindingSlotName;
  readonly databaseDigest: string;
  readonly generationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly payloadDigests: Readonly<Record<string, string>>;
  readonly preparedAt: string;
  readonly preparedIdentity: string;
  readonly projectId: string;
  readonly restoreCommandId: string;
  readonly restoredAuthorityRevoked: true;
  readonly restoredLifecycle: "QUIESCED";
  readonly restoredReadiness: "RECOVERY_REQUIRED";
  readonly state: RecoveryAnchorState;
  readonly targetSlot: RecoveryBindingSlotName;
}

export interface RecoveryAnchorRefused {
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly authority: "NONE";
  readonly code: RecoveryAnchorReasonCode;
  readonly layer: typeof RECOVERY_ANCHOR_LAYER;
  readonly reason: string;
  readonly truth: "UNKNOWN";
}

export interface RecoveryAnchorPrepared {
  readonly ok: true;
  readonly outcome: "PREPARED";
  readonly anchor: RecoveryAnchorRecord;
}

export interface RecoveryAnchorInstalled {
  readonly ok: true;
  readonly outcome: "INSTALLED";
  readonly anchor: RecoveryAnchorRecord;
}

export interface RecoveryAnchorInspected {
  readonly ok: true;
  readonly outcome: "INSPECTED";
  readonly allowedOperations: readonly RecoveryAnchorOperation[];
  readonly anchor: RecoveryAnchorRecord;
  readonly currentSlot: RecoveryBindingSlotName;
  /** Always false: the anchor selects a database, it is no lifecycle authority. */
  readonly mutatingOpenAllowed: false;
  /**
   * The refusal a mutating open receives, and it VARIES: the specific
   * verification fault when the current slot fails, otherwise
   * RECOVERY_ANCHOR_RECOVERY_REQUIRED. DoD 4's distinct stable code.
   */
  readonly mutatingOpenRefusal: RecoveryAnchorRefused;
  readonly slotVerified: boolean;
}

export interface RecoveryAnchorAbsent {
  readonly ok: true;
  readonly outcome: "ABSENT";
  readonly anchorRoot: string;
}

export interface RecoveryAnchorDiscarded {
  readonly ok: true;
  readonly outcome: "DISCARDED";
  readonly discardedSlot: RecoveryBindingSlotName;
}

export type RecoveryAnchorPrepareResult = RecoveryAnchorPrepared | RecoveryAnchorRefused;
/**
 * An install can be refused by EITHER layer. The install layer's refusal is
 * passed through unchanged rather than re-coded at RECOVERY_ANCHOR, so a test
 * can always say which layer answered.
 */
export type RecoveryAnchorInstallResult =
  | RecoveryAnchorInstalled
  | RecoveryAnchorRefused
  | RecoveryInstallRefused;
export type RecoveryAnchorInspectResult =
  | RecoveryAnchorInspected
  | RecoveryAnchorAbsent
  | RecoveryAnchorRefused;
export type RecoveryAnchorDiscardResult =
  | RecoveryAnchorDiscarded
  | RecoveryAnchorAbsent
  | RecoveryAnchorRefused;

/**
 * Refusals are FIXED module constants, matching the install layer's discipline:
 * nothing observed at the failure site reaches the caller, so a stored byte or
 * a filesystem message has no path into evidence even by accident.
 */
const refusal = (code: RecoveryAnchorReasonCode, reason: string): RecoveryAnchorRefused =>
  Object.freeze({
    authority: "NONE" as const,
    code,
    layer: RECOVERY_ANCHOR_LAYER,
    ok: false as const,
    outcome: "REFUSED" as const,
    reason,
    truth: "UNKNOWN" as const,
  });

export const RECOVERY_ANCHOR_REQUEST_INVALID = refusal(
  "RECOVERY_ANCHOR_REQUEST_INVALID",
  "A recovery anchor request must carry exactly the declared install fields.",
);
export const RECOVERY_ANCHOR_CODEC_VERSION_UNSUPPORTED = refusal(
  "RECOVERY_ANCHOR_CODEC_VERSION_UNSUPPORTED",
  "The stored recovery anchor names a codec version this store cannot read.",
);
export const RECOVERY_ANCHOR_DIGEST_MISMATCH = refusal(
  "RECOVERY_ANCHOR_DIGEST_MISMATCH",
  "The stored recovery anchor does not match the digest recorded inside it.",
);
export const RECOVERY_ANCHOR_COMMAND_MISMATCH = refusal(
  "RECOVERY_ANCHOR_COMMAND_MISMATCH",
  "The prepared recovery anchor belongs to a different restore command.",
);
export const RECOVERY_ANCHOR_INCARNATION_REUSED = refusal(
  "RECOVERY_ANCHOR_INCARNATION_REUSED",
  "A new restore command must present a fresh incarnation and key epoch.",
);
export const RECOVERY_ANCHOR_DATABASE_MISMATCH = refusal(
  "RECOVERY_ANCHOR_DATABASE_MISMATCH",
  "The installed slot database does not match the digest the anchor selected.",
);
export const RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN = refusal(
  "RECOVERY_ANCHOR_PERSISTENCE_UNPROVEN",
  "The restored slot carries no proof that its bytes were persisted.",
);
export const RECOVERY_ANCHOR_SLOT_UNVERIFIABLE = refusal(
  "RECOVERY_ANCHOR_SLOT_UNVERIFIABLE",
  "The inactive slot's bytes could not be read back and verified.",
);
/**
 * The anchor's answer to a mutating open even when everything verifies. Being
 * INSTALLED means the anchor SELECTED a database, not that recovery finished —
 * every anchor record permanently carries RECOVERY_REQUIRED, and clearing it is
 * the reducer's business, not this module's (taskRail 2).
 */
export const RECOVERY_ANCHOR_RECOVERY_REQUIRED = refusal(
  "RECOVERY_ANCHOR_RECOVERY_REQUIRED",
  "The selected database is quiesced and still requires recovery; the anchor grants no mutating open.",
);
