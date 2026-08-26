/**
 * THE BOUNDED LOCATOR SCAN (task-671cdd10): every sealed Foundation context manifest in
 * the store, judged whole, reduced to the attempts that belong to ONE expansion parent.
 *
 * A LOCATOR IS NOT AUTHORITY. This module answers "which attempts could the parent's
 * release be about", never "which release is current" — the orchestrator decides
 * zero/one/many and task-e62e3828's reader decides whether the winner is releasable.
 * Nothing here returns an intermediate success for a single row.
 *
 * NO EARLY RETURN ON A HIT, ever. The question is not "one matched" but "exactly one
 * did", and a later retry on a later page is the difference between a refusal and a
 * wrong answer. The walk is bounded by ONE externally captured horizon and by nothing
 * else: a page or candidate cap would bound TOTAL PROJECT CONTEXT SEALS, past which
 * every parent refuses forever on an append-only ledger.
 *
 * EVERY ROW IS VERIFIED BEFORE IT IS FILTERED. Deciding relevance first would skip a
 * malformed neighbour and return a partial answer as authority, so each row is decoded,
 * strict-read with its decision and receipt, byte-compared against the paged bytes and
 * parsed down to its four mandatory canonical items — and only then is an unrelated
 * node or revision allowed to be ignored.
 */

import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey, CommandDecisionRecord, CommandReceipt, CursorPage, StoredEvent,
} from "@moe/store";

import {
  FOUNDATION_CONTEXT_EVENT_TYPE, readFoundationContextManifest,
} from "../work/foundation-context-manifest-reader.js";
import { decodeFoundationContextManifestRecord }
  from "../work/foundation-context-manifest-codec.js";
import {
  refuseExpansionReleaseSelection,
} from "./expansion-release-selector-contracts.js";
import type { ExpansionReleaseSelectorRefused } from "./expansion-release-selector-contracts.js";
import { canonicalItems, itemsAgree, namesThisParent }
  from "./expansion-release-selector-items.js";
import type { ExpansionReleaseLocatorExpectation }
  from "./expansion-release-selector-items.js";

/** Read-only by construction: no commit, no outbox, no raw handle, no unfiltered pager. */
export interface ExpansionReleaseLocatorStore {
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  readEvents(aggregateId: string): readonly StoredEvent[];
  readEventsByTypeAfter(
    eventType: string, afterGlobalPosition: bigint, limit?: number,
  ): CursorPage<StoredEvent, bigint>;
}

export type { ExpansionReleaseLocatorExpectation };

/** Primitives only: holdable without holding the manifest. */
export interface ExpansionReleaseLocatorCandidate {
  readonly attemptRef: string;
  readonly sessionId: string;
}

export type ExpansionReleaseLocatorScan =
  | { readonly candidates: readonly ExpansionReleaseLocatorCandidate[]; readonly ok: true }
  | ExpansionReleaseSelectorRefused;

const PAGE_SIZE = 100;

const incomplete = (): ExpansionReleaseSelectorRefused =>
  refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_LOCATOR_SCAN_INCOMPLETE");
const unreadable = (source: string | null = null): ExpansionReleaseSelectorRefused =>
  refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_LOCATOR_EVIDENCE_UNREADABLE",
    source);
const spliced = (): ExpansionReleaseSelectorRefused =>
  refuseExpansionReleaseSelection("EXPANSION_RELEASE_SELECTOR_LOCATOR_BINDING_MISMATCH");

/** Byte equality, length first: a prefix must not read as a match. The `instanceof`
 *  pair is load-bearing — two non-binary payloads both report an undefined byteLength
 *  and would reach `.every` and CRASH where this reader has to refuse. */
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left instanceof Uint8Array && right instanceof Uint8Array
  && left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

/** A filtered scan has no positional contiguity, so the pager's contract IS the
 *  completeness proof and its shape is re-checked here before it is trusted. */
function wellShaped(page: unknown): page is CursorPage<StoredEvent, bigint> {
  if (page === null || typeof page !== "object") return false;
  const { hasMore, items, nextCursor } = page as Record<string, unknown>;
  if (typeof hasMore !== "boolean" || !Array.isArray(items)) return false;
  if (items.length > PAGE_SIZE) return false;
  return nextCursor === null || typeof nextCursor === "bigint";
}

/**
 * ONE row, judged whole: decode, strict-read the aggregate its own bytes name, prove the
 * paged row IS that aggregate's row byte-for-byte, then parse the digest-bound items.
 *
 * The strict read's expected binding is taken from the DECODED RECORD rather than from
 * the caller's expectation on purpose: this scan does not yet know which attempt it is
 * looking for, and deriving the slot from an expectation would make every unrelated seal
 * read back as a binding mismatch instead of being verified and then skipped. The
 * server-derived comparison happens in `namesThisParent`/`itemsAgree`, where a
 * disagreement is a decision rather than a lookup failure.
 */
function verifyRow(
  store: ExpansionReleaseLocatorStore, event: StoredEvent,
  expected: ExpansionReleaseLocatorExpectation,
): ExpansionReleaseSelectorRefused | ExpansionReleaseLocatorCandidate | null {
  const decoded = decodeFoundationContextManifestRecord(event.payload);
  if (!decoded.ok) return unreadable(decoded.code);
  const { record } = decoded;
  const durable = readFoundationContextManifest(store, {
    attemptRef: record.attemptRef, projectId: record.projectId, sessionId: record.sessionId,
  }, {
    configurationDigest: record.configurationDigest, graphContentHash: record.graphContentHash,
    graphEpoch: record.graphEpoch, graphRevisionRef: record.graphRevisionRef,
    inputManifestDigest: record.inputManifestDigest, nodeKey: record.nodeKey,
  });
  if (!durable.ok) return unreadable(durable.code);
  if (!sameBytes(durable.bytes, event.payload)) return unreadable("PAGED_ROW_DIVERGED");
  const items = canonicalItems(durable.record.manifest.binding.exactBytes);
  if (items === null) return unreadable("CANONICAL_ITEMS_UNUSABLE");
  if (!namesThisParent(durable.record, expected)) return null;
  if (!itemsAgree(items, durable.record, expected)) return spliced();
  return { attemptRef: durable.record.attemptRef, sessionId: durable.record.sessionId };
}

/**
 * Every sealed context manifest under `horizon`, reduced to this parent's candidates.
 *
 * Termination is the strict per-page position increase under the captured horizon. A row
 * beyond it refuses: a locator must not come from a ledger that moved.
 */
export function scanExpansionReleaseCandidates(
  store: ExpansionReleaseLocatorStore, expected: ExpansionReleaseLocatorExpectation,
  horizon: bigint,
): ExpansionReleaseLocatorScan {
  const candidates: ExpansionReleaseLocatorCandidate[] = [];
  let cursor = 0n;
  while (cursor < horizon) {
    let page: CursorPage<StoredEvent, bigint>;
    try {
      page = store.readEventsByTypeAfter(FOUNDATION_CONTEXT_EVENT_TYPE, cursor, PAGE_SIZE);
    } catch (error) {
      return unreadable(error instanceof DurableStoreError ? error.code : null);
    }
    if (!wellShaped(page)) return incomplete();
    let position = cursor;
    for (const event of page.items) {
      if (typeof event.globalPosition !== "bigint" || event.globalPosition <= position) {
        return incomplete();
      }
      position = event.globalPosition;
      if (position > horizon) return incomplete();
      if (event.eventType !== FOUNDATION_CONTEXT_EVENT_TYPE) return incomplete();
      const verified = verifyRow(store, event, expected);
      if (verified !== null && "ok" in verified) return verified;
      if (verified !== null) candidates.push(verified);
    }
    if (position === cursor) {
      if (page.hasMore) return incomplete();
      break;
    }
    if (page.nextCursor !== position) return incomplete();
    if (!page.hasMore) break;
    cursor = position;
  }
  return { candidates, ok: true as const };
}
