import { exactRecord } from "../supervisor/effect-shape.js";

/**
 * Vocabulary and hostile-input readers for the recovery-window inventory.
 *
 * Declares WHAT an inventory item and a coverage proof are; enumerates nothing.
 * Every adapter that can actually look at a disk lives in a sibling slice and
 * reaches this module only through the injected port shape below.
 *
 * The backup cursor/generation and the recovery incarnation both live in
 * packages this one cannot import (`@moe/store` and `apps/daemon` each depend on
 * the runner, so depending back would invert the graph). They therefore enter as
 * caller-supplied OPAQUE refs: validated for shape, bound into the basis digest,
 * and never interpreted or re-derived. The daemon, which can see both sides, is
 * what joins an opaque ref back to its authoritative record.
 */
export const RECOVERY_INVENTORY_VERSION = "moe-recovery-inventory/1" as const;

/**
 * The node-side classes this protocol covers. Frozen and hand-written: a class
 * nobody enumerates cannot be added silently, and a deleted class takes its
 * coverage tests red with it.
 */
export const RECOVERY_INVENTORY_CLASSES = Object.freeze([
  "PROVIDER_PROCESS_LAUNCH_LOCK",
  "WORKSPACE",
  "GIT_INTEGRATION_ON_DISK",
  "ARTIFACT_OBJECT_STAGING",
] as const);
export type RecoveryInventoryClass = (typeof RECOVERY_INVENTORY_CLASSES)[number];

/** One layer: every refusal here is the adapter seam's, never an enumerator's. */
export const RECOVERY_INVENTORY_LAYERS = Object.freeze(["INVENTORY_ADAPTER"] as const);
export type RecoveryInventoryLayer = (typeof RECOVERY_INVENTORY_LAYERS)[number];

/** UNKNOWN is the floor and the default; no path in this area may raise it. */
export const RECOVERY_INVENTORY_TRUTH_CLASSES = Object.freeze(["COMPLETE", "UNKNOWN"] as const);
export type RecoveryInventoryTruth = (typeof RECOVERY_INVENTORY_TRUTH_CLASSES)[number];

/** Ordered by refusal precedence: an earlier code always answers first. */
export const RECOVERY_INVENTORY_ERROR_CODES = Object.freeze([
  "RECOVERY_INVENTORY_REQUEST_INVALID",
  "RECOVERY_INVENTORY_PROJECT_TAG_INVALID",
  "RECOVERY_INVENTORY_BACKUP_REF_INVALID",
  "RECOVERY_INVENTORY_INCARNATION_REF_INVALID",
  "RECOVERY_INVENTORY_WINDOW_INVALID",
  "RECOVERY_INVENTORY_CONFIGURED_CLASSES_INVALID",
  "RECOVERY_INVENTORY_CLASS_MISMATCH",
  "RECOVERY_INVENTORY_PROJECT_MISMATCH",
  "RECOVERY_INVENTORY_WINDOW_MISMATCH",
  "RECOVERY_INVENTORY_EXTERNAL_IDENTITY_DUPLICATE",
  "RECOVERY_INVENTORY_COVERAGE_UNKNOWN",
] as const);
export type RecoveryInventoryErrorCode = (typeof RECOVERY_INVENTORY_ERROR_CODES)[number];

/** Why a class could not be proven COMPLETE. Never a substitute for a code. */
export const RECOVERY_INVENTORY_UNKNOWN_REASONS = Object.freeze([
  "ENUMERATOR_UNREGISTERED",
  "ENUMERATOR_UNAVAILABLE",
  "ENUMERATOR_FAILED",
  "CAPABILITY_UNSUPPORTED",
  "RESULT_MALFORMED",
  "RESULT_TRUNCATED",
  "RESULT_OVER_LIMIT",
  "NEGATIVE_PROOF_MISSING",
  "ITEM_REJECTED",
] as const);
export type RecoveryInventoryUnknownReason =
  (typeof RECOVERY_INVENTORY_UNKNOWN_REASONS)[number];

export const RECOVERY_INVENTORY_REF_KINDS = Object.freeze([
  "BACKUP_CURSOR_GENERATION",
  "RECOVERY_INCARNATION",
] as const);
export type RecoveryInventoryRefKind = (typeof RECOVERY_INVENTORY_REF_KINDS)[number];

export const MAX_RECOVERY_INVENTORY_ITEMS = 4096;
export const MAX_RECOVERY_INVENTORY_TEXT_CHARS = 400;
export const MAX_RECOVERY_INVENTORY_FACTS = 32;

export interface RecoveryInventoryOpaqueRef {
  readonly kind: RecoveryInventoryRefKind;
  readonly ref: string;
  readonly digest: string;
}

/** Inclusive at both ends: a boundary observation is inside its own window. */
export interface RecoveryInventoryWindow {
  readonly startInclusive: string;
  readonly endInclusive: string;
}

/**
 * A PATH identity is normalized across separators before comparison, because
 * `a\b` and `a/b` name one thing. An OPAQUE identity is a provider's own id and
 * its bytes are preserved — rewriting separators inside one would merge two
 * genuinely distinct records.
 */
export type RecoveryInventoryIdentity =
  | { readonly kind: "PATH"; readonly path: string }
  | { readonly kind: "OPAQUE"; readonly id: string };

export type RecoveryInventoryFactValue = string | number | boolean;

export interface RecoveryInventoryItem {
  readonly class: RecoveryInventoryClass;
  readonly projectTag: string;
  readonly identity: RecoveryInventoryIdentity;
  readonly observedAt: string;
  readonly facts: Readonly<Record<string, RecoveryInventoryFactValue>>;
  readonly sourceProofDigest: string;
}

export interface RecoveryInventoryCoverageProof {
  readonly class: RecoveryInventoryClass;
  readonly truth: RecoveryInventoryTruth;
  /** Null only when COMPLETE; an UNKNOWN proof always names its refusal. */
  readonly code: RecoveryInventoryErrorCode | null;
  readonly reason: RecoveryInventoryUnknownReason | null;
  readonly layer: RecoveryInventoryLayer;
  readonly itemCount: number;
  readonly negativeProofDigest: string | null;
  readonly proofDigest: string;
}

export interface RecoveryInventoryReport {
  readonly reportVersion: typeof RECOVERY_INVENTORY_VERSION;
  readonly projectTag: string;
  readonly backup: RecoveryInventoryOpaqueRef;
  readonly incarnation: RecoveryInventoryOpaqueRef;
  readonly window: RecoveryInventoryWindow;
  readonly configuredClasses: readonly RecoveryInventoryClass[];
  readonly items: readonly RecoveryInventoryItem[];
  readonly proofs: readonly RecoveryInventoryCoverageProof[];
  readonly coverage: RecoveryInventoryTruth;
  readonly basisDigest: string;
  readonly inventoryDigest: string;
}

export interface RecoveryInventoryFailure {
  readonly ok: false;
  readonly code: RecoveryInventoryErrorCode;
  readonly layer: RecoveryInventoryLayer;
  readonly message: string;
}

export type RecoveryInventoryResult = RecoveryInventoryReport | RecoveryInventoryFailure;

export interface RecoveryInventoryEnumerationContext {
  readonly class: RecoveryInventoryClass;
  readonly projectTag: string;
  readonly backup: RecoveryInventoryOpaqueRef;
  readonly incarnation: RecoveryInventoryOpaqueRef;
  readonly window: RecoveryInventoryWindow;
}

export type RecoveryInventoryEnumerator = (
  context: RecoveryInventoryEnumerationContext,
) => unknown;

export interface RecoveryInventoryRegistration {
  readonly class: RecoveryInventoryClass;
  readonly enumerate: RecoveryInventoryEnumerator;
}

export interface RecoveryInventoryRegistry {
  readonly registrations: readonly RecoveryInventoryRegistration[];
}

/** What a port answered, already reduced to the three shapes this seam admits. */
export type RecoveryInventoryPortReading =
  | { readonly status: "ENUMERATED"; readonly items: readonly unknown[]; readonly complete: boolean; readonly negativeProofDigest: string | null }
  | { readonly status: "UNAVAILABLE" }
  | { readonly status: "UNSUPPORTED" };

export const RECOVERY_INVENTORY_REF_KEYS = Object.freeze(["kind", "ref", "digest"] as const);
export const RECOVERY_INVENTORY_WINDOW_KEYS = Object.freeze([
  "startInclusive",
  "endInclusive",
] as const);
export const RECOVERY_INVENTORY_REQUEST_KEYS = Object.freeze([
  "projectTag",
  "backup",
  "incarnation",
  "window",
  "configuredClasses",
] as const);
export const RECOVERY_INVENTORY_ITEM_KEYS = Object.freeze([
  "class",
  "projectTag",
  "identity",
  "observedAt",
  "facts",
  "sourceProofDigest",
] as const);

export function recoveryInventoryFailure(
  code: RecoveryInventoryErrorCode,
  message: string,
): RecoveryInventoryFailure {
  return Object.freeze({ ok: false as const, code, layer: "INVENTORY_ADAPTER" as const, message });
}

export function isRecoveryInventoryFailure(value: unknown): value is RecoveryInventoryFailure {
  const record = exactRecord(value, ["ok", "code", "layer", "message"]);
  return record !== null && record["ok"] === false;
}
