/**
 * Hostile drivers for IMPORT_SHADOW_READ_LAYER, the daemon's read of one committed
 * legacy import (`apps/daemon/src/projections/import-shadow-contracts.ts`).
 *
 * SPLIT OUT OF `durable-store-boundary-scenarios.ts` for the per-file line rail, and
 * because this is the one durable-store boundary whose RACE arm cannot use the shared
 * two-writer runner: that runner asks whether two hostile WRITERS can both claim a
 * version, and this boundary owns no writer at all. Its race is a commit landing
 * mid-READ, which is a different question with a different answering code.
 *
 * NOTHING HERE REIMPLEMENTS THE READER. Every arm calls the published
 * `readImportShadowProjection` from the `@moe/daemon` root and asserts whatever it
 * answered; the expectations live in the case tables next door. Rows are only ever
 * written by the PRODUCTION chain — `buildSourceManifest` -> `decodeLegacySources` ->
 * `commitLegacyImport` — so no arm can test a shape the importer never produces.
 *
 * WHY THE AFTER ARM DROPS A ROW RATHER THAN TRUNCATING A PAYLOAD. Truncated payload
 * bytes reach `decodeImportEventFacts`, and the reader FORWARDS the decoder's own
 * `IMPORT_EVENT_*` code at the decoder's own layer verbatim (contracts.ts:13-18 makes
 * the no-restamp rule explicit). That arm would therefore pin the DECODER, not this
 * boundary. A missing row is the reader's OWN refusal: `admitEnvelope` sees the
 * aggregateSequence hole and answers IMPORT_SHADOW_EVIDENCE_MALFORMED at
 * IMPORT_SHADOW_READ_LAYER, which is the layer this roster entry is about.
 *
 * THE PORTS ARE NARROWING VIEWS OF A REAL STORE, NOT FAKES. `ImportShadowStorePort`
 * declares two readers and is deliberately structural so "a caller may pass any bounded
 * durable reader"; each port below delegates straight to a live `SqliteEventStore` and
 * removes or interleaves exactly one thing. A port that answered from a literal would
 * be the reader's expectation echoed back at it, which is what the drills check for.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  IMPORT_SHADOW_READ_LAYER,
  readImportShadowProjection,
} from "@moe/daemon";
import type { ImportShadowStorePort } from "@moe/daemon";
import { buildSourceManifest, decodeLegacySources } from "@moe/import";
import { SqliteEventStore } from "@moe/store";
import type { StoredEvent } from "@moe/store";

import { commitLegacyImport } from "../../tools/import/durable-import-store.js";
import { hostileRoot } from "./hostile-harness.js";

/** `applyImport`'s known-field set, as the importer's own consumers spell it. */
const KNOWN_FIELDS: readonly string[] = Object.freeze(["dependsOn", "held", "owner", "parent"]);
const PROJECT_ID = "security-project";
const MAX_EVENTS_PER_COMMIT = 512;

/** Well-formed but unwritten: 64 lowercase hex, so INPUT_INVALID can never be the answer. */
export const ABSENT_MANIFEST_DIGEST = "c".repeat(64);

/**
 * How many rows `commitLegacyImport` writes for {@link CORPUS}. Written down so the case
 * tables can pin the durable count exactly; `seedLegacyImport` asserts the store agrees, so
 * a change in what the importer emits fails HERE rather than silently relaxing an arm.
 */
export const SEEDED_IMPORT_ROWS = 2;

/**
 * Two claims, so the AFTER arm can drop the FIRST of two committed rows and leave a
 * genuine sequence hole behind. One claim would leave an empty aggregate, which the
 * reader answers IMPORT_SHADOW_ABSENT for — an earlier branch, and the wrong one.
 */
const CORPUS: readonly Readonly<{ document: Readonly<Record<string, unknown>>; path: string }>[] =
  Object.freeze([
    Object.freeze({
      path: "tasks/first.json",
      document: Object.freeze({
        legacyId: "task-first", owner: "alice", time: "2024-03-04T05:06:07.000Z",
      }),
    }),
    Object.freeze({
      path: "tasks/second.json",
      document: Object.freeze({
        dependsOn: Object.freeze(["task-first"]),
        legacyId: "task-second", owner: "bob", time: "2024-03-04T05:06:08.000Z",
      }),
    }),
  ]);

/**
 * The PRODUCTION import chain, end to end. Nothing here hand-builds an event, a payload
 * or an aggregate id: the rows this seeds are byte-for-byte what the importer writes.
 */
export function seedLegacyImport(root: string, store: SqliteEventStore): string {
  // The corpus lives BESIDE the database, never above it: `buildSourceManifest` walks the
  // root it is given, and a manifest that swallowed `events.sqlite` refuses the whole decode.
  const corpusRoot = join(root, "corpus");
  for (const file of CORPUS) {
    const target = join(corpusRoot, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, `${JSON.stringify(file.document, null, 2)}\n`, "utf8");
  }
  const manifest = buildSourceManifest(corpusRoot);
  if ("outcome" in manifest) {
    throw new Error(`seed manifest refused: ${manifest.code} at ${manifest.layer}`);
  }
  const decoded = decodeLegacySources({ manifest, root: corpusRoot });
  if (decoded.refusals.length > 0) {
    throw new Error(`seed decode refused: ${JSON.stringify(decoded.refusals)}`);
  }
  const committed = commitLegacyImport({
    declaredRecordCount: null,
    knownFields: KNOWN_FIELDS,
    manifest,
    maxEventsPerCommit: MAX_EVENTS_PER_COMMIT,
    records: decoded.records,
    store,
  });
  if (committed.outcome === "REFUSED") {
    throw new Error(`seed commit refused: ${JSON.stringify(committed)}`);
  }
  const digest = committed.report.manifestDigest;
  const written = store.readEvents(`legacy-import:${digest}`).length;
  if (written !== SEEDED_IMPORT_ROWS) {
    throw new Error(`the importer wrote ${String(written)} rows, not ${String(SEEDED_IMPORT_ROWS)}`);
  }
  return digest;
}

export interface ImportShadowOutcome {
  /** Every surviving row still carries an id and a payload: a refusal left no fragment. */
  readonly durableComplete: boolean;
  /** Rows the store actually holds for the seeded import, read back after the arm ran. */
  readonly durableRecords: number;
  readonly refusal: unknown;
  /**
   * The refusal's `detail`, or "" when the answer carried none. Exposed on EVERY arm because
   * the code/layer tuple cannot distinguish production's answer from a hand-built object
   * carrying the same two fields -- measured, not assumed. The detail's operands come out of
   * the store, so an arm that checks them is comparing production against the durable bytes.
   */
  readonly refusalDetail: string;
  /** `refuseImportShadow` freezes what it builds; an echoed object literal does not. */
  readonly refusalFrozen: boolean;
}

/** Read back off the LIVE store, never off the narrowed port the arm handed the reader. */
function completeness(events: readonly StoredEvent[]): boolean {
  return events.every((event) => event.eventId.length > 0 && event.payload.byteLength > 0);
}

/**
 * BEFORE — a closed durable reader. The digest is well-formed, so INPUT_INVALID cannot
 * answer; the handle is closed before the reader ever sees it, so the horizon read is the
 * FIRST thing that can fail and nothing downstream of it is reachable. That is what makes
 * IMPORT_SHADOW_STORE_UNREADABLE provably this seam's own answer rather than a later one.
 */
export function importShadowClosedStore(root: string): ImportShadowOutcome {
  const closed = SqliteEventStore.openForProject(join(root, "closed.sqlite"), PROJECT_ID);
  closed.getAggregateVersion("pre-close-probe");
  closed.close();
  // WHICH read failed is graded by the slice, not thrown here: `readEvents` fails on a closed
  // handle too and answers the same code from a different branch, so the detail is the only
  // thing that can say the horizon read was the gate. A throw would redden on a crash instead.
  const refusal = readImportShadowProjection(closed, { manifestDigest: ABSENT_MANIFEST_DIGEST });
  return {
    durableComplete: true,
    durableRecords: 0,
    refusal,
    refusalDetail: detailOf(refusal),
    refusalFrozen: Object.isFrozen(refusal),
  };
}

export interface ImportShadowControlledOutcome extends ImportShadowOutcome {
  /**
   * THE POSITIVE CONTROL, produced by the SAME driver on the SAME seeded import through an
   * INTACT port. A refusal-only arm cannot tell a reader that refuses correctly from a
   * driver that echoes the expectation back, because both answer with the same tuple. This
   * one cannot be echoed: it is an ACCEPTANCE whose entity count comes out of
   * `projectDaemonImportShadow` walking the importer's own committed bytes.
   */
  readonly acceptedEntities: number;
  readonly acceptedOk: boolean;
  /**
   * The aggregateSequence the SURVIVING first row actually carries, read back off the live
   * store. Production's refusal detail quotes this number, so an arm that checks the detail
   * against it is comparing production's answer with the store's own bytes -- neither
   * operand is written down here, which is what a hand-built refusal cannot reproduce.
   */
  readonly holeAt: number;
}

/**
 * AFTER — a real import is committed, then one of its rows goes missing between the
 * commit and the read. Every earlier layer passes: the digest is the one the importer
 * reported, the store is open and healthy, and the surviving row is the importer's own
 * bytes. Only the sequence hole can refuse.
 *
 * The intact read runs FIRST, so the refusal below is known to be caused by the hidden row
 * and nothing else about the fixture.
 */
export function importShadowMissingRow(root: string): ImportShadowControlledOutcome {
  const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), PROJECT_ID);
  try {
    const manifestDigest = seedLegacyImport(root, store);
    const intact = readImportShadowProjection(store, { manifestDigest });
    const port: ImportShadowStorePort = {
      readEventHorizon: () => store.readEventHorizon(),
      readEvents: (aggregateId) => dropFirst(store.readEvents(aggregateId)),
    };
    const refusal = readImportShadowProjection(port, { manifestDigest });
    const survivors = store.readEvents(`legacy-import:${manifestDigest}`);
    return {
      acceptedEntities: intact.ok ? intact.projection.entities.length : 0,
      acceptedOk: intact.ok,
      durableComplete: completeness(survivors),
      durableRecords: survivors.length,
      holeAt: Number(survivors[1]?.aggregateSequence ?? 0),
      refusal,
      refusalDetail: detailOf(refusal),
      refusalFrozen: Object.isFrozen(refusal),
    };
  } finally {
    store.close();
  }
}

/** Reads `detail` without interpreting it: a shape carrying none yields "" rather than a pass. */
function detailOf(refusal: unknown): string {
  if (typeof refusal !== "object" || refusal === null || !("detail" in refusal)) return "";
  const { detail } = refusal as { detail: unknown };
  return typeof detail === "string" ? detail : "";
}

/** Removing the FIRST row leaves index 0 holding aggregateSequence 2 — a hole, not a truncation. */
function dropFirst(events: readonly StoredEvent[]): readonly StoredEvent[] {
  if (events.length < 2) {
    throw new Error(`the seeded import produced ${String(events.length)} rows; a hole needs at least 2`);
  }
  return events.slice(1);
}

export interface ImportShadowRaceOutcome extends ImportShadowOutcome {
  /** Rows the whole store holds once the race settles, seeded import plus racing write. */
  readonly durableEvents: number;
  /** Horizons the reader itself observed, in the order it observed them. */
  readonly horizons: readonly string[];
  /** Rows the seeded import still holds; the racing write lands on its own aggregate. */
  readonly seededRecords: number;
}

/**
 * RACE — a real commit lands from a SECOND connection while the read is in flight.
 *
 * The reader captures the horizon, reads rows, and re-reads the horizon; the interleave
 * happens between those two horizon reads, which is the only window in which a concurrent
 * commit can corrupt a projection. Both horizons come from the live store and the
 * interleaved write is a real production commit, so the drift the reader detects is real
 * drift — the port neither invents a horizon nor reports one the store does not hold.
 */
export function importShadowMidReadCommit(root: string): ImportShadowRaceOutcome {
  const store = SqliteEventStore.openForProject(join(root, "events.sqlite"), PROJECT_ID);
  const databasePath = join(root, "events.sqlite");
  try {
    const manifestDigest = seedLegacyImport(root, store);
    const aggregateId = `legacy-import:${manifestDigest}`;
    const horizons: string[] = [];
    let interleaved = false;
    const port: ImportShadowStorePort = {
      readEventHorizon: () => {
        const at = store.readEventHorizon();
        horizons.push(String(at));
        return at;
      },
      readEvents: (id) => {
        const rows = store.readEvents(id);
        if (!interleaved) {
          interleaved = true;
          commitFromSecondConnection(databasePath);
        }
        return rows;
      },
    };
    const refusal = readImportShadowProjection(port, { manifestDigest });
    if (!interleaved) throw new Error("the racing writer never ran: readEvents was not reached");
    // The WHOLE store, not just the import: the racing commit is what moved the horizon, so
    // counting only the import aggregate would hide whether that write actually landed.
    const settled = store.readEventsAfter(0n, 100).items;
    return {
      durableComplete: completeness(settled),
      durableEvents: settled.length,
      durableRecords: store.readEvents(aggregateId).length,
      horizons: Object.freeze([...horizons]),
      refusal,
      refusalDetail: detailOf(refusal),
      refusalFrozen: Object.isFrozen(refusal),
      seededRecords: store.readEvents(aggregateId).length,
    };
  } finally {
    store.close();
  }
}

/** A genuinely separate handle on the same database file, committing through production. */
function commitFromSecondConnection(databasePath: string): void {
  const writer = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
  try {
    const committed = writer.commitExpectedVersionDecision({
      commandKind: "SECURITY_IMPORT_SHADOW_RACE",
      committedResultBytes: new TextEncoder().encode("racing-answer"),
      correlationId: "correlation",
      decidedAt: "2026-08-16T00:00:00.000Z",
      events: [{
        eventId: "import-shadow-race:racer",
        eventType: "RacingWrite",
        payload: new TextEncoder().encode("racing-event"),
      }],
      expectedVersion: 0,
      key: { commandId: "import-shadow-race", principalId: "principal", projectId: PROJECT_ID },
      requestBytes: new TextEncoder().encode("racing-request"),
      targetAggregateId: "security-import-shadow-race",
    });
    if (committed.disposition !== "DECIDED") {
      throw new Error(`racing writer did not commit: ${committed.disposition}`);
    }
  } finally {
    writer.close();
  }
}

/** Every arm gets its own tree; the caller owns cleanup through `cleanupHostileRoots`. */
export function importShadowRoot(label: string): string {
  return hostileRoot(`import-shadow-${label}`);
}

/** Re-exported so a case table can name the layer without a second spelling of it. */
export { IMPORT_SHADOW_READ_LAYER };
