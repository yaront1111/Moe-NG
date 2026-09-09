import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * The authenticated cipher that stands between an operator's environment variables and every
 * durable byte the daemon writes.
 *
 * WHY THE KEY COMES FROM THE DAEMON CREDENTIAL, not Windows DPAPI. DPAPI is Windows-only and
 * this repo ships on Windows, macOS and Linux, so a DPAPI path means either a platform-locked
 * feature or two implementations of the most security-sensitive code in the system. The daemon
 * credential already exists (`cli/moe-init.ts` mints it, `MOE_DAEMON_CREDENTIAL` carries it),
 * already gates the store, and keeps ONE secret to manage instead of two. It satisfies the
 * requirement identically on every platform: a store copied WITHOUT the credential is useless.
 *
 * WHY HKDF AND NOT scrypt/PBKDF2. The credential is machine-minted high-entropy hex
 * (`cli/moe-init.ts:152` mints it via `randomHex`), not a human password. A work factor defends
 * against GUESSING a low-entropy secret; there is nothing here to guess, so it would buy no
 * security while costing ~100ms of CPU on every seal and every open. HKDF-SHA256 is the correct
 * primitive for deriving a key from an already-strong secret.
 *
 * NONCE AND SALT DISCIPLINE - the part that must not be "optimised". Both are freshly random on
 * EVERY seal and travel inside the blob. A repeated (key, nonce) pair under AES-GCM is not a
 * degradation, it is a total break: two ciphertexts under one nonce leak their XOR, and the
 * GHASH authentication subkey becomes recoverable, so an attacker can forge blobs the daemon
 * will accept. A hard-coded nonce passes every round-trip test ever written, which is exactly
 * why the suite asserts that two seals of the SAME plaintext produce DIFFERENT bytes. The
 * per-seal salt additionally gives each value its own derived key, so the nonce space is not
 * even shared between two values.
 *
 * WHY `open` FAILS CLOSED. AES-GCM verifies the tag before releasing plaintext, and node's
 * `final()` throws on mismatch. A wrong credential therefore yields NO output rather than
 * garbage, which is what makes a copied store USELESS rather than merely scrambled. Every
 * failure is returned as a typed result carrying a reason and nothing else: no plaintext, no
 * credential, no node error string. An interpolated error message is the classic leak.
 *
 * TIMING. There is no length-dependent branch on the credential, following the discipline
 * `identity/session-authenticator.ts:66-73` documents (an early length check leaks the
 * credential's length through timing). HKDF consumes the credential whole, and tag comparison
 * happens inside node's constant-time GCM verification, never by hand here.
 *
 * This module reads no files, writes no files and mints no authority. It knows nothing about
 * environments, variable names or the store.
 */

export const ENVIRONMENT_SEAL_VERSION = 1 as const;
export const ENVIRONMENT_SEAL_SALT_BYTES = 16 as const;
export const ENVIRONMENT_SEAL_NONCE_BYTES = 12 as const;
export const ENVIRONMENT_SEAL_TAG_BYTES = 16 as const;
export const ENVIRONMENT_SEAL_KEY_BYTES = 32 as const;

/** `[version:1][salt:16][nonce:12][tag:16]` then the ciphertext, which is plaintext-length. */
export const ENVIRONMENT_SEAL_HEADER_BYTES =
  1 + ENVIRONMENT_SEAL_SALT_BYTES + ENVIRONMENT_SEAL_NONCE_BYTES + ENVIRONMENT_SEAL_TAG_BYTES;

const SALT_OFFSET = 1;
const NONCE_OFFSET = SALT_OFFSET + ENVIRONMENT_SEAL_SALT_BYTES;
const TAG_OFFSET = NONCE_OFFSET + ENVIRONMENT_SEAL_NONCE_BYTES;

/** Domain separation: this derivation may never collide with another use of the credential. */
const HKDF_INFO = "moe/environment-variable-seal/1";
const CIPHER_ALGORITHM = "aes-256-gcm";

/**
 * MALFORMED means the bytes are not a seal of a version we understand - a framing fact, decided
 * before any key is touched. AUTHENTICATION_FAILED means the bytes ARE a well-framed seal that
 * this credential cannot open. The two are kept distinct so a caller can tell "corrupt record"
 * from "wrong key" without either answer revealing anything about the value itself.
 */
export type EnvironmentSealFailureReason = "AUTHENTICATION_FAILED" | "MALFORMED";

export interface EnvironmentSealOpened {
  readonly ok: true;
  readonly plaintext: Uint8Array;
}

export interface EnvironmentSealFailure {
  readonly ok: false;
  readonly reason: EnvironmentSealFailureReason;
}

export type EnvironmentSealOpenResult = EnvironmentSealFailure | EnvironmentSealOpened;

const textEncoder = new TextEncoder();

/**
 * HKDF-SHA256 over the raw credential bytes with a per-seal salt, yielding a fresh 32-byte key.
 * The credential is consumed whole: there is deliberately no emptiness or length check, because
 * a branch on either is a timing side channel, and an empty credential must simply derive a key
 * that opens nothing rather than take a distinguishable early exit.
 */
function deriveSealKey(credential: string, salt: Uint8Array): Uint8Array {
  const secret = textEncoder.encode(credential);
  const derived = hkdfSync(
    "sha256", secret, salt, textEncoder.encode(HKDF_INFO), ENVIRONMENT_SEAL_KEY_BYTES,
  );
  return new Uint8Array(derived);
}

/**
 * Seals `plaintext` under a key derived from `credential`. The returned bytes are safe to write
 * to durable storage: they carry the salt and nonce (both public by design) and the
 * authentication tag, but no recoverable trace of the plaintext.
 */
export function sealEnvironmentValue(credential: string, plaintext: Uint8Array): Uint8Array {
  const salt = randomBytes(ENVIRONMENT_SEAL_SALT_BYTES);
  const nonce = randomBytes(ENVIRONMENT_SEAL_NONCE_BYTES);
  const cipher = createCipheriv(CIPHER_ALGORITHM, deriveSealKey(credential, salt), nonce, {
    authTagLength: ENVIRONMENT_SEAL_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const sealed = new Uint8Array(ENVIRONMENT_SEAL_HEADER_BYTES + ciphertext.byteLength);
  sealed[0] = ENVIRONMENT_SEAL_VERSION;
  sealed.set(salt, SALT_OFFSET);
  sealed.set(nonce, NONCE_OFFSET);
  sealed.set(tag, TAG_OFFSET);
  sealed.set(ciphertext, ENVIRONMENT_SEAL_HEADER_BYTES);
  return sealed;
}

const MALFORMED: EnvironmentSealFailure = Object.freeze({
  ok: false as const, reason: "MALFORMED" as const,
});
const AUTHENTICATION_FAILED: EnvironmentSealFailure = Object.freeze({
  ok: false as const, reason: "AUTHENTICATION_FAILED" as const,
});

/**
 * Opens `sealed` under `credential`, or fails closed. There is no third outcome: a wrong
 * credential, a flipped ciphertext byte, a salt replayed from another seal and a swapped tag all
 * land on AUTHENTICATION_FAILED with no bytes released, because GCM verifies before it yields.
 */
export function openEnvironmentValue(
  credential: string,
  sealed: Uint8Array,
): EnvironmentSealOpenResult {
  if (sealed.byteLength < ENVIRONMENT_SEAL_HEADER_BYTES) return MALFORMED;
  if (sealed[0] !== ENVIRONMENT_SEAL_VERSION) return MALFORMED;
  const salt = sealed.subarray(SALT_OFFSET, NONCE_OFFSET);
  const nonce = sealed.subarray(NONCE_OFFSET, TAG_OFFSET);
  const tag = sealed.subarray(TAG_OFFSET, ENVIRONMENT_SEAL_HEADER_BYTES);
  const ciphertext = sealed.subarray(ENVIRONMENT_SEAL_HEADER_BYTES);
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, deriveSealKey(credential, salt), nonce, {
      authTagLength: ENVIRONMENT_SEAL_TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const opened = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return Object.freeze({ ok: true as const, plaintext: new Uint8Array(opened) });
  } catch {
    // Deliberately swallowed: node's error text is not evidence a caller may act on, and
    // relaying it would put cipher internals into whatever log the refusal reaches.
    return AUTHENTICATION_FAILED;
  }
}
