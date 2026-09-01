/**
 * THE STRICT PROJECT+ATTEMPT CURRENT SAFE-BOUNDARY LOOKUP (task-48c79a29, DoD 3).
 *
 * THE GAP IT CLOSES, measured rather than assumed. `recordSafeBoundaryObservation`
 * DOES derive and durably record an `observationRef`
 * (`safe-boundary-observation.ts:184`, written as the event id at :203), but the
 * release carrier keeps only `safeBoundaryObserved` and DISCARDS the ref
 * (`attempt-release-boundary.ts:97-99`) — and `readSafeBoundaryObservation` is
 * keyed by that ref alone. So a consumer holding an attempt identity had no way
 * to reach the observation the host recorded for it.
 *
 * THE SCAN LOCATES; THE DELEGATE DECIDES. This module walks the PRODUCER'S OWN
 * event vocabulary — `SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE`, imported so the two
 * modules cannot drift into two names for one stream — and takes exactly ONE
 * field out of the bytes it scans: `observationRef`, a LOCATOR. Every judgement
 * about whether that row is a valid observation, and whether it belongs to the
 * asking project, is `readSafeBoundaryObservation`'s. That delegation is what
 * stops a SECOND definition of "a valid observation" existing; two validators
 * drift and then disagree about the same row.
 *
 * WHY PROJECT OWNERSHIP IS NOT SCANNED FOR. Filtering the scan by project would
 * move that decision here and make the delegate's PROJECT_MISMATCH arm
 * unreachable — a strictness that exists but is never exercised is a strictness
 * that can be removed without a red test. The scan filters by ATTEMPT, which is
 * location; the delegate answers ownership, which is judgement.
 *
 * THE PRIVATE REF HASH IS NEVER DUPLICATED. `REF_DOMAIN`, `AGGREGATE_DOMAIN` and
 * `digestOf` stay module-private to the producer. Nothing here recomputes a ref;
 * the answer's `observationRef` is read off the DELEGATE'S certified record, not
 * off the scanned payload that merely pointed at it.
 *
 * ONE HORIZON, AND IT BOUNDS THE SCAN RATHER THAN GUARDING IT. The walk stops at
 * the global position the store held when it began, so a busy daemon writing
 * during the walk cannot lengthen it or make the "current" answer depend on when
 * the loop happened to finish. There is deliberately NO global re-check
 * afterwards: `readEventHorizon` moves on ANY write anywhere in the store, so a
 * re-check would refuse nearly every lookup on a live daemon — green in a quiet
 * test, useless in production. The aggregate-scoped guard is the delegate's own
 * read of the observation aggregate.
 */

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import {
  SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, readSafeBoundaryObservation,
} from "./safe-boundary-observation.js";
import type { SafeBoundaryObservation } from "./safe-boundary-observation.js";

const LAYER = "DAEMON_SAFE_BOUNDARY_LOOKUP";
export type SafeBoundaryLookupLayer = typeof LAYER;
export const SAFE_BOUNDARY_LOOKUP_LAYER: SafeBoundaryLookupLayer = LAYER;

/** ABSENT and UNRESOLVED are deliberately distinct: "this attempt observed
 *  nothing" and "the observation it named will not validate" demand opposite
 *  repairs, and collapsing them would let a corrupted row read as a fresh
 *  attempt. */
export const SAFE_BOUNDARY_LOOKUP_CODES = Object.freeze([
  "SAFE_BOUNDARY_LOOKUP_ABSENT", "SAFE_BOUNDARY_LOOKUP_QUERY_MALFORMED",
  "SAFE_BOUNDARY_LOOKUP_SCAN_UNREADABLE", "SAFE_BOUNDARY_LOOKUP_UNRESOLVED",
] as const);
export type SafeBoundaryLookupCode = (typeof SAFE_BOUNDARY_LOOKUP_CODES)[number];

/** The refusing authority's OWN code and layer, never restamped with this
 *  module's. `null` when nothing upstream was consulted. */
export interface SafeBoundaryLookupSource {
  readonly code: string; readonly layer: string;
}

export interface SafeBoundaryLookupRefused {
  readonly code: SafeBoundaryLookupCode; readonly layer: SafeBoundaryLookupLayer;
  readonly ok: false; readonly source: SafeBoundaryLookupSource | null;
}
export interface SafeBoundaryLookupAnswer {
  readonly observation: SafeBoundaryObservation;
  /** THE DELEGATE'S field, not the scanned string that located it. */
  readonly observationRef: string;
  readonly ok: true;
}
export type SafeBoundaryLookupOutcome = SafeBoundaryLookupAnswer | SafeBoundaryLookupRefused;

export interface SafeBoundaryLookupQuery {
  readonly attemptRef: string; readonly projectId: string;
}

/** The producer commits ONE event per observation aggregate, so a page this wide
 *  walks an attempt's whole history in a handful of round trips. */
const SCAN_PAGE_SIZE = 200;

const decoder = new TextDecoder();

const refuse = (
  code: SafeBoundaryLookupCode, source: SafeBoundaryLookupSource | null = null,
): SafeBoundaryLookupRefused => Object.freeze({ code, layer: LAYER, ok: false as const, source });

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * THE ONE FIELD TAKEN OUT OF SCANNED BYTES. A row that will not parse, or whose
 * ref is not a non-empty string, is not a locator — it is skipped rather than
 * refused, because an unrelated producer's malformed row must not make an honest
 * attempt's lookup fail. `attemptRef` is read only to decide whether this row
 * points at the asked-for attempt.
 */
function locatorOf(event: StoredEvent, attemptRef: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(event.payload)); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (row["attemptRef"] !== attemptRef) return null;
  const ref = row["observationRef"];
  return text(ref) ? ref : null;
}

/**
 * The producer's rows up to the captured horizon, newest last. `null` is the
 * STORE's failure, never an absence: answering "no rows" for a scan that never
 * completed would report an unobserved attempt where the truth is unknown.
 */
function scanLocators(
  store: SqliteEventStore, attemptRef: string, horizon: bigint,
): readonly string[] | null {
  const found: string[] = [];
  let cursor = 0n;
  try {
    for (;;) {
      const page = store.readEventsByTypeAfter(
        SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, cursor, SCAN_PAGE_SIZE);
      for (const event of page.items) {
        // THE HORIZON BOUND. Rows committed after the walk began are not part of
        // the answer this call was asked for.
        if (event.globalPosition > horizon) return found;
        const ref = locatorOf(event, attemptRef);
        if (ref !== null) found.push(ref);
      }
      if (!page.hasMore || page.nextCursor === null) return found;
      // A cursor that fails to advance would spin forever; it ends the scan as
      // unreadable rather than as a complete answer.
      if (page.nextCursor <= cursor) return null;
      cursor = page.nextCursor;
    }
  } catch { return null; }
}

/**
 * The CURRENT safe-boundary observation this project recorded for this attempt.
 *
 * LATEST WINS, matching `readReleaseHandoffBinding`: a re-observed attempt whose
 * durable run record moved derives a NEW ref, and the standing observation is the
 * newest. A replayed observation over an unchanged run derives the SAME ref and
 * the same single row, so a replay is not a second answer.
 */
export function readCurrentSafeBoundaryObservation(
  store: SqliteEventStore, query: SafeBoundaryLookupQuery,
): SafeBoundaryLookupOutcome {
  if (!text(query.attemptRef) || !text(query.projectId)) {
    return refuse("SAFE_BOUNDARY_LOOKUP_QUERY_MALFORMED");
  }
  let horizon: bigint;
  try { horizon = store.readEventHorizon(); }
  catch { return refuse("SAFE_BOUNDARY_LOOKUP_SCAN_UNREADABLE"); }
  const located = scanLocators(store, query.attemptRef, horizon);
  if (located === null) return refuse("SAFE_BOUNDARY_LOOKUP_SCAN_UNREADABLE");
  const newest = located[located.length - 1];
  if (newest === undefined) return refuse("SAFE_BOUNDARY_LOOKUP_ABSENT");
  // THE DELEGATE DECIDES. Validity, byte-agreement and project ownership are all
  // its judgement, and its refusal travels out under ITS code and ITS layer.
  const read = readSafeBoundaryObservation(
    store, { observationRef: newest, projectId: query.projectId });
  if (!read.ok) {
    return refuse("SAFE_BOUNDARY_LOOKUP_UNRESOLVED", { code: read.code, layer: read.layer });
  }
  return Object.freeze({
    observation: read.observation, observationRef: read.observation.observationRef,
    ok: true as const,
  });
}
