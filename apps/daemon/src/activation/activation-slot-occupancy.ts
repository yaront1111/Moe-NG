import type { CursorPage, StoredEvent } from "@moe/store";

import {
  ATTEMPT_RELEASE_EVENT_TYPE,
  ATTEMPT_RELEASE_OUTCOMES,
  deriveAttemptReleaseAggregateId,
} from "../work/attempt-release-disposition.js";
import type { AttemptReleaseOutcomeName } from "../work/attempt-release-disposition.js";
import {
  decodeFoundationPayload, encodeFoundationPayload, sameBytes,
} from "../work/foundation-attempt-codec.js";
import { ACTIVATION_LEDGER_EVENT_TYPE } from "./activation-ledger-contracts.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";
import { tracedProject } from "./foundation-binding-predicates.js";

/**
 * The design-427 occupancy table, derived SERVER-SIDE from the durable store.
 *
 * `work-slot-ceiling.ts` counts whatever live-claim table it is handed, and that
 * table used to be the CALLER's `liveClaims` section — an empty table admitted a
 * fifth slot and a padded one manufactured exhaustion, because the one input the
 * ceiling judged was the one input no authority produced. This module derives
 * the table from committed evidence instead: every durable activation whose
 * provider slot occupies the default dimension, MINUS the attempts whose durable
 * release row records RELEASED. The caller's section stays admitted at the
 * envelope and decides nothing.
 *
 * TWO TYPE-FILTERED WALKS, SET-DIFFERENCED — the exact shape of
 * `in-flight-attempts.ts`, under the walk discipline of
 * `activation-ledger-reader.ts` `scanForEffect`: one horizon captured before any
 * page, strict per-page position increase, filter honesty re-checked, an empty
 * page may not claim more, and the cursor must name the last returned position.
 * Every activation candidate is decoded by the strict production reader
 * `readActivationLedgerRecord` BEFORE its dimension is even looked at: filtering
 * first would skip a malformed neighbour and answer a partial table as authority.
 *
 * A RELEASE ROW SUBTRACTS ONLY WHEN IT CLEANLY RECORDS `RELEASED`, read under
 * `readAttemptRelease`'s own decode discipline (decode, re-encode, byte-compare,
 * frozen outcome vocabulary). `DRAINING`, `NO_OP` and ABSENT all still HOLD the
 * slot: `attempt-release-disposition.ts:225-231` fixes that a draining release
 * keeps the durable slot fact exactly as the activation left it, because a slot
 * released mid-drain would claim the safe boundary the kernel just declined to
 * certify — and this table may not claim it either.
 *
 * FAIL CLOSED, NEVER EMPTY. A thrown read, a refused page, an undecodable or
 * ambiguous record, a drifted or orphaned release row — each refuses the WHOLE
 * derivation with its own code under this module's layer. An unreadable ledger
 * answered as an empty table would be the exact bypass this module closes.
 *
 * BOUNDED BY THE CAPTURED HORIZON, NOT BY A PAGE OR CANDIDATE COUNT (the 24c2adb
 * lesson): a fixed cap over an append-only stream bounds TOTAL PROJECT EVENTS,
 * past which every activation refuses forever — a refusal indistinguishable from
 * a real exhausted ceiling. Growth past the horizon is not this answer's
 * business: a row beyond it is neither counted nor subtracted, and refuses
 * nothing.
 */

const SCAN_PAGE_SIZE = 100;

const DEFAULT_SLOT_DIMENSION = "default";
const OCCUPYING_SLOT_STATES = Object.freeze(["RESERVED", "ACTIVE"] as const);

/** This module's own layer; no upstream refusal is ever restamped under it
 *  because none travels — every condition below is judged here. */
export const DAEMON_SLOT_OCCUPANCY = "DAEMON_SLOT_OCCUPANCY" as const;

/** Closed, and every member names a DIFFERENT repair: an unreachable store, a
 *  walk that cannot prove completeness, evidence traced to another project, an
 *  activation row that will not verify, two rows where one is the invariant, a
 *  release aggregate with two rows, a release row no committed activation
 *  explains, and a release row whose bytes or outcome drifted. */
export const ACTIVATION_SLOT_OCCUPANCY_CODES = Object.freeze([
  "ACTIVATION_SLOT_OCCUPANCY_UNREADABLE",
  "ACTIVATION_SLOT_OCCUPANCY_SCAN_INCOMPLETE",
  "ACTIVATION_SLOT_OCCUPANCY_PROJECT_MISMATCH",
  "ACTIVATION_SLOT_OCCUPANCY_RECORD_MALFORMED",
  "ACTIVATION_SLOT_OCCUPANCY_RECORD_AMBIGUOUS",
  "ACTIVATION_SLOT_OCCUPANCY_RELEASE_AMBIGUOUS",
  "ACTIVATION_SLOT_OCCUPANCY_RELEASE_ORPHANED",
  "ACTIVATION_SLOT_OCCUPANCY_RELEASE_DRIFT",
] as const);
export type ActivationSlotOccupancyCode = (typeof ACTIVATION_SLOT_OCCUPANCY_CODES)[number];

/** Shaped EXACTLY as `countOccupyingSlots` reads an entry — three own keys and
 *  no more — so the existing counting kernel consumes the derived table with no
 *  widening of its own fence. */
export interface SlotOccupancyEntry {
  readonly dimension: typeof DEFAULT_SLOT_DIMENSION;
  readonly slotRef: string;
  readonly state: (typeof OCCUPYING_SLOT_STATES)[number];
}

export interface SlotOccupancyRefusal {
  readonly ok: false;
  readonly code: ActivationSlotOccupancyCode;
  readonly layer: typeof DAEMON_SLOT_OCCUPANCY;
}

export type SlotOccupancyResult =
  | { readonly ok: true; readonly held: readonly SlotOccupancyEntry[] }
  | SlotOccupancyRefusal;

/** The exact store surface the derivation uses. Every commit method and the
 *  UNFILTERED pager are absent BY CONSTRUCTION: a reader that cannot name a
 *  write cannot perform one, and a port naming an argument its only caller does
 *  not use invites a fake to answer one. */
export interface SlotOccupancyStore {
  readEventHorizon(): bigint;
  readEventsByTypeAfter(
    eventType: string, afterGlobalPosition: bigint, limit?: number,
  ): CursorPage<StoredEvent, bigint>;
}

const refuse = (code: ActivationSlotOccupancyCode): SlotOccupancyRefusal =>
  Object.freeze({ code, layer: DAEMON_SLOT_OCCUPANCY, ok: false as const });

type TypedWalk =
  | { readonly ok: true; readonly events: ReadonlyMap<string, StoredEvent> }
  | SlotOccupancyRefusal;

/**
 * One INDEX-BACKED walk of one event type, bounded by the captured horizon.
 *
 * `duplicate` is the caller's own ambiguity code, because a second row on one
 * aggregate indicts a different writer per stream: the activation ledger's
 * exactly-one rule on one side, `readAttemptRelease`'s cardinality guard on the
 * other. Neither is ever resolved by picking one.
 */
function walkType(
  store: SlotOccupancyStore, eventType: string, projectId: string, horizon: bigint,
  duplicate: ActivationSlotOccupancyCode,
): TypedWalk {
  const events = new Map<string, StoredEvent>();
  let cursor = 0n;
  while (cursor < horizon) {
    let page: CursorPage<StoredEvent, bigint>;
    try { page = store.readEventsByTypeAfter(eventType, cursor, SCAN_PAGE_SIZE); }
    catch { return refuse("ACTIVATION_SLOT_OCCUPANCY_UNREADABLE"); }
    let position = cursor;
    let beyondHorizon = false;
    for (const event of page.items) {
      if (event.globalPosition <= position) {
        return refuse("ACTIVATION_SLOT_OCCUPANCY_SCAN_INCOMPLETE");
      }
      position = event.globalPosition;
      if (position > horizon) { beyondHorizon = true; break; }
      if (event.eventType !== eventType) {
        return refuse("ACTIVATION_SLOT_OCCUPANCY_SCAN_INCOMPLETE");
      }
      // Evidence traced to another project holds another project's slots, and
      // counting it here would exhaust this project's ceiling on foreign work.
      if (!tracedProject(event, projectId)) {
        return refuse("ACTIVATION_SLOT_OCCUPANCY_PROJECT_MISMATCH");
      }
      if (events.has(event.aggregateId)) return refuse(duplicate);
      events.set(event.aggregateId, event);
    }
    if (beyondHorizon) break;
    // A page that advanced nothing while claiming more is a never-ending walk,
    // and it is refused rather than spun on.
    if (position === cursor) {
      if (page.hasMore) return refuse("ACTIVATION_SLOT_OCCUPANCY_SCAN_INCOMPLETE");
      break;
    }
    if (page.nextCursor !== position) {
      return refuse("ACTIVATION_SLOT_OCCUPANCY_SCAN_INCOMPLETE");
    }
    if (!page.hasMore) break;
    cursor = position;
  }
  return Object.freeze({ events, ok: true as const });
}

/**
 * `readAttemptRelease`'s decode discipline over one WALKED row, and no laxer:
 * decode, RE-ENCODE, byte-compare, then re-read the outcome through the frozen
 * vocabulary — a row carrying an outcome no kernel ever answered subtracts
 * nothing and refuses everything. Cardinality is the walk's business (one row
 * per aggregate or `duplicate` fired), so only the byte judgement lives here.
 */
function releaseOutcomeOf(event: StoredEvent): AttemptReleaseOutcomeName | SlotOccupancyRefusal {
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return refuse("ACTIVATION_SLOT_OCCUPANCY_RELEASE_DRIFT");
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) {
    return refuse("ACTIVATION_SLOT_OCCUPANCY_RELEASE_DRIFT");
  }
  const stored = decoded.value["outcome"];
  const outcome = ATTEMPT_RELEASE_OUTCOMES.find((name) => name === stored);
  return outcome ?? refuse("ACTIVATION_SLOT_OCCUPANCY_RELEASE_DRIFT");
}

/**
 * The occupancy table the slot ceiling must count, or a refusal that admits
 * nothing. Entries carry the COMMITTED record's own slotRef and state, so the
 * table the kernel judges is the one the scheduler's transitions produced.
 */
export function deriveSlotOccupancy(
  store: SlotOccupancyStore, projectId: string,
): SlotOccupancyResult {
  let horizon: unknown;
  try { horizon = store.readEventHorizon(); }
  catch { return refuse("ACTIVATION_SLOT_OCCUPANCY_UNREADABLE"); }
  // An unreadable horizon is a store failure; a horizon that is not a
  // nonnegative bigint is evidence about nothing, and neither may become empty.
  if (typeof horizon !== "bigint" || horizon < 0n) {
    return refuse("ACTIVATION_SLOT_OCCUPANCY_SCAN_INCOMPLETE");
  }
  const activations = walkType(store, ACTIVATION_LEDGER_EVENT_TYPE, projectId, horizon,
    "ACTIVATION_SLOT_OCCUPANCY_RECORD_AMBIGUOUS");
  if (!activations.ok) return activations;
  const releases = walkType(store, ATTEMPT_RELEASE_EVENT_TYPE, projectId, horizon,
    "ACTIVATION_SLOT_OCCUPANCY_RELEASE_AMBIGUOUS");
  if (!releases.ok) return releases;
  // Identity only, over EVERY committed activation regardless of dimension or
  // state: a release row keyed to no activation at all is a broken durable
  // chain, not a subtraction. `commitRelease` derives its aggregate from an
  // activation the composer already re-read, so a healthy store cannot hold one
  // — and both walks share one horizon, so a release inside it proves its
  // earlier-positioned activation is inside it too.
  const explained = new Set<string>();
  for (const aggregateId of activations.events.keys()) {
    explained.add(deriveAttemptReleaseAggregateId(aggregateId));
  }
  for (const releaseAggregate of releases.events.keys()) {
    if (!explained.has(releaseAggregate)) {
      return refuse("ACTIVATION_SLOT_OCCUPANCY_RELEASE_ORPHANED");
    }
  }
  const held: SlotOccupancyEntry[] = [];
  for (const [aggregateId, event] of activations.events) {
    // VERIFIED BEFORE FILTERED: a candidate that will not verify refuses the
    // table even when its dimension would have excluded it from the count.
    const decoded = readActivationLedgerRecord(aggregateId, [event]);
    if (!decoded.ok) return refuse("ACTIVATION_SLOT_OCCUPANCY_RECORD_MALFORMED");
    const { providerSlot } = decoded.record;
    const state = OCCUPYING_SLOT_STATES.find((name) => name === providerSlot.state);
    if (providerSlot.dimension !== DEFAULT_SLOT_DIMENSION || state === undefined) continue;
    const release = releases.events.get(deriveAttemptReleaseAggregateId(aggregateId));
    if (release !== undefined) {
      const outcome = releaseOutcomeOf(release);
      if (typeof outcome !== "string") return outcome;
      if (outcome === "RELEASED") continue;
      // DRAINING and NO_OP fall through: the slot is still held.
    }
    held.push(Object.freeze({
      dimension: DEFAULT_SLOT_DIMENSION, slotRef: providerSlot.slotRef, state,
    }));
  }
  return Object.freeze({ held: Object.freeze(held), ok: true as const });
}
