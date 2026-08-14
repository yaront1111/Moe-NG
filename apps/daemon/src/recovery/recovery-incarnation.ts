import {
  RECOVERY_ENTROPY_BYTES,
  RECOVERY_ENTROPY_UNAVAILABLE,
  RECOVERY_INCARNATION_SCHEMA_VERSION,
  RECOVERY_INPUT_INVALID,
  RECOVERY_KEY_EPOCH_UNAVAILABLE,
  attemptPort,
  digestOf,
  snapshotKeyMaterial,
} from "./recovery-incarnation-contract.js";
import { snapshotRequest } from "./recovery-incarnation-context.js";
import type {
  RecoveryIncarnationBinding,
  RecoveryIncarnationCryptoPort,
  RecoveryIncarnationKeyMaterial,
  RecoveryIncarnationMinted,
  RecoveryIncarnationRefused,
  RecoveryIncarnationRequest,
  RecoveryIncarnationResult,
  RecoveryIncarnationService,
} from "./recovery-incarnation-contract.js";

export { createNodeRecoveryCryptoPort } from "./recovery-incarnation.node.js";
export {
  RECOVERY_ENTROPY_BYTES,
  RECOVERY_INCARNATION_ERROR_CODES,
  RECOVERY_INCARNATION_LAYER,
  RECOVERY_INCARNATION_SCHEMA_VERSION,
  type RecoveryIncarnationBinding,
  type RecoveryIncarnationCryptoPort,
  type RecoveryIncarnationErrorCode,
  type RecoveryIncarnationKeyHandle,
  type RecoveryIncarnationKeyMaterial,
  type RecoveryIncarnationKeyPair,
  type RecoveryIncarnationMinted,
  type RecoveryIncarnationProof,
  type RecoveryIncarnationRefused,
  type RecoveryIncarnationRequest,
  type RecoveryIncarnationResult,
  type RecoveryIncarnationService,
} from "./recovery-incarnation-contract.js";

/**
 * Mints the fresh fencing identity every disaster restore must install.
 *
 * A restored store carries the OLD incarnation and the OLD signing key, so
 * nothing derived FROM restored state can fence against it. Both identities
 * here come from material that does not exist in the backup: 32 CSPRNG bytes
 * and a brand-new Ed25519 key epoch, bound to exactly one restore command and
 * one backup generation digest.
 *
 * What it deliberately does NOT do: increment a counter, read a clock, hash the
 * backup, or accept a caller-supplied nonce or key epoch. Each of those would
 * let someone holding the backup predict or replay the fence.
 *
 * `MINTED` carries `authority: "NONE"` and is process-local. It is a proposal
 * for RecoveryAnchor to persist; nothing here is durable, and a non-extractable
 * WebCrypto key behind a handle is protected against export but is NOT an
 * OS-durable keystore reference — it does not survive the process. A later
 * controller must supply a protected durable key provider before anything can
 * claim crash-resume.
 */
export function createRecoveryIncarnationService(
  port: RecoveryIncarnationCryptoPort,
): RecoveryIncarnationService {
  const settled = new Map<string, { digest: string; result: RecoveryIncarnationMinted }>();
  const inFlight = new Map<
    string,
    { digest: string; result: Promise<RecoveryIncarnationResult> }
  >();
  const seenNonceDigests = new Set<string>();
  const seenKeyFingerprints = new Set<string>();

  /** Cleanup failure never replaces the primary code it was cleaning up after. */
  const discard = (
    material: RecoveryIncarnationKeyMaterial,
    result: RecoveryIncarnationRefused,
  ): RecoveryIncarnationRefused => {
    try {
      port.destroy(material.handle);
    } catch {
      /* best effort */
    }
    return result;
  };

  const prove = async (
    request: RecoveryIncarnationRequest,
    incarnationDigest: string,
    verificationKeyFingerprint: string,
    material: RecoveryIncarnationKeyMaterial,
  ): Promise<RecoveryIncarnationResult> => {
    const { backupGenerationDigest, restoreCommandId } = request;
    const publicKeySpkiHex = Buffer.from(material.publicKeySpki).toString("hex");
    const context = [restoreCommandId, backupGenerationDigest] as const;
    const incarnationRef = digestOf("incarnation", incarnationDigest, ...context);
    const keyEpochRef = digestOf("key-epoch", verificationKeyFingerprint, ...context);
    const bindingDigest = digestOf(
      "binding",
      RECOVERY_INCARNATION_SCHEMA_VERSION,
      ...context,
      incarnationDigest,
      incarnationRef,
      keyEpochRef,
      verificationKeyFingerprint,
      publicKeySpkiHex,
    );
    const challengeDigest = digestOf("challenge", bindingDigest);
    const challenge = Buffer.from(challengeDigest, "hex");

    const signed = await attemptPort(() => port.sign(material.handle, challenge));
    if (!(signed instanceof Uint8Array) || signed.byteLength === 0) {
      return discard(material, RECOVERY_KEY_EPOCH_UNAVAILABLE);
    }
    // Copied for the same reason the SPKI is: the bytes that get verified must
    // be the bytes that get published, and the port still holds a reference.
    const signature = Uint8Array.from(signed);
    // Self-proof through the same port a consumer would use. `!== true` rather
    // than falsiness, so a truthy non-boolean cannot pass for a verification.
    const verified = await attemptPort(() =>
      port.verify(material.publicKeySpki, challenge, signature),
    );
    if (verified !== true) return discard(material, RECOVERY_KEY_EPOCH_UNAVAILABLE);

    const binding: RecoveryIncarnationBinding = Object.freeze({
      backupGenerationDigest,
      bindingDigest,
      incarnationDigest,
      incarnationRef,
      keyEpochRef,
      proof: Object.freeze({
        challengeDigest,
        signatureHex: Buffer.from(signature).toString("hex"),
        verified: true as const,
      }),
      publicKeyAlgorithm: "Ed25519" as const,
      publicKeySpkiHex,
      restoreCommandId,
      schemaVersion: RECOVERY_INCARNATION_SCHEMA_VERSION,
      verificationKeyFingerprint,
    });
    const result: RecoveryIncarnationMinted = Object.freeze(
      Object.defineProperty(
        {
          authority: "NONE" as const,
          binding,
          keyHandle: material.handle,
          ok: true as const,
          outcome: "MINTED" as const,
        },
        "keyHandle",
        { enumerable: false, value: material.handle },
      ),
    );
    settled.set(restoreCommandId, { digest: backupGenerationDigest, result });
    return result;
  };

  const run = async (request: RecoveryIncarnationRequest): Promise<RecoveryIncarnationResult> => {
    const entropy = await attemptPort(() => port.randomBytes(RECOVERY_ENTROPY_BYTES));
    if (!(entropy instanceof Uint8Array) || entropy.byteLength !== RECOVERY_ENTROPY_BYTES) {
      return RECOVERY_ENTROPY_UNAVAILABLE;
    }
    // Fingerprint and reserve the RAW block, before the key await and before any
    // caller context is mixed in. A context-bound reference differs for every
    // command id, so only this comparison can catch a CSPRNG repeating itself.
    // The reservation stands even if this attempt later dies: a block that was
    // once exposed is burned, not retried.
    const incarnationDigest = digestOf("nonce", entropy);
    if (seenNonceDigests.has(incarnationDigest)) return RECOVERY_ENTROPY_UNAVAILABLE;
    seenNonceDigests.add(incarnationDigest);

    const answer = await attemptPort(() => port.generateSigningKey());
    // Read once and copied here: every later use reads THIS material, never the
    // port's object again.
    const material = snapshotKeyMaterial(answer);
    if (material === null) return RECOVERY_KEY_EPOCH_UNAVAILABLE;
    // Same argument, over the COMPLETE canonical SPKI rather than a tail slice.
    const verificationKeyFingerprint = digestOf("key", material.publicKeySpki);
    if (seenKeyFingerprints.has(verificationKeyFingerprint)) {
      return discard(material, RECOVERY_KEY_EPOCH_UNAVAILABLE);
    }
    seenKeyFingerprints.add(verificationKeyFingerprint);
    return prove(request, incarnationDigest, verificationKeyFingerprint, material);
  };

  /**
   * A restore command is minted at most once per process. Repeating the exact
   * same command and generation is a retry and returns the same binding;
   * rebinding that command to a DIFFERENT generation is refused, because two
   * live fences for one restore is the failure this service exists to prevent.
   */
  const mint = (input: unknown): Promise<RecoveryIncarnationResult> => {
    const request = snapshotRequest(input);
    if (request === null) return Promise.resolve(RECOVERY_INPUT_INVALID);
    const { backupGenerationDigest, restoreCommandId } = request;

    const done = settled.get(restoreCommandId);
    if (done !== undefined) {
      return Promise.resolve(
        done.digest === backupGenerationDigest ? done.result : RECOVERY_INPUT_INVALID,
      );
    }
    const running = inFlight.get(restoreCommandId);
    if (running !== undefined) {
      return running.digest === backupGenerationDigest
        ? running.result
        : Promise.resolve(RECOVERY_INPUT_INVALID);
    }
    // Registered synchronously, before any caller can await: a second identical
    // call in the same tick must join this mint rather than start a second one.
    const result = run(request).finally(() => {
      inFlight.delete(restoreCommandId);
    });
    inFlight.set(restoreCommandId, { digest: backupGenerationDigest, result });
    return result;
  };

  return Object.freeze({ mint });
}
