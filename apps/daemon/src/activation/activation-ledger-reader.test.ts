/**
 * The production reader for the durable activation ledger.
 *
 * Beside the unit it tests, which is also what makes the reader a published unit
 * rather than scaffolding: `runtime-entrypoint.test.ts` classifies a module as
 * runtime tier when it has a direct `.test.ts` sibling or is reached from one.
 * When these cases lived inside the codec suite the reader was reachable only
 * from a test, so the bridge guard correctly called its `.js` bridge unexpected.
 *
 * The reader is where authority is most easily invented, so every refusal case
 * is paired with a POSITIVE accepted control through the SAME production reader
 * (task rail 2). A table of refusals with no accepted control is passed by a
 * reader that refuses everything — the worst possible bug here, dressed as the
 * safest one.
 */

import type { CursorPage, StoreHealth, StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  ACTIVATION_LEDGER_LAYER,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import {
  DERIVED,
  EFFECT_AGGREGATE,
  encodedBytes,
  record,
  storedEvent,
} from "./activation-ledger-fixtures.js";
import {
  readActivationLedgerRecord,
  readCurrentEffectSessionBinding,
} from "./activation-ledger-reader.js";
import type { FoundationBindingStore } from "./activation-ledger-reader.js";
import { FOUNDATION_ACTIVATION_BINDING_LAYER } from "./foundation-activation-transition.js";

describe("activation ledger reader", () => {
  it("accepts exactly one correctly typed event and returns the record", () => {
    const read = readActivationLedgerRecord(DERIVED, [storedEvent()]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toEqual(record());
  });

  const REFUSALS: readonly {
    readonly name: string;
    readonly code: string;
    readonly events: readonly StoredEvent[];
  }[] = [
    { code: "ACTIVATION_LEDGER_EVIDENCE_ABSENT", events: [], name: "zero events" },
    {
      code: "ACTIVATION_LEDGER_EVIDENCE_AMBIGUOUS",
      events: [storedEvent(), storedEvent({ aggregateSequence: 2, eventId: "grant-0002" })],
      name: "two events",
    },
    {
      code: "ACTIVATION_LEDGER_EVENT_TYPE_UNEXPECTED",
      events: [storedEvent({ eventType: "SomethingElseHappened" })],
      name: "wrong event type",
    },
    {
      code: "ACTIVATION_LEDGER_EVENT_ID_MISMATCH",
      events: [storedEvent({ eventId: "not-the-grant-id" })],
      name: "event id is not the record's grantId",
    },
    {
      code: "ACTIVATION_LEDGER_BYTES_MALFORMED",
      events: [
        storedEvent({ payload: encodedBytes().subarray(0, encodedBytes().byteLength - 10) }),
      ],
      name: "truncated bytes",
    },
  ];

  for (const refusal of REFUSALS) {
    it(`refuses ${refusal.name} as UNKNOWN with its exact code and layer`, () => {
      const read = readActivationLedgerRecord(DERIVED, refusal.events);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.code).toBe(refusal.code);
      expect(read.layer).toBe(ACTIVATION_LEDGER_LAYER);
      expect(read.outcome).toBe("UNKNOWN");
      // POSITIVE CONTROL, same production reader, same call shape: a reader that
      // refuses everything cannot pass this table.
      expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
    });
  }

  it("refuses a payload whose derived aggregate id disagrees with the event's aggregate", () => {
    const read = readActivationLedgerRecord(
      deriveActivationAggregateId(EFFECT_AGGREGATE, "a-different-idempotency-key"),
      [storedEvent({ aggregateId: deriveActivationAggregateId(EFFECT_AGGREGATE, "a-different-idempotency-key") })],
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ACTIVATION_LEDGER_AGGREGATE_MISMATCH");
    expect(read.layer).toBe(ACTIVATION_LEDGER_LAYER);
    expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
  });

  it("refuses when the successor intent version does not follow its predecessor", () => {
    const drifted = record({ predecessorIntentVersion: 1 });
    const read = readActivationLedgerRecord(DERIVED, [
      storedEvent({ payload: encodedBytes(drifted) }),
    ]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ACTIVATION_LEDGER_VERSION_MISMATCH");
    expect(read.layer).toBe(ACTIVATION_LEDGER_LAYER);
    expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
  });

  it("refuses when the successor attempt version does not follow its predecessor", () => {
    const drifted = record({ predecessorAttemptVersion: 1 });
    const read = readActivationLedgerRecord(DERIVED, [
      storedEvent({ payload: encodedBytes(drifted) }),
    ]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ACTIVATION_LEDGER_VERSION_MISMATCH");
    expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
  });

  it("refuses a digest that does not cover the bytes it is carried with", () => {
    const forged = Uint8Array.from(encodedBytes());
    // The LAST byte is the final hex character of the trailing digest. Index
    // -65 would be the digest frame's own length prefix, which refuses as
    // malformed framing and would never reach the digest comparison at all.
    const last = forged.byteLength - 1;
    forged[last] = forged[last] === 97 ? 98 : 97;
    const read = readActivationLedgerRecord(DERIVED, [storedEvent({ payload: forged })]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe("ACTIVATION_LEDGER_DIGEST_MISMATCH");
    expect(readActivationLedgerRecord(DERIVED, [storedEvent()]).ok).toBe(true);
  });
});

/**
 * The effect scan, driven through the reader's OWN port.
 *
 * WHY THE PORT AND NOT A FILE-BACKED STORE. Two of these properties cannot be
 * observed any other way. The cost bound is a statement about how many events
 * the READER consumed, which is only countable at the seam the reader reads
 * through; and the hostile-page cases require pages a correct store will never
 * produce. The real-store proofs — the BOUND answer, and the same cost bound
 * measured against a genuine 6,500-event SqliteEventStore — live in
 * `foundation-launch-authority.test.ts`, which owns the production commit path.
 *
 * The pager below mirrors the store's published contract rather than inventing
 * one: `nextCursor` is the LAST RETURNED ITEM's global position, `hasMore` is
 * computed over the SAME filtered source the page was drawn from, and an empty
 * page is `{hasMore:false, items:[], nextCursor:null}`. All three are pinned on
 * the production surface by task-69's
 * `packages/store/src/event-read-model-contract.test.ts`, case "pages only exact
 * event-type matches across an interleaved ledger".
 *
 * WHAT A "FOUND" ANSWER LOOKS LIKE HERE. These fixtures are hand-written, so
 * `validateActivationCommit` can never call them COHERENT and BOUND is
 * unreachable by construction — that is the whole reason the real-store suite
 * exists. So a match is not asserted through the final status; it is asserted
 * DIRECTLY, through the aggregate id the scan hands to `readEvents`, which is
 * `scanForEffect`'s literal output. `aggregateReads` is that output.
 */
describe("effect scan", () => {
  const SCAN_PROJECT = "scan-project";
  const NOISE_TYPE = "FoundationScanNoiseObserved";
  const SECOND_KEY = "idem-key-2";
  const SECOND_GRANT = "grant-0002";
  const SECOND_DERIVED = deriveActivationAggregateId(EFFECT_AGGREGATE, SECOND_KEY);
  const INTENT_ID = record().effectIntent.intentId;

  /** Encoded ONCE. Re-encoding per event costs a hash each and turns the 6,500
   *  case into a minute of fixture construction that proves nothing. */
  const FIRST_PAYLOAD = encodedBytes();
  const SECOND_PAYLOAD = encodedBytes(record({
    effectIntent: { ...record().effectIntent, idempotencyKey: SECOND_KEY },
    grant: { ...record().grant, grantId: SECOND_GRANT },
  }));
  const NOISE_TEMPLATE = storedEvent({ eventType: NOISE_TYPE, payload: new Uint8Array(0) });
  const FIRST_TEMPLATE = storedEvent({ payload: FIRST_PAYLOAD });
  const SECOND_TEMPLATE = storedEvent({
    aggregateId: SECOND_DERIVED, eventId: SECOND_GRANT, payload: SECOND_PAYLOAD,
  });

  const noiseAt = (globalPosition: bigint): StoredEvent => ({
    ...NOISE_TEMPLATE, aggregateId: `noise-${globalPosition}`,
    eventId: `noise-${globalPosition}`, globalPosition,
  });
  const firstAt = (globalPosition: bigint): StoredEvent => ({ ...FIRST_TEMPLATE, globalPosition });
  const secondAt = (globalPosition: bigint): StoredEvent => ({ ...SECOND_TEMPLATE, globalPosition });

  interface ScanCounter {
    readonly aggregateReads: string[];
    events: number;
    pages: number;
  }

  const counter = (): ScanCounter => ({ aggregateReads: [], events: 0, pages: 0 });

  function pageOver(
    source: readonly StoredEvent[], after: bigint, limit: number,
  ): CursorPage<StoredEvent, bigint> {
    const items = source.filter((event) => event.globalPosition > after).slice(0, limit);
    const last = items.at(-1);
    if (last === undefined) return { hasMore: false, items: [], nextCursor: null };
    return {
      hasMore: source.some((event) => event.globalPosition > last.globalPosition),
      items,
      nextCursor: last.globalPosition,
    };
  }

  interface StoreOptions {
    readonly horizon?: bigint;
    readonly onPage?: (page: CursorPage<StoredEvent, bigint>) => CursorPage<StoredEvent, bigint>;
    readonly throwOnRead?: boolean;
  }

  function scanStore(
    events: readonly StoredEvent[], tally: ScanCounter, options: StoreOptions = {},
  ): FoundationBindingStore {
    const horizon = options.horizon
      ?? events.reduce((high, event) => event.globalPosition > high ? event.globalPosition : high, 0n);
    const served = (page: CursorPage<StoredEvent, bigint>): CursorPage<StoredEvent, bigint> => {
      const shaped = options.onPage === undefined ? page : options.onPage(page);
      tally.pages += 1;
      tally.events += shaped.items.length;
      return shaped;
    };
    // Deliberately NOT annotated as FoundationBindingStore at the literal: the
    // filtered method is what this task adds, and an excess-property check on
    // the literal would fail the file before the port grows to declare it.
    const fake = {
      getHealth: (): StoreHealth => ({ projectId: SCAN_PROJECT }) as unknown as StoreHealth,
      readEventHorizon: (): bigint => horizon,
      readEvents: (aggregateId: string): readonly StoredEvent[] => {
        tally.aggregateReads.push(aggregateId);
        return events.filter((event) => event.aggregateId === aggregateId);
      },
      readEventsAfter: (after: bigint, limit = 100): CursorPage<StoredEvent, bigint> => {
        if (options.throwOnRead === true) throw new Error("injected read failure");
        return served(pageOver(events, after, limit));
      },
      readEventsByTypeAfter: (
        eventType: string, after: bigint, limit = 100,
      ): CursorPage<StoredEvent, bigint> => {
        if (options.throwOnRead === true) throw new Error("injected read failure");
        return served(pageOver(events.filter((event) => event.eventType === eventType), after, limit));
      },
    };
    return fake;
  }

  function bindingOver(
    events: readonly StoredEvent[], tally: ScanCounter, options: StoreOptions = {},
    effectId: string = INTENT_ID,
  ): ReturnType<typeof readCurrentEffectSessionBinding> {
    return readCurrentEffectSessionBinding(
      scanStore(events, tally, options), SCAN_PROJECT, effectId, "session-1", 0,
    );
  }

  function codeOf(answer: ReturnType<typeof readCurrentEffectSessionBinding>): string {
    return answer.status === "BOUND" ? "BOUND" : `${answer.status}:${answer.code}`;
  }

  function expectLayer(answer: ReturnType<typeof readCurrentEffectSessionBinding>): void {
    expect(answer.status === "BOUND" ? null : answer.layer)
      .toBe(FOUNDATION_ACTIVATION_BINDING_LAYER);
  }

  it("resolves exactly the matching aggregate out of an interleaved ledger", () => {
    const tally = counter();
    const answer = bindingOver(
      [noiseAt(1n), noiseAt(2n), firstAt(3n), noiseAt(4n), noiseAt(5n)], tally,
    );
    // THE SCAN'S LITERAL OUTPUT: the one aggregate it resolved, read exactly once.
    expect(tally.aggregateReads).toStrictEqual([DERIVED]);
    // Past the scan, these hand-written fixtures carry no decision trace, so the
    // history fold refuses on project provenance. That is the post-scan phase,
    // not this case's subject; what it pins is that the scan got that far AT ALL,
    // which NOT_FOUND below shows it does not do when nothing matches.
    expect(codeOf(answer)).toBe("UNKNOWN:FOUNDATION_BINDING_PROJECT_MISMATCH");
    expectLayer(answer);
  });

  it("answers NOT_FOUND for an effect no committed activation claims", () => {
    const tally = counter();
    const answer = bindingOver(
      [noiseAt(1n), firstAt(2n), noiseAt(3n)], tally, {}, "absent-effect",
    );
    expect(codeOf(answer)).toBe("ABSENT:FOUNDATION_BINDING_NOT_FOUND");
    // NOT the same thing as "found and then refused": no aggregate was resolved.
    expect(tally.aggregateReads).toStrictEqual([]);
  });

  it("answers NOT_FOUND on a ledger holding no activation of any kind", () => {
    const tally = counter();
    const answer = bindingOver([noiseAt(1n), noiseAt(2n)], tally);
    expect(codeOf(answer)).toBe("ABSENT:FOUNDATION_BINDING_NOT_FOUND");
    expect(tally.aggregateReads).toStrictEqual([]);
  });

  /**
   * THE NO-EARLY-RETURN RULE, and the only case that catches breaking it.
   *
   * The second match is placed at the LAST position on purpose. A rewrite that
   * returns as soon as it holds a match answers this correctly on every other
   * case in this file and wrongly only here, because only here is the disproof
   * of uniqueness strictly after the first hit.
   */
  it("refuses a second aggregate claiming the same effect as AMBIGUOUS", () => {
    const tally = counter();
    const answer = bindingOver(
      [noiseAt(1n), firstAt(2n), noiseAt(3n), noiseAt(4n), secondAt(5n)], tally,
    );
    expect(codeOf(answer)).toBe("UNKNOWN:FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS");
    expectLayer(answer);
    // The refusal came from the scan, not from a later fold over one aggregate.
    expect(tally.aggregateReads).toStrictEqual([]);
  });

  it("accepts one aggregate appearing sparsely across many pages", () => {
    const tally = counter();
    const events = [
      ...Array.from({ length: 250 }, (_unused, index) => noiseAt(BigInt(index + 1))),
      firstAt(251n),
      ...Array.from({ length: 250 }, (_unused, index) => noiseAt(BigInt(index + 252))),
    ];
    expect(events).toHaveLength(501);
    const answer = bindingOver(events, tally);
    expect(tally.aggregateReads).toStrictEqual([DERIVED]);
    expect(codeOf(answer)).toBe("UNKNOWN:FOUNDATION_BINDING_PROJECT_MISMATCH");
  });

  /**
   * GROWTH PAST THE CAPTURED HORIZON IS NOT THIS ANSWER'S BUSINESS.
   *
   * Both halves matter and they fail differently. A match that exists ONLY past
   * H must not be returned; a SECOND match past H must not turn a sound unique
   * answer into an ambiguity refusal. Without the second half the horizon bound
   * could be dropped entirely and only the first half would notice.
   */
  it("ignores an activation committed past the captured horizon", () => {
    const onlyPast = counter();
    const absent = bindingOver([noiseAt(1n), noiseAt(2n), firstAt(3n)], onlyPast, { horizon: 2n });
    expect(codeOf(absent)).toBe("ABSENT:FOUNDATION_BINDING_NOT_FOUND");
    expect(onlyPast.aggregateReads).toStrictEqual([]);

    const secondPast = counter();
    const unique = bindingOver(
      [firstAt(1n), noiseAt(2n), secondAt(3n)], secondPast, { horizon: 2n },
    );
    expect(codeOf(unique)).not.toBe("UNKNOWN:FOUNDATION_BINDING_EVIDENCE_AMBIGUOUS");
    expect(secondPast.aggregateReads).toStrictEqual([DERIVED]);
  });

  it("refuses an activation whose payload does not decode as MALFORMED", () => {
    const tally = counter();
    const truncated: StoredEvent = {
      ...firstAt(2n), payload: FIRST_PAYLOAD.subarray(0, FIRST_PAYLOAD.byteLength - 10),
    };
    const answer = bindingOver([noiseAt(1n), truncated], tally);
    expect(codeOf(answer)).toBe("UNKNOWN:FOUNDATION_BINDING_EVIDENCE_MALFORMED");
    expectLayer(answer);
  });

  it("refuses a throwing page read as UNREADABLE", () => {
    const tally = counter();
    const answer = bindingOver([noiseAt(1n), firstAt(2n)], tally, { throwOnRead: true });
    expect(codeOf(answer)).toBe("UNKNOWN:FOUNDATION_BINDING_EVIDENCE_UNREADABLE");
    expectLayer(answer);
  });

  /**
   * THE OBJECTIVE, STATED AS A NUMBER THE OLD SCAN CANNOT MEET.
   *
   * `tally.events` counts events HANDED TO THE READER, so it is the reader's own
   * consumption and not a property of this fake. The global-walk implementation
   * must read all 6,501; the type-filtered one reads the single match. The bound
   * is a literal rather than a fraction of the stream size because a fraction
   * would move with whatever the implementation happens to do.
   */
  it("reads a number of events bounded by the MATCHES, not by the stream", () => {
    const stream = 6_500;
    const events = [
      ...Array.from({ length: stream }, (_unused, index) => noiseAt(BigInt(index + 1))),
      firstAt(BigInt(stream + 1)),
    ];
    expect(events).toHaveLength(stream + 1);
    const tally = counter();
    const answer = bindingOver(events, tally);
    expect(tally.aggregateReads).toStrictEqual([DERIVED]);
    expect(codeOf(answer)).toBe("UNKNOWN:FOUNDATION_BINDING_PROJECT_MISMATCH");
    // One match exists, so one event is the honest floor; 8 leaves room for the
    // terminating empty page without leaving room for a stream walk.
    expect(tally.events).toBeLessThanOrEqual(8);
    expect(tally.pages).toBeLessThanOrEqual(2);
    // The case was actually generated at the size it claims.
    expect(events.at(-1)?.eventType).toBe(ACTIVATION_LEDGER_EVENT_TYPE);
    expect(Number(events.at(-1)?.globalPosition ?? 0n)).toBeGreaterThan(stream);
  });

  /**
   * PAGE SHAPES A CORRECT STORE NEVER PRODUCES.
   *
   * Under the global walk these were caught by positional contiguity. A filtered
   * pager returns sparse positions by construction, so contiguity is gone and
   * each case below names the guard that replaces it. Every fixture is a REAL
   * activation event, not noise: if these were the wrong event type the type
   * guard would answer every case and the whole table would pass while testing
   * one comparison.
   */
  const HOSTILE: readonly {
    readonly name: string;
    readonly page: CursorPage<StoredEvent, bigint>;
  }[] = [
    {
      name: "a position repeated inside one page",
      page: { hasMore: false, items: [firstAt(1n), firstAt(1n)], nextCursor: 1n },
    },
    {
      name: "a position that goes backwards inside one page",
      page: { hasMore: false, items: [firstAt(2n), firstAt(1n)], nextCursor: 2n },
    },
    {
      name: "a cursor that does not name the last returned position",
      page: { hasMore: false, items: [firstAt(1n)], nextCursor: null },
    },
    {
      name: "a cursor left behind the last returned position",
      page: { hasMore: true, items: [firstAt(1n)], nextCursor: 0n },
    },
    {
      name: "an empty page claiming there is more",
      page: { hasMore: true, items: [], nextCursor: null },
    },
    {
      name: "an event the type filter should have excluded",
      page: { hasMore: false, items: [noiseAt(1n)], nextCursor: 1n },
    },
  ];

  for (const hostile of HOSTILE) {
    it(`refuses ${hostile.name} as SCAN_INCOMPLETE`, () => {
      const tally = counter();
      let served = 0;
      const answer = bindingOver([firstAt(1n), firstAt(2n), firstAt(3n)], tally, {
        horizon: 3n,
        onPage: (page) => served++ === 0 ? hostile.page : page,
      });
      expect(served).toBeGreaterThan(0);
      expect(codeOf(answer)).toBe("UNKNOWN:FOUNDATION_BINDING_SCAN_INCOMPLETE");
      expectLayer(answer);
    });
  }

  it("accepts the honest page shape the hostile table is measured against", () => {
    // POSITIVE CONTROL. Without it a reader that refused every page shape would
    // pass all six cases above, which is the worst bug here wearing the safest
    // possible disguise.
    const tally = counter();
    const answer = bindingOver([firstAt(1n), firstAt(2n), firstAt(3n)], tally, { horizon: 3n });
    expect(codeOf(answer)).not.toBe("UNKNOWN:FOUNDATION_BINDING_SCAN_INCOMPLETE");
    expect(tally.aggregateReads).toStrictEqual([DERIVED]);
  });
});
