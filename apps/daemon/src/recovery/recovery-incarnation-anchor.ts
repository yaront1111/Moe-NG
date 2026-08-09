import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import type { RecoveryIncarnationBinding } from "./recovery-incarnation-contract.js";
import {
  RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND,
  incarnationAggregateId,
} from "./recovery-succession-contract.js";
import type { RecoveryDurableWriteRequest } from "./recovery-succession-contract.js";

/**
 * The durable half of recovery incarnation identity.
 *
 * Minting produces a binding that is fully serializable and proves itself, but
 * nothing about being serializable makes it a FACT: until a row exists, "I held
 * incarnation X" is only a caller's assertion, and a caller can mint a throwaway
 * incarnation whose binding passes every self-check. Anchoring is what makes the
 * predecessor of a succession something the daemon observed rather than
 * something it was told.
 *
 * The private key is not anchored and cannot be: it dies with its process by
 * design. Only public bytes are written here.
 */
const PAGE_SIZE = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HEX64 = /^[0-9a-f]{64}$/;
/** A signature, not a digest: Ed25519 is 64 bytes, but the bound is what matters. */
const HEX_BLOB = /^[0-9a-f]{2,1024}$/;

const isHex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

/**
 * Serialized in ONE fixed field order, never from the caller's object. Two
 * callers holding the same binding therefore produce the same bytes, which is
 * what lets a re-anchor after a crash be recognised as a repeat rather than as
 * a conflicting second anchor.
 */
function encodeBinding(binding: RecoveryIncarnationBinding): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      backupGenerationDigest: binding.backupGenerationDigest,
      bindingDigest: binding.bindingDigest,
      incarnationDigest: binding.incarnationDigest,
      incarnationRef: binding.incarnationRef,
      keyEpochRef: binding.keyEpochRef,
      proof: {
        challengeDigest: binding.proof.challengeDigest,
        signatureHex: binding.proof.signatureHex,
        verified: binding.proof.verified,
      },
      publicKeyAlgorithm: binding.publicKeyAlgorithm,
      publicKeySpkiHex: binding.publicKeySpkiHex,
      restoreCommandId: binding.restoreCommandId,
      schemaVersion: binding.schemaVersion,
      verificationKeyFingerprint: binding.verificationKeyFingerprint,
    }),
  );
}

const BINDING_KEYS = Object.freeze([
  "backupGenerationDigest",
  "bindingDigest",
  "incarnationDigest",
  "incarnationRef",
  "keyEpochRef",
  "proof",
  "publicKeyAlgorithm",
  "publicKeySpkiHex",
  "restoreCommandId",
  "schemaVersion",
  "verificationKeyFingerprint",
]);
const PROOF_KEYS = Object.freeze(["challengeDigest", "signatureHex", "verified"]);

const hasExactKeys = (value: unknown, expected: readonly string[]): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
};

/**
 * A bounded exact-shape decode, not a cast. A row that has drifted, been
 * truncated or gained a field is returned as absent rather than admitted with
 * fields the reader would then be free to invent.
 */
function decodeBinding(bytes: Uint8Array): RecoveryIncarnationBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!hasExactKeys(parsed, BINDING_KEYS)) return null;
  const proof: unknown = parsed["proof"];
  if (!hasExactKeys(proof, PROOF_KEYS)) return null;
  if (proof["verified"] !== true) return null;
  if (!isHex64(proof["challengeDigest"])) return null;
  const signatureHex: unknown = proof["signatureHex"];
  if (typeof signatureHex !== "string" || !HEX_BLOB.test(signatureHex)) return null;

  if (parsed["publicKeyAlgorithm"] !== "Ed25519") return null;
  if (parsed["schemaVersion"] !== "moe-recovery-incarnation/1") return null;
  const publicKeySpkiHex: unknown = parsed["publicKeySpkiHex"];
  if (typeof publicKeySpkiHex !== "string" || !HEX_BLOB.test(publicKeySpkiHex)) return null;
  const restoreCommandId: unknown = parsed["restoreCommandId"];
  if (typeof restoreCommandId !== "string" || restoreCommandId.length === 0) return null;
  for (const key of ["backupGenerationDigest", "bindingDigest", "incarnationDigest",
    "incarnationRef", "keyEpochRef", "verificationKeyFingerprint"]) {
    if (!isHex64(parsed[key])) return null;
  }

  return Object.freeze({
    backupGenerationDigest: parsed["backupGenerationDigest"] as string,
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
    restoreCommandId,
    schemaVersion: "moe-recovery-incarnation/1" as const,
    verificationKeyFingerprint: parsed["verificationKeyFingerprint"] as string,
  });
}

function isAnchorRow(decision: CommandDecisionRecord, projectId: string): boolean {
  return (
    decision.key.projectId === projectId &&
    decision.commandKind === RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND &&
    decision.effectDisposition === "EFFECTS_COMMITTED"
  );
}

/**
 * Returns the anchored binding for one incarnation, or null when nothing
 * anchored it. The aggregate id is recomputed from the DECODED content, so a
 * row filed under one incarnation while carrying another's binding is dropped
 * rather than answered with.
 */
export function readAnchoredIncarnation(
  store: SqliteEventStore,
  projectId: string,
  incarnationRef: string,
): RecoveryIncarnationBinding | null {
  const wanted = incarnationAggregateId(incarnationRef);
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, PAGE_SIZE);
    for (const decision of page.items) {
      if (!isAnchorRow(decision, projectId) || decision.targetAggregateId !== wanted) continue;
      const binding = decodeBinding(decision.resultBytes);
      if (binding === null) continue;
      if (incarnationAggregateId(binding.incarnationRef) !== wanted) continue;
      return binding;
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Anchors one incarnation, single-shot. `expectedVersion: 0` against an
 * aggregate keyed on the incarnation itself means the STORE refuses the second
 * anchor; nothing here reads-then-writes and hopes.
 *
 * Returns false only for that version conflict, which the store RETURNS as a
 * NO_BUSINESS_EFFECT decision. There is deliberately no try/catch: a genuine
 * store fault throws and must keep throwing, because a catch-all here would
 * report a real database failure as a benign duplicate.
 *
 * Re-anchoring the identical binding is idempotent, which is what makes a crash
 * between anchoring and recording the succession recoverable by simply retrying.
 */
export function anchorIncarnation(
  store: SqliteEventStore,
  request: RecoveryDurableWriteRequest,
  binding: RecoveryIncarnationBinding,
): boolean {
  const bytes = encodeBinding(binding);
  const aggregateId = incarnationAggregateId(binding.incarnationRef);
  const existing = readAnchoredIncarnation(store, request.projectId, binding.incarnationRef);
  if (existing !== null) return sameBytes(encodeBinding(existing), bytes);

  const commandId = `recovery-incarnate:${binding.incarnationRef}`;
  const response = store.commitExpectedVersionDecision({
    commandKind: RECOVERY_INCARNATION_ANCHOR_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [
      {
        eventId: `${commandId}:anchored`,
        eventType: "RecoveryIncarnationAnchored",
        payload: bytes,
      },
    ],
    expectedVersion: 0,
    key: { commandId, principalId: request.principalId, projectId: request.projectId },
    requestBytes: encoder.encode(
      JSON.stringify({ incarnationRef: binding.incarnationRef, intent: "ANCHOR" }),
    ),
    targetAggregateId: aggregateId,
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED";
}
