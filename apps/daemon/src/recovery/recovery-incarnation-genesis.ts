import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import {
  PORT_FAILED,
  RECOVERY_ENTROPY_BYTES,
  RECOVERY_ENTROPY_UNAVAILABLE,
  RECOVERY_GENESIS_INPUT_INVALID,
  RECOVERY_INCARNATION_SCHEMA_VERSION,
  RECOVERY_KEY_EPOCH_UNAVAILABLE,
  digestOf,
} from "./recovery-incarnation-contract.js";
import type {
  GenesisIncarnationBinding,
  RecoveryIncarnationRefused,
} from "./recovery-incarnation-contract.js";
import { deriveIncarnation, snapshotGenesisContext } from "./recovery-incarnation-context.js";

/**
 * The fencing identity a store that has NEVER restored is entitled to.
 *
 * It is synchronous because the daemon's store dependencies are built
 * synchronously and the landed crypto port is WebCrypto, which has no sync path.
 * That is the ONLY difference from the port-based mint: the context snapshot,
 * the derivation, the freshness reservations and the self-proof are the same
 * code, so the two origins cannot drift apart.
 *
 * What it deliberately does NOT do: synthesize a restore command or a backup
 * generation for a store that never restored, accept a caller-chosen context,
 * read a clock or a counter, or return a key handle. The Node keypair is a
 * classic `KeyObject` whose PKCS8 stays exportable — the async port rejected
 * that shape on purpose — so the private key is never stored in a map, a
 * closure or a returned property: it dies with this call.
 *
 * The result carries `authority: "NONE"`. It proves a fence exists; it grants
 * nothing, signs no business command, and is not a durable keystore reference.
 */
export interface GenesisSigningKey {
  readonly privateKey: KeyObject;
  readonly publicKeySpki: Uint8Array;
}

export interface GenesisCryptoShell {
  readonly randomBytes: (byteLength: number) => Uint8Array;
  readonly generateSigningKey: () => GenesisSigningKey;
  readonly sign: (privateKey: KeyObject, message: Uint8Array) => Uint8Array;
  readonly verify: (
    publicKeySpki: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ) => boolean;
}

export interface GenesisIncarnationMinted {
  readonly ok: true;
  readonly outcome: "MINTED";
  readonly authority: "NONE";
  readonly binding: GenesisIncarnationBinding;
}

export type GenesisMintResult = GenesisIncarnationMinted | RecoveryIncarnationRefused;

/** Ed25519 SPKI is 44 bytes; the bound only makes an absurd answer cheap to refuse. */
const MAX_SPKI_BYTES = 1024;

/**
 * Process-wide, and shared by every shell: a caller cannot dodge freshness by
 * handing in a different crypto implementation.
 */
const seenNonceDigests = new Set<string>();
const seenKeyFingerprints = new Set<string>();

export const nodeGenesisCryptoShell: GenesisCryptoShell = Object.freeze({
  generateSigningKey: (): GenesisSigningKey => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return {
      privateKey,
      publicKeySpki: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
    };
  },
  randomBytes: (byteLength: number): Uint8Array => new Uint8Array(randomBytes(byteLength)),
  sign: (privateKey: KeyObject, message: Uint8Array): Uint8Array =>
    new Uint8Array(sign(null, message, privateKey)),
  // Verifies through the PUBLISHED bytes, never through the generated public
  // key object: what a later reader can check is exactly what is checked here.
  verify: (publicKeySpki: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean =>
    verify(
      null,
      message,
      createPublicKey({ format: "der", key: Buffer.from(publicKeySpki), type: "spki" }),
      signature,
    ),
});

/** Swallows the diagnostic on purpose; the caller maps to a fixed refusal. */
const attemptShell = <T>(call: () => T): T | typeof PORT_FAILED => {
  try {
    return call();
  } catch {
    return PORT_FAILED;
  }
};

export function mintGenesisIncarnation(
  projectId: string,
  shell: GenesisCryptoShell = nodeGenesisCryptoShell,
): GenesisMintResult {
  const context = snapshotGenesisContext({ projectId });
  if (context === null) return RECOVERY_GENESIS_INPUT_INVALID;

  const entropy = attemptShell(() => shell.randomBytes(RECOVERY_ENTROPY_BYTES));
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== RECOVERY_ENTROPY_BYTES) {
    return RECOVERY_ENTROPY_UNAVAILABLE;
  }
  // The RAW block is fingerprinted and reserved BEFORE any key material exists,
  // so a block that was once exposed is burned rather than retried, even if the
  // attempt that exposed it dies immediately afterwards.
  const incarnationDigest = digestOf("nonce", entropy);
  if (seenNonceDigests.has(incarnationDigest)) return RECOVERY_ENTROPY_UNAVAILABLE;
  seenNonceDigests.add(incarnationDigest);

  const generated = attemptShell(() => shell.generateSigningKey());
  if (generated === PORT_FAILED || generated === null || typeof generated !== "object") {
    return RECOVERY_KEY_EPOCH_UNAVAILABLE;
  }
  // Read ONCE and copied: a shell answering with a getter must not be able to
  // show one SPKI to the fingerprint and another to the published binding.
  const { privateKey, publicKeySpki } = generated;
  if (!(publicKeySpki instanceof Uint8Array)) return RECOVERY_KEY_EPOCH_UNAVAILABLE;
  if (publicKeySpki.byteLength === 0 || publicKeySpki.byteLength > MAX_SPKI_BYTES) {
    return RECOVERY_KEY_EPOCH_UNAVAILABLE;
  }
  const spki = Uint8Array.from(publicKeySpki);
  const verificationKeyFingerprint = digestOf("key", spki);
  if (seenKeyFingerprints.has(verificationKeyFingerprint)) return RECOVERY_KEY_EPOCH_UNAVAILABLE;
  seenKeyFingerprints.add(verificationKeyFingerprint);

  const publicKeySpkiHex = Buffer.from(spki).toString("hex");
  const derived = deriveIncarnation({
    context,
    incarnationDigest,
    publicKeySpkiHex,
    verificationKeyFingerprint,
  });
  const challenge = Buffer.from(derived.challengeDigest, "hex");
  const signed = attemptShell(() => shell.sign(privateKey, challenge));
  if (!(signed instanceof Uint8Array) || signed.byteLength === 0) {
    return RECOVERY_KEY_EPOCH_UNAVAILABLE;
  }
  const signature = Uint8Array.from(signed);
  // `!== true` rather than falsiness: a truthy non-boolean is not a proof.
  if (attemptShell(() => shell.verify(spki, challenge, signature)) !== true) {
    return RECOVERY_KEY_EPOCH_UNAVAILABLE;
  }

  const binding: GenesisIncarnationBinding = Object.freeze({
    bindingDigest: derived.bindingDigest,
    incarnationDigest,
    incarnationRef: derived.incarnationRef,
    keyEpochRef: derived.keyEpochRef,
    origin: "GENESIS" as const,
    projectId: context.projectId,
    proof: Object.freeze({
      challengeDigest: derived.challengeDigest,
      signatureHex: Buffer.from(signature).toString("hex"),
      verified: true as const,
    }),
    publicKeyAlgorithm: "Ed25519" as const,
    publicKeySpkiHex,
    schemaVersion: RECOVERY_INCARNATION_SCHEMA_VERSION,
    storeContextDigest: context.storeContextDigest,
    verificationKeyFingerprint,
  });
  // No key handle field exists to leak: `privateKey` goes out of scope here.
  return Object.freeze({
    authority: "NONE" as const,
    binding,
    ok: true as const,
    outcome: "MINTED" as const,
  });
}
