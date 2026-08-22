/**
 * WHICH of one attempt's effects and resources were proven terminal when it released.
 *
 * THIS RECORD ENUMERATES TERMINALITY; IT NEVER DECIDES IT. An effect's terminal state comes from
 * `readCurrentTerminalEffect`, the only strict reader of the terminal-effect ledger. A resource's
 * comes from the scheduler's own reducers: `attempt-resource-authority-contracts.ts` says outright
 * that terminality is deliberately not derived there, and `ACQUISITION_STATES` is not published on
 * the `@moe/scheduler` root, so re-declaring a terminal list here would be a SECOND definition of
 * a state machine — the drift that makes a legitimately QUARANTINED member read as something else.
 * Instead each durable row is offered back to the public reducers that own its transitions, and a
 * row NO reducer will still move is terminal. That keeps RELEASED terminal and QUARANTINED not: a
 * quarantine waits for a proven release, which `grantSuccessorCapacity` will still grant it.
 *
 * NO CALLER-SUPPLIED TERMINALITY. The request is an exact `{attemptRef, projectId}` record and any
 * further key is refused before a byte is read. A caller may say WHICH attempt, never WHAT was
 * terminal.
 *
 * FAIL CLOSED, AND NEVER SKIP. An item whose state cannot be READ makes the whole answer UNKNOWN,
 * because an item quietly dropped from these lists is an item nobody proved terminal while the
 * list still reads as complete. "No terminal record" is a different fact — a readable durable NO —
 * and it lands as a FALSE flag with the item still enumerated.
 *
 * THE ZERO CASE, MEASURED IN BOTH DIRECTIONS. Zero enumerated RESOURCES is reachable — nothing was
 * ever bound — and is answered FALSE with an explicit count of 0, never a vacuous true. Zero
 * enumerated EFFECTS is unreachable: a BOUND activation always carries exactly one effect intent,
 * so the enumeration is SEEDED from the binding and there is no vacuous-true arm to guard.
 */

import { adapterConfirm, adapterFail, grantSuccessorCapacity } from "@moe/scheduler";
import type { AcquisitionSet, AuthorityOutcome } from "@moe/scheduler";
import type { CursorPage, SqliteEventStore, StoredEvent } from "@moe/store";

import { readFoundationActivationByAttempt } from "../activation/activation-attempt-reader.js";
import type { AttemptResourceMember } from "./attempt-resource-authority-contracts.js";
import { readAttemptResources } from "./attempt-resource-reader.js";
import { decodeTerminalEffectRecord, exactKeys, isText } from "./effect-terminal-contracts.js";
import { EFFECT_TERMINAL_EVENT_TYPE, readCurrentTerminalEffect } from "./effect-terminal-ledger.js";
import { provenTerminal, refuseReleaseTerminal } from "./release-terminal-evidence-contracts.js";
import type {
  ReleaseTerminalOutcome, ReleaseTerminalRefusal, ReleaseTerminalRequest, ReleaseTerminalSplit,
} from "./release-terminal-evidence-contracts.js";

export { RELEASE_TERMINAL_CODES } from "./release-terminal-evidence-contracts.js";
export type {
  ReleaseTerminalCode, ReleaseTerminalEvidence, ReleaseTerminalLayer, ReleaseTerminalOutcome,
  ReleaseTerminalRefusal, ReleaseTerminalRequest, ReleaseTerminalUpstream,
} from "./release-terminal-evidence-contracts.js";

const SCAN_PAGE_SIZE = 100;
/** Never persisted and never a fact: it only asks the reducer whether a move still EXISTS. */
const PROBE_PROOF_REF = "release-terminal-evidence:transition-probe";

const enumerationUnreadable = (detail: string): ReleaseTerminalRefusal =>
  refuseReleaseTerminal("RELEASE_TERMINAL_EFFECT_ENUMERATION_UNREADABLE", detail);

type IntentWalk =
  | { readonly intentIds: ReadonlySet<string>; readonly ok: true }
  | ReleaseTerminalRefusal;

/**
 * ONE INDEX-BACKED walk of the terminal-effect event type, bounded by a captured horizon and by
 * the pager's own contract — the shape `in-flight-attempts.ts` fixes. Nothing here walks the
 * global stream, and a payload that does not decode refuses the whole sweep rather than being
 * stepped over: an effect missing from this set is an effect nobody proved terminal.
 */
function walkTerminalIntents(
  store: SqliteEventStore, request: ReleaseTerminalRequest, horizon: bigint,
): IntentWalk {
  const intentIds = new Set<string>();
  let cursor = 0n;
  while (cursor < horizon) {
    let page: CursorPage<StoredEvent, bigint>;
    try { page = store.readEventsByTypeAfter(EFFECT_TERMINAL_EVENT_TYPE, cursor, SCAN_PAGE_SIZE); }
    catch { return enumerationUnreadable("the terminal-effect index could not be read"); }
    let position = cursor;
    let beyond = false;
    for (const event of page.items) {
      if (event.globalPosition <= position) return enumerationUnreadable("the index is unordered");
      position = event.globalPosition;
      if (position > horizon) { beyond = true; break; }
      if (event.eventType !== EFFECT_TERMINAL_EVENT_TYPE) {
        return enumerationUnreadable("the index answered with a foreign event type");
      }
      const decoded = decodeTerminalEffectRecord(event.payload);
      if (!decoded.ok) {
        return enumerationUnreadable(`a durable terminal payload is ${decoded.reason}`);
      }
      const { record } = decoded;
      if (record.projectId !== request.projectId) continue;
      if (record.attemptRef === request.attemptRef) intentIds.add(record.intentId);
    }
    if (beyond) break;
    if (position === cursor) {
      if (page.hasMore) return enumerationUnreadable("a page advanced nothing while claiming more");
      break;
    }
    if (page.nextCursor !== position) return enumerationUnreadable("the pager cursor disagrees");
    if (!page.hasMore) break;
    cursor = position;
  }
  return { intentIds, ok: true as const };
}

/** Terminal / not terminal / UNKNOWN, one effect at a time, from the ledger's own reader. */
function splitEffects(
  store: SqliteEventStore, request: ReleaseTerminalRequest, intentIds: ReadonlySet<string>,
): ReleaseTerminalSplit | ReleaseTerminalRefusal {
  const terminal: string[] = [];
  const nonTerminal: string[] = [];
  for (const intentId of [...intentIds].sort()) {
    const current = readCurrentTerminalEffect(store, { ...request, intentId });
    if (current.ok) { terminal.push(intentId); continue; }
    if (current.code === "EFFECT_TERMINAL_ABSENT") { nonTerminal.push(intentId); continue; }
    return refuseReleaseTerminal("RELEASE_TERMINAL_EFFECT_UNKNOWN",
      `the terminal state of ${intentId} cannot be read`,
      { code: current.code, layer: current.layer });
  }
  return { nonTerminal, terminal };
}

type Probe = "FIXED" | "MOVABLE" | "UNKNOWN";

/** The durable row, field by field, as the reducers' own `ResourceRow`. Nothing is invented. */
const rowsOf = (member: AttemptResourceMember): Record<string, unknown>[] => [{
  capacityUnits: member.capacityUnits, effectIntentRef: member.effectIntentRef,
  epoch: member.epoch, external: member.external, fenceable: member.fenceable,
  resourceId: member.resourceId, state: member.state,
}];

/**
 * Asks the scheduler, four ways, whether this row still has a transition. A reducer that THROWS or
 * that cannot parse the row leaves the state unread, which is UNKNOWN and never terminal.
 * `grantSuccessorCapacity` accepts an unchanged set, so the resulting STATE is compared rather
 * than the verdict — reading `ok` alone would call every parsable row movable.
 */
function probeMember(member: AttemptResourceMember): Probe {
  const rows = rowsOf(member);
  const runs: readonly (() => AuthorityOutcome<AcquisitionSet>)[] = [
    () => adapterConfirm(rows, member.resourceId, member.epoch),
    () => adapterFail(rows, member.resourceId, member.epoch, "FAILED"),
    () => adapterFail(rows, member.resourceId, member.epoch, "UNKNOWN"),
    () => grantSuccessorCapacity(rows, PROBE_PROOF_REF),
  ];
  let movable = false;
  for (const run of runs) {
    let outcome: AuthorityOutcome<AcquisitionSet>;
    try { outcome = run(); } catch { return "UNKNOWN"; }
    if (!outcome.ok) {
      if (outcome.issues.some((issue) => issue.code === "AUTHORITY_MALFORMED_INPUT")) {
        return "UNKNOWN";
      }
      continue;
    }
    const next = outcome.value.rows[0];
    if (next === undefined || next.resourceId !== member.resourceId) return "UNKNOWN";
    if (next.state !== member.state) movable = true;
  }
  return movable ? "MOVABLE" : "FIXED";
}

const EMPTY_SPLIT: ReleaseTerminalSplit = Object.freeze({ nonTerminal: [], terminal: [] });

/** An ABSENT set is a readable durable answer — zero members, and therefore not proven terminal.
 *  Every other refusal keeps the resource authority's own code and its own refusing layer. */
function splitResources(
  store: SqliteEventStore, activationAggregateId: string, projectId: string,
): ReleaseTerminalSplit | ReleaseTerminalRefusal {
  const current = readAttemptResources(store, activationAggregateId, projectId);
  if (!current.ok) {
    return current.code === "ATTEMPT_RESOURCE_RECORD_ABSENT"
      ? EMPTY_SPLIT
      : refuseReleaseTerminal("RELEASE_TERMINAL_RESOURCE_UNKNOWN",
        "the durable resource set cannot be read",
        { code: current.code, layer: current.refusedBy });
  }
  const terminal: string[] = [];
  const nonTerminal: string[] = [];
  for (const member of current.members) {
    const probe = probeMember(member);
    if (probe === "UNKNOWN") {
      return refuseReleaseTerminal("RELEASE_TERMINAL_RESOURCE_UNKNOWN",
        `no scheduler reducer could read the state of ${member.resourceId}`,
        { code: "AUTHORITY_MALFORMED_INPUT", layer: "SCHEDULER_RESOURCE_AUTHORITY" });
    }
    (probe === "FIXED" ? terminal : nonTerminal).push(member.resourceId);
  }
  return { nonTerminal: nonTerminal.sort(), terminal: terminal.sort() };
}

const isRefusal = (
  value: ReleaseTerminalSplit | ReleaseTerminalRefusal,
): value is ReleaseTerminalRefusal => "ok" in value;

/** A re-read that THROWS counts as moved: an unreadable horizon is not a stable one, and
 *  this module owes its caller the fail-closed direction on every uncertainty. */
function horizonMoved(store: SqliteEventStore, captured: bigint): boolean {
  try { return store.readEventHorizon() !== captured; } catch { return true; }
}

/**
 * The whole answer, or a refusal that grants nothing. Reads only; no clock, no randomness, and no
 * consultation of `FoundationAttemptRecorded`, a process exit or a recovery inventory — none of
 * those decide terminality, and absence has never been terminality.
 */
export function deriveReleaseTerminalEvidence(
  store: SqliteEventStore, request: ReleaseTerminalRequest,
): ReleaseTerminalOutcome {
  const admitted = exactKeys(request, ["attemptRef", "projectId"]);
  // Each field is read ONCE and then judged. `exactKeys` returns the caller's own object, so a
  // second read could run an accessor that answers differently after passing `isText`.
  const attemptRef = admitted === null ? null : admitted["attemptRef"];
  const projectId = admitted === null ? null : admitted["projectId"];
  if (!isText(attemptRef) || !isText(projectId)) {
    return refuseReleaseTerminal("RELEASE_TERMINAL_REQUEST_INVALID",
      "the request is not an exact {attemptRef, projectId} record");
  }
  const identity: ReleaseTerminalRequest = { attemptRef, projectId };
  const bound = readFoundationActivationByAttempt(store, identity.projectId, identity.attemptRef);
  if (bound.status !== "BOUND") {
    return refuseReleaseTerminal("RELEASE_TERMINAL_BINDING_UNREADABLE",
      "no readable activation for this attempt", { code: bound.code, layer: bound.layer });
  }
  let horizon: bigint;
  try { horizon = store.readEventHorizon(); }
  catch { return enumerationUnreadable("the event horizon could not be captured"); }
  const walked = walkTerminalIntents(store, identity, horizon);
  if (!walked.ok) return walked;
  // SEEDED from the binding, which is why a zero-effect answer cannot exist.
  const effects = splitEffects(
    store, identity, new Set([bound.effectIntentId, ...walked.intentIds]));
  if (isRefusal(effects)) return effects;
  const resources = splitResources(store, bound.activationAggregateId, identity.projectId);
  if (isRefusal(resources)) return resources;
  // The horizon was the EFFECT walk's bound and the resource split never consulted it, so an
  // answer composed while the store grew could report a terminal TRUE over membership that has
  // since moved. "Unknown" and "terminal" demand opposite handling from a caller about to
  // release, so a bound this answer can no longer vouch for refuses instead of being reported.
  if (horizonMoved(store, horizon)) {
    return refuseReleaseTerminal("RELEASE_TERMINAL_RESOURCE_UNKNOWN",
      "the event horizon moved while this answer was composed");
  }
  const effectsTerminal = provenTerminal(effects);
  const resourcesTerminal = provenTerminal(resources);
  return Object.freeze({
    attemptRef: identity.attemptRef, effectsTerminal,
    enumeratedEffects: effects.terminal.length + effects.nonTerminal.length,
    enumeratedResources: resources.terminal.length + resources.nonTerminal.length,
    nonTerminalEffectRefs: Object.freeze([...effects.nonTerminal]),
    nonTerminalResourceRefs: Object.freeze([...resources.nonTerminal]),
    ok: true as const, projectId: identity.projectId,
    releasable: effectsTerminal && resourcesTerminal, resourcesTerminal,
    terminalEffectRefs: Object.freeze([...effects.terminal]),
    terminalResourceRefs: Object.freeze([...resources.terminal]),
  });
}
