import type { SqliteEventStore } from "@moe/store";

import { attemptPort, digestOf } from "./recovery-incarnation-contract.js";
import type {
  RecoveryIncarnationBinding,
  RecoveryIncarnationCryptoPort,
  RecoveryIncarnationKeyHandle,
} from "./recovery-incarnation-contract.js";
import { createRecoveryIncarnationService } from "./recovery-incarnation.js";
import { anchorIncarnation, readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import {
  RECOVERY_SUCCESSION_COMMAND_KIND,
  RECOVERY_SUCCESSION_SCHEMA_VERSION,
  SUCCESSION_ALREADY_RECORDED,
  SUCCESSION_ANCHOR_UNAVAILABLE,
  SUCCESSION_INPUT_INVALID,
  SUCCESSION_PREDECESSOR_NOT_FOUND,
  SUCCESSION_PREDECESSOR_UNVERIFIABLE,
  SUCCESSION_PROOF_UNAVAILABLE,
  decodeSuccessionRecord,
  snapshotSuccessionRequest,
  successionAggregateId,
} from "./recovery-succession-contract.js";
import type {
  RecoverySuccessionChainResult,
  RecoverySuccessionRecord,
  RecoverySuccessionRefused,
  RecoverySuccessionRequest,
  RecoverySuccessionResult,
  RecoverySuccessionService,
} from "./recovery-succession-contract.js";

// Re-published so callers see ONE module, exactly as the incarnation service
// does for its own contract. Packed to spend fewer physical lines here.
export {
  RECOVERY_SUCCESSION_ERROR_CODES, RECOVERY_SUCCESSION_LAYER,
  RECOVERY_SUCCESSION_SCHEMA_VERSION,
  type RecoverySuccessionChain, type RecoverySuccessionChainResult,
  type RecoverySuccessionErrorCode, type RecoverySuccessionRecord,
  type RecoverySuccessionRecorded, type RecoverySuccessionRefused,
  type RecoverySuccessionRequest, type RecoverySuccessionResult,
  type RecoverySuccessionService,
} from "./recovery-succession-contract.js";

/**
 * Proves that a named predecessor incarnation is one this project actually
 * observed, using only what outlives its process.
 *
 * The predecessor's private key is gone by design, so nothing here asks it to
 * sign. Everything below is checkable from durable public bytes, which is the
 * whole reason a crashed incarnation can still be succeeded.
 */
export async function verifyAnchoredPredecessor(
  port: RecoveryIncarnationCryptoPort,
  store: SqliteEventStore,
  projectId: string,
  predecessorIncarnationRef: string,
): Promise<RecoveryIncarnationBinding | RecoverySuccessionRefused> {
  // 1. Existence is a DURABLE fact, never a caller assertion. A binding that
  //    was minted but never anchored is indistinguishable from one a caller
  //    minted a moment ago purely to claim succession from it.
  const binding = readAnchoredIncarnation(store, projectId, predecessorIncarnationRef);
  if (binding === null) return SUCCESSION_PREDECESSOR_NOT_FOUND;

  // 2. The proof must cover THIS binding. A proof lifted from another genuine
  //    binding verifies perfectly in isolation under its own key; recomputing
  //    the challenge from this binding's digest is the only thing that catches
  //    it, which is why this runs before the signature is ever checked.
  if (digestOf("challenge", binding.bindingDigest) !== binding.proof.challengeDigest) {
    return SUCCESSION_PREDECESSOR_UNVERIFIABLE;
  }

  const publicKeySpki = Buffer.from(binding.publicKeySpkiHex, "hex");
  // 3. The fingerprint must cover the key the binding actually published.
  //    Without this a binding could name a fingerprint from one key epoch while
  //    carrying another's public key, and the signature check below would still
  //    pass against the key that is really there.
  if (digestOf("key", publicKeySpki) !== binding.verificationKeyFingerprint) {
    return SUCCESSION_PREDECESSOR_UNVERIFIABLE;
  }

  // 4. Finally the signature itself, through the same port a consumer would
  //    use. `!== true` rather than falsiness, matching the mint service, so a
  //    port answering with a truthy non-boolean never authorizes a succession.
  const verified = await attemptPort(() =>
    port.verify(
      publicKeySpki,
      Buffer.from(binding.proof.challengeDigest, "hex"),
      Buffer.from(binding.proof.signatureHex, "hex"),
    ),
  );
  if (verified !== true) return SUCCESSION_PREDECESSOR_UNVERIFIABLE;
  return binding;
}

/** What a mint hands back: the published binding plus the process-local handle. */
interface Successor {
  readonly binding: RecoveryIncarnationBinding;
  readonly keyHandle: RecoveryIncarnationKeyHandle;
}

/**
 * Mints the successor through the EXISTING incarnation service. No second key
 * lifecycle: a parallel minter would be a second source of truth for
 * incarnation identity and would drift from the first.
 */
export async function mintSuccessor(
  port: RecoveryIncarnationCryptoPort,
  restoreCommandId: string,
  backupGenerationDigest: string,
): Promise<Successor | RecoverySuccessionRefused> {
  const minted = await createRecoveryIncarnationService(port).mint({
    backupGenerationDigest,
    restoreCommandId,
  });
  // The mint's own refusal codes belong to its layer, not this one. A successor
  // that could not be minted leaves this layer with no proof to offer.
  if (!minted.ok) return SUCCESSION_PROOF_UNAVAILABLE;
  return { binding: minted.binding, keyHandle: minted.keyHandle };
}

/**
 * Builds the statement linking the two incarnations and has the SUCCESSOR sign
 * it. The predecessor cannot sign — its key died with its process — and is
 * never asked to; that asymmetry is the point of the whole design.
 *
 * `digestOf` is domain-separated and length-framed, which is what makes hashing
 * six refs in one call safe: without framing a caller able to steer one ref
 * could slide the boundary and land on another statement's digest.
 */
export async function proveSuccession(
  port: RecoveryIncarnationCryptoPort,
  predecessor: RecoveryIncarnationBinding,
  successor: Successor,
): Promise<RecoverySuccessionRecord | RecoverySuccessionRefused> {
  const successionDigest = digestOf(
    "succession",
    predecessor.incarnationRef,
    predecessor.keyEpochRef,
    predecessor.bindingDigest,
    successor.binding.incarnationRef,
    successor.binding.keyEpochRef,
    successor.binding.bindingDigest,
  );
  const challengeDigest = digestOf("succession-challenge", successionDigest);
  // The RAW 32 bytes of the hex-decoded digest are signed, never the hex text,
  // matching what the mint service signs.
  const challenge = Buffer.from(challengeDigest, "hex");

  const signed = await attemptPort(() => port.sign(successor.keyHandle, challenge));
  if (!(signed instanceof Uint8Array) || signed.byteLength === 0) {
    return SUCCESSION_PROOF_UNAVAILABLE;
  }
  // Copied for the same reason the mint copies: the bytes that get verified must
  // be the bytes that get published, and the port still holds a reference.
  const signature = Uint8Array.from(signed);
  const verified = await attemptPort(() =>
    port.verify(Buffer.from(successor.binding.publicKeySpkiHex, "hex"), challenge, signature),
  );
  if (verified !== true) return SUCCESSION_PROOF_UNAVAILABLE;

  return Object.freeze({
    predecessorBindingDigest: predecessor.bindingDigest,
    predecessorIncarnationRef: predecessor.incarnationRef,
    predecessorKeyEpochRef: predecessor.keyEpochRef,
    predecessorVerificationKeyFingerprint: predecessor.verificationKeyFingerprint,
    proof: Object.freeze({
      challengeDigest,
      signatureHex: Buffer.from(signature).toString("hex"),
      verified: true as const,
    }),
    // Read from the minted binding rather than echoed from the request, so the
    // record names the command the successor was actually minted for.
    restoreCommandId: successor.binding.restoreCommandId,
    schemaVersion: RECOVERY_SUCCESSION_SCHEMA_VERSION,
    successionDigest,
    successorBindingDigest: successor.binding.bindingDigest,
    successorIncarnationRef: successor.binding.incarnationRef,
    successorKeyEpochRef: successor.binding.keyEpochRef,
  });
}

/** Cleanup failure never replaces the primary result it was cleaning up after. */
function discardHandle(
  port: RecoveryIncarnationCryptoPort,
  handle: RecoveryIncarnationKeyHandle,
): void {
  try {
    port.destroy(handle);
  } catch {
    /* best effort */
  }
}

const PAGE_SIZE = 100;
const encoder = new TextEncoder();

function readSuccessionRecords(
  store: SqliteEventStore,
  projectId: string,
): ReadonlyMap<string, RecoverySuccessionRecord> {
  const records = new Map<string, RecoverySuccessionRecord>();
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId) continue;
      if (decision.commandKind !== RECOVERY_SUCCESSION_COMMAND_KIND) continue;
      if (decision.effectDisposition !== "EFFECTS_COMMITTED") continue;
      const record = decodeSuccessionRecord(decision.resultBytes);
      if (record === null) continue;
      // The aggregate is keyed on the PREDECESSOR, so a row filed under one
      // predecessor while naming another is dropped rather than indexed.
      if (decision.targetAggregateId !== successionAggregateId(record.predecessorIncarnationRef)) {
        continue;
      }
      records.set(record.successorIncarnationRef, record);
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return records;
}

/**
 * Walks backwards from a current incarnation to the origin the whole chain
 * descends from, newest link first.
 *
 * The originating restore command is read from the ANCHORED ORIGIN BINDING, not
 * from the newest record, which is reachable precisely because every incarnation
 * on the chain was anchored as it was minted.
 */
export function readSuccessionChain(
  store: SqliteEventStore,
  projectId: string,
  fromIncarnationRef: string,
): RecoverySuccessionChainResult {
  if (readAnchoredIncarnation(store, projectId, fromIncarnationRef) === null) {
    return SUCCESSION_PREDECESSOR_NOT_FOUND;
  }
  const bySuccessor = readSuccessionRecords(store, projectId);
  const links: RecoverySuccessionRecord[] = [];
  const visited = new Set<string>([fromIncarnationRef]);
  let current = fromIncarnationRef;
  for (;;) {
    const link = bySuccessor.get(current);
    if (link === undefined) break;
    // The single-shot write makes a cycle unreachable today. A read path that
    // trusts a write invariant it does not itself enforce is one bad row away
    // from hanging the daemon at startup, so it is enforced here too.
    if (visited.has(link.predecessorIncarnationRef)) return SUCCESSION_ALREADY_RECORDED;
    visited.add(link.predecessorIncarnationRef);
    links.push(link);
    current = link.predecessorIncarnationRef;
  }
  const origin = readAnchoredIncarnation(store, projectId, current);
  if (origin === null) return SUCCESSION_PREDECESSOR_NOT_FOUND;
  return Object.freeze({
    links: Object.freeze(links),
    ok: true as const,
    originIncarnationRef: current,
    restoreCommandId: origin.restoreCommandId,
  });
}

/**
 * Records the succession, single-shot. `expectedVersion: 0` on an aggregate
 * keyed on the PREDECESSOR is the enforcement: the store itself refuses the
 * second succession from one incarnation, so the chain cannot fork and two
 * callers cannot both claim to succeed it.
 *
 * No try/catch: the version conflict is RETURNED as a NO_BUSINESS_EFFECT
 * decision, and a catch-all would also swallow a real store fault and report it
 * as a benign duplicate.
 */
function commitSuccession(
  store: SqliteEventStore,
  request: RecoverySuccessionRequest,
  record: RecoverySuccessionRecord,
): boolean {
  const bytes = encoder.encode(JSON.stringify(record));
  // The command id names BOTH ends while the aggregate names only the
  // predecessor. That split is deliberate: the ledger raises
  // IDEMPOTENCY_CONFLICT — a throw — when one command id is reused for
  // different request bytes, and it raises it BEFORE the expected-version
  // check. A predecessor-only id would therefore make a rival successor throw
  // instead of returning the conflict this layer maps to ALREADY_RECORDED,
  // while an identical retry still replays cleanly under its own id.
  const commandId = `recovery-succeed:${record.predecessorIncarnationRef}:${record.successorIncarnationRef}`;
  const response = store.commitExpectedVersionDecision({
    commandKind: RECOVERY_SUCCESSION_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [
      { eventId: `${commandId}:recorded`, eventType: "RecoverySuccessionRecorded", payload: bytes },
    ],
    expectedVersion: 0,
    key: { commandId, principalId: request.principalId, projectId: request.projectId },
    requestBytes: encoder.encode(
      JSON.stringify({
        predecessorIncarnationRef: record.predecessorIncarnationRef,
        successorIncarnationRef: record.successorIncarnationRef,
      }),
    ),
    targetAggregateId: successionAggregateId(record.predecessorIncarnationRef),
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED";
}

/**
 * Establishes a fresh incarnation after a crash and proves durably that it
 * succeeds the interrupted one.
 *
 * ANCHOR BEFORE SUCCEED is the safe crash order and is not an implementation
 * detail. A crash between the two writes leaves an anchored incarnation with no
 * succession record, which is recoverable: the next run simply retries. The
 * reverse order would leave a succession record pointing at an incarnation that
 * was never anchored — a dangling reference the predecessor check would refuse
 * forever, with no way to repair it.
 */
export function createRecoverySuccessionService(
  port: RecoveryIncarnationCryptoPort,
): RecoverySuccessionService {
  const succeed = async (
    store: SqliteEventStore,
    input: unknown,
  ): Promise<RecoverySuccessionResult> => {
    const request = snapshotSuccessionRequest(input);
    if (request === null) return SUCCESSION_INPUT_INVALID;

    const predecessor = await verifyAnchoredPredecessor(
      port,
      store,
      request.projectId,
      request.predecessorIncarnationRef,
    );
    if ("ok" in predecessor) return predecessor;

    const successor = await mintSuccessor(
      port,
      request.restoreCommandId,
      request.backupGenerationDigest,
    );
    if ("ok" in successor) return successor;

    // The handle is process-local and is never returned, so it is destroyed on
    // every path below — a failure must not leave key material alive longer
    // than a success does.
    try {
      if (!anchorIncarnation(store, request, successor.binding)) {
        return SUCCESSION_ANCHOR_UNAVAILABLE;
      }
      const record = await proveSuccession(port, predecessor, successor);
      if ("ok" in record) return record;
      if (!commitSuccession(store, request, record)) return SUCCESSION_ALREADY_RECORDED;
      return Object.freeze({
        authority: "NONE" as const,
        ok: true as const,
        outcome: "SUCCEEDED" as const,
        record,
      });
    } finally {
      discardHandle(port, successor.keyHandle);
    }
  };

  return Object.freeze({ succeed });
}
