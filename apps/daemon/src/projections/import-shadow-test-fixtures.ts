import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyImport } from "@moe/import";
import type {
  ImportCommitInput,
  ImportReport,
  LegacySourceRecord,
  SourceManifest,
} from "@moe/import";
import { SqliteEventStore } from "@moe/store";

/**
 * Seeding and witnessing support shared by the import-shadow suites.
 *
 * It lives in its own module, with NO `.js` bridge, so it is reachable from the suites and
 * from nothing else — the same shape as `activation-ledger-fixtures.ts` and the other
 * `*-test-fixtures.ts` modules in this tree. Importing one test file from another instead
 * would re-register its `describe` blocks in the importer's module graph and run every
 * shared suite twice, inflating the counts a gate is read against.
 *
 * WHY THE SEEDING LOOKS UNUSUAL, and it is not a fixture OF THE FACTS. No production path
 * commits a `legacy.<kind>.imported` row to a real store yet: the only non-test composer of
 * `applyImport` is `tools/import/import-shadow.ts:141`, which passes a discarding port by
 * rail. So the rows are manufactured by composing PRODUCTION `applyImport` with a port that
 * forwards to a REAL file-backed SqliteEventStore. The payload bytes come from the production
 * encoder, and the aggregate id and command identity from `applyImport` itself. Nothing here
 * hand-writes a payload — a hand-written payload would make every downstream assertion a
 * statement about this file rather than about the reader.
 */

export const DIGEST = "a".repeat(64);

export function manifestOf(digest: string): SourceManifest {
  return Object.freeze({
    digest,
    entries: Object.freeze([
      Object.freeze({ digest: "b".repeat(64), path: "tasks/one.json", size: 10 }),
      Object.freeze({ digest: "c".repeat(64), path: "tasks/two.json", size: 20 }),
    ]),
    version: "moe-import-source-manifest/1",
  });
}

export function recordOf(over: Partial<LegacySourceRecord> = {}): LegacySourceRecord {
  return {
    declaredTime: "2024-03-04T05:06:07.000Z",
    kind: "task",
    legacyId: "task-1",
    payload: { owner: "alice" },
    sourcePath: "tasks/one.json",
    ...over,
  };
}

/** Forwards to the real store, so the committed bytes are the production encoder's. */
function forwardingPort(store: SqliteEventStore): {
  commit(input: ImportCommitInput): { currentVersion: number };
} {
  return {
    commit: (input: ImportCommitInput) => ({ currentVersion: store.commit(input).currentVersion }),
  };
}

/**
 * Returns the production report so a caller can take the LEGACY side's claims and links from
 * the importer itself rather than restating them.
 *
 * The throw carries `result.detail`: without it the store's own message is invisible and a
 * refused commit reads as a mapper bug while the suite asserts against an empty database.
 */
export function seedImport(
  store: SqliteEventStore,
  digest: string,
  records: readonly LegacySourceRecord[],
): ImportReport {
  const result = applyImport({
    declaredRecordCount: null,
    knownFields: ["dependsOn", "held", "owner", "parent"],
    manifest: manifestOf(digest),
    maxEventsPerCommit: 100,
    records,
    store: forwardingPort(store),
  });
  if ("outcome" in result) {
    throw new Error(`seed refused: ${result.code}/${result.layer}: ${result.detail}`);
  }
  return result;
}

/** Every durable number a pure read must leave untouched, plus the file's own bytes. */
export interface StoreWitness {
  readonly decisions: number;
  readonly events: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly version: number;
}

export function witness(store: SqliteEventStore, path: string, aggregateId: string): StoreWitness {
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
  const stat = statSync(path);
  return {
    decisions,
    events,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    version: store.getAggregateVersion(aggregateId),
  };
}

/**
 * A file-backed, PROJECT-BOUND store, closed in a `finally` on every exit path.
 *
 * `SqliteEventStore.open` alone is not enough: an unbound handle refuses every commit with
 * `PROJECT_SCOPE_REQUIRED: durable command effects require an explicitly project-asserted
 * store handle`, so the seeding would never durably write and each read would be asserting
 * against an empty database. A store left open makes `rmSync` fail with EPERM on Windows and
 * kills the vitest worker with an error that looks unrelated.
 */
export function withStore(run: (store: SqliteEventStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-import-shadow-"));
  const path = join(directory, "store.db");
  const store = SqliteEventStore.openForProject(path, "moe-import-shadow-project");
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

export function aggregateOf(digest: string): string {
  return `legacy-import:${digest}`;
}

/**
 * The commit PRODUCTION `applyImport` would have made, captured instead of performed.
 *
 * Hostile rows are built by taking this and mutating ONE thing. Starting from the encoder's
 * own bytes is what makes each case below a statement about that one mutation: a payload
 * written from scratch would differ from an honest row in ways nobody enumerated, and the
 * refusal it produced would not be evidence about the field under test.
 */
export function capturedCommit(
  digest: string,
  records: readonly LegacySourceRecord[],
): ImportCommitInput {
  let captured: ImportCommitInput | null = null;
  const result = applyImport({
    declaredRecordCount: null,
    knownFields: ["dependsOn", "held", "owner", "parent"],
    manifest: manifestOf(digest),
    maxEventsPerCommit: 100,
    records,
    store: {
      commit: (input: ImportCommitInput) => {
        captured = input;
        return { currentVersion: input.events.length };
      },
    },
  });
  if ("outcome" in result) {
    throw new Error(`capture refused: ${result.code}/${result.layer}: ${result.detail}`);
  }
  if (captured === null) throw new Error("applyImport made no commit to capture");
  return captured;
}

/** Commits a doctored `ImportCommitInput` verbatim, so the store holds the hostile row. */
export function commitRaw(store: SqliteEventStore, input: ImportCommitInput): void {
  store.commit({
    aggregateId: input.aggregateId,
    commandBytes: input.commandBytes,
    commandId: input.commandId,
    committedAt: input.committedAt,
    events: input.events,
    expectedVersion: input.expectedVersion,
  });
}

/** Rewrites the single event's payload bytes, leaving every other field production's. */
export function withPayload(input: ImportCommitInput, payload: Uint8Array): ImportCommitInput {
  const [first] = input.events;
  if (first === undefined) throw new Error("captured commit carries no event");
  return { ...input, events: [{ ...first, payload }] };
}

/** Decodes the single event's payload as JSON so a case can mutate one member of it. */
export function payloadObjectOf(input: ImportCommitInput): Record<string, unknown> {
  const [first] = input.events;
  if (first === undefined) throw new Error("captured commit carries no event");
  return JSON.parse(new TextDecoder().decode(first.payload)) as Record<string, unknown>;
}

export function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
