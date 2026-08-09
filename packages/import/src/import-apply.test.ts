import { describe, expect, it } from "vitest";

import { applyImport } from "./import-apply.js";
import type { ImportCommitInput, ImportStorePort } from "./import-apply.js";
import type { LegacySourceRecord } from "./import-canonical.js";
import { IMPORTED_CLAIM_STATUSES, LEGACY_LINK_KINDS } from "./import-contract.js";
import type { ImportReport } from "./import-contract.js";
import type { SourceManifest } from "./source-manifest.js";

/**
 * Design §21.4, §21.5 and §21.7's all-or-nothing half.
 *
 * The store seam is spied rather than faked: every assertion below reads what the
 * PRODUCTION module actually handed the port, so a test helper cannot restate the rule it
 * is supposed to be checking. The real SqliteEventStore is wired in by the migration
 * suite.
 */

const MANIFEST: SourceManifest = Object.freeze({
  digest: "a".repeat(64),
  entries: Object.freeze([
    Object.freeze({ digest: "b".repeat(64), path: "tasks/one.json", size: 10 }),
    Object.freeze({ digest: "c".repeat(64), path: "tasks/two.json", size: 20 }),
  ]),
  version: "moe-import-source-manifest/1",
});

function record(over: Partial<LegacySourceRecord> = {}): LegacySourceRecord {
  return {
    declaredTime: "2024-03-04T05:06:07.000Z",
    kind: "task",
    legacyId: "task-1",
    payload: { owner: "alice" },
    sourcePath: "tasks/one.json",
    ...over,
  };
}

interface Spy {
  readonly commits: ImportCommitInput[];
  readonly port: ImportStorePort;
}

function spyStore(fail?: string): Spy {
  const commits: ImportCommitInput[] = [];
  return {
    commits,
    port: {
      commit(input) {
        commits.push(input);
        if (fail !== undefined) throw new Error(fail);
        return { currentVersion: input.events.length };
      },
    },
  };
}

function run(records: readonly LegacySourceRecord[], spy: Spy, maxEvents = 100): ReturnType<typeof applyImport> {
  return applyImport({
    declaredRecordCount: null,
    knownFields: ["dependsOn", "held", "owner", "parent"],
    manifest: MANIFEST,
    maxEventsPerCommit: maxEvents,
    records,
    store: spy.port,
  });
}

function reported(result: ReturnType<typeof applyImport>): ImportReport {
  if ("outcome" in result) throw new Error(`refused: ${result.code}/${result.layer}`);
  return result;
}

describe("the whole import is one commit, or it is refused", () => {
  it("writes every event in a single commit", () => {
    const spy = spyStore();
    const report = reported(run([
      record({ legacyId: "a" }),
      record({ legacyId: "b", sourcePath: "tasks/two.json" }),
    ], spy));
    expect(spy.commits.length).toBe(1);
    expect(spy.commits[0]?.events.length).toBe(2);
    expect(report.counts.claims).toBe(2);
  });

  it("refuses rather than splitting when the import exceeds the per-commit bound", () => {
    const spy = spyStore();
    const result = run([record({ legacyId: "a" }), record({ legacyId: "b" })], spy, 1);
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_TOO_LARGE_FOR_ONE_COMMIT");
    expect(result.layer).toBe("APPLY");
    // Nothing may be written on the refusal path.
    expect(spy.commits.length).toBe(0);
  });

  it("reports a failed commit with its code and layer rather than throwing", () => {
    const spy = spyStore("disk full");
    const result = run([record()], spy);
    expect("outcome" in result).toBe(true);
    if (!("outcome" in result)) return;
    expect(result.code).toBe("IMPORT_COMMIT_FAILED");
    expect(result.layer).toBe("APPLY");
    expect(result.detail).toContain("disk full");
  });
});

describe("nothing imported is active, and no link is a hard edge", () => {
  it("imports an ordinary claim as HISTORICAL", () => {
    const report = reported(run([record()], spyStore()));
    expect(report.claims[0]?.status).toBe("HISTORICAL");
  });

  it("imports a held legacy claim as SUSPENDED, never active", () => {
    const report = reported(run([record({ payload: { held: true, owner: "alice" } })], spyStore()));
    expect(report.claims[0]?.status).toBe("SUSPENDED");
  });

  it("can only ever produce the two non-active statuses", () => {
    // Read through the PRODUCTION vocabulary: an ACTIVE arm does not exist to be produced.
    const report = reported(run([
      record({ legacyId: "a", payload: { held: true, owner: "x" } }),
      record({ legacyId: "b", payload: { owner: "y" } }),
    ], spyStore()));
    for (const claim of report.claims) {
      expect(IMPORTED_CLAIM_STATUSES).toContain(claim.status);
    }
    expect([...IMPORTED_CLAIM_STATUSES]).toEqual(["HISTORICAL", "SUSPENDED"]);
  });

  it("imports dependsOn as RELATED evidence and parent as CONTAINS evidence", () => {
    const report = reported(run([record({
      payload: { dependsOn: ["task-9"], owner: "alice", parent: "epic-1" },
    })], spyStore()));
    expect(report.links.map((link) => link.kind)).toEqual(["CONTAINS", "RELATED"]);
    for (const link of report.links) {
      expect(link.evidenceOnly).toBe(true);
      expect(LEGACY_LINK_KINDS).toContain(link.kind);
    }
  });
});

describe("the commit itself is deterministic", () => {
  it("derives committedAt from source time, never from a clock", () => {
    const spy = spyStore();
    run([record({ declaredTime: "2024-03-04T05:06:07.000Z" })], spy);
    expect(spy.commits[0]?.committedAt).toBe("2024-03-04T05:06:07.000Z");
  });

  it("uses the deterministic sentinel when no source declared a time", () => {
    const spy = spyStore();
    run([record({ declaredTime: null })], spy);
    expect(spy.commits[0]?.committedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("produces an identical commit for two runs over the same records", () => {
    const first = spyStore();
    const second = spyStore();
    const records = [record({ legacyId: "b", sourcePath: "tasks/two.json" }), record({ legacyId: "a" })];
    run(records, first);
    run([...records].reverse(), second);
    const left = first.commits[0];
    const right = second.commits[0];
    expect(right?.commandId).toBe(left?.commandId);
    expect(right?.committedAt).toBe(left?.committedAt);
    expect(right?.events.map((event) => event.eventId))
      .toEqual(left?.events.map((event) => event.eventId));
  });
});
