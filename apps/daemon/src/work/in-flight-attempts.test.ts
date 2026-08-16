/**
 * The in-flight foundation attempt sweep, driven through a REAL file-backed
 * store and seeded through the PRODUCTION writer `commitFoundationPhase`.
 *
 * Every fixture is committed by the same function the dispatch path uses, so a
 * positive here is a shape production can actually produce; a hand-written event
 * would let the sweep pass against bytes nothing ever writes.
 *
 * WINDOWS HANDLE DISCIPLINE: every store is closed in a `finally` on every exit
 * path including throws. A handle held across the temp-directory cleanup throws
 * EPERM and kills the vitest worker with no output.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyCrash } from "@moe/runner";
import { SqliteEventStore } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  DAEMON_FOUNDATION_ATTEMPT, FOUNDATION_ATTEMPT_RECORD_VERSION,
  FOUNDATION_DISPATCH_EVENT_TYPES, FOUNDATION_RESERVATION_VERSION,
  decodeFoundationPayload, deriveDispatchAggregateId, encodeFoundationPayload,
} from "./foundation-attempt-contracts.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import { commitFoundationPhase } from "./foundation-attempt-store.js";
import { IN_FLIGHT_SITUATION_KEYS, readInFlightFoundationAttempts } from "./in-flight-attempts.js";

const PROJECT_ID = "in-flight-project";
const PRINCIPAL_ID = "principal-1";
const NOISE_EVENT_TYPE = "UnrelatedThingHappened";
const encoder = new TextEncoder();

const digestOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const targetOf = (slug: string): string => deriveDispatchAggregateId(`attempt-${slug}`);

function withDirectory<T>(name: string, run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-in-flight-${name}-`));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withStore<T>(name: string, run: (store: SqliteEventStore) => T): T {
  return withDirectory(name, (directory) => {
    const store = SqliteEventStore.openForProject(join(directory, "store.sqlite"), PROJECT_ID);
    try {
      return run(store);
    } finally {
      store.close();
    }
  });
}

function boundFor(slug: string, suffix = ""): FoundationAttemptBound {
  return Object.freeze({
    aggregateId: `attempt-${slug}`, claim: {}, commandId: `command-${slug}${suffix}`,
    correlationId: `correlation-${slug}${suffix}`, nodeKey: `node-${slug}`,
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID, sessionId: `session-${slug}`,
    target: targetOf(slug),
  });
}

/** The exact reservation body `foundation-attempt-service.ts` commits. */
function reservationBytes(slug: string): Uint8Array {
  const encoded = encodeFoundationPayload({
    activationDigest: digestOf(`activation-${slug}`), attemptAggregateId: `attempt-${slug}`,
    attemptId: `attempt-id-${slug}`, grantId: `grant-${slug}`, nodeKey: `node-${slug}`,
    recordVersion: FOUNDATION_RESERVATION_VERSION, requestDigest: digestOf(`request-${slug}`),
    sessionId: `session-${slug}`,
  });
  if (!encoded.ok) throw new Error(`reservation fixture refused: ${encoded.code}`);
  return encoded.bytes;
}

function recordBytes(slug: string): Uint8Array {
  const encoded = encodeFoundationPayload({
    attemptAggregateId: `attempt-${slug}`, recordVersion: FOUNDATION_ATTEMPT_RECORD_VERSION,
    truthClass: "PROVEN",
  });
  if (!encoded.ok) throw new Error(`record fixture refused: ${encoded.code}`);
  return encoded.bytes;
}

function commitPhase(
  store: SqliteEventStore, slug: string, tag: "RECORDED" | "RESERVED", bytes: Uint8Array,
  expectedVersion: number, suffix = "",
): void {
  const answer = commitFoundationPhase(
    store, boundFor(slug, suffix), tag, bytes, expectedVersion, `grant-${slug}${suffix}:${tag}`);
  if (answer === null || answer.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`seed ${tag} refused for ${slug}${suffix}`);
  }
}

const seedReserved = (store: SqliteEventStore, slug: string, bytes = reservationBytes(slug)): void =>
  commitPhase(store, slug, "RESERVED", bytes, 0);

const seedRecorded = (store: SqliteEventStore, slug: string, expectedVersion = 1): void =>
  commitPhase(store, slug, "RECORDED", recordBytes(slug), expectedVersion);

function seedNoise(store: SqliteEventStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const bytes = encoder.encode(`{"noise":${index}}`);
    store.commitExpectedVersionDecision({
      commandKind: "noise.write", committedResultBytes: bytes,
      correlationId: `noise-correlation-${index}`, decidedAt: "2026-08-16T00:00:00.000Z",
      events: [{ eventId: `noise-${index}`, eventType: NOISE_EVENT_TYPE, payload: bytes }],
      expectedVersion: 0,
      key: { commandId: `noise-${index}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      requestBytes: bytes, targetAggregateId: `noise-aggregate-${index}`,
    });
  }
}

function walkGlobalStream(store: SqliteEventStore): readonly StoredEvent[] {
  const seen: StoredEvent[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readEventsAfter(cursor, 1_000);
    seen.push(...page.items);
    if (!page.hasMore) return seen;
    const next = page.nextCursor;
    if (next === null || next <= cursor) throw new Error("global cursor did not advance");
    cursor = next;
  }
}

function refusalOf(answer: unknown): { code: string; ok: boolean; refusedBy: string } {
  const record = answer as { code: string; ok: boolean; refusedBy: string };
  return { code: record.code, ok: record.ok, refusedBy: record.refusedBy };
}

function attemptsOf(answer: unknown): readonly { attemptRef: string; situation: unknown }[] {
  const record = answer as {
    attempts?: readonly { attemptRef: string; situation: unknown }[]; ok: boolean;
  };
  if (record.ok !== true || record.attempts === undefined) {
    throw new Error(`sweep refused: ${JSON.stringify(answer)}`);
  }
  return record.attempts;
}

describe("readInFlightFoundationAttempts", () => {
  it("returns exactly the reserved attempts whose durable record is absent", () => {
    withStore("rule", (store) => {
      // A RESERVED with no RECORDED is in flight; the pair is finished; an
      // aggregate with neither was never dispatched at all.
      seedReserved(store, "live-one");
      seedReserved(store, "live-two");
      seedReserved(store, "finished");
      seedRecorded(store, "finished");

      const refs = attemptsOf(readInFlightFoundationAttempts(store, PROJECT_ID))
        .map((attempt) => attempt.attemptRef);

      expect(refs).toStrictEqual([targetOf("live-one"), targetOf("live-two")]);
      expect(refs).not.toContain(targetOf("finished"));
      expect(refs).not.toContain(targetOf("never-dispatched"));
    });
  });

  it("refuses a recorded attempt whose reservation is absent instead of dropping it", () => {
    withStore("lost-reservation", (store) => {
      seedReserved(store, "live-one");
      // A final record with no reservation means the reservation was LOST. That
      // is not "finished": silently absorbing it into the not-in-flight case
      // would hide a broken durable chain.
      commitPhase(store, "orphan", "RECORDED", recordBytes("orphan"), 0);

      expect(refusalOf(readInFlightFoundationAttempts(store, PROJECT_ID))).toStrictEqual({
        code: "FOUNDATION_ATTEMPT_DISPATCH_SUSPECT", ok: false,
        refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    });
  });

  it("refuses a duplicated reservation rather than resolving it to one entry", () => {
    withStore("ambiguous-reservation", (store) => {
      seedReserved(store, "twice");
      commitPhase(store, "twice", "RESERVED", reservationBytes("twice"), 1, "-again");

      expect(refusalOf(readInFlightFoundationAttempts(store, PROJECT_ID))).toStrictEqual({
        code: "FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS", ok: false,
        refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    });
  });

  it("refuses a duplicated final record, exactly as the single-attempt reader does", () => {
    withStore("ambiguous-record", (store) => {
      seedReserved(store, "twice");
      seedRecorded(store, "twice");
      commitPhase(store, "twice", "RECORDED", recordBytes("twice"), 2, "-again");

      expect(refusalOf(readInFlightFoundationAttempts(store, PROJECT_ID))).toStrictEqual({
        code: "FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS", ok: false,
        refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    });
  });

  it("refuses a drifted reservation payload, and the DECODER is what answered", () => {
    withStore("drift", (store) => {
      // Key order the canonical encoder would not emit. The bytes are valid at
      // the STORE layer (it commits them and hands them back unchanged) and at
      // the DECODE layer (they parse), so the only thing that can refuse is the
      // re-encode byte comparison inside the sweep.
      const drifted = encoder.encode(
        `{"sessionId":"session-drift","activationDigest":"${digestOf("activation-drift")}",`
        + `"attemptAggregateId":"attempt-drift","attemptId":"attempt-id-drift",`
        + `"grantId":"grant-drift","nodeKey":"node-drift",`
        + `"recordVersion":"${FOUNDATION_RESERVATION_VERSION}",`
        + `"requestDigest":"${digestOf("request-drift")}"}`);
      seedReserved(store, "drift", drifted);

      const stored = store.readEvents(targetOf("drift"))[0];
      expect(stored?.eventType).toBe(FOUNDATION_DISPATCH_EVENT_TYPES.RESERVED);
      expect(stored?.payload).toStrictEqual(drifted);
      expect(decodeFoundationPayload(stored?.payload).ok).toBe(true);

      expect(refusalOf(readInFlightFoundationAttempts(store, PROJECT_ID))).toStrictEqual({
        code: "FOUNDATION_ATTEMPT_RECORD_DRIFT", ok: false, refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    });
  });

  it("refuses dispatch evidence traced to another project", () => {
    withStore("project-fence", (store) => {
      seedReserved(store, "live-one");

      expect(refusalOf(readInFlightFoundationAttempts(store, "a-different-project"))).toStrictEqual({
        code: "FOUNDATION_ATTEMPT_BINDING_MISMATCH", ok: false,
        refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    });
  });

  it("builds the situation only from the decoded reservation's committed fields", () => {
    withStore("provenance", (store) => {
      seedReserved(store, "live-one");
      const [attempt] = attemptsOf(readInFlightFoundationAttempts(store, PROJECT_ID));

      // The expectation is derived by the PRODUCTION codec from the bytes the
      // store hands back, not rebuilt by a helper that reimplements the pick.
      const stored = store.readEvents(targetOf("live-one"))[0];
      const decoded = decodeFoundationPayload(stored?.payload);
      if (!decoded.ok) throw new Error(`fixture payload did not decode: ${decoded.code}`);
      const committed = Object.fromEntries(
        IN_FLIGHT_SITUATION_KEYS.map((key) => [key, decoded.value[key]]));

      expect(Object.keys(attempt?.situation as object)).toStrictEqual([...IN_FLIGHT_SITUATION_KEYS]);
      expect(attempt?.situation).toStrictEqual(committed);
      // No caller value reached it: the only caller-supplied argument is the
      // project id, and it appears nowhere in the situation.
      expect(JSON.stringify(attempt?.situation)).not.toContain(PROJECT_ID);
      // No clock reached it: two sweeps of the same durable bytes are identical.
      const [again] = attemptsOf(readInFlightFoundationAttempts(store, PROJECT_ID));
      expect(JSON.stringify(again?.situation)).toStrictEqual(JSON.stringify(attempt?.situation));
    });
  });

  it("hands reconciliation an honestly UNKNOWN situation rather than a fabricated crash", () => {
    withStore("no-fabrication", (store) => {
      seedReserved(store, "live-one");
      const [attempt] = attemptsOf(readInFlightFoundationAttempts(store, PROJECT_ID));

      // The dispatch aggregate carries no crash observation, so `classifyCrash`
      // must refuse with its OWN code. Inventing an observation to make this
      // classify would be manufacturing evidence the crash never produced.
      expect(classifyCrash(attempt?.situation)).toStrictEqual({
        kind: "REFUSED",
        failure: {
          code: "RECOVERY_OBSERVATION_MALFORMED", layer: "CLASSIFICATION",
          message: "the crash situation does not carry exactly records, observation and authority",
          ok: false,
        },
      });
    });
  });

  it("reads events proportional to attempt events, not to the whole stream", () => {
    withStore("bounded", (store) => {
      seedNoise(store, 80);
      seedReserved(store, "live-one");
      seedReserved(store, "live-two");
      seedReserved(store, "finished");
      seedRecorded(store, "finished");

      const stream = walkGlobalStream(store);
      expect(stream).toHaveLength(84);
      expect(stream.length).toBeGreaterThan(80);

      let served = 0;
      let pages = 0;
      let aggregateReads = 0;
      const counting = {
        getHealth: () => store.getHealth(),
        readEventHorizon: () => store.readEventHorizon(),
        readEvents: (aggregateId: string) => {
          aggregateReads += 1;
          return store.readEvents(aggregateId);
        },
        readEventsAfter: (after: bigint, limit?: number) => {
          const page = store.readEventsAfter(after, limit);
          pages += 1;
          served += page.items.length;
          return page;
        },
        readEventsByTypeAfter: (eventType: string, after: bigint, limit?: number) => {
          const page = store.readEventsByTypeAfter(eventType, after, limit);
          pages += 1;
          served += page.items.length;
          return page;
        },
      } as unknown as SqliteEventStore;

      // The bound is not bought by refusing: this is the same answer the
      // uncounted cases assert.
      expect(attemptsOf(readInFlightFoundationAttempts(counting, PROJECT_ID))
        .map((attempt) => attempt.attemptRef))
        .toStrictEqual([targetOf("live-one"), targetOf("live-two")]);

      // 4 dispatch events exist and 84 events do. A full-stream walk serves 84
      // and fails this; a per-reservation round trip fails `aggregateReads`.
      expect(served).toBeLessThanOrEqual(8);
      expect(pages).toBeLessThanOrEqual(4);
      expect(aggregateReads).toBe(0);
    });
  });

  it("refuses a pager that never advances instead of spinning on it", () => {
    withStore("endless", (store) => {
      const endless = {
        getHealth: () => store.getHealth(),
        readEventHorizon: () => 64n,
        readEvents: (aggregateId: string) => store.readEvents(aggregateId),
        readEventsByTypeAfter: () => ({ hasMore: true, items: [], nextCursor: 0n }),
      } as unknown as SqliteEventStore;

      expect(refusalOf(readInFlightFoundationAttempts(endless, PROJECT_ID))).toStrictEqual({
        code: "FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS", ok: false,
        refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    });
  });

  it("refuses an unreadable durable store rather than reporting nothing in flight", () => {
    withStore("unreadable", (store) => {
      // Seeded so the captured horizon is nonzero: on an empty store the walk
      // is correctly skipped and the injected failure would never be reached.
      seedReserved(store, "live-one");
      const broken = {
        getHealth: () => store.getHealth(),
        readEventHorizon: () => store.readEventHorizon(),
        readEvents: (aggregateId: string) => store.readEvents(aggregateId),
        readEventsByTypeAfter: () => { throw new Error("injected read failure"); },
      } as unknown as SqliteEventStore;

      expect(refusalOf(readInFlightFoundationAttempts(broken, PROJECT_ID))).toStrictEqual({
        code: "FOUNDATION_ATTEMPT_RECORD_AMBIGUOUS", ok: false,
        refusedBy: DAEMON_FOUNDATION_ATTEMPT,
      });
    });
  });

  it("answers an empty sweep on a store that holds no dispatch evidence at all", () => {
    withStore("empty", (store) => {
      seedNoise(store, 3);
      expect(attemptsOf(readInFlightFoundationAttempts(store, PROJECT_ID))).toStrictEqual([]);
    });
  });
});
