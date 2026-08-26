/**
 * THE STRICT RE-READS A FINALIZATION MAKES, and nothing else.
 *
 * Split out of `./attempt-finalization-service.js` so the composition stays
 * readable beside the four questions it asks: WHICH attempt, WHICH receipt,
 * WHAT the producers currently say, and WHETHER the attempt's own streams moved
 * while they were being asked. Each answer comes from the producer that owns it
 * and every refusal carries THAT producer's code and layer, never this layer's.
 */

import type { SqliteEventStore } from "@moe/store";

import { readCurrentAttemptJournal } from "../journal/journal-reader.js";
import { readStoredReceipt } from "../evidence/foundation-verification-store.js";
import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { refuseFinalization, sourceOf } from "./attempt-finalization-contracts.js";
import type { AttemptFinalizationRefused } from "./attempt-finalization-contracts.js";
import { readCurrentSafeBoundaryObservation } from "./attempt-safe-boundary-lookup.js";
import { deriveSafeBoundary } from "./attempt-release-boundary.js";
import { deriveSchedulerHandoff } from "./attempt-release-handoff.js";
import { durableActivation } from "./attempt-release-store.js";
import { deriveReleaseTerminal } from "./attempt-release-terminal.js";
import { deriveDispatchAggregateId } from "./foundation-attempt-codec.js";
import { readFoundationAttemptRecord } from "./foundation-attempt-store.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";

/** The SERVER's decision identity. No field of it is readable from the payload. */
export interface FinalizationIdentity {
  readonly commandId: string; readonly correlationId: string;
  readonly principalId: string; readonly projectId: string;
}

/** Only a PASSED receipt earns the resumable reason, exactly as only a PROVEN
 *  settle did on the live path. A FAILED verification releases as a cancel. */
const REASON_OF = Object.freeze({
  FAILED: "WORK_CANCEL", PASSED: "WORK_RELEASE_OR_PAUSE",
} as const);

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** The attempt's OWN two streams. Movement anywhere else is not this attempt's
 *  business, and a global horizon would make it so. */
export function attemptVersions(store: SqliteEventStore, bound: FoundationAttemptBound): string | null {
  try {
    return `${String(store.readEvents(bound.aggregateId).length)}:`
      + `${String(store.readEvents(bound.target).length)}`;
  } catch { return null; }
}

export interface Selected {
  readonly bound: FoundationAttemptBound;
  readonly durable: ActivationLedgerRecord;
}

/**
 * The bound attempt, rebuilt from DURABLE bytes plus the server's own decision
 * identity. `nodeKey` and `sessionId` come off the attempt record the dispatch
 * sealed; `claim` is deliberately EMPTY because the release path reads none and
 * a fabricated one would be a durable audit field asserting something nothing
 * observed.
 */
export function selectAttempt(
  store: SqliteEventStore, who: FinalizationIdentity, attemptAggregateId: string,
): Selected | AttemptFinalizationRefused {
  const stored = readFoundationAttemptRecord(store, attemptAggregateId);
  if (!stored.ok) {
    return refuseFinalization("ATTEMPT_FINALIZATION_ATTEMPT_UNREADABLE", sourceOf(stored));
  }
  const { nodeKey, sessionId } = stored.record;
  if (!text(nodeKey) || !text(sessionId)) {
    return refuseFinalization("ATTEMPT_FINALIZATION_ATTEMPT_UNREADABLE", {
      code: "FOUNDATION_ATTEMPT_RECORD_INCOMPLETE", layer: "DAEMON_FOUNDATION_ATTEMPT",
    });
  }
  const bound: FoundationAttemptBound = Object.freeze({
    aggregateId: attemptAggregateId, claim: Object.freeze({}),
    commandId: `${who.commandId}:FINALIZE`, correlationId: `${who.correlationId}:FINALIZE`,
    nodeKey, principalId: who.principalId, projectId: who.projectId, sessionId,
    target: deriveDispatchAggregateId(attemptAggregateId),
  });
  const durable = durableActivation(store, bound);
  if ("ok" in durable) {
    return refuseFinalization("ATTEMPT_FINALIZATION_ATTEMPT_UNREADABLE", sourceOf(durable));
  }
  return { bound, durable };
}

export interface VerifiedReceipt {
  readonly receiptRef: string; readonly receiptSha256: string;
  readonly reason: string;
}

/**
 * THE ORDERING GATE. Nothing downstream runs until a durable receipt for THIS
 * attempt has been re-decoded, re-encoded and byte-compared by
 * `readStoredReceipt`, and until the row carries the paired `receiptSha256` a
 * later drift check needs. Only then is `verificationId` adopted as the core
 * receipt reference.
 */
export function verifiedReceipt(
  store: SqliteEventStore, attemptAggregateId: string, verificationId: string,
): VerifiedReceipt | AttemptFinalizationRefused {
  const stored = readStoredReceipt(store, verificationId);
  if (!stored.ok) {
    return refuseFinalization("ATTEMPT_FINALIZATION_RECEIPT_UNVERIFIED", sourceOf(stored));
  }
  const sha = stored.row["receiptSha256"];
  if (stored.authority !== "PROVEN_RECEIPT" || !text(sha)) {
    return refuseFinalization("ATTEMPT_FINALIZATION_RECEIPT_UNVERIFIED", {
      code: "FOUNDATION_VERIFICATION_RECEIPT_UNSEALED", layer: "DAEMON_VERIFICATION_RECEIPT",
    });
  }
  // A receipt naming ANOTHER attempt, or answering under another id, is FOREIGN —
  // never silently accepted as this attempt's proof.
  if (stored.row["attemptAggregateId"] !== attemptAggregateId
    || stored.row["verificationId"] !== verificationId) {
    return refuseFinalization("ATTEMPT_FINALIZATION_RECEIPT_FOREIGN", {
      code: "FOUNDATION_VERIFICATION_RECEIPT_IDENTITY_MISMATCH",
      layer: "DAEMON_VERIFICATION_RECEIPT",
    });
  }
  const verdict = stored.verdict;
  return { reason: REASON_OF[verdict], receiptRef: verificationId, receiptSha256: sha };
}

/** The five strict re-reads DoD 1 names, each through its owning producer. On
 *  agreement it answers the producer-owned `observationRef`; otherwise the wrapper
 *  naming which stage declined, carrying that producer's own code and layer. */
export function reReadSources(
  store: SqliteEventStore, bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
): { readonly observationRef: string } | AttemptFinalizationRefused {
  const journal = readCurrentAttemptJournal(store, durable.activationDigest, bound.projectId);
  if (!journal.ok) {
    return refuseFinalization("ATTEMPT_FINALIZATION_JOURNAL_UNRESOLVED", sourceOf(journal));
  }
  // THE BOUNDARY: LOOK IT UP FIRST, AND ASK THE PRODUCER ONLY IF NOTHING STANDS.
  //
  // THE ORDER IS LOAD-BEARING AND IT WAS MEASURED, NOT GUESSED.
  // `recordSafeBoundaryObservation` commits at `expectedVersion: 0` on a
  // ref-derived aggregate, so a re-observation under a DIFFERENT decision key is
  // refused SAFE_BOUNDARY_COMMIT_CONFLICT — and a finalization running after the
  // live dispatch path already observed this attempt necessarily carries a
  // different key. Asking the producer unconditionally would therefore refuse
  // exactly the sequence this row exists to serve. Looking up first also keeps
  // the common path READ-ONLY: no write happens on any boundary refusal.
  const query = { attemptRef: durable.attempt.attemptId, projectId: bound.projectId };
  let boundary = readCurrentSafeBoundaryObservation(store, query);
  if (!boundary.ok && boundary.code === "SAFE_BOUNDARY_LOOKUP_ABSENT") {
    // Never observed. `deriveSafeBoundary` is the PRODUCER — it reads the durable
    // provider-run record and applies its own predicate — and it is keyed on this
    // bound attempt, so the release below replays that exact row rather than
    // composing a second. A run the host never recorded refuses under ITS code.
    const observed = deriveSafeBoundary(store, bound, durable);
    if (!observed.ok) {
      return refuseFinalization("ATTEMPT_FINALIZATION_BOUNDARY_UNRESOLVED", sourceOf(observed));
    }
    boundary = readCurrentSafeBoundaryObservation(store, query);
  }
  // The producer-owned `observationRef` the release carrier discards. The lookup
  // scans the producer's own vocabulary and delegates validation back to
  // `readSafeBoundaryObservation`; nothing here recomputes a ref.
  if (!boundary.ok) {
    return refuseFinalization(
      "ATTEMPT_FINALIZATION_BOUNDARY_UNRESOLVED", boundary.source ?? sourceOf(boundary));
  }
  const terminal = deriveReleaseTerminal(store, bound, durable);
  if (!terminal.ok) {
    return refuseFinalization("ATTEMPT_FINALIZATION_TERMINAL_UNRESOLVED", sourceOf(terminal));
  }
  // THE SCHEDULER'S NINE-KEY CHECKPOINT, asked for as a precondition and DISCARDED:
  // `recordAttemptRelease` builds its own from the same durable facts. Handing this
  // value onward would make a value composed HERE the kernel's authority.
  const scheduler = deriveSchedulerHandoff(store, bound, durable);
  if (!scheduler.ok) {
    return refuseFinalization("ATTEMPT_FINALIZATION_HANDOFF_UNRESOLVED", sourceOf(scheduler));
  }
  return { observationRef: boundary.observationRef };
}
