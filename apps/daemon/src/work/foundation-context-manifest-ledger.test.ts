/**
 * The Foundation context-manifest ledger, driven through a REAL file-backed
 * SqliteEventStore on a temp file.
 *
 * WHY A REAL STORE. The one property this module exists to hold — a REPLAYED
 * disposition answers from the DURABLE event rather than from the caller's
 * candidate — is a property of the store's replay identity, which hashes
 * `requestBytes` and NOT the proposed events. A fake store would let the test
 * author decide what a replay is; only the real one can prove that a second
 * caller handing a DIFFERENT manifest under the same identity still gets the
 * first commit's bytes back.
 *
 * WINDOWS HANDLE DISCIPLINE: every store handle is closed in a `finally` before
 * the temp directory is removed. A handle held across the cleanup throws EPERM
 * and kills the vitest worker with no test output at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DurableStoreError, SqliteEventStore } from "@moe/store";
import type {
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
  EventDraft,
  StoredEvent,
} from "@moe/store";
import { renderContext, selectContext } from "@moe/context";
import type { ContextRenderManifest } from "@moe/context";
import { describe, expect, it } from "vitest";

import {
  FOUNDATION_CONTEXT_CODEC,
  FOUNDATION_CONTEXT_RECORD_VERSION,
  deriveFoundationContextRecordDigest,
  encodeFoundationContextManifestRecord,
} from "./foundation-context-manifest-codec.js";
import type { FoundationContextManifestRecord } from "./foundation-context-manifest-codec.js";
import {
  FOUNDATION_CONTEXT_COMMAND_KIND,
  FOUNDATION_CONTEXT_EVENT_TYPE,
  FOUNDATION_CONTEXT_LEDGER,
  FOUNDATION_CONTEXT_LEDGER_CODES,
  FOUNDATION_CONTEXT_READER,
  commitFoundationContextManifest,
  deriveFoundationContextAggregateId,
  deriveFoundationContextDecisionKey,
  deriveFoundationContextRequestBytes,
} from "./foundation-context-manifest-ledger.js";
import type {
  FoundationContextLedgerResult,
  FoundationContextLedgerStore,
} from "./foundation-context-manifest-ledger.js";

const PROJECT_ID = "proj-foundation-context";
const DECIDED_AT = "2026-08-18T00:00:00.000Z";
const encoder = new TextEncoder();

/** Written out by hand. Do not replace with a map over the production list. */
const EXPECTED_LEDGER_CODES = [
  "FOUNDATION_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT",
  "FOUNDATION_CONTEXT_LEDGER_REPLAY_DIVERGED",
  "FOUNDATION_CONTEXT_LEDGER_STORE_UNAVAILABLE",
  "FOUNDATION_CONTEXT_READER_ABSENT",
  "FOUNDATION_CONTEXT_READER_AMBIGUOUS",
  "FOUNDATION_CONTEXT_READER_EVENT_TYPE_UNEXPECTED",
  "FOUNDATION_CONTEXT_READER_UNREADABLE",
] as const;

// --- fixtures ----------------------------------------------------------------

/** A genuine `renderContext` output over the given text — never hand-forged. */
function manifestFor(text: string): ContextRenderManifest {
  const selected = selectContext({
    byteBudget: 4_096,
    exclusions: [],
    mandatory: [{ id: "m-1", section: "brief", content: text, kind: "MANDATORY" }],
    optional: [],
  });
  if (selected.kind !== "ADMITTED") {
    throw new Error(`fixture selection refused: ${selected.code}`);
  }
  return renderContext(selected.selection).manifest;
}

function outerFields(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptRef: "attempt-0000000000000001",
    configurationDigest: "c".repeat(64),
    graphContentHash: "a".repeat(64),
    graphEpoch: 3,
    graphRevisionRef: "graph-revision-1",
    inputManifestDigest: "d".repeat(64),
    manifest: manifestFor("the task"),
    nodeKey: "dev-c",
    projectId: PROJECT_ID,
    sessionId: "session-0000000000000001",
    ...patch,
  };
}

/** A well-formed candidate; the digest comes from the PRODUCTION deriver. */
function candidate(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const fields = outerFields(patch);
  return { ...fields, recordDigest: deriveFoundationContextRecordDigest(fields) };
}

interface Sealed {
  readonly bytes: Uint8Array;
  readonly record: FoundationContextManifestRecord;
}

/** What the codec admits for a fixture, so the test can compare durable bytes. */
function sealed(patch: Record<string, unknown> = {}): Sealed {
  const encoded = encodeFoundationContextManifestRecord(candidate(patch));
  if (!encoded.ok) throw new Error(`fixture refused by the codec: ${encoded.code}`);
  return { bytes: encoded.bytes, record: encoded.record };
}

const BASE = sealed();
const DERIVED_AGGREGATE = deriveFoundationContextAggregateId(BASE.record);

// --- harness -----------------------------------------------------------------

function withDirectory<T>(name: string, run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-context-ledger-${name}-`));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withStore<T>(databasePath: string, run: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

interface StoreSpy extends FoundationContextLedgerStore {
  readonly calls: string[];
}

/**
 * A delegate over the REAL store. Every forwarded call lands in the same file
 * the assertions reopen; the faults are injected only where the store's own API
 * cannot produce the durable state under test.
 */
function spyOn(
  store: SqliteEventStore,
  faults: { readonly commitThrows?: Error; readonly readEventsAs?: readonly StoredEvent[];
    readonly readThrows?: Error } = {},
): StoreSpy {
  const calls: string[] = [];
  return {
    calls,
    commitExpectedVersionDecision(
      input: CommitExpectedVersionDecisionInput,
    ): CommandDecisionResponse {
      calls.push("commitExpectedVersionDecision");
      if (faults.commitThrows !== undefined) throw faults.commitThrows;
      return store.commitExpectedVersionDecision(input);
    },
    readEvents(aggregateId: string): readonly StoredEvent[] {
      calls.push("readEvents");
      if (faults.readThrows !== undefined) throw faults.readThrows;
      return faults.readEventsAs ?? store.readEvents(aggregateId);
    },
  };
}

function commit(
  store: FoundationContextLedgerStore,
  patch: Record<string, unknown> = {},
): FoundationContextLedgerResult {
  return commitFoundationContextManifest(store, {
    candidate: candidate(patch),
    decidedAt: DECIDED_AT,
  });
}

/**
 * Seeds a decision under the module's OWN derived identity, so the module's next
 * call replays onto whatever durable events this seed left behind. The identity
 * comes from the production derivers, never from a transcription of them.
 */
function seedDecision(store: SqliteEventStore, events: readonly EventDraft[]): void {
  store.commitExpectedVersionDecision({
    commandKind: FOUNDATION_CONTEXT_COMMAND_KIND,
    committedResultBytes: encoder.encode("seeded-result"),
    correlationId: "seed-correlation",
    decidedAt: DECIDED_AT,
    events,
    expectedVersion: 0,
    key: deriveFoundationContextDecisionKey(BASE.record),
    requestBytes: deriveFoundationContextRequestBytes(BASE.record),
    targetAggregateId: DERIVED_AGGREGATE,
  });
}

function eventCount(store: SqliteEventStore): number {
  return store.readEventsAfter(0n, 1_000).items.length;
}

function decisionCount(store: SqliteEventStore): number {
  return store.readCommandDecisionsAfter(0n, 1_000).items.length;
}

interface Refusal {
  readonly code: string;
  readonly layer: string;
}

function refusalOf(result: FoundationContextLedgerResult): Refusal & {
  readonly codecCode: unknown; readonly storeCode: unknown;
} {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal, got a committed record");
  // No authority may ride along on a refusal.
  expect(result).not.toHaveProperty("record");
  expect(result).not.toHaveProperty("bytes");
  // Read WITHOUT coalescing: a refusal that dropped the field entirely would
  // otherwise read as an honest null and every `toBeNull()` below would pass.
  const wide = result as unknown as Record<string, unknown>;
  return {
    code: result.code, codecCode: wide["codecCode"], layer: result.layer,
    storeCode: wide["storeCode"],
  };
}

// --- roster ------------------------------------------------------------------

describe("foundation context manifest ledger vocabulary", () => {
  it("declares exactly the seven distinct ledger and reader codes", () => {
    expect([...FOUNDATION_CONTEXT_LEDGER_CODES].sort()).toEqual([...EXPECTED_LEDGER_CODES]);
    expect(FOUNDATION_CONTEXT_LEDGER_CODES).toHaveLength(7);
    expect(new Set(FOUNDATION_CONTEXT_LEDGER_CODES).size).toBe(7);
    expect(Object.isFrozen(FOUNDATION_CONTEXT_LEDGER_CODES)).toBe(true);
  });

  it("names two layers of its own, distinct from the codec layer", () => {
    expect(FOUNDATION_CONTEXT_LEDGER).toBe("FOUNDATION_CONTEXT_LEDGER");
    expect(FOUNDATION_CONTEXT_READER).toBe("FOUNDATION_CONTEXT_READER");
    expect(new Set([FOUNDATION_CONTEXT_LEDGER, FOUNDATION_CONTEXT_READER,
      FOUNDATION_CONTEXT_CODEC]).size).toBe(3);
  });

  it("pins the command kind and the versioned event type", () => {
    expect(FOUNDATION_CONTEXT_COMMAND_KIND).toBe("foundation.context-manifest.seal");
    expect(FOUNDATION_CONTEXT_EVENT_TYPE).toBe("foundation.context-manifest.sealed.v1");
  });
});

// --- 1. the accepted control -------------------------------------------------

describe("foundation context manifest ledger commit", () => {
  it("commits exactly one versioned event on its own derived aggregate", () => {
    withDirectory("accept", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      const spied = withStore(databasePath, (store) => {
        expect(eventCount(store)).toBe(0);
        const spy = spyOn(store);
        const result = commit(spy);
        expect(result.ok).toBe(true);
        if (!result.ok) return null;
        expect(result.disposition).toBe("COMMITTED");
        expect(result.aggregateId).toBe(DERIVED_AGGREGATE);
        expect(result.record).toEqual(BASE.record);
        expect([...result.bytes]).toEqual([...BASE.bytes]);
        // One store call, and no `WithApply` variant is even reachable.
        expect(spy.calls).toEqual(["commitExpectedVersionDecision"]);
        expect(eventCount(store)).toBe(1);
        expect(decisionCount(store)).toBe(1);
        expect(store.readPendingOutbox()).toHaveLength(0);
        return result.aggregateId;
      });

      withStore(databasePath, (reopened) => {
        const events = reopened.readEvents(spied ?? "");
        expect(events).toHaveLength(1);
        expect(events[0]?.eventType).toBe(FOUNDATION_CONTEXT_EVENT_TYPE);
        expect(events[0]?.domainSchemaVersion).toBe(FOUNDATION_CONTEXT_RECORD_VERSION);
        expect([...(events[0]?.payload ?? [])]).toEqual([...BASE.bytes]);
      });
    });
  });

  it("derives the aggregate from project, session and attempt identity alone", () => {
    // The aggregate MUST NOT be the Foundation attempt aggregate, and it must
    // move when — and only when — one of those three identity fields moves.
    const other = sealed({ attemptRef: "attempt-0000000000000002" });
    const sameAttempt = sealed({ configurationDigest: "e".repeat(64) });
    expect(DERIVED_AGGREGATE).toMatch(/^moe-foundation-context\/1:sha256:[0-9a-f]{64}$/u);
    expect(DERIVED_AGGREGATE).not.toBe(BASE.record.attemptRef);
    expect(DERIVED_AGGREGATE).not.toContain(BASE.record.sessionId);
    expect(deriveFoundationContextAggregateId(other.record)).not.toBe(DERIVED_AGGREGATE);
    expect(deriveFoundationContextAggregateId(sameAttempt.record)).toBe(DERIVED_AGGREGATE);
  });
});

// --- 2, 3. replay answers from the durable event -----------------------------

describe("foundation context manifest ledger replay", () => {
  it("returns the FIRST commit's bytes when a later caller hands a different manifest", () => {
    withDirectory("echo", (directory) => {
      const second = sealed({ manifest: manifestFor("a DIFFERENT task") });
      // Self-guard: an identical fixture could not tell an echo from a readback.
      expect([...second.bytes]).not.toEqual([...BASE.bytes]);
      expect(deriveFoundationContextRequestBytes(second.record))
        .toEqual(deriveFoundationContextRequestBytes(BASE.record));

      withStore(join(directory, "store.sqlite"), (store) => {
        expect(commit(store).ok).toBe(true);
        const spy = spyOn(store);
        const replay = commitFoundationContextManifest(spy, {
          candidate: candidate({ manifest: second.record.manifest }),
          decidedAt: DECIDED_AT,
        });
        expect(replay.ok).toBe(true);
        if (!replay.ok) return;
        expect(replay.disposition).toBe("REPLAYED");
        // THE ECHO TRAP: the durable bytes, never the caller's candidate.
        expect([...replay.bytes]).toEqual([...BASE.bytes]);
        expect([...replay.bytes]).not.toEqual([...second.bytes]);
        expect(replay.record.manifest.digest).toBe(BASE.record.manifest.digest);
        expect(spy.calls).toEqual(["commitExpectedVersionDecision", "readEvents"]);
        expect(store.readEvents(DERIVED_AGGREGATE)).toHaveLength(1);
        expect(eventCount(store)).toBe(1);
        expect(decisionCount(store)).toBe(1);
      });
    });
  });

  it("replays a byte-identical redelivery without writing a second event", () => {
    withDirectory("idempotent", (directory) => {
      withStore(join(directory, "store.sqlite"), (store) => {
        const first = commit(store);
        expect(first.ok).toBe(true);
        const again = commit(store);
        expect(again.ok).toBe(true);
        if (!again.ok || !first.ok) return;
        expect(again.disposition).toBe("REPLAYED");
        expect([...again.bytes]).toEqual([...first.bytes]);
        expect(again.record).toEqual(first.record);
        expect(eventCount(store)).toBe(1);
        expect(decisionCount(store)).toBe(1);
      });
    });
  });
});

// --- 4, 5. the two conflicts, kept apart -------------------------------------

describe("foundation context manifest ledger conflicts", () => {
  it("refuses REPLAY_DIVERGED when the same command carries a different request", () => {
    withDirectory("diverged", (directory) => {
      const drifted = sealed({ configurationDigest: "f".repeat(64) });
      // Same command id, different request: the store's own idempotency fence.
      expect(deriveFoundationContextDecisionKey(drifted.record))
        .toEqual(deriveFoundationContextDecisionKey(BASE.record));
      expect(deriveFoundationContextRequestBytes(drifted.record))
        .not.toEqual(deriveFoundationContextRequestBytes(BASE.record));

      withStore(join(directory, "store.sqlite"), (store) => {
        expect(commit(store).ok).toBe(true);
        const refusal = refusalOf(commit(store, { configurationDigest: "f".repeat(64) }));
        expect(refusal.code).toBe("FOUNDATION_CONTEXT_LEDGER_REPLAY_DIVERGED");
        expect(refusal.layer).toBe(FOUNDATION_CONTEXT_LEDGER);
        expect(refusal.storeCode).toBe("IDEMPOTENCY_CONFLICT");
        expect(refusal.codecCode).toBeNull();
        expect(store.readEvents(DERIVED_AGGREGATE)).toHaveLength(1);
        expect([...(store.readEvents(DERIVED_AGGREGATE)[0]?.payload ?? [])])
          .toEqual([...BASE.bytes]);
      });
    });
  });

  it("preserves the store's EXPECTED_VERSION_CONFLICT for a different command", () => {
    withDirectory("stale", (directory) => {
      const laterEpoch = sealed({ graphEpoch: 4 });
      expect(deriveFoundationContextAggregateId(laterEpoch.record)).toBe(DERIVED_AGGREGATE);
      expect(deriveFoundationContextDecisionKey(laterEpoch.record).commandId)
        .not.toBe(deriveFoundationContextDecisionKey(BASE.record).commandId);

      withStore(join(directory, "store.sqlite"), (store) => {
        expect(commit(store).ok).toBe(true);
        const refusal = refusalOf(commit(store, { graphEpoch: 4 }));
        expect(refusal.code).toBe("FOUNDATION_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT");
        expect(refusal.layer).toBe(FOUNDATION_CONTEXT_LEDGER);
        expect(refusal.storeCode).toBe("EXPECTED_VERSION_CONFLICT");
        // Zero NEW business events: the aggregate still holds only the first.
        expect(store.readEvents(DERIVED_AGGREGATE)).toHaveLength(1);
        expect([...(store.readEvents(DERIVED_AGGREGATE)[0]?.payload ?? [])])
          .toEqual([...BASE.bytes]);
      });
    });
  });

  it("maps a thrown store fault to STORE_UNAVAILABLE, keeping the store's code", () => {
    withDirectory("unavailable", (directory) => {
      withStore(join(directory, "store.sqlite"), (store) => {
        const spy = spyOn(store, {
          commitThrows: new DurableStoreError("STORE_CLOSED", "the handle is closed"),
        });
        const refusal = refusalOf(commit(spy));
        expect(refusal.code).toBe("FOUNDATION_CONTEXT_LEDGER_STORE_UNAVAILABLE");
        expect(refusal.layer).toBe(FOUNDATION_CONTEXT_LEDGER);
        expect(refusal.storeCode).toBe("STORE_CLOSED");
        expect(eventCount(store)).toBe(0);
      });
    });
  });
});

// --- 6. the codec answers for the candidate, unrestamped ---------------------

describe("foundation context manifest ledger codec pass-through", () => {
  const CODEC_CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
    ["a forged authority field", { ...candidate(), projectId: PROJECT_ID + "-attacker" },
      "FOUNDATION_CONTEXT_RECORD_DIGEST_MISMATCH"],
    ["an unsupported manifest version",
      { ...candidate(), manifest: { ...candidate()["manifest"] as object,
        version: "context-manifest.v0" } },
      "FOUNDATION_CONTEXT_VERSION_UNSUPPORTED"],
    ["a missing outer field", { ...outerFields() }, "FOUNDATION_CONTEXT_MALFORMED"],
  ];

  for (const [name, input, expectedCode] of CODEC_CASES) {
    it(`refuses ${name} with the codec's own code and layer, writing nothing`, () => {
      withDirectory("codec", (directory) => {
        withStore(join(directory, "store.sqlite"), (store) => {
          const spy = spyOn(store);
          const result = commitFoundationContextManifest(spy, {
            candidate: input, decidedAt: DECIDED_AT,
          });
          const refusal = refusalOf(result);
          expect(refusal.code).toBe(expectedCode);
          // WHICH layer refused, not merely that something did: two layers can
          // answer here, and a ledger restamp would still be "a refusal".
          expect(refusal.layer).toBe(FOUNDATION_CONTEXT_CODEC);
          expect([...FOUNDATION_CONTEXT_LEDGER_CODES]).not.toContain(refusal.code);
          expect(result).not.toHaveProperty("storeCode");
          expect(spy.calls).toEqual([]);
          expect(eventCount(store)).toBe(0);
          expect(decisionCount(store)).toBe(0);
        });
      });
    });
  }

  it("covers three distinct codec codes, so the expected column is not constant", () => {
    expect(new Set(CODEC_CASES.map(([, , code]) => code)).size).toBe(3);
  });
});

// --- 7. the reader's four distinct durable states ----------------------------

describe("foundation context manifest ledger reader refusals", () => {
  it("refuses ABSENT when the derived aggregate carries no event", () => {
    withDirectory("absent", (directory) => {
      withStore(join(directory, "store.sqlite"), (store) => {
        expect(commit(store).ok).toBe(true);
        // The store's own API cannot commit a decision with zero events, so the
        // empty read is injected; the guard it proves is still production's.
        const refusal = refusalOf(commit(spyOn(store, { readEventsAs: [] })));
        expect(refusal.code).toBe("FOUNDATION_CONTEXT_READER_ABSENT");
        expect(refusal.layer).toBe(FOUNDATION_CONTEXT_READER);
      });
    });
  });

  it("refuses AMBIGUOUS when the derived aggregate carries two events", () => {
    withDirectory("ambiguous", (directory) => {
      withStore(join(directory, "store.sqlite"), (store) => {
        seedDecision(store, [
          { eventId: "seed-1", eventType: FOUNDATION_CONTEXT_EVENT_TYPE, payload: BASE.bytes },
          { eventId: "seed-2", eventType: FOUNDATION_CONTEXT_EVENT_TYPE, payload: BASE.bytes },
        ]);
        const refusal = refusalOf(commit(store));
        expect(refusal.code).toBe("FOUNDATION_CONTEXT_READER_AMBIGUOUS");
        expect(refusal.layer).toBe(FOUNDATION_CONTEXT_READER);
        expect(store.readEvents(DERIVED_AGGREGATE)).toHaveLength(2);
      });
    });
  });

  it("refuses EVENT_TYPE_UNEXPECTED when the lone event is of another type", () => {
    withDirectory("wrong-type", (directory) => {
      withStore(join(directory, "store.sqlite"), (store) => {
        seedDecision(store, [
          { eventId: "seed-3", eventType: "foundation.something-else.v1", payload: BASE.bytes },
        ]);
        const refusal = refusalOf(commit(store));
        expect(refusal.code).toBe("FOUNDATION_CONTEXT_READER_EVENT_TYPE_UNEXPECTED");
        expect(refusal.layer).toBe(FOUNDATION_CONTEXT_READER);
      });
    });
  });

  it("refuses UNREADABLE when the durable payload fails the codec, keeping its code", () => {
    withDirectory("unreadable", (directory) => {
      withStore(join(directory, "store.sqlite"), (store) => {
        seedDecision(store, [
          { eventId: "seed-4", eventType: FOUNDATION_CONTEXT_EVENT_TYPE,
            payload: encoder.encode("{\"not\":\"a record\"}") },
        ]);
        const refusal = refusalOf(commit(store));
        expect(refusal.code).toBe("FOUNDATION_CONTEXT_READER_UNREADABLE");
        expect(refusal.layer).toBe(FOUNDATION_CONTEXT_READER);
        // The codec's own diagnosis is carried, never minted here.
        expect(refusal.codecCode).toBe("FOUNDATION_CONTEXT_MALFORMED");
      });
    });
  });

  it("maps a thrown read fault to STORE_UNAVAILABLE rather than to a reader state", () => {
    withDirectory("read-throws", (directory) => {
      withStore(join(directory, "store.sqlite"), (store) => {
        expect(commit(store).ok).toBe(true);
        const refusal = refusalOf(commit(spyOn(store, {
          readThrows: new DurableStoreError("STORE_CORRUPT", "the page is torn"),
        })));
        expect(refusal.code).toBe("FOUNDATION_CONTEXT_LEDGER_STORE_UNAVAILABLE");
        expect(refusal.layer).toBe(FOUNDATION_CONTEXT_LEDGER);
        expect(refusal.storeCode).toBe("STORE_CORRUPT");
      });
    });
  });

  it("keeps the four durable states on four distinct codes", () => {
    const reader = FOUNDATION_CONTEXT_LEDGER_CODES.filter((code) =>
      code.startsWith("FOUNDATION_CONTEXT_READER_"));
    expect(new Set(reader).size).toBe(4);
  });
});
