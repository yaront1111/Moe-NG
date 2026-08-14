import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { applyImport } from "./import-apply.js";
import type { ImportStorePort } from "./import-apply.js";
import { deriveProvenance } from "./import-canonical.js";
import { reconcileImport } from "./import-reconcile.js";
import type { ReconcileEntry } from "./import-reconcile.js";
import { decodeLegacySources } from "./legacy-decoder.js";
import type { ShadowEntity, ShadowProjection } from "./shadow-contract.js";
import { SHADOW_PROJECTION_VERSION } from "./shadow-contract.js";
import { compareShadowProjections, projectLegacyImport } from "./shadow-projection.js";
import { buildSourceManifest } from "./source-manifest.js";
import type { SourceManifest } from "./source-manifest.js";

/**
 * The corpus gate: the whole chain over a COMMITTED copy of a legacy project.
 *
 * Every record here comes OUT of the production decoder. Nothing in this file hands
 * production a record it authored, which is the defect that motivated the task:
 * `tests/migration/import/import-determinism.test.ts:70` hand-writes
 * `payload: { owner: "alice" }` while its own fixture bytes at line 40 already say
 * `"owner":"alice"`. That file is outside this task's owned paths and is left untouched;
 * the defect is recorded as a follow-up instead.
 *
 * Counts are EXACT and nonzero. A lower bound would pass on a sweep that generated
 * nothing, which is the failure mode the epic rail on generated cases names.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORPUS_ROOT = join(PACKAGE_ROOT, "corpus", "legacy-project");
const CLI = join(REPOSITORY_ROOT, "tools", "import", "import-shadow.ts");

/** Hand-transcribed from the committed bytes. A generated table could not police them. */
const CORPUS_MANIFEST_DIGEST =
  "d1ab82e6115ed2432cc1efa351ee2c2a29be69471fa8d234c1ddc08a3020eff0";

const CORPUS_FILES: readonly (readonly [string, string, number])[] = Object.freeze([
  ["notes/CHANGELOG.md", "2b49d142109308dd790347c86176dd1812d4a5a68468623deae9bcfa2c61055e", 109],
  ["skills/format.json", "2673891030a2d7e2b7c9b0d51d249e82c2cb1ee01f385d56c485fe9cce5276fa", 67],
  ["skills/lint.json", "76f00443de0dd703b1bbb24b925b74781739ac7f328980c22e9193f73a3485e5", 60],
  ["tasks/alpha.json", "1e9d3b00424ac983b8fc4e7f4fac71930e7e01375302a145c6963505da531731", 87],
  ["tasks/ambiguous.json", "9fbe106e7056ea117400a80038211ac80498dcb7c014e420c7fafcc073e7303f", 56],
  ["tasks/beta.json", "fd5040044fae8d8a92b94f40df1024d03964f4f9716e0cc810b9f7825ca60fc4", 92],
  ["tasks/broken.json", "ce1616fe65963f24f2b2cbe537d1cb849c1e3bda9370037ca5c47d1d52c1efa4", 30],
  ["tasks/gamma.json", "a9acbb16e453e1799d7d8d39dd57b4f9cc1b5f65d23debe0400b6b74fda487f9", 76],
  ["tasks/nested/delta.json", "d323fefaa04e51f6206876a05638c51b9dcdb1b1293cfc63864c7eba177f7ae0", 64],
]);

/** Discards everything: no database, no file, no handle. Nothing durable can happen. */
const DISCARDING_STORE: ImportStorePort = Object.freeze({
  commit: () => ({ currentVersion: 0 }),
});

function corpusManifest(): SourceManifest {
  const result = buildSourceManifest(CORPUS_ROOT);
  if ("outcome" in result) throw new Error(`corpus manifest refused: ${result.code}`);
  return result;
}

interface ShadowCliReport {
  readonly counts: Readonly<Record<string, number>>;
  readonly manifestDigest: string;
  readonly outcome: string;
  readonly sourceIntegrity: { readonly files: number; readonly verified: boolean };
}

interface FileFacts {
  readonly mtimeMs: number;
  readonly path: string;
  readonly size: number;
}

function observeCorpus(): readonly FileFacts[] {
  return CORPUS_FILES.map(([path]) => {
    const stat = statSync(join(CORPUS_ROOT, ...path.split("/")));
    return { mtimeMs: stat.mtimeMs, path, size: stat.size };
  });
}

describe("the committed corpus is the exact tree the expectations pin", () => {
  it("hashes to the recorded manifest digest, file for file", () => {
    const manifest = corpusManifest();

    expect(manifest.entries.length).toBe(CORPUS_FILES.length);
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(manifest.entries.map((entry) => [entry.path, entry.digest, entry.size]))
      .toEqual(CORPUS_FILES.map((expected) => [...expected]));
    expect(manifest.digest).toBe(CORPUS_MANIFEST_DIGEST);
  });

  it("carries no CR byte, so a mangled checkout names itself instead of a digest", () => {
    // `.gitattributes` is `* text=auto eol=lf`; a CRLF-bearing fixture would break every
    // digest above with an opaque failure that says nothing about line endings.
    for (const [path] of CORPUS_FILES) {
      const bytes = readFileSync(join(CORPUS_ROOT, ...path.split("/")));
      expect([path, bytes.includes(0x0d)]).toEqual([path, false]);
    }
  });
});

describe("the production decoder owns the corpus's semantics", () => {
  it("decodes exactly six records and refuses exactly three files, one per code", () => {
    const decoded = decodeLegacySources({ manifest: corpusManifest(), root: CORPUS_ROOT });

    expect(decoded.records.length).toBe(6);
    expect(decoded.refusals.length).toBe(3);
    expect(decoded.refusals.map((item) => [item.sourcePath, item.refusal.code, item.refusal.layer]))
      .toEqual([
        ["notes/CHANGELOG.md", "IMPORT_SOURCE_UNSUPPORTED", "DECODE"],
        ["tasks/ambiguous.json", "IMPORT_SOURCE_AMBIGUOUS", "DECODE"],
        ["tasks/broken.json", "IMPORT_SOURCE_MALFORMED", "DECODE"],
      ]);
  });

  it("reads each payload out of the bytes rather than assembling it from the path", () => {
    const decoded = decodeLegacySources({ manifest: corpusManifest(), root: CORPUS_ROOT });
    const byPath = new Map(decoded.records.map((record) => [record.sourcePath, record]));

    // `priority` is present in the bytes and absent from every path component, so it can
    // only be here if the payload was parsed. A path-derived payload cannot produce it.
    expect(byPath.get("tasks/alpha.json")?.payload).toEqual({ owner: "ada", priority: "high" });
    expect(byPath.get("tasks/alpha.json")?.declaredTime).toBe("2024-01-02T03:04:05.000Z");
    expect(byPath.get("tasks/gamma.json")?.payload)
      .toEqual({ held: true, owner: "ada", parent: "alpha" });
    expect(byPath.get("tasks/gamma.json")?.declaredTime).toBeNull();
  });

  it("reports exactly the four ambiguities the corpus was built to carry", () => {
    const manifest = corpusManifest();
    const decoded = decodeLegacySources({ manifest, root: CORPUS_ROOT });
    const entries: ReconcileEntry[] = decoded.records.map((record) => {
      const provenance = deriveProvenance(manifest, record);
      if ("outcome" in provenance) throw new Error(`provenance refused: ${provenance.code}`);
      return { provenance, record };
    });

    const report = reconcileImport({
      declaredRecordCount: null,
      entries,
      knownFields: ["dependsOn", "held", "owner", "parent"],
      sourcePaths: manifest.entries.map((entry) => entry.path),
    });

    expect(report.findings.length).toBe(4);
    expect(report.findings.map((item) => [item.provenance.sourcePath, item.ambiguityClass]))
      .toEqual([
        ["skills/format.json", "SKILL_MISSING_LICENSE"],
        ["skills/format.json", "SKILL_UNSUPPORTED_SCRIPT"],
        ["tasks/alpha.json", "UNKNOWN_FIELD"],
        ["tasks/nested/delta.json", "DANGLING_REF"],
      ]);
  });
});

describe("the shadow comparison over real decoded records", () => {
  function legacyProjection(): ShadowProjection {
    const manifest = corpusManifest();
    const decoded = decodeLegacySources({ manifest, root: CORPUS_ROOT });
    const report = applyImport({
      declaredRecordCount: null,
      knownFields: ["dependsOn", "held", "owner", "parent"],
      manifest,
      maxEventsPerCommit: 10_000,
      records: decoded.records,
      store: DISCARDING_STORE,
    });
    if ("outcome" in report) throw new Error(`import refused: ${report.code}`);
    return projectLegacyImport({ claims: report.claims, links: report.links });
  }

  /** The new side as a PERTURBATION of the old, which is what a real shadow run faces. */
  function perturbed(legacy: ShadowProjection): ShadowProjection {
    const entities: ShadowEntity[] = [];
    let changed = false;
    for (const item of legacy.entities) {
      if (item.kind === "BLOCKER") continue;
      if (item.kind === "CLAIM" && !changed) {
        changed = true;
        entities.push(Object.freeze({
          fields: Object.freeze({ ...item.fields, principal: "someone-else", tier: "gold" }),
          id: item.id,
          kind: item.kind,
        }));
        continue;
      }
      entities.push(item);
    }
    expect(changed).toBe(true);
    return Object.freeze({ entities: Object.freeze(entities), version: SHADOW_PROJECTION_VERSION });
  }

  it("projects every claim, hold and link the corpus produced", () => {
    const legacy = legacyProjection();

    // 6 claims, 1 hold (tasks/gamma.json), 3 links (one parent, two dependsOn).
    expect(legacy.entities.filter((item) => item.kind === "CLAIM").length).toBe(6);
    expect(legacy.entities.filter((item) => item.kind === "BLOCKER").length).toBe(1);
    expect(legacy.entities.filter((item) => item.kind === "LINK").length).toBe(3);
  });

  it("reports exactly the perturbation, in the declared total order", () => {
    const legacy = legacyProjection();
    const comparison = compareShadowProjections(legacy, perturbed(legacy));

    expect(comparison.mismatches.map((item) => [item.entityKind, item.field, item.mismatchKind])).toEqual([
      ["BLOCKER", "*", "ENTITY_ABSENT_ON_CURRENT"],
      ["CLAIM", "principal", "FIELD_DIFFERS"],
      ["CLAIM", "tier", "FIELD_UNMAPPED"],
    ]);
    expect(comparison.refusals.map((item) => [item.code, item.layer]))
      .toEqual([["IMPORT_SHADOW_FIELD_UNMAPPED", "SHADOW"]]);
    // The five untouched claims and three untouched links report nothing, so the three
    // above are the perturbation and not a comparator that flags everything.
    expect(comparison.mismatches.length).toBe(3);
  });

  it("orders identically however the entities were listed", () => {
    const legacy = legacyProjection();
    const current = perturbed(legacy);
    const reversed = Object.freeze({
      entities: Object.freeze([...legacy.entities].reverse()),
      version: SHADOW_PROJECTION_VERSION,
    });

    expect(JSON.stringify(compareShadowProjections(reversed, current).mismatches))
      .toBe(JSON.stringify(compareShadowProjections(legacy, current).mismatches));
  });
});

describe("the read-only CLI over the committed corpus", () => {
  it("reports exact counts and leaves every source byte and mtime untouched", () => {
    const before = observeCorpus();

    const args = ["--experimental-strip-types", CLI, CORPUS_ROOT];
    const stdout = execFileSync(process.execPath, args, { encoding: "utf8" });
    const report = JSON.parse(stdout) as ShadowCliReport;

    expect(report.outcome).toBe("COMPLETED");
    expect(report.manifestDigest).toBe(CORPUS_MANIFEST_DIGEST);
    expect(report.counts).toEqual({
      decodeRefusals: 3,
      mismatches: 10,
      reconciliations: 4,
      records: 6,
      shadowRefusals: 0,
      sourceFiles: 9,
      verifiedFiles: 9,
    });
    expect(report.sourceIntegrity).toEqual({ files: 9, verified: true });
    // Digest, size AND mtime for every covered file: a write that restores identical
    // content still moves mtime, and a digest-only check would call that untouched.
    expect(observeCorpus()).toEqual(before);
    expect(corpusManifest().digest).toBe(CORPUS_MANIFEST_DIGEST);
  });
});
