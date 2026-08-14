import { createHash } from "node:crypto";

import type { BackupGenerationManifest } from "@moe/store";

/**
 * Vocabulary, shapes and admission for the fresh recovery fencing identity.
 *
 * Split out of `recovery-incarnation.ts` purely to hold the per-file line cap;
 * the mint service is the only intended consumer and re-publishes every symbol
 * here, so callers still see one module.
 */
export const RECOVERY_INCARNATION_SCHEMA_VERSION = "moe-recovery-incarnation/1" as const;

export const RECOVERY_INCARNATION_LAYER = "RECOVERY_INCARNATION" as const;

export const RECOVERY_INCARNATION_ERROR_CODES = Object.freeze([
  "RECOVERY_INCARNATION_INPUT_INVALID",
  "RECOVERY_ENTROPY_UNAVAILABLE",
  "RECOVERY_KEY_EPOCH_UNAVAILABLE",
] as const);
export type RecoveryIncarnationErrorCode = (typeof RECOVERY_INCARNATION_ERROR_CODES)[number];

export const RECOVERY_ENTROPY_BYTES = 32;
/** NUL cannot occur in a hex digest or in an admitted command id. */
const FRAME = "\u0000";

export interface RecoveryIncarnationRequest {
  readonly restoreCommandId: string;
  readonly backupGenerationDigest: BackupGenerationManifest["generationDigest"];
}

/**
 * Opaque by contract, not by type: the adapter is the only thing that can map a
 * handle back to key material, through a module-private WeakMap. A fabricated
 * or structurally cloned object is a different identity and resolves to nothing.
 */
export type RecoveryIncarnationKeyHandle = object;

export interface RecoveryIncarnationKeyPair {
  readonly handle: RecoveryIncarnationKeyHandle;
  readonly algorithm: string;
  readonly publicKeySpki: Uint8Array;
}

export interface RecoveryIncarnationCryptoPort {
  readonly randomBytes: (byteLength: number) => Promise<Uint8Array> | Uint8Array;
  readonly generateSigningKey: () => Promise<RecoveryIncarnationKeyPair>;
  readonly sign: (handle: RecoveryIncarnationKeyHandle, message: Uint8Array) => Promise<Uint8Array>;
  readonly verify: (
    publicKeySpki: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ) => Promise<boolean>;
  readonly destroy: (handle: RecoveryIncarnationKeyHandle) => void;
}

export interface RecoveryIncarnationProof {
  readonly challengeDigest: string;
  readonly signatureHex: string;
  readonly verified: true;
}

/** Everything an incarnation proves about ITSELF, whatever it was minted for. */
export interface RecoveryIncarnationBindingCommon {
  readonly schemaVersion: typeof RECOVERY_INCARNATION_SCHEMA_VERSION;
  readonly incarnationDigest: string;
  readonly incarnationRef: string;
  readonly keyEpochRef: string;
  readonly verificationKeyFingerprint: string;
  readonly publicKeyAlgorithm: "Ed25519";
  readonly publicKeySpkiHex: string;
  readonly bindingDigest: string;
  readonly proof: RecoveryIncarnationProof;
}

/** Both restore fields stay exactly where every existing caller reads them. */
export interface RestoreIncarnationBinding extends RecoveryIncarnationBindingCommon {
  readonly origin: "RESTORE";
  readonly restoreCommandId: string;
  readonly backupGenerationDigest: string;
}

/**
 * A never-restored store possesses no restore command and no backup generation,
 * so the genesis branch cannot NAME them: counterfeiting a restore fact is a
 * type error rather than a runtime check somebody can forget to write.
 */
export interface GenesisIncarnationBinding extends RecoveryIncarnationBindingCommon {
  readonly origin: "GENESIS";
  readonly projectId: string;
  readonly storeContextDigest: string;
}

export type RecoveryIncarnationBinding = GenesisIncarnationBinding | RestoreIncarnationBinding;

export interface RecoveryIncarnationMinted {
  readonly ok: true;
  readonly outcome: "MINTED";
  readonly authority: "NONE";
  /** RESTORE only: this service mints against a restore command, never genesis. */
  readonly binding: RestoreIncarnationBinding;
  /** Non-enumerable, so it cannot ride along in serialized evidence. */
  readonly keyHandle: RecoveryIncarnationKeyHandle;
}

export interface RecoveryIncarnationRefused {
  readonly ok: false;
  readonly outcome: "REFUSED";
  readonly authority: "NONE";
  readonly layer: typeof RECOVERY_INCARNATION_LAYER;
  readonly code: RecoveryIncarnationErrorCode;
  readonly truth: "UNKNOWN";
  readonly reason: string;
}

export type RecoveryIncarnationResult = RecoveryIncarnationMinted | RecoveryIncarnationRefused;

export interface RecoveryIncarnationService {
  readonly mint: (request: unknown) => Promise<RecoveryIncarnationResult>;
}

/**
 * Refusals are FIXED module constants. Nothing observed at the failure site
 * reaches them, so a caught provider message, a key byte or a stack frame has
 * no path into evidence even by accident.
 */
const refusal = (code: RecoveryIncarnationErrorCode, reason: string): RecoveryIncarnationRefused =>
  Object.freeze({
    authority: "NONE" as const,
    code,
    layer: RECOVERY_INCARNATION_LAYER,
    ok: false as const,
    outcome: "REFUSED" as const,
    reason,
    truth: "UNKNOWN" as const,
  });

export const RECOVERY_INPUT_INVALID = refusal(
  "RECOVERY_INCARNATION_INPUT_INVALID",
  "A recovery incarnation request must name exactly one restore command and one backup generation digest.",
);
export const RECOVERY_ENTROPY_UNAVAILABLE = refusal(
  "RECOVERY_ENTROPY_UNAVAILABLE",
  "The recovery incarnation nonce could not be proven fresh from the system CSPRNG.",
);
export const RECOVERY_KEY_EPOCH_UNAVAILABLE = refusal(
  "RECOVERY_KEY_EPOCH_UNAVAILABLE",
  "A fresh, self-proving signing-key epoch could not be established.",
);

/**
 * Domain-separated and length-framed. Without framing, ("ab", "c") and
 * ("a", "bc") hash identically, so a caller able to choose a command id could
 * steer one digest onto another binding's value.
 */
export const digestOf = (
  domain: string,
  ...parts: readonly (Uint8Array | string)[]
): string => {
  const hash = createHash("sha256")
    .update(`${RECOVERY_INCARNATION_SCHEMA_VERSION}:${domain}${FRAME}`);
  for (const part of parts) {
    hash.update(typeof part === "string" ? `${part.length}:${part}${FRAME}` : part);
  }
  return hash.digest("hex");
};

/** What the service keeps once the port's answer has been read and copied. */
export interface RecoveryIncarnationKeyMaterial {
  readonly handle: RecoveryIncarnationKeyHandle;
  readonly publicKeySpki: Uint8Array;
}

/** Ed25519 SPKI is 44 bytes; the bound only has to make an absurd answer cheap to refuse. */
const MAX_SPKI_BYTES = 1024;

/**
 * Reads each port-supplied property EXACTLY ONCE, by destructuring, and COPIES
 * the key bytes.
 *
 * Without the copy a port answering with a getter can show one SPKI to the
 * fingerprint and a different one to the published binding: both are
 * well-formed, the signature still verifies, and the binding looks complete
 * while its fingerprint covers bytes nobody ever receives. Re-reading
 * `pair.publicKeySpki` at each use is the whole bug, so the value is read once
 * and never re-read.
 */
export const snapshotKeyMaterial = (value: unknown): RecoveryIncarnationKeyMaterial | null => {
  if (value === null || typeof value !== "object") return null;
  const { algorithm, handle, publicKeySpki } = value as Partial<RecoveryIncarnationKeyPair>;
  if (algorithm !== "Ed25519") return null;
  if (typeof handle !== "object" || handle === null) return null;
  if (!(publicKeySpki instanceof Uint8Array)) return null;
  if (publicKeySpki.byteLength === 0 || publicKeySpki.byteLength > MAX_SPKI_BYTES) return null;
  return Object.freeze({ handle, publicKeySpki: Uint8Array.from(publicKeySpki) });
};

export const PORT_FAILED = Symbol("recovery-incarnation-port-failed");

/** Swallows the diagnostic on purpose; the caller maps to a fixed refusal. */
export const attemptPort = async <T>(
  call: () => T | Promise<T>,
): Promise<T | typeof PORT_FAILED> => {
  try {
    return await call();
  } catch {
    return PORT_FAILED;
  }
};
