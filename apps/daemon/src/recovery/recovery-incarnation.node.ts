import { webcrypto } from "node:crypto";

import type {
  RecoveryIncarnationCryptoPort,
  RecoveryIncarnationKeyHandle,
  RecoveryIncarnationKeyPair,
} from "./recovery-incarnation-contract.js";

/**
 * The production crypto boundary for a fresh recovery key epoch.
 *
 * The private key is a NON-EXTRACTABLE WebCrypto `CryptoKey` and is never
 * returned. Callers get a frozen empty object; the only thing that can turn one
 * back into key material is this port's own WeakMap. A fabricated `{}` or a
 * `structuredClone` of a real handle is a different object identity and
 * resolves to nothing, so a caller cannot forge its way to a signature.
 *
 * Classic `KeyObject` was rejected deliberately: it is structured-cloneable and
 * its PKCS8 bytes stay exportable, while `JSON.stringify` misleadingly yields
 * `{}` — it LOOKS contained and is not.
 *
 * Honest limit: non-extractable is protection against export, not durability.
 * This key lives in process memory and dies with the process. It is not an
 * OS-protected keystore reference, and nothing built on it may claim
 * crash-resume until a durable protected provider exists.
 */
const ALGORITHM = "Ed25519";

const failed = (detail: string): Error =>
  new Error(`Recovery key epoch unusable: ${detail}.`);

interface RawSigningPair {
  readonly privateKey: webcrypto.CryptoKey;
  readonly publicKey: webcrypto.CryptoKey;
}

/** `generateKey` is typed to return either one key or a pair; narrow, do not cast. */
const isSigningPair = (value: unknown): value is RawSigningPair =>
  value !== null && typeof value === "object" && "privateKey" in value && "publicKey" in value;

export function createNodeRecoveryCryptoPort(): RecoveryIncarnationCryptoPort {
  /** Port-private, not module-private: a handle from one port cannot sign on another. */
  const protectedKeys = new WeakMap<object, webcrypto.CryptoKey>();

  const generateSigningKey = async (): Promise<RecoveryIncarnationKeyPair> => {
    const generated: unknown = await webcrypto.subtle.generateKey({ name: ALGORITHM }, false, [
      "sign",
      "verify",
    ]);
    if (!isSigningPair(generated)) {
      throw failed("the runtime returned a single key rather than a signing pair");
    }
    const { privateKey, publicKey } = generated;
    // Asserted, not assumed: a runtime that quietly handed back an extractable
    // private key would still satisfy every later step of the mint.
    if (privateKey.type !== "private" || privateKey.extractable) {
      throw failed("the private key is not a non-extractable private CryptoKey");
    }
    if (!privateKey.usages.includes("sign") || privateKey.algorithm.name !== ALGORITHM) {
      throw failed("the private key cannot sign under the required algorithm");
    }

    const publicKeySpki = new Uint8Array(await webcrypto.subtle.exportKey("spki", publicKey));
    // Round-trip the COMPLETE canonical SPKI DER now, so a consumer verifying
    // this binding later cannot be the first to discover it is unimportable.
    const reimported = await webcrypto.subtle.importKey(
      "spki",
      publicKeySpki,
      { name: ALGORITHM },
      true,
      ["verify"],
    );
    if (reimported.type !== "public" || reimported.algorithm.name !== ALGORITHM) {
      throw failed("the exported public key did not round-trip as Ed25519 public metadata");
    }

    const handle: RecoveryIncarnationKeyHandle = Object.freeze({});
    protectedKeys.set(handle, privateKey);
    return Object.freeze({ algorithm: ALGORITHM, handle, publicKeySpki });
  };

  const sign = async (
    handle: RecoveryIncarnationKeyHandle,
    message: Uint8Array,
  ): Promise<Uint8Array> => {
    const key = protectedKeys.get(handle);
    if (key === undefined) throw failed("no protected signing key is bound to this handle");
    return new Uint8Array(await webcrypto.subtle.sign({ name: ALGORITHM }, key, message));
  };

  const verify = async (
    publicKeySpki: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> => {
    const key = await webcrypto.subtle.importKey(
      "spki",
      publicKeySpki,
      { name: ALGORITHM },
      true,
      ["verify"],
    );
    return webcrypto.subtle.verify({ name: ALGORITHM }, key, signature, message);
  };

  return Object.freeze({
    destroy: (handle: RecoveryIncarnationKeyHandle): void => {
      protectedKeys.delete(handle);
    },
    generateSigningKey,
    randomBytes: (byteLength: number): Uint8Array =>
      webcrypto.getRandomValues(new Uint8Array(byteLength)),
    sign,
    verify,
  });
}
