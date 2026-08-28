import type { ReleaseHandoff } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { refuse } from "./attempt-release-store.js";
import type { AttemptReleaseRefused } from "./attempt-release-store.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import type { AttemptReleaseFenceObservation } from "./attempt-release-fence-legs.js";
import {
  deriveReleaseHandoffAggregateId, recordReleaseHandoffBinding,
} from "./release-handoff-binding.js";
import type {
  HandoffBindingRefused, ReleaseHandoffBinding,
} from "./release-handoff-binding.js";
import { buildReleaseHandoff } from "./release-handoff-builder.js";
import type { ReleaseHandoffRefused } from "./release-handoff-contracts.js";

/**
 * THE RELEASE PATH'S HANDOFF SEAM, shaped exactly like `./attempt-release-boundary.ts`.
 *
 * THREE KEYS ARE RETIRED HERE, and as of task-a20e8ef6 the third is `handoff`.
 * `receiptRef` and `workerHandoff` were never fields a caller could speak on this
 * path; both are DERIVED from durable authority — the worker handoff from the
 * journal `journal.append` folded, the receipt from the verification row
 * `readStoredReceipt` re-reads. `handoff` has now joined them: the nine-key
 * `ReleaseHandoff` the kernel parses (`lease-drain.ts:41`) is SERVER-BUILT from
 * durable Foundation facts by `./release-handoff-builder.js`, so a request that so
 * much as SPELLS the key is REFUSED rather than obeyed. A caller value that happens
 * to agree is refused too: agreement is not authority.
 *
 * IT IS A DIFFERENT OBJECT FROM CORE'S TWO-KEY `{digest, ref}` BINDING and is
 * never projected from it. `deriveHandoffBinding` below produces the CORE one;
 * `deriveSchedulerHandoff` produces the SCHEDULER one. They share this file
 * because they are both "the handoff seam", and nothing else.
 *
 * ORDER: THE SCHEDULER HANDOFF IS BUILT BEFORE THE CORE BINDING IS WRITTEN, so a
 * handoff the server cannot compose costs ZERO rows. The core binding is still
 * derived before the kernel is asked; an inert binding on a refused release is a
 * FACT about what the attempt handed off, not authority — only a consumer that
 * also sees RELEASED may act on it.
 */

const encoder = new TextEncoder();

/** The retired keys. Named ONCE, so the admission and the header cannot drift. */
export const RETIRED_HANDOFF_KEYS: readonly string[] =
  Object.freeze(["handoff", "receiptRef", "workerHandoff"]);

export interface DerivedHandoffBinding {
  /** `null` when the attempt journalled nothing: no evidence, so no binding. */
  readonly binding: ReleaseHandoffBinding | null;
  /**
   * THE BINDING AGGREGATE AS THIS CALL LEFT IT (task-06835dfa), so the release
   * writer can fence it.
   *
   * The binding aggregate is APPENDABLE — `recordReleaseHandoffBinding` writes at
   * `expectedVersion: store.readEvents(aggregateId).length` — and its reader is
   * LATEST WINS. Two release calls can therefore both append a binding before
   * either wins the separate release primary at `expectedVersion: 0`, and the
   * loser's release row would then stand beside a `{digest, ref}` a consumer never
   * reads. Fencing at the version THIS call produced is what makes the release and
   * its own binding one decision.
   *
   * It is READ HERE, immediately after the write, rather than re-read at commit
   * time: a fence at a re-read version certifies a window nobody observed.
   */
  readonly bindingVersion: AttemptReleaseFenceObservation;
  readonly ok: true;
}
export type HandoffDerivation = AttemptReleaseRefused | DerivedHandoffBinding;

/**
 * OWN-PROPERTY PRESENCE, not truthiness: `{receiptRef: undefined}` is a caller
 * that tried to speak about the receipt and must hear the same refusal as one
 * that named a row. `hasOwnProperty.call` cannot be answered by a hostile
 * prototype, which `in` and `Reflect.has` can.
 *
 * TOTAL over `unknown` so a null request refuses rather than crashing — a crash
 * is not a fail-closed answer.
 */
export function carriesHandoffClaim(request: unknown): boolean {
  if (typeof request !== "object" || request === null) return true;
  return RETIRED_HANDOFF_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(request, key));
}

/** The producer's refusal, under ITS layer with ITS code — never flattened into a
 *  daemon code, because a journal that cannot be read and a binding this daemon
 *  composed badly demand opposite repairs. */
function carryHandoffRefusal(refusal: HandoffBindingRefused): AttemptReleaseRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const,
    code: refusal.code as AttemptReleaseRefused["code"], message: null, ok: false as const,
    refusedBy: refusal.layer as AttemptReleaseRefused["refusedBy"],
  });
}

/**
 * The handoff binding for THIS attempt, derived from durable records only.
 *
 * Identity and decision metadata are composed from the bound attempt and the
 * durable activation — never from a caller — and the command id is suffixed so
 * the binding cannot collide with the release decision the same command lands.
 */
export function deriveHandoffBinding(
  store: SqliteEventStore, bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
): HandoffDerivation {
  const { commandId, correlationId, principalId, projectId } = bound;
  const attemptRef = durable.attempt.attemptId;
  const recorded = recordReleaseHandoffBinding(store, {
    activationDigest: durable.activationDigest, attemptAggregateId: bound.aggregateId,
    attemptRef, correlationId: `${correlationId}:HANDOFF`,
    key: { commandId: `${commandId}:HANDOFF`, principalId, projectId },
    projectId, releaseCommandId: commandId,
    // LENGTH-FRAMED rather than delimiter-joined: a bare separator would map one
    // identity triple onto another whose parts split differently.
    requestBytes: encoder.encode(JSON.stringify([projectId, attemptRef, bound.aggregateId])),
  });
  if (!recorded.ok) return carryHandoffRefusal(recorded);
  const aggregateId = deriveReleaseHandoffAggregateId(bound.aggregateId);
  let version: number;
  // AN UNREADABLE HEAD IS NOT VERSION ZERO. Collapsing the two would let a store
  // that threw authorise a fence at a version nothing observed.
  try { version = store.readEvents(aggregateId).length; }
  catch { return refuse("ATTEMPT_RELEASE_COMMIT_UNAVAILABLE"); }
  return Object.freeze({
    binding: "written" in recorded ? null : recorded.binding,
    bindingVersion: Object.freeze({ aggregateId, slot: "BINDING" as const, version }),
    ok: true as const,
  });
}

/** The admission's refusal, kept beside the predicate so a reader sees the code
 *  and the rule that raises it together. */
export const refuseHandoffClaim = (): AttemptReleaseRefused =>
  refuse("ATTEMPT_RELEASE_REQUEST_MALFORMED");

export interface DerivedSchedulerHandoff {
  readonly handoff: ReleaseHandoff;
  readonly ok: true;
  /** The builder's captured source versions, relayed UNCHANGED (task-06835dfa). This
   *  seam re-derives nothing: re-reading here would fence at a version the handoff
   *  content was not built from, which is the staleness the fence exists to close. */
  readonly sources: readonly AttemptReleaseFenceObservation[];
}
export type SchedulerHandoffDerivation = AttemptReleaseRefused | DerivedSchedulerHandoff;

/** The builder's refusal, under ITS layer with ITS code — never flattened into a
 *  daemon code. A source that was never written and a store that cannot be read
 *  demand opposite repairs, and the builder already separated them. The source
 *  attribution and the upstream reader's own code stay inside the builder's
 *  answer; what crosses here is the class and the layer the row can record. */
function carrySchedulerRefusal(refusal: ReleaseHandoffRefused): AttemptReleaseRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code: refusal.code,
    message: refusal.upstream === null
      ? null : `${refusal.upstream.code}@${refusal.upstream.layer}`,
    ok: false as const, refusedBy: refusal.layer,
  });
}

/**
 * THE SCHEDULER CHECKPOINT for this attempt, built from durable server facts only.
 *
 * The four identity fields come from the bound attempt and the durable activation,
 * never from a caller: there is no request field this function could reach for, and
 * `AttemptReleaseRequest` no longer has a `handoff` key to read.
 */
export function deriveSchedulerHandoff(
  store: SqliteEventStore, bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
): SchedulerHandoffDerivation {
  const built = buildReleaseHandoff(store, {
    attemptRef: durable.attempt.attemptId, nodeKey: bound.nodeKey,
    projectId: bound.projectId, sessionId: bound.sessionId,
  });
  return built.ok ? built : carrySchedulerRefusal(built);
}
