import type { SqliteEventStore } from "@moe/store";

import type { RecoveryIncarnationKeyHandle } from "./recovery-incarnation-contract.js";
import type {
  RecoveryDurableWriteRequest,
  RecoverySuccessionRefused,
} from "./recovery-succession-contract.js";

/**
 * Vocabulary and shapes for the durable, OS-protected recovery key epoch.
 *
 * WHAT "PROTECTED" MEANS HERE, so nobody widens this into a secret store: no
 * private key material is persisted — it cannot be, the private key dies with
 * its process by design. Everything durable is PUBLIC (an SPKI, refs, digests,
 * signatures). The property this layer supplies is therefore ACCESS RESTRICTION
 * against other local users; tamper-EVIDENCE already comes from the anchored
 * self-proofs the incarnation layer writes. Secrecy is neither claimed nor
 * achievable here, and must never be claimed later.
 *
 * WHY ONLY FOUR CODES ARE MINTED: `recovery-succession-contract.ts` already owns
 * a refusal for every succession fault, and the provider propagates those
 * verbatim WITH THEIR OWN LAYER so evidence names the layer that actually
 * refused. Minted here are only the faults succession does not model — the two
 * protection faults, an unreadable epoch pointer, and an input fault; the last
 * because succession's input refusal reads "must name exactly one predecessor
 * incarnation", and a provider request must NOT name one, so reusing it would be
 * false evidence.
 *
 * Split across three modules (this one, `recovery-key-epoch-store.ts` and
 * `recovery-key-provider.ts`) purely to hold the per-file line cap, for the same
 * reason `recovery-incarnation-contract.ts` documents.
 */
export const RECOVERY_KEY_EPOCH_SCHEMA_VERSION = "moe-recovery-key-epoch/1" as const;
export const RECOVERY_KEY_PROVIDER_LAYER = "RECOVERY_KEY_PROVIDER" as const;
export const RECOVERY_KEY_EPOCH_COMMAND_KIND = "recovery.key-epoch" as const;

export const RECOVERY_KEY_PROVIDER_ERROR_CODES = Object.freeze([
  "RECOVERY_KEY_EPOCH_INPUT_INVALID",
  "RECOVERY_KEY_PROTECTION_UNAVAILABLE",
  "RECOVERY_KEY_PROTECTION_UNVERIFIABLE",
  "RECOVERY_KEY_EPOCH_POINTER_UNREADABLE",
] as const);
export type RecoveryKeyProviderErrorCode = (typeof RECOVERY_KEY_PROVIDER_ERROR_CODES)[number];

/**
 * A CLOSED union of mechanism identifiers, never a boolean. A boolean would let
 * a host that applied nothing report the same `true` as one that applied a real
 * DACL — exactly the optimistic pass this task forbids. Each name states the
 * ACTUAL primitive: Win32 discretionary ACLs are not POSIX mode bits.
 */
export const RECOVERY_KEY_PROTECTION_MECHANISMS = Object.freeze([
  "WIN32_DACL_EXPLICIT_OWNER_ONLY",
  "POSIX_MODE_0700_OWNER_ONLY",
] as const);
export type RecoveryKeyProtectionMechanism =
  (typeof RECOVERY_KEY_PROTECTION_MECHANISMS)[number];

/** Bounded on purpose: an unrecognised `process.platform` reads as OTHER. */
export const RECOVERY_KEY_HOST_PLATFORMS = Object.freeze([
  "win32", "darwin", "linux", "OTHER",
] as const);
export type RecoveryKeyHostPlatform = (typeof RECOVERY_KEY_HOST_PLATFORMS)[number];

export const asHostPlatform = (value: string): RecoveryKeyHostPlatform =>
  value !== "OTHER" && (RECOVERY_KEY_HOST_PLATFORMS as readonly string[]).includes(value)
    ? (value as RecoveryKeyHostPlatform)
    : "OTHER";

export interface RecoveryKeyProtection {
  readonly ok: true;
  readonly mechanism: RecoveryKeyProtectionMechanism;
  readonly platform: RecoveryKeyHostPlatform;
}

export interface RecoveryKeyProtectionUnknown {
  readonly ok: false;
  readonly mechanism: "UNKNOWN";
  readonly truth: "UNKNOWN";
  readonly authority: "NONE";
  readonly layer: typeof RECOVERY_KEY_PROVIDER_LAYER;
  readonly code: Extract<RecoveryKeyProviderErrorCode, `RECOVERY_KEY_PROTECTION_${string}`>;
  readonly platform: RecoveryKeyHostPlatform;
  readonly reason: string;
}

export type RecoveryKeyProtectionResult = RecoveryKeyProtection | RecoveryKeyProtectionUnknown;

/**
 * Refusal text is FIXED, as the incarnation and succession contracts build
 * theirs: nothing observed at the failure site — a caught `icacls` message, a
 * path, a stack frame — has a path into evidence. The only observed value
 * admitted is the platform, and `asHostPlatform` narrows it first.
 */
const protectionUnknown = (
  code: RecoveryKeyProtectionUnknown["code"],
  platform: RecoveryKeyHostPlatform,
  reason: string,
): RecoveryKeyProtectionUnknown =>
  Object.freeze({
    authority: "NONE" as const,
    code,
    layer: RECOVERY_KEY_PROVIDER_LAYER,
    mechanism: "UNKNOWN" as const,
    ok: false as const,
    platform,
    reason,
    truth: "UNKNOWN" as const,
  });

export const protectionUnavailable = (p: RecoveryKeyHostPlatform): RecoveryKeyProtectionUnknown =>
  protectionUnknown("RECOVERY_KEY_PROTECTION_UNAVAILABLE", p,
    "This host offers no OS mechanism this provider can name and apply to the durable epoch record.");

export const protectionUnverifiable = (p: RecoveryKeyHostPlatform): RecoveryKeyProtectionUnknown =>
  protectionUnknown("RECOVERY_KEY_PROTECTION_UNVERIFIABLE", p,
    "The protection mechanism was applied but did not prove itself on read-back.");

/**
 * The host boundary. Everything platform-specific lives behind `protect`.
 * `platform` is declared separately so a port that THROWS still lets the pure
 * provider name the host honestly instead of defaulting it to OTHER.
 */
export interface RecoveryKeyProviderPort {
  readonly platform: RecoveryKeyHostPlatform;
  readonly protect: (directoryPath: string) => Promise<RecoveryKeyProtectionResult>;
}

export interface RecoveryKeyProviderRefused {
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly authority: "NONE";
  readonly layer: typeof RECOVERY_KEY_PROVIDER_LAYER;
  readonly code: RecoveryKeyProviderErrorCode;
  readonly truth: "UNKNOWN";
  readonly reason: string;
}

const refusal = (code: RecoveryKeyProviderErrorCode, reason: string): RecoveryKeyProviderRefused =>
  Object.freeze({
    authority: "NONE" as const,
    code,
    layer: RECOVERY_KEY_PROVIDER_LAYER,
    ok: false as const,
    outcome: "REFUSED" as const,
    reason,
    truth: "UNKNOWN" as const,
  });

export const KEY_EPOCH_INPUT_INVALID = refusal("RECOVERY_KEY_EPOCH_INPUT_INVALID",
  "A key epoch request must name one restore command, one backup generation and one directory to protect, and must not name a predecessor.");
export const KEY_EPOCH_POINTER_UNREADABLE = refusal("RECOVERY_KEY_EPOCH_POINTER_UNREADABLE",
  "A durable key epoch pointer exists for this restore command but did not read back as one.");

/** A protection refusal is already a typed UNKNOWN; it crosses over unchanged. */
export const asProviderRefusal = (u: RecoveryKeyProtectionUnknown): RecoveryKeyProviderRefused =>
  refusal(u.code, u.reason);

export interface RecoveryKeyEpoch {
  readonly ok: true;
  readonly outcome: "OPENED";
  readonly authority: "NONE";
  /** MINTED on a cold start, REOPENED when a durable epoch was resolved. */
  readonly opening: "MINTED" | "REOPENED";
  readonly protection: RecoveryKeyProtection;
  /** The STABLE epoch identity: unchanged across every restart. */
  readonly originIncarnationRef: string;
  readonly restoreCommandId: string;
  /** This process's incarnation. Entropy-derived, so it MUST differ per open. */
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly publicKeySpkiHex: string;
  readonly verificationKeyFingerprint: string;
  readonly generation: number;
  readonly chainLength: number;
  /** Non-enumerable and process-local, so it cannot ride along in evidence. */
  readonly keyHandle: RecoveryIncarnationKeyHandle;
}

export type RecoveryKeyEpochResult =
  | RecoveryKeyEpoch
  | RecoveryKeyProviderRefused
  | RecoverySuccessionRefused;

export interface RecoveryKeyProviderService {
  readonly open: (store: SqliteEventStore, request: unknown) => Promise<RecoveryKeyEpochResult>;
}

/**
 * Deliberately carries NO predecessor ref and no key handle. A process that died
 * holds nothing, so anything a caller could supply here would be a claim the
 * provider must not trust; the predecessor is read from the durable pointer.
 */
export interface RecoveryKeyEpochRequest extends RecoveryDurableWriteRequest {
  readonly backupGenerationDigest: string;
  readonly protectedDirectory: string;
  readonly restoreCommandId: string;
}

const REQUEST_KEYS = Object.freeze(["backupGenerationDigest", "correlationId", "decidedAt",
  "principalId", "projectId", "protectedDirectory", "restoreCommandId"]);

const HEX64 = /^[0-9a-f]{64}$/;
const UNSAFE_ID = /[\s\p{Cc}\p{Cf}]/u;
/** Control and format characters only: a real path may legitimately contain spaces. */
const UNSAFE_PATH = /[\p{Cc}\p{Cf}]/u;
const MAX_ID_CHARS = 200;
const MAX_PATH_CHARS = 4096;

const isSafeId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS &&
  !UNSAFE_ID.test(value) && value.normalize("NFC") === value;

const isDataProperty = (descriptor: PropertyDescriptor | undefined): boolean =>
  descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined;

/**
 * One synchronous read of own property DESCRIPTORS, before any await, exactly as
 * the incarnation and succession contracts do: an accessor or a proxy must not
 * answer differently the second time, and a caller mutating the request mid
 * flight must not be able to move the epoch. Extra keys are refused rather than
 * ignored — a caller-supplied `predecessorIncarnationRef` or `keyHandle` is
 * precisely what this provider must never accept, and dropping one silently
 * would look like it had been honoured.
 */
export const snapshotKeyEpochRequest = (value: unknown): RecoveryKeyEpochRequest | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== REQUEST_KEYS.length) return null;
  if (keys.some((key) => typeof key !== "string" || !REQUEST_KEYS.includes(key))) return null;
  if (REQUEST_KEYS.some((key) => !isDataProperty(descriptors[key]))) return null;

  const read = (key: string): unknown => descriptors[key]?.value;
  const backupGenerationDigest: unknown = read("backupGenerationDigest");
  const correlationId: unknown = read("correlationId");
  const decidedAt: unknown = read("decidedAt");
  const principalId: unknown = read("principalId");
  const projectId: unknown = read("projectId");
  const protectedDirectory: unknown = read("protectedDirectory");
  const restoreCommandId: unknown = read("restoreCommandId");

  if (typeof backupGenerationDigest !== "string" || !HEX64.test(backupGenerationDigest)) return null;
  if (!isSafeId(correlationId) || !isSafeId(decidedAt)) return null;
  if (!isSafeId(principalId) || !isSafeId(projectId) || !isSafeId(restoreCommandId)) return null;
  if (typeof protectedDirectory !== "string" || protectedDirectory.length === 0 ||
    protectedDirectory.length > MAX_PATH_CHARS || UNSAFE_PATH.test(protectedDirectory)) {
    return null;
  }
  return Object.freeze({
    backupGenerationDigest, correlationId, decidedAt, principalId, projectId,
    protectedDirectory, restoreCommandId,
  });
};
