/**
 * THE AUTHENTICATED POST-VERIFICATION FINALIZATION PATH (task-48c79a29).
 *
 * THE ORDERING IS THE FIX, AND IT IS THE WHOLE ROW. The live Foundation result
 * path calls `recordAttemptRelease` SYNCHRONOUSLY, before any
 * `foundation.verification` receipt exists — so the core `{digest, ref}` binding
 * it composes NECESSARILY carries `receipt: null` on that ordering, and a
 * downstream that needs a verified release has nothing to read. This module runs
 * AFTER the receipt is durable, so a RELEASED row and a receipt-BEARING binding
 * CO-OCCUR. The binding is never patched afterwards: back-filling a receipt onto
 * a receipt-null row would make an unverified binding indistinguishable from a
 * verified one, which is exactly the confusion the field exists to prevent.
 *
 * IT ADDS NO WRITER. `recordAttemptRelease` remains the one release writer and
 * `recordReleaseHandoffBinding` the one binding writer; this module RE-READS and
 * then invokes them. Nothing here re-derives a boundary, a terminality, a digest
 * or a handoff — each question is asked of the producer that owns it, and every
 * refusal travels out under THAT producer's code and layer beneath a wrapper
 * naming which stage declined.
 *
 * THE CALLER SELECTS IDENTITIES AND NOTHING ELSE. Seven authority categories —
 * release, truth, terminal, receipt, observation, digest, handoff — are refused
 * STRUCTURALLY by the exact-arity allow-list in `./attempt-finalization-contracts.js`,
 * before a single store read. The decision identity (`projectId`, `principalId`,
 * `commandId`, `correlationId`) is the SERVER's, handed in by the command seam.
 *
 * THE RECEIPT IS ADOPTED ONLY AFTER ITS BYTES ARE CHECKED. `readStoredReceipt`
 * re-decodes, re-encodes and byte-compares the durable row; only then is its
 * `verificationId` taken as the core receipt reference, and only when the row
 * carries the paired `receiptSha256` that keeps drift detectable later. A receipt
 * trusted before its byte check is a receipt in name only.
 *
 * TWO HANDOFFS, NEVER SHAPE-CAST. The scheduler's NINE-key `ReleaseHandoff` and
 * core's TWO-key `ExpansionHandoffBinding` share a word and nothing else —
 * different arity, different owner, different consumer. Both are asked for here;
 * neither is derived from the other.
 *
 * ONE HORIZON, AGGREGATE-SCOPED. The attempt's own activation and dispatch
 * aggregates are measured before the strict re-reads and again after them: those
 * are the only streams whose movement can invalidate what was just read. A global
 * `readEventHorizon` guard would move on ANY unrelated write and refuse nearly
 * every finalization on a busy daemon — green in a quiet test, useless in
 * production.
 */

import type { SqliteEventStore } from "@moe/store";

import { ATTEMPT_FINALIZATION_LAYER, admitFinalizationRequest, refuseFinalization, sourceOf }
  from "./attempt-finalization-contracts.js";
import type {
  AttemptFinalizationOutcomeName, AttemptFinalizationRefused, FinalizationSource,
} from "./attempt-finalization-contracts.js";
import {
  attemptVersions, reReadSources, selectAttempt, verifiedReceipt,
} from "./attempt-finalization-sources.js";
import type { AttemptVersions, FinalizationIdentity } from "./attempt-finalization-sources.js";
import { recordAttemptRelease } from "./attempt-release-disposition.js";
import { readAttemptRelease } from "./attempt-release-store.js";
import { readReleaseHandoffBinding } from "./release-handoff-binding.js";
import type { ReleaseHandoffBinding } from "./release-handoff-binding.js";

export { ATTEMPT_FINALIZATION_LAYER };
export type { FinalizationIdentity };

export interface AttemptFinalizationAnswer {
  /** The binding as the store holds it, re-read — never the value just written. */
  readonly binding: ReleaseHandoffBinding | null;
  readonly observationRef: string;
  readonly ok: true;
  readonly outcome: AttemptFinalizationOutcomeName;
  /** The verified `verificationId`, adopted only after the byte check. */
  readonly receiptRef: string;
  /** PINNED INDEPENDENTLY of `receiptRef`: the ref identifies the row, the sha
   *  detects a row that later stopped covering its own bytes. */
  readonly receiptSha256: string;
  readonly release: Record<string, unknown> | null;
  /** Set only on BINDING_WRITTEN_RELEASE_REFUSED: the kernel's own words. */
  readonly releaseRefusal: FinalizationSource | null;
}
export type AttemptFinalizationOutcome =
  | AttemptFinalizationAnswer | AttemptFinalizationRefused;

function sameAttemptVersions(
  before: AttemptVersions, after: AttemptVersions | null,
): boolean {
  if (after === null) return false;
  return before.every((observation, index) => {
    const current = after[index];
    return current !== undefined
      && current.aggregateId === observation.aggregateId
      && current.slot === observation.slot
      && current.version === observation.version;
  });
}

/**
 * Finalize ONE verified attempt: re-read everything, then invoke the release.
 *
 * REPLAYS ARE IDEMPOTENT. `commitRelease` pins `expectedVersion: 0` so the first
 * release row is the only one the aggregate can hold, and a second call is
 * answered `NO_OP` from that standing row. `recordReleaseHandoffBinding` answers
 * from the row already recorded when its re-derived bytes are identical, so a
 * replay composes no second binding either.
 */
export function finalizeVerifiedAttempt(
  store: SqliteEventStore, who: FinalizationIdentity, request: unknown,
): AttemptFinalizationOutcome {
  const admitted = admitFinalizationRequest(request);
  if (admitted === null) return refuseFinalization("ATTEMPT_FINALIZATION_REQUEST_MALFORMED");
  const { attemptAggregateId, verificationId } = admitted;
  // FIRST, AND BEFORE ANY RELEASE COULD BE ATTEMPTED: the receipt must exist and
  // must byte-verify. This is the ordering the whole module exists to impose.
  const receipt = verifiedReceipt(store, attemptAggregateId, verificationId);
  if ("ok" in receipt) return receipt;
  const selected = selectAttempt(store, who, attemptAggregateId);
  if ("ok" in selected) return selected;
  const { bound, durable } = selected;

  const before = attemptVersions(store, bound);
  if (before === null) {
    return refuseFinalization("ATTEMPT_FINALIZATION_ATTEMPT_UNREADABLE", {
      code: "ATTEMPT_AGGREGATE_UNREADABLE", layer: ATTEMPT_FINALIZATION_LAYER,
    });
  }
  const sources = reReadSources(store, bound, durable);
  if ("ok" in sources) return sources;
  if (!sameAttemptVersions(before, attemptVersions(store, bound))) {
    return refuseFinalization("ATTEMPT_FINALIZATION_HORIZON_MOVED", null);
  }

  // CARRY the first server-owned observation pair. Re-reading here would reopen
  // the finalizer-to-release window this fence exists to close.
  const released = recordAttemptRelease(store, bound, durable, {
    disposition: null, intentRefs: [durable.effectIntent.intentId], reason: receipt.reason,
  }, before);
  const binding = readReleaseHandoffBinding(
    store, { attemptAggregateId, projectId: bound.projectId });
  const answer = {
    binding: binding.ok ? binding.binding : null, observationRef: sources.observationRef,
    ok: true as const, receiptRef: receipt.receiptRef, receiptSha256: receipt.receiptSha256,
  };
  if (released.ok) {
    return Object.freeze({
      ...answer, outcome: released.outcome, release: released.record, releaseRefusal: null,
    });
  }
  // THE FOURTH OUTCOME. A refused release that nonetheless left a binding standing
  // is reported as itself, so an operator can see the inert binding. It is claimed
  // ONLY when the release aggregate is genuinely empty — a refusal that somehow
  // left a row behind is not this outcome and stays a refusal, which is how "no
  // new release authority on a refusal path" is asserted rather than assumed.
  const refusal = sourceOf(released);
  const standing = readAttemptRelease(store, attemptAggregateId);
  if (binding.ok && !standing.ok && standing.code === "ATTEMPT_RELEASE_RECORD_ABSENT") {
    return Object.freeze({
      ...answer, outcome: "BINDING_WRITTEN_RELEASE_REFUSED" as const, release: null,
      releaseRefusal: refusal,
    });
  }
  return refuseFinalization("ATTEMPT_FINALIZATION_RELEASE_REFUSED", refusal);
}
