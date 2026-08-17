import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  IMPORT_EVENT_FACTS_VERSION,
  applyImport,
  buildSourceManifest,
  decodeImportEventFacts,
} from "../../../packages/import/src/index.js";
import type {
  ImportCommitInput,
  ImportEventFacts,
  ImportReport,
  ImportStorePort,
  LegacySourceRecord,
  SourceManifest,
} from "../../../packages/import/src/index.js";
import { SqliteEventStore } from "../../../packages/store/src/index.js";
import type { StoredEvent } from "../../../packages/store/src/index.js";

/**
 * DoD 1 (identical bytes produce identical imports) and DoD 3 (an interrupted import
 * commits wholly or not at all), proven by BEHAVIOUR.
 *
 * The real `SqliteEventStore` is wired into the production `ImportStorePort` here — this
 * directory is the one place allowed to import production packages by relative path, the
 * same arrangement `tests/fault/foundation/foundation-harness.ts` uses. Asserting
 * atomicity against a fake would only prove the fake is atomic.
 *
 * DoD 1 is asserted by comparing TWO FULL RUNS over separate trees, never by grepping the
 * source for `Date.now`. Only a two-run comparison catches a nondeterministic `readdir`
 * order or a Set iteration leaking into output.
 */

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const FIXTURE = Object.freeze([
  ["tasks/zeta.json", '{"legacyId":"z","owner":"alice","time":"2024-03-04T05:06:07.000Z"}'],
  ["tasks/alpha.json", '{"legacyId":"a","owner":"bob","time":"2024-01-02T03:04:05.000Z"}'],
  ["tasks/nested/mid.json", '{"legacyId":"m","owner":"alice","time":null}'],
] as const);

function tree(files: readonly (readonly [string, string])[]): string {
  const root = mkdtempSync(join(tmpdir(), "moe-migration-"));
  cleanups.push(() => {
    rmSync(root, { force: true, recursive: true });
  });
  for (const [path, body] of files) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

function manifestOf(root: string): SourceManifest {
  const result = buildSourceManifest(root);
  if ("outcome" in result) throw new Error(`manifest refused: ${result.code}`);
  return result;
}

/** Records derived from the manifest, so the record set is itself deterministic. */
function recordsFor(manifest: SourceManifest): readonly LegacySourceRecord[] {
  return manifest.entries.map((entry) => ({
    declaredTime: entry.path.includes("mid") ? null : "2024-03-04T05:06:07.000Z",
    kind: "task",
    legacyId: entry.path,
    payload: { owner: "alice" },
    sourcePath: entry.path,
  }));
}

function openStore(): SqliteEventStore {
  const store = SqliteEventStore.openEphemeralForTest();
  cleanups.push(() => {
    store.close();
  });
  return store;
}

function importInto(root: string, store: ImportStorePort): ImportReport {
  const manifest = manifestOf(root);
  const result = applyImport({
    declaredRecordCount: null,
    knownFields: ["owner"],
    manifest,
    maxEventsPerCommit: 100,
    records: recordsFor(manifest),
    store,
  });
  if ("outcome" in result) throw new Error(`import refused: ${result.code}/${result.layer}`);
  return result;
}

/** A stable fingerprint of everything the import claims to have produced. */
function fingerprint(report: ImportReport): string {
  return JSON.stringify({
    claims: report.claims.map((claim) => [claim.claimId, claim.status, claim.principal]),
    counts: report.counts,
    links: report.links.map((link) => [link.from, link.kind, link.to]),
    manifestDigest: report.manifestDigest,
    reconciliations: report.reconciliations.map((finding) => finding.ambiguityClass),
  });
}

function sourceSnapshot(root: string): readonly string[] {
  return FIXTURE.map(([path]) => {
    const stat = statSync(join(root, path));
    return `${path}:${String(stat.mtimeMs)}:${String(stat.size)}`;
  });
}

describe("DoD 1 — identical bytes produce an identical import", () => {
  it("produces the identical fingerprint from two separate trees and two fresh databases", () => {
    // Separate temp roots, files created in opposite order, separate ephemeral databases:
    // only the bytes are the same. A readdir order leaking into output fails here.
    const first = importInto(tree(FIXTURE), openStore());
    const second = importInto(tree([...FIXTURE].reverse()), openStore());
    expect(fingerprint(second)).toBe(fingerprint(first));
    expect(second.manifestDigest).toBe(first.manifestDigest);
  });

  it("produces a DIFFERENT digest when one byte of the source differs", () => {
    // The negative control. Without it the digest could be ignoring content entirely.
    const base = importInto(tree(FIXTURE), openStore());
    const changed = importInto(tree([
      ["tasks/zeta.json", '{"legacyId":"z","owner":"Alice","time":"2024-03-04T05:06:07.000Z"}'],
      ["tasks/alpha.json", '{"legacyId":"a","owner":"bob","time":"2024-01-02T03:04:05.000Z"}'],
      ["tasks/nested/mid.json", '{"legacyId":"m","owner":"alice","time":null}'],
    ]), openStore());
    expect(changed.manifestDigest).not.toBe(base.manifestDigest);
    expect(fingerprint(changed)).not.toBe(fingerprint(base));
  });

  it("orders imported claims into the importer's own total order, not the filesystem's", () => {
    // Asserting the EXPECTED order, not merely that two runs agree. NTFS happens to hand
    // back directory entries in roughly sorted order, so a two-run comparison passes even
    // with the comparator neutered — it would only fail on ext4, months later, for
    // somebody else. The explicit expectation makes the comparator load-bearing here.
    const forward = importInto(tree(FIXTURE), openStore());
    const reverse = importInto(tree([...FIXTURE].reverse()), openStore());
    const expected = ["tasks/alpha.json", "tasks/nested/mid.json", "tasks/zeta.json"];
    expect(forward.claims.map((claim) => claim.provenance.sourcePath)).toEqual(expected);
    expect(reverse.claims.map((claim) => claim.provenance.sourcePath)).toEqual(expected);
  });
});

describe("DoD 3 — an interrupted import commits wholly or not at all", () => {
  it("leaves no rows behind when the commit is interrupted mid-flight", () => {
    const root = tree(FIXTURE);
    const store = openStore();
    const manifest = manifestOf(root);
    const aggregateId = `legacy-import:${manifest.digest}`;
    expect(store.getAggregateVersion(aggregateId)).toBe(0);

    // Interrupt inside the store seam, exactly where a crash would land. The commit is
    // never completed, so nothing may become readable. SQLite's own all-or-nothing under
    // BEGIN IMMEDIATE is @moe/store's drilled property; this composes it rather than
    // re-proving it, and asserts the importer's half: refuse, and leave nothing behind.
    const interrupting: ImportStorePort = {
      commit() {
        throw new Error("interrupted mid-import");
      },
    };
    const result = applyImport({
      declaredRecordCount: null,
      knownFields: ["owner"],
      manifest,
      maxEventsPerCommit: 100,
      records: recordsFor(manifest),
      store: interrupting,
    });
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_COMMIT_FAILED");
    expect(result.layer).toBe("APPLY");
    // No partial import is readable afterwards.
    expect(store.readEvents(aggregateId).length).toBe(0);
  });

  it("leaves every source file's mtime and size unchanged across a successful import", () => {
    const root = tree(FIXTURE);
    const before = sourceSnapshot(root);
    importInto(root, openStore());
    expect(sourceSnapshot(root)).toEqual(before);
  });

  it("leaves the source unchanged when the import fails", () => {
    // A rollback that corrupts the source is still a failure, so both halves are asserted.
    const root = tree(FIXTURE);
    const before = sourceSnapshot(root);
    const manifest = manifestOf(root);
    const result = applyImport({
      declaredRecordCount: null,
      knownFields: ["owner"],
      manifest,
      maxEventsPerCommit: 100,
      records: recordsFor(manifest),
      store: {
        commit() {
          throw new Error("store unavailable");
        },
      },
    });
    expect("outcome" in result).toBe(true);
    expect(sourceSnapshot(root)).toEqual(before);
  });
});

interface Recorder {
  readonly commits: ImportCommitInput[];
  readonly dispositions: string[];
  readonly port: ImportStorePort;
}

/**
 * Delegates `commit` to the REAL store unchanged and only records what came back, so the
 * disposition asserted below is SQLite's own answer rather than a fake's restatement of it.
 */
function recordingPort(store: SqliteEventStore): Recorder {
  const commits: ImportCommitInput[] = [];
  const dispositions: string[] = [];
  return {
    commits,
    dispositions,
    port: {
      commit(input) {
        commits.push(input);
        const result = store.commit(input);
        dispositions.push(result.disposition);
        return result;
      },
    },
  };
}

/** Everything durable about one row, so a replay that rewrote any of it is visible. */
function envelope(event: StoredEvent): Record<string, unknown> {
  return {
    aggregateId: event.aggregateId,
    aggregateSequence: event.aggregateSequence,
    commandId: event.commandId,
    domainSchemaVersion: event.domainSchemaVersion,
    eventId: event.eventId,
    eventType: event.eventType,
    globalPosition: String(event.globalPosition),
    payload: [...event.payload],
    requestSha256: event.requestSha256,
  };
}

function factsOf(event: StoredEvent): ImportEventFacts {
  const facts = decodeImportEventFacts(event.payload);
  if ("outcome" in facts) throw new Error(`decode refused: ${facts.code}/${facts.layer}`);
  return facts;
}

describe("the durable event envelope declares the import facts schema", () => {
  it("stamps every stored event, and an identical replay changes nothing", () => {
    const root = tree(FIXTURE);
    const store = openStore();
    const recorder = recordingPort(store);
    const report = importInto(root, recorder.port);
    const aggregateId = `legacy-import:${report.manifestDigest}`;
    const commandId = recorder.commits[0]?.commandId;
    if (commandId === undefined) throw new Error("production issued no commit");

    // The sweep below is only worth anything over a non-empty page, and `hasMore` proves
    // the page is the WHOLE ledger rather than a first slice that happened to agree.
    const global = store.readEventsAfter(0n);
    const aggregate = store.readAggregateEvents(aggregateId);
    expect(global.items.length).toBe(report.counts.claims);
    expect(global.items.length).toBeGreaterThan(0);
    expect(global.hasMore).toBe(false);
    expect(aggregate.items.length).toBe(global.items.length);
    expect(aggregate.hasMore).toBe(false);
    // Plain applyImport commits; it never touches the decision API. Zero is the CORRECT
    // count here, so it is pinned rather than left as an unexamined absence.
    const decisions = store.readCommandDecisionsAfter(0n);
    expect(decisions.items).toEqual([]);
    expect(decisions.hasMore).toBe(false);

    for (const event of global.items) {
      const facts = factsOf(event);
      // The envelope and the payload it carries must agree, and both must be the exact
      // published constant — the store's generic default would satisfy neither.
      expect(event.domainSchemaVersion).toBe(IMPORT_EVENT_FACTS_VERSION);
      expect(facts.schemaVersion).toBe(event.domainSchemaVersion);
      expect(event.eventId).toBe(facts.claim.claimId);
      expect(event.aggregateId).toBe(aggregateId);
    }

    const before = {
      envelopes: global.items.map(envelope),
      horizon: String(store.readEventHorizon()),
      receipt: store.getCommandReceipt(commandId),
      version: store.getAggregateVersion(aggregateId),
    };
    expect(before.receipt?.eventIds).toEqual(global.items.map((event) => event.eventId));
    expect(before.version).toBe(global.items.length);

    // The SAME store, the SAME bytes: the store replays its receipt instead of writing a
    // second copy. An already-stamped row therefore stays stamped, and no row is rewritten.
    const replayed = importInto(root, recorder.port);
    expect(recorder.dispositions).toEqual(["COMMITTED", "REPLAYED"]);
    expect(replayed.manifestDigest).toBe(report.manifestDigest);
    const after = store.readEventsAfter(0n);
    expect(after.hasMore).toBe(false);
    expect(after.items.map(envelope)).toEqual(before.envelopes);
    expect(String(store.readEventHorizon())).toBe(before.horizon);
    expect(store.getAggregateVersion(aggregateId)).toBe(before.version);
    expect(store.getCommandReceipt(commandId)).toEqual(before.receipt);
    expect(store.readAggregateEvents(aggregateId).items.length).toBe(before.envelopes.length);
    expect(store.readCommandDecisionsAfter(0n).items).toEqual([]);
  });
});

describe("the import is readable back out of a real database", () => {
  it("commits every event to the real store and reports matching counts", () => {
    const root = tree(FIXTURE);
    const store = openStore();
    const report = importInto(root, store);
    const aggregateId = `legacy-import:${report.manifestDigest}`;
    const events = store.readEvents(aggregateId);
    expect(events.length).toBe(report.counts.claims);
    expect(report.counts.sourceFiles).toBe(FIXTURE.length);
    // Nothing imported is active: the vocabulary has no such arm to report.
    for (const claim of report.claims) {
      expect(["HISTORICAL", "SUSPENDED"]).toContain(claim.status);
    }
  });
});
