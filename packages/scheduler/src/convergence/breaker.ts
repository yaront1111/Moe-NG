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
  BREAKER_HOLDS_EXHAUSTED_REFUSAL,
  BREAKER_INPUT_INVALID_REFUSAL,
  CONVERGENCE_BREAKER_LAYER,
  MAX_ACTIVE_HOLDS,
  MAX_HOLD_ENTRY_IDS,
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

/**
 * Consumer-driven eviction: keeps exactly the holds whose fingerprint the
 * caller vouches for, dropping the rest — the lever for shedding holds a base
 * or environment rotation has stranded below `MAX_ACTIVE_HOLDS` forever. Pure
 * like every transition here: the input map is untouched and the kept records
 * are carried over as-is.
 */
export function retainHolds(
  holds: ActiveHolds,
  keepFingerprint: (fingerprint: string) => boolean,
): ActiveHolds {
  const next = new Map<FailureFingerprint, HoldRecord>();
  for (const [fingerprint, record] of holds) {
    if (keepFingerprint(fingerprint)) next.set(fingerprint, record);
  }
  return next;
}

/**
 * Exactly the key set each `FactPredicate` variant declares in `@moe/context`'s
 * contract — the same arity discipline the daemon's journal entry codec
 * enforces (apps/daemon/src/journal/journal-entry-codec.ts), copied locally
 * because scheduler must not import daemon code. The list lengths gate arity
 * and the per-field reads in `parseFactPredicate` gate identity; together they
 * make the accepted key SET exact.
 */
const PREDICATE_KEYS = Object.freeze({
  FACT_DIGEST: Object.freeze(["expectedDigest", "factId", "kind", "operator"] as const),
  FACT_VALUE: Object.freeze(["expectedValue", "factId", "kind", "operator"] as const),
  FACT_VERSION: Object.freeze(["expectedVersion", "factId", "kind", "operator"] as const),
});

/**
 * A predicate must be well formed BEFORE it reaches `evaluateRetryUnlock`.
 * That function answers "did the predicate move?" by digesting both sides, so
 * an unparseable candidate digests to something that simply differs from the
 * held value — and would read as movement. Without this gate, a caller who
 * cannot change the underlying fact can still release any hold by submitting
 * junk.
 *
 * Field checks alone are not that gate. A value can carry every valid field
 * PLUS an extra key: an unserializable extra (`junk: undefined`) makes
 * `canonicalSha256` THROW inside every later unlock attempt — a crash instead
 * of a refusal, on a hold no predicate could ever release — and a serializable
 * extra perturbs the digest so byte-identical facts read as movement. So the
 * key set is exact per variant, and the accepted predicate is REBUILT from the
 * validated fields into a fresh frozen object — never spread — which is also
 * what makes the hold immune to the caller mutating their object afterwards.
 * The per-kind builds are pinned to `@moe/context`'s own `FactPredicate`, so an
 * operator or field that drifts from the contract fails the typecheck.
 */
function parseFactPredicate(value: unknown): FactPredicate | null {
  if (typeof value !== "object" || value === null) return null;
  const kind = readOwnDataValue(value, "kind");
  if (kind !== "FACT_VALUE" && kind !== "FACT_VERSION" && kind !== "FACT_DIGEST") return null;
  if (Object.getOwnPropertyNames(value).length !== PREDICATE_KEYS[kind].length) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const factId = readOwnDataString(value, "factId");
  if (factId === null) return null;
  const operator = readOwnDataValue(value, "operator");

  if (kind === "FACT_VERSION") {
    if (operator !== "EQUALS" && operator !== "GREATER_THAN") return null;
    const expectedVersion = readOwnDataValue(value, "expectedVersion");
    if (typeof expectedVersion !== "number" || !Number.isFinite(expectedVersion)) return null;
    return Object.freeze({ kind, factId, operator, expectedVersion });
  }

  if (operator !== "EQUALS" && operator !== "NOT_EQUALS") return null;

  if (kind === "FACT_DIGEST") {
    const expectedDigest = readOwnDataString(value, "expectedDigest");
    if (expectedDigest === null) return null;
    return Object.freeze({ kind, factId, operator, expectedDigest });
  }

  const expectedValue = readOwnDataValue(value, "expectedValue");
  if (
    expectedValue !== null &&
    typeof expectedValue !== "string" &&
    typeof expectedValue !== "number" &&
    typeof expectedValue !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({ kind, factId, operator, expectedValue });
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
 * inflate the record — and the record is a WINDOW: past `MAX_HOLD_ENTRY_IDS`
 * the oldest id is dropped for the newest, because ids are provenance
 * breadcrumbs rather than authority (see the contract's constant).
 */
function join(existing: HoldRecord, entryId: string, reason: HoldRecord["reason"]): HoldRecord {
  const appended = existing.entryIds.includes(entryId)
    ? existing.entryIds
    : [...existing.entryIds, entryId];
  const entryIds =
    appended.length > MAX_HOLD_ENTRY_IDS ? appended.slice(appended.length - MAX_HOLD_ENTRY_IDS) : appended;
  return Object.freeze({ ...existing, entryIds: Object.freeze(entryIds), reason });
}

/** `awaited` is `parseFactPredicate`'s output: already a fresh frozen rebuild. */
function openHold(
  fingerprint: FailureFingerprint,
  entryId: string,
  awaited: FactPredicate,
): HoldRecord {
  return Object.freeze({
    fingerprint,
    entryIds: Object.freeze([entryId]),
    reason: "SAME_BUG_CONVERGENCE",
    awaitedPredicate: awaited,
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
   * not obliged to honour it. Both predicates are the parser's REBUILDS, and
   * everything downstream — the hold, the unlock comparison — uses only these,
   * never the caller's objects.
   */
  const entryId = readOwnDataString(request.entry, "id");
  const retryPredicate = parseFactPredicate(readOwnDataValue(request.entry, "retryPredicate"));
  if (entryId === null || retryPredicate === null) return refused;
  const candidatePredicate =
    request.candidatePredicate === null ? null : parseFactPredicate(request.candidatePredicate);
  if (request.candidatePredicate !== null && candidatePredicate === null) return refused;

  const { fingerprint } = fingerprinted;
  const existing = holds.get(fingerprint);

  if (existing === undefined) {
    /**
     * The cap gates only the INSERT. A request whose fingerprint is already
     * tracked never lands here, so convergence, unlock and release keep
     * working on a full ledger — only novel fingerprints are turned away.
     */
    if (holds.size >= MAX_ACTIVE_HOLDS) {
      return Object.freeze({ outcome: BREAKER_HOLDS_EXHAUSTED_REFUSAL, holds });
    }
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

  if (candidatePredicate === null) {
    const joined = join(existing, entryId, "SAME_BUG_CONVERGENCE");
    return Object.freeze({ outcome: sameBugHold(joined), holds: withHold(holds, joined) });
  }

  const refusedBy = unlocks(existing, request.entry, candidatePredicate);
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
