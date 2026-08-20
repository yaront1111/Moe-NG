/**
 * The STRICT Foundation context-manifest reader, driven through a REAL
 * file-backed SqliteEventStore.
 *
 * WHY A REAL STORE AND THE LEDGER'S OWN WRITER. The accepted state is seeded by
 * `commitFoundationContextManifest`, never by hand-inserted events: a
 * hand-seeded event tests a shape the ledger never writes, and every decision
 * and receipt proof below would then be checking the fixture author's idea of a
 * commit rather than the store's. The ONE legitimate raw seed is the AMBIGUOUS
 * arm, which needs a second event on an aggregate the writer refuses to write
 * twice.
 *
 * WHAT THIS READER ADDS over the minimal `readFoundationContextManifestEvent`
 * that task-22fa35a5 landed in this same file: aggregate derivation from server
 * identity, a codec RE-ENCODE byte-compare (never trusting the stored digest),
 * decision and receipt proofs, and an outer-binding comparison against the
 * server-derived current selection. The minimal reader stays exactly as it was
 * — the ledger re-exports it — and is exercised here only to prove it still
 * behaves identically.
 *
 * THE EXPECTED BINDING IS COMPARISON INPUT, NEVER AUTHORITY. The reader refuses
 * on disagreement; it never adopts a caller's value. That is what separates
 * STALE (same slot, older selection) from FOREIGN (a different slot's record).
 *
 * WINDOWS HANDLE DISCIPLINE: every store handle closes in a `finally` before
 * the temp directory is removed. A handle held across cleanup throws EPERM and
 * kills the vitest worker with no output at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import type { CommandDecisionKey, CommandReceipt, StoredEvent } from "@moe/store";
import type { CommandDecisionRecord } from "@moe/store";
import { renderContext, selectContext } from "@moe/context";
import type { ContextRenderManifest } from "@moe/context";
import { afterEach, describe, expect, it } from "vitest";

import { deriveFoundationContextRecordDigest } from "./foundation-context-manifest-codec.js";
import type { FoundationContextManifestRecord } from "./foundation-context-manifest-codec.js";
import {
  deriveFoundationContextAggregateId,
  deriveFoundationContextDecisionKey,
} from "./foundation-context-manifest-identity.js";
import type {
  FoundationContextSelectionIdentity,
  FoundationContextSlotIdentity,
} from "./foundation-context-manifest-identity.js";
import { commitFoundationContextManifest } from "./foundation-context-manifest-ledger.js";
import {
  FOUNDATION_CONTEXT_READER,
  readFoundationContextManifest,
} from "./foundation-context-manifest-reader.js";

const PROJECT_ID = "proj-context-reader-0001";
const SESSION_ID = "session-0000000000000001";
const ATTEMPT_REF = "attempt-0000000000000001";

function manifestFor(text: string): ContextRenderManifest {
  const selected = selectContext({
    byteBudget: 4_096,
    exclusions: [],
    mandatory: [{ id: "m-1", section: "brief", content: text, kind: "MANDATORY" }],
    optional: [],
  });
  if (selected.kind !== "ADMITTED") throw new Error(`fixture selection refused: ${selected.code}`);
  return renderContext(selected.selection).manifest;
}

function outerFields(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptRef: ATTEMPT_REF,
    configurationDigest: "c".repeat(64),
    graphContentHash: "a".repeat(64),
    graphEpoch: 3,
    graphRevisionRef: "graph-revision-1",
    inputManifestDigest: "d".repeat(64),
    manifest: manifestFor("the task"),
    nodeKey: "dev-c",
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    ...patch,
  };
}

/** A well-formed candidate; the digest comes from the PRODUCTION deriver. */
function candidate(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const fields = outerFields(patch);
  return { ...fields, recordDigest: deriveFoundationContextRecordDigest(fields) };
}

/** The slot the aggregate is derived from — server identity, never a payload field. */
const SLOT: FoundationContextSlotIdentity = Object.freeze({
  attemptRef: ATTEMPT_REF, projectId: PROJECT_ID, sessionId: SESSION_ID,
});

/**
 * The expected binding, taken from the SAME fields the fixture sealed. In
 * production these come from `readCurrentActiveGraph`,
 * `readCurrentProjectConfiguration`'s `settingsDigest` and the durable attempt
 * record's input manifest; here they are read off the sealed record so the
 * comparison operands are never hand-written hex.
 */
function bindingOf(record: FoundationContextManifestRecord): FoundationContextSelectionIdentity {
  return Object.freeze({
    attemptRef: record.attemptRef,
    configurationDigest: record.configurationDigest,
    graphContentHash: record.graphContentHash,
    graphEpoch: record.graphEpoch,
    graphRevisionRef: record.graphRevisionRef,
    inputManifestDigest: record.inputManifestDigest,
    nodeKey: record.nodeKey,
    projectId: record.projectId,
    sessionId: record.sessionId,
  });
}

const stores: SqliteEventStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length > 0) {
    try { stores.pop()?.close(); } catch { /* a closed store is the goal */ }
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
    }
  }
});

function openStore(): { store: SqliteEventStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "moe-context-reader-"));
  directories.push(directory);
  const path = join(directory, "store.sqlite");
  const store = SqliteEventStore.openForProject(path, PROJECT_ID);
  stores.push(store);
  return { store, path };
}

/** The narrow READ port: three methods, none of which can write. */
function readPort(store: SqliteEventStore): {
  getCommandDecision(key: CommandDecisionKey): CommandDecisionRecord | null;
  getCommandReceipt(commandId: string): CommandReceipt | null;
  readEvents(aggregateId: string): readonly StoredEvent[];
} {
  return {
    getCommandDecision: (key) => store.getCommandDecision(key),
    getCommandReceipt: (commandId) => store.getCommandReceipt(commandId),
    readEvents: (aggregateId) => store.readEvents(aggregateId),
  };
}

/** Seeds the accepted state through the LEDGER'S OWN WRITER. */
function seal(
  store: SqliteEventStore, patch: Record<string, unknown> = {},
): FoundationContextManifestRecord {
  const committed = commitFoundationContextManifest(store, {
    candidate: candidate(patch), decidedAt: "2026-08-19T00:00:00.000Z",
  });
  if (!committed.ok) throw new Error(`fixture commit refused: ${committed.code}`);
  return committed.record;
}

function rawCounts(store: SqliteEventStore): { decisions: number; events: number } {
  return {
    decisions: store.readCommandDecisionsAfter(0n, 1_000).items.length,
    events: store.readEventsAfter(0n, 1_000).items.length,
  };
}

describe("readFoundationContextManifest — accepted read", () => {
  it("returns the DURABLE record and bytes after every proof passes", () => {
    const { store } = openStore();
    const record = seal(store);

    const result = readFoundationContextManifest(readPort(store), SLOT, bindingOf(record));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Compared against the WRITER's own record, never transcribed values.
    expect(result.record).toEqual(record);
    // THE DURABLE BYTES, byte for byte. `length > 0` would have been satisfied
    // by any non-empty buffer the reader chose to hand back, including a
    // re-encode of its own; only equality with what the store actually holds
    // says these are the bytes that were committed.
    const stored = store.readEvents(deriveFoundationContextAggregateId(SLOT))[0]?.payload;
    expect(stored).toBeDefined();
    expect([...result.bytes]).toEqual([...(stored ?? new Uint8Array())]);
    // DEEPLY frozen: a shallow freeze leaves every nested object — the whole
    // manifest, its binding, its section array — writable by the caller that
    // was just handed this as authority.
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.manifest)).toBe(true);
    expect(Object.isFrozen(result.record.manifest.binding)).toBe(true);
  });

  it("re-reads identically from a reopened store", () => {
    const { store, path } = openStore();
    const record = seal(store);
    const first = readFoundationContextManifest(readPort(store), SLOT, bindingOf(record));
    store.close();

    const reopened = SqliteEventStore.openForProject(path, PROJECT_ID);
    stores.push(reopened);
    const second = readFoundationContextManifest(readPort(reopened), SLOT, bindingOf(record));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second).toEqual(first);
  });

  it("writes nothing: raw event and decision counts are unchanged by a read", () => {
    const { store } = openStore();
    const record = seal(store);
    const before = rawCounts(store);

    readFoundationContextManifest(readPort(store), SLOT, bindingOf(record));
    readFoundationContextManifest(readPort(store), SLOT, bindingOf(record));

    expect(rawCounts(store)).toEqual(before);
  });
});

describe("readFoundationContextManifest — refusal arms, one distinct code each", () => {
  it("ABSENT when the derived aggregate holds no event", () => {
    const { store } = openStore();
    const record = seal(store);
    // A DIFFERENT slot derives a different aggregate, which is empty.
    const elsewhere: FoundationContextSlotIdentity = {
      ...SLOT, attemptRef: "attempt-0000000000000002",
    };

    const result = readFoundationContextManifest(readPort(store), elsewhere, bindingOf(record));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_ABSENT");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_READER);
  });

  it("AMBIGUOUS when a second event reaches the same aggregate", () => {
    const { store } = openStore();
    const record = seal(store);
    const aggregateId = deriveFoundationContextAggregateId(SLOT);
    // The one legitimate raw seed: the writer refuses to write this aggregate
    // twice, so the only way to reach the arm is to append underneath it.
    store.commit({
      aggregateId,
      commandBytes: new Uint8Array([9]),
      commandId: "foundation-context-duplicate-command-1",
      committedAt: "2026-08-19T00:00:01.000Z",
      events: [{
        domainSchemaVersion: "moe-foundation-context-record/1",
        eventId: "foundation-context-duplicate-1",
        eventType: "foundation.context-manifest.sealed.v1",
        payload: new Uint8Array([1, 2, 3]),
      }],
      expectedVersion: 1,
    });

    const result = readFoundationContextManifest(readPort(store), SLOT, bindingOf(record));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_AMBIGUOUS");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_READER);
  });

  it("STALE when the same slot sealed an OLDER selection than the expected one", () => {
    const { store } = openStore();
    const record = seal(store);
    // Same slot, same identity — a newer graph epoch is now current.
    const newer: FoundationContextSelectionIdentity = {
      ...bindingOf(record), graphEpoch: record.graphEpoch + 1,
    };

    const result = readFoundationContextManifest(readPort(store), SLOT, newer);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_STALE");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_READER);
  });

  it("BINDING_MISMATCH when the sealed record names a different node", () => {
    const { store } = openStore();
    const record = seal(store);
    const foreign: FoundationContextSelectionIdentity = {
      ...bindingOf(record), nodeKey: "dev-a",
    };

    const result = readFoundationContextManifest(readPort(store), SLOT, foreign);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // DISTINCT from STALE: a different node is a foreign record, not an old
    // one, and collapsing them would let a mis-selected node read as staleness.
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_BINDING_MISMATCH");
    expect(result.code).not.toBe("FOUNDATION_CONTEXT_READER_STALE");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_READER);
  });

  it("retains the CODEC's own code when the stored bytes do not decode", () => {
    const { store } = openStore();
    const record = seal(store);
    const aggregateId = deriveFoundationContextAggregateId(SLOT);
    const corrupt = {
      ...readPort(store),
      readEvents: (id: string): readonly StoredEvent[] => {
        const events = store.readEvents(id);
        const first = events[0];
        if (id !== aggregateId || first === undefined) return events;
        return [{ ...first, payload: new Uint8Array([123, 34, 120, 34, 58, 49, 125]) }];
      },
    };

    const result = readFoundationContextManifest(corrupt, SLOT, bindingOf(record));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The codec diagnosed it; the reader must not restamp that into its own
    // vocabulary or the caller loses WHICH layer rejected the bytes.
    expect(result.codecCode).not.toBeNull();
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_UNREADABLE");
  });

  it("NONCANONICAL when the bytes decode but are not what the codec would emit", () => {
    const { store } = openStore();
    const record = seal(store);
    const aggregateId = deriveFoundationContextAggregateId(SLOT);
    // DRILL-DRIVEN. The corrupt-bytes arm below fails at DECODE, so it never
    // reaches the re-encode and cannot tell "recomputed the digest" from
    // "trusted the stored one". These bytes decode perfectly and carry the
    // ORIGINAL recordDigest untouched — only their serialization differs, which
    // is exactly what a canonical-form check exists to catch.
    const canonical = new TextDecoder().decode(store.readEvents(aggregateId)[0]!.payload);
    // One insignificant space. It parses to the identical value — every field,
    // including recordDigest, is untouched — but it is not the byte sequence the
    // codec emits, which is the whole point of a canonical-form check.
    const reordered = new TextEncoder().encode(canonical.replace("{", "{ "));
    const skewed = {
      ...readPort(store),
      readEvents: (id: string): readonly StoredEvent[] => {
        const events = store.readEvents(id);
        const first = events[0];
        if (id !== aggregateId || first === undefined) return events;
        return [{ ...first, payload: reordered }];
      },
    };

    const result = readFoundationContextManifest(skewed, SLOT, bindingOf(record));

    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // WHICH LAYER, AND WHY. The recomputation lives in the codec — its decode
    // re-encodes and byte-compares (codec :242-246) — so the reader reports
    // UNREADABLE while carrying the codec's own NONCANONICAL verbatim. This
    // pair is the assertion: the code says the reader could not use the bytes,
    // the codecCode says the bytes were not canonical, and a restamp that
    // dropped codecCode would leave a caller unable to tell this from a
    // malformed payload or a binding disagreement.
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_UNREADABLE");
    expect(result.codecCode).toBe("FOUNDATION_CONTEXT_NONCANONICAL");
    expect(result.codecCode).not.toBe("FOUNDATION_CONTEXT_MALFORMED");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_READER);
  });

  it("refuses when the command decision is missing", () => {
    const { store } = openStore();
    const record = seal(store);
    const blind = { ...readPort(store), getCommandDecision: () => null };

    const result = readFoundationContextManifest(blind, SLOT, bindingOf(record));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_DECISION_MISSING");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_READER);
  });

  it("refuses when the command receipt is missing", () => {
    const { store } = openStore();
    const record = seal(store);
    const blind = { ...readPort(store), getCommandReceipt: () => null };

    const result = readFoundationContextManifest(blind, SLOT, bindingOf(record));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_RECEIPT_MISSING");
    expect(result.layer).toBe(FOUNDATION_CONTEXT_READER);
  });

  it("retains the STORE's own code when the read throws", () => {
    const { store } = openStore();
    const record = seal(store);
    const throwing = {
      ...readPort(store),
      readEvents: (): readonly StoredEvent[] => {
        throw Object.assign(new Error("store is corrupt"), { code: "STORE_CORRUPT" });
      },
    };

    const result = readFoundationContextManifest(throwing, SLOT, bindingOf(record));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FOUNDATION_CONTEXT_READER_UNREADABLE");
    // The landed minimal refusal pins storeCode null; the STRICT shape must
    // carry the store's own code through instead of flattening it.
    expect(result.storeCode).toBe("STORE_CORRUPT");
  });

  it("leaves the store untouched on every refusal arm", () => {
    const { store } = openStore();
    const record = seal(store);
    const before = rawCounts(store);
    const arms = [
      () => readFoundationContextManifest(
        readPort(store), { ...SLOT, attemptRef: "attempt-0000000000000009" }, bindingOf(record)),
      () => readFoundationContextManifest(
        readPort(store), SLOT, { ...bindingOf(record), graphEpoch: 99 }),
      () => readFoundationContextManifest(
        readPort(store), SLOT, { ...bindingOf(record), nodeKey: "dev-a" }),
      () => readFoundationContextManifest(
        { ...readPort(store), getCommandDecision: () => null }, SLOT, bindingOf(record)),
    ];
    // A sweep that silently produced zero cases would pass while testing nothing.
    expect(arms.length).toBeGreaterThan(0);

    for (const arm of arms) expect(arm().ok).toBe(false);

    expect(rawCounts(store)).toEqual(before);
  });
});

describe("the landed minimal reader is unchanged", () => {
  it("still answers exactly-one/type/decode on its own, for the ledger's re-export", async () => {
    const { readFoundationContextManifestEvent, FOUNDATION_CONTEXT_READER_CODES } =
      await import("./foundation-context-manifest-reader.js");
    const { store } = openStore();
    seal(store);
    const events = store.readEvents(deriveFoundationContextAggregateId(SLOT));

    const durable = readFoundationContextManifestEvent(events);
    const empty = readFoundationContextManifestEvent([]);

    expect(durable.ok).toBe(true);
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("unreachable");
    expect(empty.code).toBe("FOUNDATION_CONTEXT_READER_ABSENT");
    // The ledger's roster spreads THIS array and its suite pins it at four.
    // Extending it here would red another task's committed tests.
    expect(FOUNDATION_CONTEXT_READER_CODES).toHaveLength(4);
  });
});

describe("the decision key is derived, never supplied", () => {
  it("derives the same decision key the writer committed under", () => {
    const { store } = openStore();
    const record = seal(store);
    const key = deriveFoundationContextDecisionKey(bindingOf(record));

    // If the reader derived a different key it would answer DECISION_MISSING on
    // a perfectly good record, so this pins the shared derivation directly.
    expect(store.getCommandDecision(key)).not.toBeNull();
  });
});
