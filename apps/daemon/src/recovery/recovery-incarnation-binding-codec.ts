import { RECOVERY_INCARNATION_SCHEMA_VERSION } from "./recovery-incarnation-contract.js";
import type { RecoveryIncarnationBinding } from "./recovery-incarnation-contract.js";

/**
 * The wire form of a recovery incarnation binding.
 *
 * Split out of the anchor because the bytes are now read by more than the
 * anchor: an origin-tagged binding is the canonical public evidence a genesis
 * fence has, and whoever installs or classifies it must agree byte-for-byte
 * with whoever anchored it. One codec, two readers.
 *
 * Serialized in ONE fixed field order PER ORIGIN, never from the caller's
 * object. Two callers holding the same binding therefore produce the same
 * bytes, which is what lets a re-anchor after a crash be recognised as a repeat
 * rather than as a conflicting second anchor.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HEX64 = /^[0-9a-f]{64}$/;
/** A signature, not a digest: Ed25519 is 64 bytes, but the bound is what matters. */
const HEX_BLOB = /^[0-9a-f]{2,1024}$/;

const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

const isName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const COMMON_KEYS = Object.freeze([
  "bindingDigest",
  "incarnationDigest",
  "incarnationRef",
  "keyEpochRef",
  "origin",
  "proof",
  "publicKeyAlgorithm",
  "publicKeySpkiHex",
  "schemaVersion",
  "verificationKeyFingerprint",
]);
const RESTORE_KEYS = Object.freeze([
  ...COMMON_KEYS,
  "backupGenerationDigest",
  "restoreCommandId",
]);
const GENESIS_KEYS = Object.freeze([...COMMON_KEYS, "projectId", "storeContextDigest"]);
const PROOF_KEYS = Object.freeze(["challengeDigest", "signatureHex", "verified"]);
const COMMON_DIGEST_KEYS = Object.freeze([
  "bindingDigest",
  "incarnationDigest",
  "incarnationRef",
  "keyEpochRef",
  "verificationKeyFingerprint",
]);

const commonFields = (binding: RecoveryIncarnationBinding): Record<string, unknown> => ({
  bindingDigest: binding.bindingDigest,
  incarnationDigest: binding.incarnationDigest,
  incarnationRef: binding.incarnationRef,
  keyEpochRef: binding.keyEpochRef,
  origin: binding.origin,
  proof: {
    challengeDigest: binding.proof.challengeDigest,
    signatureHex: binding.proof.signatureHex,
    verified: binding.proof.verified,
  },
  publicKeyAlgorithm: binding.publicKeyAlgorithm,
  publicKeySpkiHex: binding.publicKeySpkiHex,
  schemaVersion: binding.schemaVersion,
  verificationKeyFingerprint: binding.verificationKeyFingerprint,
});

export function encodeBinding(binding: RecoveryIncarnationBinding): Uint8Array {
  const common = commonFields(binding);
  return encoder.encode(
    JSON.stringify(
      binding.origin === "RESTORE"
        ? {
            ...common,
            backupGenerationDigest: binding.backupGenerationDigest,
            restoreCommandId: binding.restoreCommandId,
          }
        : {
            ...common,
            projectId: binding.projectId,
            storeContextDigest: binding.storeContextDigest,
          },
    ),
  );
}

const hasExactKeys = (
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
};

/**
 * A bounded exact-shape decode, not a cast. A row that has drifted, been
 * truncated or gained a field is returned as absent rather than admitted with
 * fields the reader would then be free to invent.
 *
 * The origin selects the exact key set BEFORE anything is read, so a genesis row
 * carrying a restore command — or a restore row claiming a project context — is
 * refused structurally rather than by remembering to check for it. A row written
 * before the origin existed carries no tag and is therefore absent, never
 * admitted under an invented one.
 */
export function decodeBinding(bytes: Uint8Array): RecoveryIncarnationBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const origin: unknown = (parsed as Record<string, unknown>)["origin"];
  if (origin !== "GENESIS" && origin !== "RESTORE") return null;
  if (!hasExactKeys(parsed, origin === "RESTORE" ? RESTORE_KEYS : GENESIS_KEYS)) return null;

  const proof: unknown = parsed["proof"];
  if (!hasExactKeys(proof, PROOF_KEYS)) return null;
  if (proof["verified"] !== true) return null;
  if (!isHex64(proof["challengeDigest"])) return null;
  const signatureHex: unknown = proof["signatureHex"];
  if (typeof signatureHex !== "string" || !HEX_BLOB.test(signatureHex)) return null;

  if (parsed["publicKeyAlgorithm"] !== "Ed25519") return null;
  if (parsed["schemaVersion"] !== RECOVERY_INCARNATION_SCHEMA_VERSION) return null;
  const publicKeySpkiHex: unknown = parsed["publicKeySpkiHex"];
  if (typeof publicKeySpkiHex !== "string" || !HEX_BLOB.test(publicKeySpkiHex)) return null;
  for (const key of COMMON_DIGEST_KEYS) {
    if (!isHex64(parsed[key])) return null;
  }

  const common = {
    bindingDigest: parsed["bindingDigest"] as string,
    incarnationDigest: parsed["incarnationDigest"] as string,
    incarnationRef: parsed["incarnationRef"] as string,
    keyEpochRef: parsed["keyEpochRef"] as string,
    proof: Object.freeze({
      challengeDigest: proof["challengeDigest"] as string,
      signatureHex,
      verified: true as const,
    }),
    publicKeyAlgorithm: "Ed25519" as const,
    publicKeySpkiHex,
    schemaVersion: RECOVERY_INCARNATION_SCHEMA_VERSION,
    verificationKeyFingerprint: parsed["verificationKeyFingerprint"] as string,
  };

  if (origin === "RESTORE") {
    const restoreCommandId: unknown = parsed["restoreCommandId"];
    if (!isName(restoreCommandId)) return null;
    if (!isHex64(parsed["backupGenerationDigest"])) return null;
    return Object.freeze({
      ...common,
      backupGenerationDigest: parsed["backupGenerationDigest"] as string,
      origin,
      restoreCommandId,
    });
  }
  const projectId: unknown = parsed["projectId"];
  if (!isName(projectId)) return null;
  if (!isHex64(parsed["storeContextDigest"])) return null;
  return Object.freeze({
    ...common,
    origin,
    projectId,
    storeContextDigest: parsed["storeContextDigest"] as string,
  });
}
