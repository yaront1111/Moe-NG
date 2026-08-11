/**
 * Vocabulary for the store-side recovery binding rows and their atomic install.
 *
 * Nothing here reasons about recovery LIFECYCLE. The store persists columns and
 * opaque bytes; deciding what a binding means, and whether an incarnation may
 * succeed another, stays with the daemon and with @moe/core's reducer. That
 * separation is why @moe/store still declares no package dependencies.
 */
export const RECOVERY_BINDING_CODEC_VERSION = "moe-recovery-binding/1" as const;

export const RECOVERY_BINDING_SLOTS = Object.freeze(["ACTIVE", "PENDING"] as const);
export type RecoveryBindingSlot = (typeof RECOVERY_BINDING_SLOTS)[number];

/**
 * Two layers can refuse an install, so every refusal names which one answered.
 * The transaction layer is asked FIRST: an unscoped handle is refused before
 * the codec ever inspects the record, so a caller cannot learn whether their
 * bytes were well formed by probing a store they may not write to.
 */
export const RECOVERY_BINDING_CODEC_LAYER = "RECOVERY_BINDING_CODEC" as const;
export const RECOVERY_INSTALL_TRANSACTION_LAYER = "RECOVERY_INSTALL_TRANSACTION" as const;
export const RECOVERY_INSTALL_LAYERS = Object.freeze([
  RECOVERY_BINDING_CODEC_LAYER,
  RECOVERY_INSTALL_TRANSACTION_LAYER,
] as const);
export type RecoveryInstallLayer = (typeof RECOVERY_INSTALL_LAYERS)[number];

export const RECOVERY_INSTALL_REASON_CODES = Object.freeze([
  "RECOVERY_BINDING_SHAPE_INVALID",
  "RECOVERY_BINDING_FIELD_INVALID",
  "RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED",
  "RECOVERY_BINDING_BYTES_MALFORMED",
  "RECOVERY_BINDING_DIGEST_MISMATCH",
  "RECOVERY_INSTALL_SCOPE_REQUIRED",
  "RECOVERY_INSTALL_INCARNATION_CONFLICT",
  "RECOVERY_BINDING_ROW_DIVERGED",
] as const);
export type RecoveryInstallReasonCode = (typeof RECOVERY_INSTALL_REASON_CODES)[number];

/** One durable row. `payload` is opaque: the store never parses or repairs it. */
export interface RecoveryBindingRecord {
  readonly bindingCodecVersion: typeof RECOVERY_BINDING_CODEC_VERSION;
  readonly incarnationRef: string;
  readonly installedAt: string;
  readonly keyEpochRef: string;
  readonly payload: Uint8Array;
  readonly slot: RecoveryBindingSlot;
}

export interface RecoveryInstallRefused {
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly authority: "NONE";
  readonly code: RecoveryInstallReasonCode;
  readonly layer: RecoveryInstallLayer;
  readonly reason: string;
  readonly truth: "UNKNOWN";
}

export interface RecoveryBindingEncoded {
  readonly ok: true;
  readonly binding: RecoveryBindingRecord;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface RecoveryBindingDecoded {
  readonly ok: true;
  readonly binding: RecoveryBindingRecord;
}

export type RecoveryBindingEncodeResult = RecoveryBindingEncoded | RecoveryInstallRefused;
export type RecoveryBindingDecodeResult = RecoveryBindingDecoded | RecoveryInstallRefused;

export interface RecoveryInstallCommitted {
  readonly ok: true;
  readonly outcome: "INSTALLED";
  readonly binding: RecoveryBindingRecord;
  readonly bindingDigest: string;
}

export type RecoveryInstallResult = RecoveryInstallCommitted | RecoveryInstallRefused;

export interface RecoveryBindingFound {
  readonly ok: true;
  readonly outcome: "FOUND";
  readonly binding: RecoveryBindingRecord;
  readonly bindingDigest: string;
}

export interface RecoveryBindingAbsent {
  readonly ok: true;
  readonly outcome: "ABSENT";
  readonly slot: RecoveryBindingSlot;
}

export type RecoveryBindingReadResult =
  | RecoveryBindingFound
  | RecoveryBindingAbsent
  | RecoveryInstallRefused;

/**
 * Refusals are FIXED module constants. Nothing observed at the failure site
 * reaches them, so a stored byte, a SQLite message or a caller-supplied value
 * has no path into evidence even by accident.
 */
const refusal = (
  layer: RecoveryInstallLayer,
  code: RecoveryInstallReasonCode,
  reason: string,
): RecoveryInstallRefused =>
  Object.freeze({
    authority: "NONE" as const,
    code,
    layer,
    ok: false as const,
    outcome: "REFUSED" as const,
    reason,
    truth: "UNKNOWN" as const,
  });

export const RECOVERY_BINDING_SHAPE_INVALID = refusal(
  RECOVERY_BINDING_CODEC_LAYER,
  "RECOVERY_BINDING_SHAPE_INVALID",
  "A recovery binding must be an object carrying exactly the six declared fields.",
);
export const RECOVERY_BINDING_FIELD_INVALID = refusal(
  RECOVERY_BINDING_CODEC_LAYER,
  "RECOVERY_BINDING_FIELD_INVALID",
  "A recovery binding field is outside the shape the durable row admits.",
);
export const RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED = refusal(
  RECOVERY_BINDING_CODEC_LAYER,
  "RECOVERY_BINDING_CODEC_VERSION_UNSUPPORTED",
  "The recovery binding codec version is not one this store can read or write.",
);
export const RECOVERY_BINDING_BYTES_MALFORMED = refusal(
  RECOVERY_BINDING_CODEC_LAYER,
  "RECOVERY_BINDING_BYTES_MALFORMED",
  "Recovery binding bytes are truncated, over-long or otherwise unframed.",
);
export const RECOVERY_BINDING_DIGEST_MISMATCH = refusal(
  RECOVERY_BINDING_CODEC_LAYER,
  "RECOVERY_BINDING_DIGEST_MISMATCH",
  "Recovery binding bytes do not match the digest recorded beside them.",
);
export const RECOVERY_INSTALL_SCOPE_REQUIRED = refusal(
  RECOVERY_INSTALL_TRANSACTION_LAYER,
  "RECOVERY_INSTALL_SCOPE_REQUIRED",
  "Installing a recovery binding requires an explicitly project-asserted store handle.",
);
export const RECOVERY_INSTALL_INCARNATION_CONFLICT = refusal(
  RECOVERY_INSTALL_TRANSACTION_LAYER,
  "RECOVERY_INSTALL_INCARNATION_CONFLICT",
  "The recovery incarnation is already bound to the other slot; the prior state is unchanged.",
);
/**
 * The indexed columns duplicate values the bytes already carry, and UNIQUE is
 * enforced on the COLUMN. If a column could disagree with the bytes, the
 * one-incarnation-per-store guarantee would only ever have been about the
 * index. A diverged row is refused whole, never reconciled toward either side.
 */
export const RECOVERY_BINDING_ROW_DIVERGED = refusal(
  RECOVERY_INSTALL_TRANSACTION_LAYER,
  "RECOVERY_BINDING_ROW_DIVERGED",
  "A recovery binding row's indexed columns disagree with the binding bytes they index.",
);
