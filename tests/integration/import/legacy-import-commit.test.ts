/**
 * The durable side of the legacy import: what `applyImport` DRAFTS must become rows.
 *
 * Every fixture here is driven through PRODUCTION `applyImport` — never a hand-built
 * `ImportCommitInput` — because the byte-identity claim is about what the importer
 * drafted, not about what this file can construct. The store is a REAL file-backed
 * `SqliteEventStore`; `openForProject` rather than `open`, because a handle opened
 * without a project refuses every commit with PROJECT_SCOPE_REQUIRED.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IMPORT_EVENT_FACTS_VERSION, applyImport, decodeImportEventFacts,
} from "@moe/import";
import type {
  ImportCommitInput, ImportEventDraft, LegacySourceRecord, SourceManifest,
} from "@moe/import";
import { SqliteEventStore } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  DURABLE_COMMIT_LAYER, commitLegacyImport, runImportCommit,
} from "../../../tools/import/import-commit.js";

const KNOWN_FIELDS: readonly string[] = Object.freeze(["dependsOn", "held", "owner", "parent"]);
const PROJECT = "moe-legacy-import";
const DIGEST = "d".repeat(64);

const roots: string[] = [];
const stores: SqliteEventStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moe-import-commit-"));
  roots.push(root);
  return root;
}

/** An existing, project-bound store file. The CLI never creates one, so tests must. */
function openStore(path: string): SqliteEventStore {
  const store = SqliteEventStore.openForProject(path, PROJECT);
  stores.push(store);
  return store;
}

function manifestOf(digest: string, paths: readonly string[]): SourceManifest {
  return Object.freeze({
    digest,
    entries: Object.freeze(paths.map((path, index) => Object.freeze({
      digest: String(index).repeat(64),
      path,
      size: 10 + index,
    }))),
    version: "moe-import-source-manifest/1",
  });
}

function recordOf(over: Partial<LegacySourceRecord> = {}): LegacySourceRecord {
  return {
    declaredTime: "2024-03-04T05:06:07.000Z",
    kind: "task",
    legacyId: "task-1",
    payload: { owner: "alice" },
    sourcePath: "tasks/one.json",
    ...over,
  };
}

const RECORDS: readonly LegacySourceRecord[] = Object.freeze([
  recordOf(),
  recordOf({ legacyId: "task-2", payload: { owner: "bob" }, sourcePath: "tasks/two.json" }),
]);

const MANIFEST = manifestOf(DIGEST, ["tasks/one.json", "tasks/two.json"]);

/**
 * The commit PRODUCTION `applyImport` would have made over the same input, captured
 * instead of performed. `applyImport` is deterministic over its input, so these ARE the
 * drafts the durable run committed — and nothing here derives a payload of its own.
 */
function draftsOf(
  manifest: SourceManifest,
  records: readonly LegacySourceRecord[],
): readonly ImportEventDraft[] {
  let captured: readonly ImportEventDraft[] | null = null;
  const result = applyImport({
    declaredRecordCount: null,
    knownFields: KNOWN_FIELDS,
    manifest,
    maxEventsPerCommit: 100,
    records,
    store: {
      commit: (input: ImportCommitInput) => {
        captured = input.events;
        return { currentVersion: 0 };
      },
    },
  });
  if ("outcome" in result) {
    throw new Error(`draft capture refused: ${result.code}/${result.layer}: ${result.detail}`);
  }
  if (captured === null) throw new Error("applyImport made no commit to capture");
  return captured;
}

function commit(
  store: SqliteEventStore,
  manifest: SourceManifest,
  records: readonly LegacySourceRecord[],
): ReturnType<typeof commitLegacyImport> {
  return commitLegacyImport({
    declaredRecordCount: null,
    knownFields: KNOWN_FIELDS,
    manifest,
    maxEventsPerCommit: 100,
    records,
    store,
  });
}

function rowsOf(store: SqliteEventStore, digest: string): readonly StoredEvent[] {
  return store.readAggregateEvents(`legacy-import:${digest}`, 0, 100).items;
}

/** Raw durable counts, so "the original survived" is measured rather than assumed. */
function rawCounts(store: SqliteEventStore): { decisions: number; events: number } {
  let cursor = 0n;
  let events = 0;
  for (;;) {
    const page = store.readEventsAfter(cursor, 100);
    events += page.items.length;
    if (page.nextCursor === null || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  let decisionCursor = 0n;
  let decisions = 0;
  for (;;) {
    const page = store.readCommandDecisionsAfter(decisionCursor, 100);
    decisions += page.items.length;
    if (page.nextCursor === null || page.items.length === 0) break;
    decisionCursor = page.nextCursor;
  }
  return { decisions, events };
}

describe("commitLegacyImport", () => {
  it("commits the drafted events with the drafted envelope version and byte-identical payloads", () => {
    const store = openStore(join(tempRoot(), "store.db"));
    const drafts = draftsOf(MANIFEST, RECORDS);
    expect(drafts.length).toBeGreaterThan(0);

    const result = commit(store, MANIFEST, RECORDS);
    expect(result.outcome).toBe("COMMITTED");

    const rows = rowsOf(store, DIGEST);
    expect(rows).toHaveLength(drafts.length);
    for (const [index, draft] of drafts.entries()) {
      const row = rows[index];
      expect(row?.eventId).toBe(draft.eventId);
      expect(row?.eventType).toBe(draft.eventType);
      expect(row?.domainSchemaVersion).toBe(IMPORT_EVENT_FACTS_VERSION);
      expect([...row?.payload ?? []]).toEqual([...draft.payload]);
    }
  });

  it("commits rows that decode back to a nonzero claim count through decodeImportEventFacts", () => {
    const store = openStore(join(tempRoot(), "store.db"));
    const result = commit(store, MANIFEST, RECORDS);
    if (result.outcome !== "COMMITTED") throw new Error(`refused: ${JSON.stringify(result)}`);

    const legacyIds: string[] = [];
    for (const row of rowsOf(store, DIGEST)) {
      const facts = decodeImportEventFacts(row.payload);
      if ("outcome" in facts) throw new Error(`row did not decode: ${facts.code}`);
      legacyIds.push(facts.claim.legacyId);
    }
    expect(legacyIds.length).toBeGreaterThan(0);
    expect(legacyIds).toEqual(result.report.claims.map((claim) => claim.legacyId));
  });

  it("adds no event of its own: the durable ids are exactly the drafted ids", () => {
    const store = openStore(join(tempRoot(), "store.db"));
    const drafts = draftsOf(MANIFEST, RECORDS);
    commit(store, MANIFEST, RECORDS);

    const rows = rowsOf(store, DIGEST);
    expect(rows.map((row) => row.eventId)).toEqual(drafts.map((draft) => draft.eventId));
    expect(rawCounts(store).events).toBe(drafts.length);
  });

  it("replays a byte-identical re-import instead of appending, leaving the rows untouched", () => {
    const store = openStore(join(tempRoot(), "store.db"));
    expect(commit(store, MANIFEST, RECORDS).outcome).toBe("COMMITTED");
    const before = rawCounts(store);
    const rowsBefore = rowsOf(store, DIGEST).map((row) => [...row.payload]);

    const second = commit(store, MANIFEST, RECORDS);
    expect(second.outcome).toBe("REPLAYED");
    expect(rawCounts(store)).toEqual(before);
    expect(rowsOf(store, DIGEST).map((row) => [...row.payload])).toEqual(rowsBefore);
  });

  it("refuses a second import of the same manifest digest with the store's own COMMAND_ID_CONFLICT", () => {
    const store = openStore(join(tempRoot(), "store.db"));
    expect(commit(store, MANIFEST, RECORDS).outcome).toBe("COMMITTED");
    const before = rawCounts(store);
    const rowsBefore = rowsOf(store, DIGEST).map((row) => [...row.payload]);

    const second = commit(store, MANIFEST, [recordOf({ payload: { owner: "carol" } })]);
    expect(second.outcome).toBe("REFUSED");
    if (second.outcome !== "REFUSED") throw new Error("unreachable");
    expect(second.code).toBe("COMMAND_ID_CONFLICT");
    expect(second.layer).toBe(DURABLE_COMMIT_LAYER);
    expect(second.layer).not.toBe("APPLY");
    expect(rawCounts(store)).toEqual(before);
    expect(rowsOf(store, DIGEST).map((row) => [...row.payload])).toEqual(rowsBefore);
  });

  it("surfaces a broken store as IMPORT_COMMIT_FAILED / APPLY from applyImport itself", () => {
    const store = openStore(join(tempRoot(), "store.db"));
    store.close();

    const result = commit(store, MANIFEST, RECORDS);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") throw new Error("unreachable");
    expect(result.code).toBe("IMPORT_COMMIT_FAILED");
    expect(result.layer).toBe("APPLY");
  });
});

/** A legacy snapshot the production decoder accepts: one .json per record under tasks/. */
function snapshotRoot(records: readonly Record<string, unknown>[]): string {
  const root = tempRoot();
  mkdirSync(join(root, "tasks"));
  for (const [index, record] of records.entries()) {
    writeFileSync(join(root, "tasks", `${String(index)}.json`), JSON.stringify(record));
  }
  return root;
}

const SNAPSHOT: readonly Record<string, unknown>[] = Object.freeze([
  { legacyId: "task-a", owner: "alice", time: "2024-03-04T05:06:07.000Z" },
  { legacyId: "task-b", owner: "bob", time: "2024-03-05T05:06:07.000Z" },
]);

describe("runImportCommit", () => {
  it("commits a real snapshot into an existing store and reports the committed count", () => {
    const root = snapshotRoot(SNAPSHOT);
    const path = join(tempRoot(), "store.db");
    openStore(path).close();

    const result = runImportCommit([root, "--store", path, "--project", PROJECT]);
    expect(result.code).toBe(0);
    const report: unknown = JSON.parse(result.text);
    expect(report).toMatchObject({ committedEvents: SNAPSHOT.length, outcome: "COMMITTED" });

    const store = openStore(path);
    const digest = (report as { manifestDigest: string }).manifestDigest;
    expect(rowsOf(store, digest)).toHaveLength(SNAPSHOT.length);
  });

  it("refuses a store path that does not exist and creates nothing there", () => {
    const root = snapshotRoot(SNAPSHOT);
    const path = join(tempRoot(), "absent.db");

    const result = runImportCommit([root, "--store", path, "--project", PROJECT]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.text)).toMatchObject({
      code: "IMPORT_SOURCE_UNREADABLE",
      layer: "INPUT",
      outcome: "REFUSED",
    });
    expect(existsSync(path)).toBe(false);
  });

  it("refuses argv that names no store with IMPORT_ROOT_INVALID / INPUT", () => {
    const result = runImportCommit([snapshotRoot(SNAPSHOT)]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.text)).toMatchObject({
      code: "IMPORT_ROOT_INVALID",
      layer: "INPUT",
      outcome: "REFUSED",
    });
  });
});
