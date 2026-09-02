import { createHash } from "node:crypto";

import { derivePolicySliceDigest } from "@moe/core";
import type { PolicyFactInput, PolicySlice, PolicyWaiver } from "@moe/core";
import type { JsonValue } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readPolicyRisk } from "./policy-risk-reader.js";
import { readPolicyWaiver } from "./policy-waiver-reader.js";
import type { PolicyWaiverEventStoreReader } from "./policy-waiver-reader.js";

const FACT_ID_DOMAIN = "moe.policy-fact-resolver.v1";

/** Contract A item 6: the read-only expected-version leg, one per CONSUMED waiver aggregate. */
export interface ConsumedWaiverAggregate {
  readonly aggregateId: string;
  readonly observedVersion: number;
}

export interface ResolvedEmptyPolicyWaivers {
  readonly consumed: readonly [];
  readonly status: "RESOLVED_EMPTY";
  readonly waivers: readonly [];
}

export interface ResolvedVerifiedPolicyWaivers {
  readonly consumed: readonly ConsumedWaiverAggregate[];
  readonly status: "RESOLVED_VERIFIED";
  readonly waivers: readonly PolicyWaiver[];
}

export type ResolvedPolicyWaivers =
  | ResolvedEmptyPolicyWaivers
  | ResolvedVerifiedPolicyWaivers;

/** Every operand is server-owned; the caller supplies none of them. */
export interface PolicyWaiverResolutionInput {
  readonly authenticatedPrincipal: string;
  readonly evaluatedAction: string;
  readonly evaluatedAtEpochMs: number;
  readonly installedPolicyRevisionRef: string;
  readonly installedSliceChain: readonly PolicySlice[];
  readonly projectId: string;
  readonly scope: readonly string[];
}

export type PolicyWaiverResolutionStore =
  PolicyWaiverEventStoreReader & Pick<SqliteEventStore, "getAggregateVersion">;

const RESOLVED_EMPTY_WAIVERS: ResolvedEmptyPolicyWaivers = Object.freeze({
  consumed: Object.freeze([] as const),
  status: "RESOLVED_EMPTY",
  waivers: Object.freeze([] as const),
});

/**
 * The two narrowings the caller needs, kept beside the resolver that consumes them so
 * `bootstrap-policy-services.ts` stays argument threading and stays under its size ruling.
 *
 * `derivePolicySliceDigest` accepts a value exactly when core's own `validSlice` does, so it is
 * the witness that these bytes are a `PolicySlice` rather than an assertion of ours.
 * `policy.install` also stores non-evaluation artifacts; one of those yields an EMPTY chain,
 * which names no obligation and can therefore verify no waiver.
 */
export function evaluationChain(slice: JsonValue): readonly PolicySlice[] {
  return derivePolicySliceDigest(slice).ok ? [slice as unknown as PolicySlice] : [];
}

/** A non-list or any non-string member yields EMPTY, which no nonempty granted scope equals. */
export function evaluationScope(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as readonly string[])
    : [];
}

/**
 * The obligation ids the INSTALLED chain names, deduplicated and ordered so the read sequence is
 * a function of the durable slice bytes alone. This is the candidate key set only: whether an id
 * is uniquely SOFT, and every other join, remains the reader's judgement.
 */
function candidateObligationIds(chain: readonly PolicySlice[]): readonly string[] {
  const ids = new Set<string>();
  for (const slice of chain) {
    for (const rule of slice.rules) {
      for (const obligation of rule.obligations) ids.add(obligation.obligationId);
    }
  }
  return [...ids].sort();
}

/**
 * Resolve verified policy waivers from durable history, or resolve EMPTY.
 *
 * The landed strict reader is the sole authority: this edge derives no ref, recomputes no digest,
 * re-implements no join and mints no second refusal vocabulary. Any refusal, for any reason, is
 * the fail-closed RESOLVED_EMPTY that policy.validate has always seen, so a waiver can only ever
 * subtract a refusal the reader affirmatively verified.
 *
 * Contract A item 6 also requires a read-only expected-version leg per consumed aggregate. The
 * accepted read reports the version it observed, and `getAggregateVersion` is the same number the
 * writer fences on (policy-waiver-leg.ts:183), so an aggregate that moved under the read is
 * dropped rather than consumed.
 */
export function resolvePolicyWaivers(
  store: PolicyWaiverResolutionStore,
  input: PolicyWaiverResolutionInput,
): ResolvedPolicyWaivers {
  const consumed: ConsumedWaiverAggregate[] = [];
  const waivers: PolicyWaiver[] = [];
  for (const namedObligationId of candidateObligationIds(input.installedSliceChain)) {
    const read = readPolicyWaiver(store, { ...input, namedObligationId });
    if (!read.ok || store.getAggregateVersion(read.aggregateId) !== read.observedVersion) continue;
    consumed.push(Object.freeze({
      aggregateId: read.aggregateId, observedVersion: read.observedVersion,
    }));
    waivers.push(read.waiver);
  }
  if (waivers.length === 0) return RESOLVED_EMPTY_WAIVERS;
  return Object.freeze({
    consumed: Object.freeze(consumed),
    status: "RESOLVED_VERIFIED" as const,
    waivers: Object.freeze(waivers),
  });
}

/**
 * Resolve policy-risk authority from the durable, strictly joined reader.
 *
 * A full reader join yields the human approval's fact id and tier verbatim. Every refusal keeps
 * the prior UNKNOWN value byte-for-byte: `assessRisk` skips that null-tier fact, adds
 * RISK_TIER_UNCLASSIFIABLE, and folds evaluation to HOLD_UNKNOWN.
 *
 * The server binds the configured project and authenticated principal. The action is only the
 * caller-requested evaluation subject: the reader treats it only as an equality fence. It cannot
 * supply a tier, truth, waiver, subject, or live allowance.
 */
export function resolvePolicyFact(
  store: SqliteEventStore,
  projectId: string,
  authenticatedPrincipal: string,
  callerRequestedAction: string,
): PolicyFactInput {
  const resolved = readPolicyRisk(
    store, projectId, authenticatedPrincipal, callerRequestedAction,
  );
  if (resolved.ok) {
    return Object.freeze({
      factId: resolved.factId,
      tier: resolved.tier,
      truthClass: resolved.truthClass,
    });
  }
  const identity = JSON.stringify([
    FACT_ID_DOMAIN,
    projectId,
    authenticatedPrincipal,
    callerRequestedAction,
  ]);
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return Object.freeze({
    factId: `policy-risk-unclassifiable:sha256:${digest}`,
    tier: null,
    truthClass: "UNKNOWN",
  });
}
