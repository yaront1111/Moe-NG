import { describe, expect, it } from "vitest";

import {
  AMBIGUITY_CLASSES,
  AMBIGUITY_OUTCOME,
  DERIVED_IDENTITY_AMBIGUITY_CLASSES,
  DESIGN_AMBIGUITY_CLASSES,
  SKILL_ASSET_AMBIGUITY_CLASSES,
} from "./import-contract.js";
import type { AmbiguityClass, ImportProvenance } from "./import-contract.js";
import type { LegacySourceRecord } from "./import-canonical.js";
import { reconcileImport } from "./import-reconcile.js";
import type { ReconcileEntry } from "./import-reconcile.js";

/**
 * Design §21.6 plus the 2026-08-07 roadmap amendment on this task.
 *
 * EACH CLASS GETS ITS OWN FIXTURE. A single "bad input" case would let twelve of the
 * thirteen regress unseen, which is precisely the detached-assertion failure the epic rail
 * warns about. The final test asserts every DECLARED class was actually produced, so a
 * detector that silently stops firing fails by name.
 */

const PROVENANCE: ImportProvenance = Object.freeze({
  manifestDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
  sourcePath: "tasks/one.json",
  sourceTime: "2024-03-04T05:06:07.000Z",
  timeBasis: "SOURCE_DECLARED",
});

function entry(over: Partial<LegacySourceRecord> = {}, path?: string): ReconcileEntry {
  const record: LegacySourceRecord = {
    declaredTime: "2024-03-04T05:06:07.000Z",
    kind: "task",
    legacyId: "task-1",
    payload: {},
    sourcePath: path ?? "tasks/one.json",
    ...over,
  };
  return {
    provenance: Object.freeze({ ...PROVENANCE, sourcePath: record.sourcePath }),
    record,
  };
}

const KNOWN_FIELDS = Object.freeze(["dependsOn", "owner", "state", "title"]);

function classesFrom(entries: readonly ReconcileEntry[], over: {
  readonly declaredRecordCount?: number | null;
  readonly sourcePaths?: readonly string[];
} = {}): readonly AmbiguityClass[] {
  const report = reconcileImport({
    declaredRecordCount: over.declaredRecordCount ?? null,
    entries,
    knownFields: KNOWN_FIELDS,
    sourcePaths: over.sourcePaths ?? entries.map((item) => item.record.sourcePath),
  });
  return report.findings.map((finding) => finding.ambiguityClass);
}

describe("each design §21.6 class is detected on its own fixture", () => {
  it("COUNT_MISMATCH when the source declares a different total", () => {
    expect(classesFrom([entry()], { declaredRecordCount: 5 })).toContain("COUNT_MISMATCH");
  });

  it("COUNT_MISMATCH when the source declared records and ZERO were read", () => {
    // The total-loss case: every record dropped upstream. No entry exists to lend the
    // finding provenance, so it must carry the explicit no-source sentinel instead —
    // suppressing it would report a "successful" import of nothing, the exact
    // successful-looking failure §21.6's "report exact counts" exists to prevent.
    const report = reconcileImport({
      declaredRecordCount: 100,
      entries: [],
      knownFields: KNOWN_FIELDS,
      sourcePaths: ["tasks/one.json"],
    });
    expect(report.findings.map((finding) => finding.ambiguityClass)).toEqual(["COUNT_MISMATCH"]);
    expect(report.findings[0]?.detail).toContain("100");
    expect(report.findings[0]?.detail).toContain("0 were read");
    expect(report.findings[0]?.outcome).toBe(AMBIGUITY_OUTCOME);
  });

  it("reports no COUNT_MISMATCH when the source declared zero and zero were read", () => {
    expect(classesFrom([], { declaredRecordCount: 0 })).toEqual([]);
  });

  it("UNKNOWN_FIELD when a payload carries a field outside the known set", () => {
    expect(classesFrom([entry({ payload: { mystery: 1 } })])).toContain("UNKNOWN_FIELD");
  });

  it("DANGLING_REF when dependsOn names a record that was not imported", () => {
    expect(classesFrom([entry({ payload: { dependsOn: ["task-absent"] } })]))
      .toContain("DANGLING_REF");
  });

  it("CYCLE when dependsOn forms a loop", () => {
    const classes = classesFrom([
      entry({ legacyId: "a", payload: { dependsOn: ["b"] } }, "tasks/a.json"),
      entry({ legacyId: "b", payload: { dependsOn: ["a"] } }, "tasks/b.json"),
    ]);
    expect(classes).toContain("CYCLE");
    expect(classes).not.toContain("DANGLING_REF");
  });

  it("SPLIT_OWNERSHIP when one legacy id is claimed by two owners", () => {
    expect(classesFrom([
      entry({ legacyId: "a", payload: { owner: "alice" } }, "tasks/a.json"),
      entry({ legacyId: "a", payload: { owner: "bob" } }, "tasks/b.json"),
    ])).toContain("SPLIT_OWNERSHIP");
  });

  it("CORRUPT_BYTES when the payload cannot be canonicalised", () => {
    expect(classesFrom([entry({ payload: { n: Number.MAX_SAFE_INTEGER + 2 } })]))
      .toContain("CORRUPT_BYTES");
  });

  it("CASE_PATH_CONFLICT when two source paths differ only by case", () => {
    // Foo.json and foo.json cannot coexist on NTFS but can in a tree copied from another
    // OS. Letting one silently overwrite the other loses data AND still hashes stably.
    expect(classesFrom([entry()], { sourcePaths: ["skills/Foo.json", "skills/foo.json"] }))
      .toContain("CASE_PATH_CONFLICT");
  });
});

describe("each roadmap-amendment skill class is detected on its own fixture", () => {
  it("SKILL_MALFORMED when a skill asset is not a structured record", () => {
    expect(classesFrom([entry({ kind: "skill", payload: { skill: "not-a-record" } })]))
      .toContain("SKILL_MALFORMED");
  });

  it("SKILL_AMBIGUOUS when two skill assets claim the same identity and version", () => {
    expect(classesFrom([
      entry({ kind: "skill", legacyId: "s", payload: { skill: { license: "MIT", version: "1" } } }, "skills/a.json"),
      entry({ kind: "skill", legacyId: "s", payload: { skill: { license: "MIT", version: "1" } } }, "skills/b.json"),
    ])).toContain("SKILL_AMBIGUOUS");
  });

  it("SKILL_MISSING_LICENSE when a skill declares no license", () => {
    expect(classesFrom([entry({ kind: "skill", payload: { skill: { version: "1" } } })]))
      .toContain("SKILL_MISSING_LICENSE");
  });

  it("SKILL_UNSUPPORTED_SCRIPT when a skill declares an executable script", () => {
    expect(classesFrom([entry({
      kind: "skill",
      payload: { skill: { license: "MIT", script: "install.ps1", version: "1" } },
    })])).toContain("SKILL_UNSUPPORTED_SCRIPT");
  });

  it("SKILL_ESCAPING_ASSET when an asset path escapes its skill directory", () => {
    expect(classesFrom([entry({
      kind: "skill",
      payload: { skill: { assets: ["../../etc/passwd"], license: "MIT", version: "1" } },
    })])).toContain("SKILL_ESCAPING_ASSET");
  });
});

describe("the derived-identity guard is detected on its own fixture", () => {
  it("DUPLICATE_IDENTITY when one identity tuple carries two conflicting payloads", () => {
    // (kind, legacyId, sourcePath) is exactly what deriveImportedId digests, so these two
    // records derive the SAME imported id; the differing titles make the collapse a
    // last-writer-wins guess unless it is reported.
    expect(classesFrom([
      entry({ payload: { title: "first" } }),
      entry({ payload: { title: "second" } }),
    ])).toContain("DUPLICATE_IDENTITY");
  });

  it("stays silent for byte-identical duplicates, which collapse losslessly", () => {
    expect(classesFrom([
      entry({ payload: { title: "same" } }),
      entry({ payload: { title: "same" } }),
    ])).not.toContain("DUPLICATE_IDENTITY");
  });

  it("stays silent when the same legacy id comes from two different files", () => {
    // A different sourcePath derives a DIFFERENT imported id — no collapse to report.
    // (That pair is SPLIT_OWNERSHIP's territory when the owners also differ.)
    expect(classesFrom([
      entry({ payload: { title: "first" } }, "tasks/a.json"),
      entry({ payload: { title: "second" } }, "tasks/b.json"),
    ])).not.toContain("DUPLICATE_IDENTITY");
  });
});

describe("the sweep is complete and nothing is guessed or dropped", () => {
  it("produces every declared class across the fixture set, so none can quietly stop firing", () => {
    const entries: readonly ReconcileEntry[] = [
      entry({ legacyId: "a", payload: { dependsOn: ["b"], mystery: 1 } }, "tasks/a.json"),
      entry({ legacyId: "b", payload: { dependsOn: ["a"], owner: "alice" } }, "tasks/b.json"),
      entry({ legacyId: "b", payload: { owner: "bob" } }, "tasks/c.json"),
      entry({ legacyId: "d", payload: { dependsOn: ["nobody"] } }, "tasks/d.json"),
      entry({ legacyId: "e", payload: { n: Number.MAX_SAFE_INTEGER + 2 } }, "tasks/e.json"),
      entry({ kind: "skill", legacyId: "f", payload: { skill: "flat" } }, "skills/f.json"),
      entry({ kind: "skill", legacyId: "g", payload: { skill: { version: "1" } } }, "skills/g.json"),
      entry({ kind: "skill", legacyId: "h", payload: { skill: { license: "MIT", script: "x.sh", version: "1" } } }, "skills/h.json"),
      entry({ kind: "skill", legacyId: "i", payload: { skill: { assets: ["../out"], license: "MIT", version: "1" } } }, "skills/i.json"),
      entry({ kind: "skill", legacyId: "j", payload: { skill: { license: "MIT", version: "1" } } }, "skills/j.json"),
      entry({ kind: "skill", legacyId: "j", payload: { skill: { license: "MIT", version: "1" } } }, "skills/J.json"),
      entry({ legacyId: "k", payload: { title: "one" } }, "tasks/k.json"),
      entry({ legacyId: "k", payload: { title: "two" } }, "tasks/k.json"),
    ];
    const produced = new Set(classesFrom(entries, { declaredRecordCount: 99 }));
    // Guard the sweep itself: a fixture set that produced nothing would pass a
    // subset check vacuously.
    expect(produced.size).toBeGreaterThan(0);
    expect([...AMBIGUITY_CLASSES].filter((name) => !produced.has(name))).toEqual([]);
    expect(DESIGN_AMBIGUITY_CLASSES.length).toBe(7);
    expect(SKILL_ASSET_AMBIGUITY_CLASSES.length).toBe(5);
    expect(DERIVED_IDENTITY_AMBIGUITY_CLASSES.length).toBe(1);
  });

  it("preserves every finding with typed provenance and the single outcome", () => {
    const report = reconcileImport({
      declaredRecordCount: null,
      entries: [entry({ payload: { mystery: 1 } })],
      knownFields: KNOWN_FIELDS,
      sourcePaths: ["tasks/one.json"],
    });
    expect(report.findings.length).toBe(1);
    const finding = report.findings[0];
    expect(finding?.outcome).toBe(AMBIGUITY_OUTCOME);
    expect(finding?.provenance.sourcePath).toBe("tasks/one.json");
    expect(finding?.provenance.sourceDigest).toBe("b".repeat(64));
    expect(finding?.detail).toContain("mystery");
  });

  it("reports a clean import as zero findings rather than throwing", () => {
    const report = reconcileImport({
      declaredRecordCount: 1,
      entries: [entry({ payload: { owner: "alice", state: "OPEN" } })],
      knownFields: KNOWN_FIELDS,
      sourcePaths: ["tasks/one.json"],
    });
    expect(report.findings).toEqual([]);
  });

  it("orders findings deterministically regardless of entry order", () => {
    const entries = [
      entry({ legacyId: "z", payload: { mystery: 1 } }, "tasks/z.json"),
      entry({ legacyId: "a", payload: { mystery: 1 } }, "tasks/a.json"),
    ];
    const forward = classesFrom(entries);
    const reversed = classesFrom([...entries].reverse());
    expect(reversed).toEqual(forward);
  });
});
