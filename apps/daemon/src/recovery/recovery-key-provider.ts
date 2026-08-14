import type { SqliteEventStore } from "@moe/store";

import { anchorIncarnation } from "./recovery-incarnation-anchor.js";
import { createRecoveryIncarnationService } from "./recovery-incarnation.js";
import type {
  RecoveryIncarnationCryptoPort, RecoveryIncarnationKeyHandle, RestoreIncarnationBinding,
} from "./recovery-incarnation-contract.js";
import {
  commitSuccessionRecord, readKeyEpochPointer, readRecordedSuccessor, writeKeyEpochPointer,
} from "./recovery-key-epoch-store.js";
import {
  KEY_EPOCH_INPUT_INVALID, KEY_EPOCH_POINTER_UNREADABLE, RECOVERY_KEY_EPOCH_SCHEMA_VERSION,
  asProviderRefusal, protectionUnavailable, snapshotKeyEpochRequest,
} from "./recovery-key-provider-contract.js";
import type {
  RecoveryKeyEpochRequest, RecoveryKeyEpochResult, RecoveryKeyProtection,
  RecoveryKeyProviderPort, RecoveryKeyProviderRefused, RecoveryKeyProviderService,
} from "./recovery-key-provider-contract.js";
import {
  mintSuccessor, proveSuccession, readSuccessionChain, verifyAnchoredPredecessor,
} from "./recovery-succession.js";
import {
  SUCCESSION_ALREADY_RECORDED, SUCCESSION_ANCHOR_UNAVAILABLE, SUCCESSION_PROOF_UNAVAILABLE,
} from "./recovery-succession-contract.js";

export { createNodeRecoveryKeyProviderPort } from "./recovery-key-provider.node.js";
export * from "./recovery-key-provider-contract.js";

/**
 * Supplies the durable, OS-protected recovery key epoch that
 * `recovery-incarnation.ts:56-61` says must exist before anything may claim
 * crash-resume: "nothing here is durable ... A later controller must supply a
 * protected durable key provider".
 *
 * WHAT SURVIVES A PROCESS DEATH IS THE EPOCH IDENTITY, NEVER THE KEY. The
 * private key is non-extractable and dies with its process by design, so the
 * durable artifact is the anchored RECORD — public SPKI, refs, proofs — and
 * "reopen the same epoch" means resolve the same ORIGIN incarnation and prove an
 * unbroken chain to it. Every open therefore RE-MINTS a key and proves
 * succession from the predecessor; a build that returned the old key would be
 * resurrection, which is why the origin and the SPKI are asserted separately.
 *
 * Composition, not a parallel mechanism: `verifyAnchoredPredecessor`,
 * `mintSuccessor`, `proveSuccession` and `readSuccessionChain` are the landed
 * succession surface, and `readSuccessionChain` — not this module — is the
 * authority on the epoch's origin. Zero host-specific code lives here; all
 * platform work is behind `RecoveryKeyProviderPort`.
 */
interface Successor {
  readonly binding: RestoreIncarnationBinding;
  readonly keyHandle: RecoveryIncarnationKeyHandle;
}

interface Established {
  readonly generation: number; readonly opening: "MINTED" | "REOPENED";
  readonly originIncarnationRef: string; readonly successor: Successor;
}

/** Cleanup failure never replaces the primary result it was cleaning up after. */
const discard = (crypto: RecoveryIncarnationCryptoPort, handle: RecoveryIncarnationKeyHandle) => {
  try {
    crypto.destroy(handle);
  } catch {
    /* best effort */
  }
};

/**
 * The pointer says where the epoch WAS; the succession records say where it
 * actually got to. Following them forward heals a crash between the succession
 * commit and the pointer advance. A revisited ref is a cycle — a damaged log,
 * not a newer head.
 */
function resolveHead(store: SqliteEventStore, head: string): string | null {
  const visited = new Set([head]);
  for (let current = head; ; ) {
    const recorded = readRecordedSuccessor(store, current);
    if (recorded === null) return current;
    if (visited.has(recorded.successorIncarnationRef)) return null;
    visited.add(recorded.successorIncarnationRef);
    current = recorded.successorIncarnationRef;
  }
}

export function createRecoveryKeyProvider(
  crypto: RecoveryIncarnationCryptoPort,
  port: RecoveryKeyProviderPort,
): RecoveryKeyProviderService {
  /**
   * A protection fault is a typed UNKNOWN and NEVER a success. This provider
   * exists so that something downstream may claim crash-resume; downgrading an
   * unprotected or unverified host to an optimistic pass would launder that
   * claim through this layer — the one failure the task forbids outright. A
   * THROWING port is an unknown host, not an absent one, and the platform is
   * read from the port so the refusal still names the real host.
   */
  const protect = async (
    request: RecoveryKeyEpochRequest,
  ): Promise<RecoveryKeyProtection | RecoveryKeyProviderRefused> => {
    let answer;
    try {
      answer = await port.protect(request.protectedDirectory);
    } catch {
      return asProviderRefusal(protectionUnavailable(port.platform));
    }
    return answer.ok ? answer : asProviderRefusal(answer);
  };

  const mintFresh = async (
    store: SqliteEventStore,
    request: RecoveryKeyEpochRequest,
  ): Promise<Established | RecoveryKeyEpochResult> => {
    const minted = await createRecoveryIncarnationService(crypto).mint({
      backupGenerationDigest: request.backupGenerationDigest,
      restoreCommandId: request.restoreCommandId,
    });
    // The mint's own codes belong to its layer; from here the fault is that no
    // provable epoch could be established, exactly as `mintSuccessor` maps it.
    if (!minted.ok) return SUCCESSION_PROOF_UNAVAILABLE;
    if (!anchorIncarnation(store, request, minted.binding)) {
      discard(crypto, minted.keyHandle);
      return SUCCESSION_ANCHOR_UNAVAILABLE;
    }
    return {
      generation: 0, opening: "MINTED" as const,
      originIncarnationRef: minted.binding.incarnationRef,
      successor: { binding: minted.binding, keyHandle: minted.keyHandle },
    };
  };

  /**
   * ANCHOR, RECORD, THEN ADVANCE — the crash-safe order `recovery-succession.ts`
   * documents, extended by one write. A death between any two steps is
   * recoverable: an orphaned anchor is never referenced, and a recorded
   * succession whose pointer never advanced is picked up by `resolveHead`.
   */
  const succeedFrom = async (
    store: SqliteEventStore,
    request: RecoveryKeyEpochRequest,
    head: string,
  ): Promise<Successor | RecoveryKeyEpochResult> => {
    const predecessor = await verifyAnchoredPredecessor(crypto, store, request.projectId, head);
    if ("ok" in predecessor) return predecessor;
    const { backupGenerationDigest, restoreCommandId } = request;
    const successor = await mintSuccessor(crypto, restoreCommandId, backupGenerationDigest);
    if ("ok" in successor) return successor;
    let keep = false;
    try {
      if (!anchorIncarnation(store, request, successor.binding)) {
        return SUCCESSION_ANCHOR_UNAVAILABLE;
      }
      const record = await proveSuccession(crypto, predecessor, successor);
      if ("ok" in record) return record;
      if (!commitSuccessionRecord(store, request, record)) return SUCCESSION_ALREADY_RECORDED;
      keep = true;
      return successor;
    } finally {
      if (!keep) discard(crypto, successor.keyHandle);
    }
  };

  /**
   * `readSuccessionChain` is the authority on the origin, not the pointer. When
   * the two disagree the pointer has drifted, and a drifted pointer is refused
   * rather than believed — believing it would rename the epoch identity that
   * everything downstream fences against.
   */
  const finish = (
    store: SqliteEventStore,
    request: RecoveryKeyEpochRequest,
    protection: RecoveryKeyProtection,
    established: Established,
  ): RecoveryKeyEpochResult => {
    const { binding, keyHandle } = established.successor;
    const chain = readSuccessionChain(store, request.projectId, binding.incarnationRef);
    if (!chain.ok) return chain;
    if (chain.originIncarnationRef !== established.originIncarnationRef) {
      return KEY_EPOCH_POINTER_UNREADABLE;
    }
    return Object.freeze(
      Object.defineProperty(
        {
          authority: "NONE" as const, chainLength: chain.links.length,
          generation: established.generation, incarnationRef: binding.incarnationRef,
          keyEpochRef: binding.keyEpochRef, keyHandle, ok: true as const,
          opening: established.opening,
          originIncarnationRef: established.originIncarnationRef,
          outcome: "OPENED" as const, protection,
          publicKeySpkiHex: binding.publicKeySpkiHex,
          restoreCommandId: binding.restoreCommandId,
          verificationKeyFingerprint: binding.verificationKeyFingerprint,
        },
        "keyHandle",
        { enumerable: false, value: keyHandle },
      ),
    );
  };

  const establish = async (
    store: SqliteEventStore,
    request: RecoveryKeyEpochRequest,
  ): Promise<Established | RecoveryKeyEpochResult> => {
    const read = readKeyEpochPointer(store, request.projectId, request.restoreCommandId);
    // UNREADABLE is refused, never treated as ABSENT: minting a second epoch for
    // one restore command is the fork this whole chain exists to prevent.
    if (read.state === "UNREADABLE") return KEY_EPOCH_POINTER_UNREADABLE;
    if (read.state === "ABSENT") return mintFresh(store, request);

    const { pointer } = read;
    const head = resolveHead(store, pointer.headIncarnationRef);
    if (head === null) return KEY_EPOCH_POINTER_UNREADABLE;
    const successor = await succeedFrom(store, request, head);
    if (!("binding" in successor)) return successor;
    return {
      generation: pointer.generation + 1, opening: "REOPENED" as const,
      originIncarnationRef: pointer.originIncarnationRef, successor,
    };
  };

  const open = async (store: SqliteEventStore, input: unknown): Promise<RecoveryKeyEpochResult> => {
    // Nothing a caller supplies is evidence: a request carrying a predecessor,
    // an epoch or a handle is refused rather than trimmed, for the reason
    // recovery-incarnation.ts:53-56 gives — each would let someone holding the
    // backup predict or replay the fence.
    const request = snapshotKeyEpochRequest(input);
    if (request === null) return KEY_EPOCH_INPUT_INVALID;
    const protection = await protect(request);
    if (!protection.ok) return protection;

    const established = await establish(store, request);
    if (!("successor" in established)) return established;
    const advanced = writeKeyEpochPointer(store, request, {
      generation: established.generation,
      headIncarnationRef: established.successor.binding.incarnationRef,
      originIncarnationRef: established.originIncarnationRef,
      restoreCommandId: request.restoreCommandId,
      schemaVersion: RECOVERY_KEY_EPOCH_SCHEMA_VERSION,
    });
    if (!advanced) {
      discard(crypto, established.successor.keyHandle);
      return SUCCESSION_ALREADY_RECORDED;
    }
    const epoch = finish(store, request, protection, established);
    if (!epoch.ok) discard(crypto, established.successor.keyHandle);
    return epoch;
  };

  return Object.freeze({ open });
}
