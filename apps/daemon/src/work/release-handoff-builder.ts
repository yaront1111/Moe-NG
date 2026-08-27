/**
 * The server-owned producer of @moe/scheduler's nine-key `ReleaseHandoff`
 * (task-a20e8ef668b54c3abbfce37a505252eb).
 *
 * IT ACCEPTS ONLY SERVER IDENTITY — the same four keys the context seal port already
 * takes on the live dispatch path (foundation-attempt-service.ts:328). No digest, no
 * completed-step set, no resource fact, no next action and no truth class can be spelled
 * here, so none can be smuggled. `activationDigest` and the attempt aggregate are NOT
 * accepted either: both are RESOLVED from the durable activation, which is also what makes
 * the session cross-check below a comparison between two authorities rather than a caller
 * agreeing with itself.
 *
 * ONE HORIZON, CAPTURED ONCE, AGGREGATE-SCOPED. Seven sources read across a moving store
 * disagree with each other, and an internally inconsistent handoff is caught by no single
 * field assertion. Five aggregate counts are captured before the first read; the provider
 * run's sixth is added immediately after its strict reader discovers the run ref, then all
 * six are compared after the last read. The scope is deliberate and
 * follows foundation-artifact-ledger.ts:237-246: a GLOBAL `readEventHorizon` check moves
 * on any unrelated write and would refuse nearly every release on a busy daemon — green in
 * a quiet test, useless in production.
 *
 * A REFUSAL RETURNS NO HANDOFF AT ALL. The scheduler's `exactRecord` would refuse a partial
 * one anyway, but as a generic `AUTHORITY_MALFORMED_INPUT`; refusing here, first, with this
 * layer's code AND the source's own code and layer intact, is what keeps distinct failures
 * tied to distinct repairs instead of one indistinguishable kernel error.
 */

import type { ReleaseHandoff } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import type { FoundationAttemptBinding } from "../activation/activation-attempt-reader.js";
import {
  RELEASE_HANDOFF_IDENTITY_KEYS, SCHEDULER_HANDOFF_KEYS, isHandoffText, refuseHandoff,
} from "./release-handoff-contracts.js";
import type {
  ReleaseHandoffIdentity, ReleaseHandoffRefused,
} from "./release-handoff-contracts.js";
import {
  HANDOFF_CROSS_CHECK_LAYER, handoffAggregateIds,
} from "./release-handoff-classify.js";
import { readReleaseHandoffFacts } from "./release-handoff-sources.js";

export interface ReleaseHandoffBuilt {
  readonly handoff: ReleaseHandoff;
  readonly ok: true;
}

export type ReleaseHandoffResult = ReleaseHandoffBuilt | ReleaseHandoffRefused;

/** The scheduler parses these with `stringList(value, MAX_AUTHORITY_ITEMS)`. Checked here
 *  so an over-long roster is attributable to the roster rather than to the whole handoff. */
const MAX_HANDOFF_ITEMS = 128;

/**
 * The ONLY truth class a built handoff can carry, and it is not a shortcut. Every one of
 * the nine facts arrives from a strict durable reader; in particular the step reader
 * REFUSES any record whose own `truthClass` is not `DAEMON_VERIFIED`
 * (step-lifecycle-reader.ts:162), so a weaker record yields no handoff rather than a
 * weaker one. That is what makes this value falsifiable: drift the durable class and the
 * build refuses instead of downgrading.
 */
const BUILT_TRUTH_CLASS = "DAEMON_VERIFIED";

/**
 * EXACTLY the four identity keys, as own data properties, and nothing else. A caller that
 * spelled a tenth key tried to speak about a fact this builder derives, and hears
 * REQUEST_INVALID rather than having the key quietly dropped.
 */
function admitIdentity(value: unknown): ReleaseHandoffIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // `Reflect.ownKeys`, like the kernel's `hasOnlyOwnStringKeys`, sees non-enumerable
  // strings AND Symbols. Neither kind may smuggle caller authority past this roster.
  let held: readonly PropertyKey[];
  try { held = Reflect.ownKeys(value); } catch { return null; }
  if (held.length !== RELEASE_HANDOFF_IDENTITY_KEYS.length) return null;
  if (!held.every((key) => typeof key === "string"
    && (RELEASE_HANDOFF_IDENTITY_KEYS as readonly string[]).includes(key))) return null;
  const admitted: Record<string, string> = {};
  for (const key of RELEASE_HANDOFF_IDENTITY_KEYS) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return null; }
    if (descriptor === undefined || !("value" in descriptor)) return null;
    const read: unknown = descriptor.value;
    if (!isHandoffText(read)) return null;
    admitted[key] = read;
  }
  return Object.freeze(admitted) as unknown as ReleaseHandoffIdentity;
}

/** Row counts for exactly the aggregates this builder reads. An unreadable aggregate is
 *  not a stable one, so a throw is the same answer as a move. */
function captureCounts(
  store: SqliteEventStore, aggregateIds: readonly string[],
): readonly number[] | null {
  const counts: number[] = [];
  for (const aggregateId of aggregateIds) {
    try { counts.push(store.readEvents(aggregateId).length); } catch { return null; }
  }
  return counts;
}

interface HandoffHorizon {
  aggregateIds: string[];
  counts: number[];
}

function extendProviderHorizon(
  store: SqliteEventStore, horizon: HandoffHorizon, binding: FoundationAttemptBinding,
  identity: ReleaseHandoffIdentity, providerRunRef: Parameters<typeof handoffAggregateIds>[2],
): ReleaseHandoffRefused | null {
  const expanded = [...handoffAggregateIds(binding, identity, providerRunRef)];
  const aggregateId = expanded.at(-1);
  if (aggregateId === undefined || horizon.aggregateIds.includes(aggregateId)) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_MALFORMED", "provider-run",
      { code: "PROVIDER_RUN_AGGREGATE_MISMATCH", layer: "PROVIDER_RUN_READER" });
  }
  const captured = captureCounts(store, [aggregateId]);
  if (captured === null) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_UNREADABLE", "provider-run",
      { code: "PROVIDER_RUN_EVIDENCE_UNREADABLE", layer: "PROVIDER_RUN_READER" });
  }
  if (captured[0] !== 1) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_AMBIGUOUS", "provider-run",
      { code: "PROVIDER_RUN_EVIDENCE_AMBIGUOUS", layer: "PROVIDER_RUN_READER" });
  }
  horizon.aggregateIds = expanded;
  horizon.counts.push(captured[0]);
  return null;
}

const countsAgree = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((count, index) => count === right[index]);

/**
 * BOTH DIRECTIONS over the scheduler's roster. Iterating the roster alone cannot see an
 * extra key, iterating the built object alone cannot see a missing one, and a length check
 * alone cannot see a swap; all three run. `exactRecord` downstream is EXACT, and a handoff
 * that fails it there arrives as a generic malformed input with no source attached.
 */
function exactNineKeys(candidate: Record<string, unknown>): boolean {
  const held = Object.keys(candidate);
  return held.length === SCHEDULER_HANDOFF_KEYS.length
    && SCHEDULER_HANDOFF_KEYS.every((key) => held.includes(key))
    && held.every((key) => SCHEDULER_HANDOFF_KEYS.includes(key));
}

/** Frozen through the arrays too: a consumer holding the handoff must not be able to
 *  append a completed step or a resource fact to it after the fact. */
function freezeHandoff(candidate: Record<string, unknown>): ReleaseHandoff {
  for (const value of Object.values(candidate)) {
    if (Array.isArray(value)) Object.freeze(value);
  }
  return Object.freeze(candidate) as unknown as ReleaseHandoff;
}

/** The durable activation IS the identity anchor: it resolves the digest and aggregate the
 *  sources are keyed by, and its own session owner is cross-checked against the caller's. */
function bindAttempt(
  store: SqliteEventStore, identity: ReleaseHandoffIdentity,
): FoundationAttemptBinding | ReleaseHandoffRefused {
  const bound = readFoundationActivationByAttempt(
    store, identity.projectId, identity.attemptRef);
  if (bound.status !== "BOUND") {
    return refuseHandoff(
      bound.status === "ABSENT"
        ? "RELEASE_HANDOFF_SOURCE_ABSENT" : "RELEASE_HANDOFF_SOURCE_UNREADABLE",
      null, { code: bound.code, layer: bound.layer });
  }
  if (bound.ownerSessionRef !== identity.sessionId) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_FOREIGN", null,
      { code: "FOUNDATION_BINDING_SESSION_MISMATCH", layer: HANDOFF_CROSS_CHECK_LAYER });
  }
  return bound;
}

/**
 * The whole answer, or a refusal that grants nothing.
 *
 * Reads only. No clock, no randomness, no caller value on any of the nine fields, and no
 * write of any kind — in particular no DRAINING transition is composed here to make a row
 * reachable: the release aggregate cannot upgrade DRAINING to RELEASED, so a premature row
 * is permanently un-correctable.
 */
export function buildReleaseHandoff(
  store: SqliteEventStore, request: unknown,
): ReleaseHandoffResult {
  const identity = admitIdentity(request);
  if (identity === null) return refuseHandoff("RELEASE_HANDOFF_REQUEST_INVALID");
  const bound = bindAttempt(store, identity);
  if ("ok" in bound) return bound;
  const aggregateIds = [...handoffAggregateIds(bound, identity)];
  const counts = captureCounts(store, aggregateIds);
  if (counts === null) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_UNREADABLE", null,
      { code: "RELEASE_HANDOFF_HORIZON_UNREADABLE", layer: HANDOFF_CROSS_CHECK_LAYER });
  }
  const horizon: HandoffHorizon = { aggregateIds, counts: [...counts] };
  const facts = readReleaseHandoffFacts(store, bound, identity,
    (ref) => extendProviderHorizon(store, horizon, bound, identity, ref));
  if ("ok" in facts) return facts;
  const after = captureCounts(store, horizon.aggregateIds);
  if (after === null || !countsAgree(horizon.counts, after)) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_HORIZON_MOVED", null,
      { code: "RELEASE_HANDOFF_AGGREGATE_MOVED", layer: HANDOFF_CROSS_CHECK_LAYER });
  }
  if (facts.completedSteps.length > MAX_HANDOFF_ITEMS) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_MALFORMED", "step-record",
      { code: "STEP_RECORD_MALFORMED", layer: "DAEMON_STEP_LIFECYCLE" });
  }
  if (facts.resourceFacts.length > MAX_HANDOFF_ITEMS) {
    return refuseHandoff("RELEASE_HANDOFF_SOURCE_MALFORMED", "terminal-evidence",
      { code: "RELEASE_TERMINAL_RESOURCE_UNKNOWN", layer: "RELEASE_TERMINAL_EVIDENCE" });
  }
  // FRESHLY REBUILT, key by key. A spread of the facts record would carry whatever extra
  // key a later field added straight into a roster the scheduler admits exactly.
  const candidate: Record<string, unknown> = {
    activeProcessResourceFacts: [...facts.resourceFacts],
    artifactDigest: facts.artifactDigest,
    completedSteps: [...facts.completedSteps],
    contextDigest: facts.contextDigest,
    inputDigest: facts.inputDigest,
    journalDigest: facts.journalDigest,
    nextSafeAction: facts.nextSafeAction,
    truthClass: BUILT_TRUTH_CLASS,
    worktreeDigest: facts.worktreeDigest,
  };
  if (!exactNineKeys(candidate)) return refuseHandoff("RELEASE_HANDOFF_INEXACT");
  return Object.freeze({ handoff: freezeHandoff(candidate), ok: true as const });
}
