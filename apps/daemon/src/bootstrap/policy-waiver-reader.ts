/**
 * Strict, side-effect-free durable reader for human policy waivers.
 *
 * It enumerates only the versioned policy-waiver aggregate prefix, folds each aggregate ONCE
 * through the landed production codec, and turns a fully joined current grant into the canonical
 * five-field `@moe/core` PolicyWaiver plus the aggregate id/version observed by that same read.
 * There is deliberately no branch capable of minting, repairing, defaulting or broadening
 * authority: every accepted byte comes from immutable history joined to server-owned operands.
 *
 * Supersession is READER-OWNED and VALIDITY-AWARE. `foldPolicyWaiverEvents` marks supersession by
 * LINEAGE (policy-waiver-leg.ts:138 "Revocation ends authority, not lineage"), so its `superseded`
 * flag is deliberately not carried into `LoadedGrant`: under the amended DoD 3 a later grant only
 * displaces its predecessor when that successor itself satisfies every join and every validity
 * condition. The displacement is computed from the ordered grants the single fold already
 * returned, so no second read and no additional store round-trip is needed.
 */
import type { PolicySlice, PolicyWaiver } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { foldPolicyWaiverEvents } from "../planning/policy-waiver-leg.js";
import {
  DAEMON_POLICY_WAIVER,
  POLICY_WAIVER_READER_CODES,
  policyWaiverRefusal,
} from "./policy-waiver-record.js";
import type {
  PolicyWaiverGrantRecord,
  PolicyWaiverReaderCode,
  PolicyWaiverRefusal,
} from "./policy-waiver-record.js";

export { DAEMON_POLICY_WAIVER, POLICY_WAIVER_READER_CODES };
export type { PolicyWaiverReaderCode };

export type PolicyWaiverEventStoreReader =
  Pick<SqliteEventStore, "enumerateAggregateIdsByPrefix" | "readEvents">;

/** Every operand is server-owned; no caller-carried waiver or approval reference is accepted. */
export interface PolicyWaiverReadInput {
  readonly authenticatedPrincipal: string;
  readonly evaluatedAction: string;
  readonly evaluatedAtEpochMs: number;
  readonly installedPolicyRevisionRef: string;
  readonly installedSliceChain: readonly PolicySlice[];
  readonly namedObligationId: string;
  readonly projectId: string;
  readonly scope: readonly string[];
}

/** `aggregateId`/`observedVersion` come from the same read that produced the waiver bytes. */
export interface PolicyWaiverReadAccepted {
  readonly aggregateId: string;
  readonly observedVersion: number;
  readonly ok: true;
  readonly waiver: PolicyWaiver;
}

export type PolicyWaiverReadRefusal = PolicyWaiverRefusal<PolicyWaiverReaderCode>;
export type PolicyWaiverReadResult = PolicyWaiverReadAccepted | PolicyWaiverReadRefusal;

const AGGREGATE_PREFIX = "policy-waiver:aggregate:v1:sha256:";

function refuse(code: PolicyWaiverReaderCode): PolicyWaiverReadRefusal {
  return policyWaiverRefusal(code);
}

interface LoadedGrant {
  readonly aggregateId: string;
  readonly observedVersion: number;
  readonly record: Readonly<PolicyWaiverGrantRecord>;
  readonly revoked: boolean;
}

type LoadedGrants =
  | Readonly<{ readonly grants: readonly LoadedGrant[]; readonly ok: true }>
  | Readonly<{ readonly ok: false }>;

const unreadable = Object.freeze({ ok: false as const });

/**
 * One enumeration, one event-tail read and one fold per aggregate. A malformed event type, an
 * out-of-order sequence, tampered bytes, a mismatched hash and a store exception are all
 * indistinguishable corruption from here, so every one of them fails closed as UNREADABLE.
 */
function loadGrants(store: PolicyWaiverEventStoreReader): LoadedGrants {
  const grants: LoadedGrant[] = [];
  try {
    for (const aggregateId of store.enumerateAggregateIdsByPrefix(AGGREGATE_PREFIX)) {
      const events = store.readEvents(aggregateId);
      if (events.length === 0) return unreadable;
      const folded = foldPolicyWaiverEvents(aggregateId, events);
      if (!folded.ok) return unreadable;
      for (const candidate of folded.grants) {
        grants.push(Object.freeze({
          aggregateId,
          observedVersion: folded.observedVersion,
          record: candidate.record,
          revoked: candidate.revoked,
        }));
      }
    }
  } catch { return unreadable; }
  return Object.freeze({ grants: Object.freeze(grants), ok: true as const });
}

/** Canonical scope comparison is SET equality: the same members in any order are the same scope. */
function sameScopeSet(granted: readonly string[], requested: readonly string[]): boolean {
  const left = new Set(granted);
  const right = new Set(requested);
  return left.size === right.size && [...left].every((member) => right.has(member));
}

type JoinPredicate = (
  record: Readonly<PolicyWaiverGrantRecord>, input: PolicyWaiverReadInput,
) => boolean;

interface JoinStep {
  readonly code: PolicyWaiverReaderCode;
  readonly matches: JoinPredicate;
}
const joinStep = (code: PolicyWaiverReaderCode, matches: JoinPredicate): JoinStep =>
  Object.freeze({ code, matches });

/** Deterministic join order; the first empty result names the refusing operand. */
const JOIN_ORDER: readonly JoinStep[] = Object.freeze([
  joinStep("POLICY_WAIVER_PROJECT_FOREIGN",
    (record, input) => record.projectId === input.projectId),
  joinStep("POLICY_WAIVER_PRINCIPAL_FOREIGN",
    (record, input) => record.approvedBy === input.authenticatedPrincipal),
  joinStep("POLICY_WAIVER_ACTION_FOREIGN",
    (record, input) => record.actionKind === input.evaluatedAction),
  joinStep("POLICY_WAIVER_POLICY_STALE",
    (record, input) => record.policyRevisionRef === input.installedPolicyRevisionRef),
  joinStep("POLICY_WAIVER_OBLIGATION_FOREIGN",
    (record, input) => record.namedObligationId === input.namedObligationId),
  joinStep("POLICY_WAIVER_SCOPE_FOREIGN",
    (record, input) => sameScopeSet(record.scope, input.scope)),
]);

type JoinResult =
  | Readonly<{ readonly ok: true; readonly survivors: readonly LoadedGrant[] }>
  | Readonly<{ readonly ok: false; readonly refusal: PolicyWaiverReadRefusal }>;

function joinGrants(all: readonly LoadedGrant[], input: PolicyWaiverReadInput): JoinResult {
  let survivors = all;
  for (const step of JOIN_ORDER) {
    survivors = survivors.filter((grant) => step.matches(grant.record, input));
    if (survivors.length === 0) {
      return Object.freeze({ ok: false as const, refusal: refuse(step.code) });
    }
  }
  return Object.freeze({ ok: true as const, survivors });
}

/**
 * The named obligation must occur UNIQUELY as SOFT in the installed slice chain. Absence is a
 * foreign obligation; ambiguity and any HARD occurrence are both NOT_SOFT — a HARD obligation is
 * never waivable, and two SOFT occurrences leave no single obligation to relax.
 */
function obligationRefusal(
  chain: readonly PolicySlice[], obligationId: string,
): PolicyWaiverReaderCode | null {
  let soft = 0;
  let hard = 0;
  for (const slice of chain) {
    for (const rule of slice.rules) {
      for (const obligation of rule.obligations) {
        if (obligation.obligationId !== obligationId) continue;
        if (obligation.kind === "SOFT") soft += 1;
        else hard += 1;
      }
    }
  }
  if (soft + hard === 0) return "POLICY_WAIVER_OBLIGATION_FOREIGN";
  return soft === 1 && hard === 0 ? null : "POLICY_WAIVER_NOT_SOFT";
}

/**
 * Expiry is EXCLUSIVE: a waiver expiring at the evaluation instant is already expired. An
 * unusable evaluation instant (NaN, Infinity, fractional) cannot establish that a waiver is still
 * live, so it expires rather than silently comparing false and granting authority.
 */
function isExpired(record: Readonly<PolicyWaiverGrantRecord>, evaluatedAtEpochMs: number): boolean {
  return !Number.isSafeInteger(evaluatedAtEpochMs)
    || record.expiresAtEpochMs <= evaluatedAtEpochMs;
}

function isValidGrant(grant: LoadedGrant, evaluatedAtEpochMs: number): boolean {
  return !grant.revoked && !isExpired(grant.record, evaluatedAtEpochMs);
}

/**
 * Validity-aware current-grant selection over the ordered grants of the single fold. The last
 * VALID survivor wins, so a predecessor is displaced only by a successor that is itself valid; a
 * successor that is expired or revoked leaves its predecessor in force. When nothing is valid the
 * last survivor is current and reports its own refusal.
 */
function selectCurrent(
  survivors: readonly LoadedGrant[], evaluatedAtEpochMs: number,
): LoadedGrant {
  for (let index = survivors.length - 1; index >= 0; index -= 1) {
    const candidate = survivors[index]!;
    if (isValidGrant(candidate, evaluatedAtEpochMs)) return candidate;
  }
  return survivors[survivors.length - 1]!;
}

function accept(current: LoadedGrant): PolicyWaiverReadAccepted {
  const { record } = current;
  return Object.freeze({
    aggregateId: current.aggregateId,
    observedVersion: current.observedVersion,
    ok: true as const,
    waiver: Object.freeze({
      expiresAtEpochMs: record.expiresAtEpochMs,
      humanApprovalRef: record.humanApprovalRef,
      namedObligationId: record.namedObligationId,
      scope: record.scope,
      waiverRef: record.waiverRef,
    }),
  });
}

/**
 * Resolve a verified policy waiver from durable history alone. Every miss returns a stable
 * Contract-A code at literal `DAEMON_POLICY_WAIVER` and carries no waiver, no aggregate id and no
 * version, so a refusal can never be mistaken for a partially granted authority.
 */
export function readPolicyWaiver(
  store: PolicyWaiverEventStoreReader, input: PolicyWaiverReadInput,
): PolicyWaiverReadResult {
  const loaded = loadGrants(store);
  if (!loaded.ok) return refuse("POLICY_WAIVER_RECORD_UNREADABLE");
  if (loaded.grants.length === 0) return refuse("POLICY_WAIVER_RECORD_MISSING");
  const joined = joinGrants(loaded.grants, input);
  if (!joined.ok) return joined.refusal;
  const obligationCode = obligationRefusal(input.installedSliceChain, input.namedObligationId);
  if (obligationCode !== null) return refuse(obligationCode);
  const current = selectCurrent(joined.survivors, input.evaluatedAtEpochMs);
  if (current.revoked) return refuse("POLICY_WAIVER_REVOKED");
  if (isExpired(current.record, input.evaluatedAtEpochMs)) return refuse("POLICY_WAIVER_EXPIRED");
  return accept(current);
}
