/**
 * The same-bug circuit breaker's decision. Pure: it answers ADMIT or HOLD and
 * returns the next hold state. It never schedules, and it performs no I/O.
 *
 * Holds are keyed BY FINGERPRINT. That is what makes "unrelated work remains
 * schedulable" true by construction rather than by a filter somebody can
 * forget to apply: a hold on one fingerprint is simply not reachable from a
 * lookup for another.
 */
import { evaluateRetryUnlock } from "@moe/context";
import type { DeadEndJournalEntry, FactPredicate } from "@moe/context";

import {
  BREAKER_INPUT_INVALID_REFUSAL,
  CONVERGENCE_BREAKER_LAYER,
  type ActiveHolds,
  type BreakerAdmission,
  type BreakerRequest,
  type BreakerTransition,
  type FailureFingerprint,
  type HoldRecord,
  type HumanRelease,
  type RetryPredicateHold,
  type RetryPredicateRefusal,
  type SameBugHold,
} from "./breaker-contract.js";
import {
  computeFailureFingerprint,
  readOwnDataString,
  readOwnDataValue,
} from "./failure-fingerprint.js";

export function emptyHolds(): ActiveHolds {
  return new Map<FailureFingerprint, HoldRecord>();
}

const PREDICATE_OPERATORS = Object.freeze({
  FACT_VALUE: Object.freeze(["EQUALS", "NOT_EQUALS"] as const),
  FACT_VERSION: Object.freeze(["EQUALS", "GREATER_THAN"] as const),
  FACT_DIGEST: Object.freeze(["EQUALS", "NOT_EQUALS"] as const),
});

/**
 * A predicate must be well formed BEFORE it reaches `evaluateRetryUnlock`.
 * That function answers "did the predicate move?" by digesting both sides, so
 * an unparseable candidate digests to something that simply differs from the
 * held value — and would read as movement. Without this gate, a caller who
 * cannot change the underlying fact can still release any hold by submitting
 * junk.
 */
function isFactPredicate(value: unknown): value is FactPredicate {
  if (typeof value !== "object" || value === null) return false;
  const kind = readOwnDataValue(value, "kind");
  if (kind !== "FACT_VALUE" && kind !== "FACT_VERSION" && kind !== "FACT_DIGEST") return false;
  if (readOwnDataString(value, "factId") === null) return false;
  const operator = readOwnDataValue(value, "operator");
  if (!PREDICATE_OPERATORS[kind].some((allowed) => allowed === operator)) return false;
  if (kind === "FACT_VERSION") {
    return Number.isFinite(readOwnDataValue(value, "expectedVersion"));
  }
  if (kind === "FACT_DIGEST") {
    return readOwnDataString(value, "expectedDigest") !== null;
  }
  const expected = readOwnDataValue(value, "expectedValue");
  return (
    expected === null ||
    typeof expected === "string" ||
    typeof expected === "number" ||
    typeof expected === "boolean"
  );
}

/**
 * The hold captures its own frozen copy. Holding the caller's object would let
 * a caller mutate, after the fact, the very predicate the hold is waiting on.
 */
function frozenPredicate(predicate: FactPredicate): FactPredicate {
  return Object.freeze({ ...predicate });
}

function withHold(holds: ActiveHolds, record: HoldRecord): ActiveHolds {
  const next = new Map(holds);
  next.set(record.fingerprint, record);
  return next;
}

function withoutHold(holds: ActiveHolds, fingerprint: FailureFingerprint): ActiveHolds {
  const next = new Map(holds);
  next.delete(fingerprint);
  return next;
}

/**
 * Joins a sibling onto the hold it converged with. Entry ids are appended in
 * arrival order and de-duplicated, so re-reporting the same entry cannot
 * inflate the record.
 */
function join(existing: HoldRecord, entryId: string, reason: HoldRecord["reason"]): HoldRecord {
  const entryIds = existing.entryIds.includes(entryId)
    ? existing.entryIds
    : [...existing.entryIds, entryId];
  return Object.freeze({ ...existing, entryIds: Object.freeze(entryIds), reason });
}

function openHold(
  fingerprint: FailureFingerprint,
  entryId: string,
  awaited: FactPredicate,
): HoldRecord {
  return Object.freeze({
    fingerprint,
    entryIds: Object.freeze([entryId]),
    reason: "SAME_BUG_CONVERGENCE",
    awaitedPredicate: frozenPredicate(awaited),
  });
}

function admit(fingerprint: FailureFingerprint): BreakerAdmission {
  return Object.freeze({ ok: true, decision: "ADMIT", fingerprint });
}

function sameBugHold(hold: HoldRecord): SameBugHold {
  return Object.freeze({
    ok: false,
    decision: "HOLD",
    truth: "UNKNOWN",
    layer: CONVERGENCE_BREAKER_LAYER,
    code: "SAME_BUG_HOLD_ACTIVE",
    refusedBy: null,
    hold,
  });
}

function retryPredicateHold(hold: HoldRecord, refusedBy: RetryPredicateRefusal): RetryPredicateHold {
  return Object.freeze({
    ok: false,
    decision: "HOLD",
    truth: "UNKNOWN",
    layer: CONVERGENCE_BREAKER_LAYER,
    code: "RETRY_PREDICATE_UNCHANGED_HOLD",
    refusedBy,
    hold,
  });
}

function releases(release: HumanRelease | null, fingerprint: FailureFingerprint): boolean {
  return (
    release !== null &&
    release.kind === "HUMAN_RELEASE" &&
    release.decisionId.length > 0 &&
    release.fingerprint === fingerprint
  );
}

/**
 * The predicate comparison is `@moe/context`'s, never a second copy: a local
 * reimplementation would drift from the reviewed one and DoD 2 would then be
 * asserted against scheduler's opinion instead of the authority.
 *
 * `evaluateRetryUnlock` reads only `previous.retryPredicate`, and the
 * authoritative previous value is the one recorded on the HOLD — not the one
 * on the caller's own entry. Comparing the caller's entry against the caller's
 * candidate would put both sides of the test under the caller's control and
 * make any hold unlockable on demand.
 */
function unlocks(
  hold: HoldRecord,
  entry: DeadEndJournalEntry,
  candidate: FactPredicate,
): RetryPredicateRefusal | null {
  const held: DeadEndJournalEntry = { ...entry, retryPredicate: hold.awaitedPredicate };
  const result = evaluateRetryUnlock(held, candidate);
  return result.kind === "REFUSED" ? result : null;
}

export function decideBreaker(holds: ActiveHolds, request: BreakerRequest): BreakerTransition {
  const refused = Object.freeze({ outcome: BREAKER_INPUT_INVALID_REFUSAL, holds });
  const fingerprinted = computeFailureFingerprint(request.entry);
  if (!fingerprinted.ok) return refused;

  /**
   * `computeFailureFingerprint` vouches only for the five fields it hashes.
   * The id and the predicate are read straight into hold state, so they are
   * validated here rather than trusted from the declared type — a caller is
   * not obliged to honour it.
   */
  const entryId = readOwnDataString(request.entry, "id");
  const retryPredicate = readOwnDataValue(request.entry, "retryPredicate");
  if (entryId === null || !isFactPredicate(retryPredicate)) return refused;
  if (request.candidatePredicate !== null && !isFactPredicate(request.candidatePredicate)) {
    return refused;
  }

  const { fingerprint } = fingerprinted;
  const existing = holds.get(fingerprint);

  if (existing === undefined) {
    return Object.freeze({
      outcome: admit(fingerprint),
      holds: withHold(holds, openHold(fingerprint, entryId, retryPredicate)),
    });
  }

  if (releases(request.humanRelease, fingerprint)) {
    return Object.freeze({
      outcome: admit(fingerprint),
      holds: withoutHold(holds, fingerprint),
    });
  }

  if (request.candidatePredicate === null) {
    const joined = join(existing, entryId, "SAME_BUG_CONVERGENCE");
    return Object.freeze({ outcome: sameBugHold(joined), holds: withHold(holds, joined) });
  }

  const refusedBy = unlocks(existing, request.entry, request.candidatePredicate);
  if (refusedBy === null) {
    return Object.freeze({
      outcome: admit(fingerprint),
      holds: withoutHold(holds, fingerprint),
    });
  }

  const joined = join(existing, entryId, "RETRY_PREDICATE_UNMOVED");
  return Object.freeze({
    outcome: retryPredicateHold(joined, refusedBy),
    holds: withHold(holds, joined),
  });
}
