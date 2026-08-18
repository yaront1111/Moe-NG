/**
 * Lifecycle and evidence capture for the projection shadow matrix.
 *
 * NO ASSERTIONS, NO EXPECTED VALUES, NO PROJECTION LOGIC. This file copies a
 * corpus, measures bytes before and after, opens a real store, and runs the
 * PRODUCTION import chain. Every verdict belongs to the suite.
 *
 * WHY MTIME IS IN THE INVENTORY. DoD 4's claim is that the copied corpus and the
 * durable store are untouched. A digest alone cannot show a write that restored
 * identical content — the bytes match and the digest matches, but the mtime
 * moved. That is the ONLY signal of an accidental write-mode open, so digest,
 * size and mtime are captured for EVERY entry, never a sample.
 *
 * WHY `openForProject` AND NOT `open`. A handle opened without a project refuses
 * every commit with PROJECT_SCOPE_REQUIRED, which the neighbouring
 * tests/integration/import suite already documents. A suite that used `open`
 * would see every ingest refuse and could mistake that for a shadow verdict.
 *
 * PORTABILITY: paths are composed with `join` and rooted at `tmpdir()` (DoD 5),
 * so this runs on Windows while remaining correct on Linux and macOS.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { buildSourceManifest, decodeLegacySources } from "@moe/import";
import type {
  LegacyImportFacts, LegacySourceRecord, ReconciliationFinding, SourceManifest,
} from "@moe/import";
import { SqliteEventStore } from "@moe/store";

import { commitLegacyImport } from "../../../tools/import/durable-import-store.js";
import { KNOWN_FIELDS, PROJECT_ID, materialiseCorpus } from "./shadow-corpus-fixtures.js";
import type { CorpusFile } from "./shadow-corpus-fixtures.js";

const MAX_EVENTS_PER_COMMIT = 512;
const PAGE = 200;

export interface FileFacts {
  readonly digest: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/** Path -> facts, for every file under the corpus root. */
export type Inventory = Readonly<Record<string, FileFacts>>;

export interface StoreFacts {
  readonly databaseMtimeMs: number;
  readonly databaseSize: number;
  readonly decisionCount: number;
  readonly eventCount: number;
}

export interface IngestResult {
  readonly facts: LegacyImportFacts;
  readonly manifest: SourceManifest;
  readonly manifestDigest: string;
  /** What the IMPORTER could not map, recorded upstream of any shadow comparison. */
  readonly reconciliations: readonly ReconciliationFinding[];
  readonly records: readonly LegacySourceRecord[];
}

/** Every file under `root`, POSIX-normalised so the key set is host-independent. */
function walk(root: string, current: string = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) found.push(...walk(root, full));
    else found.push(relative(root, full).split(sep).join("/"));
  }
  return found.sort();
}

/**
 * Digest AND size AND mtime for every entry. Taking any one of the three alone
 * would miss a real class of write: identical-content rewrites move only mtime,
 * and a truncation that happens to collide on a prefix moves only size.
 */
export function inventoryOf(root: string): Inventory {
  const out: Record<string, FileFacts> = {};
  for (const path of walk(root)) {
    const full = join(root, path);
    const stat = statSync(full);
    out[path] = Object.freeze({
      digest: createHash("sha256").update(readFileSync(full)).digest("hex"),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
  return Object.freeze(out);
}

export function storeFactsOf(store: SqliteEventStore, databasePath: string): StoreFacts {
  let eventCount = 0;
  let cursor = 0n;
  for (;;) {
    const page = store.readEventsAfter(cursor, PAGE);
    eventCount += page.items.length;
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  let decisionCount = 0;
  let decisionCursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(decisionCursor, PAGE);
    decisionCount += page.items.length;
    if (!page.hasMore || page.nextCursor === null) break;
    decisionCursor = page.nextCursor;
  }
  const stat = statSync(databasePath);
  return Object.freeze({
    databaseMtimeMs: stat.mtimeMs,
    databaseSize: stat.size,
    decisionCount,
    eventCount,
  });
}

export interface CorpusContext {
  readonly corpusRoot: string;
  readonly databasePath: string;
  /**
   * A second REAL project-bound store, for arms that need legacy facts the main
   * store never saw. Deriving those facts through a throwaway store keeps the
   * whole chain in production: no stub port, no hand-built commit input.
   */
  openScratchStore(name: string): SqliteEventStore;
  readonly store: SqliteEventStore;
}

/**
 * A materialised corpus plus an open project-bound store, torn down on EVERY
 * path. A held SQLite handle across `rmSync` throws EPERM on Windows and kills
 * the vitest worker with an error that looks unrelated to the test.
 */
export function withCorpus<T>(
  name: string,
  run: (context: CorpusContext) => T,
  files?: readonly CorpusFile[],
): T {
  const root = mkdtempSync(join(tmpdir(), `moe-shadow-${name}-`));
  const opened: SqliteEventStore[] = [];
  try {
    const corpusRoot = join(root, "corpus");
    materialiseCorpus(corpusRoot, files);
    const databasePath = join(root, "store.sqlite");
    const store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
    opened.push(store);
    const openScratchStore = (scratchName: string): SqliteEventStore => {
      const scratch = SqliteEventStore.openForProject(
        join(root, `scratch-${scratchName}.sqlite`), PROJECT_ID,
      );
      opened.push(scratch);
      return scratch;
    };
    return run({ corpusRoot, databasePath, openScratchStore, store });
  } finally {
    // Every handle, including scratch stores opened mid-run, before the tree goes.
    for (const handle of opened.splice(0)) handle.close();
    rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
}

/**
 * The PRODUCTION chain, end to end: `buildSourceManifest` -> `decodeLegacySources`
 * -> `applyImport` -> `commitLegacyImport`.
 *
 * Nothing here hand-builds an `ImportCommitInput` or an event payload. The whole
 * byte-identity claim is about what the IMPORTER drafted, so a fixture-built
 * commit would be measuring this file instead of production.
 */
export function ingestCorpus(
  corpusRoot: string,
  store: SqliteEventStore,
  keep?: (record: LegacySourceRecord) => boolean,
): IngestResult {
  const manifest = buildSourceManifest(corpusRoot);
  if ("outcome" in manifest) {
    throw new Error(`corpus manifest refused: ${manifest.code} at ${manifest.layer}`);
  }
  const decoded = decodeLegacySources({ manifest, root: corpusRoot });
  if (decoded.refusals.length > 0) {
    throw new Error(`corpus decode refused: ${JSON.stringify(decoded.refusals)}`);
  }
  const records = keep === undefined ? decoded.records : decoded.records.filter(keep);
  const committed = commitLegacyImport({
    declaredRecordCount: null,
    knownFields: KNOWN_FIELDS,
    manifest,
    maxEventsPerCommit: MAX_EVENTS_PER_COMMIT,
    records,
    store,
  });
  if (committed.outcome === "REFUSED") {
    throw new Error(`corpus commit refused: ${JSON.stringify(committed)}`);
  }
  const report = committed.report;
  return Object.freeze({
    facts: Object.freeze({ claims: report.claims, links: report.links }),
    manifest,
    reconciliations: report.reconciliations,
    manifestDigest: report.manifestDigest,
    records,
  });
}
