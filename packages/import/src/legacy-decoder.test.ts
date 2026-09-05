import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { IMPORT_REFUSAL_CODES, IMPORT_REFUSAL_LAYERS } from "./import-contract.js";
import { LEGACY_DECODER_VERSION, decodeLegacySources } from "./legacy-decoder.js";
import type { DecodeReport } from "./legacy-decoder.js";
import { buildSourceManifest } from "./source-manifest.js";
import type { SourceManifest } from "./source-manifest.js";

/**
 * The decoder is the production owner of legacy payload SEMANTICS.
 *
 * Every assertion here pins an exact refusal code AND the layer that produced it, because
 * more than one layer can refuse the same file and a test that only asserts "refused"
 * stays green when a different layer starts answering first.
 *
 * The payload assertions are the point of the module: `tests/migration/import/`
 * hand-wrote `payload: { owner: "alice" }` next to fixture bytes that already said
 * `"owner":"alice"`, which is a test authoring semantics production should derive. Here
 * the payload is only ever read back OUT of the decoder and compared to what the bytes
 * say, so nothing in this file can supply a record to production.
 */

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const GOOD = Object.freeze([
  ["tasks/alpha.json", '{"legacyId":"a","owner":"bob","time":"2024-01-02T03:04:05.000Z"}'],
  ["tasks/nested/mid.json", '{"legacyId":"m","owner":"alice","time":null}'],
  ["skills/lint.json", '{"legacyId":"lint","skill":{"license":"MIT","version":"1"}}'],
] as const);

function tree(files: readonly (readonly [string, string])[]): string {
  const root = mkdtempSync(join(tmpdir(), "moe-decoder-"));
  cleanups.push(() => {
    rmSync(root, { force: true, recursive: true });
  });
  for (const [path, body] of files) write(root, path, body);
  return root;
}

function write(root: string, path: string, body: string): void {
  const full = join(root, ...path.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

function manifestOf(root: string): SourceManifest {
  const result = buildSourceManifest(root);
  if ("outcome" in result) throw new Error(`manifest refused: ${result.code}`);
  return result;
}

function decode(root: string): DecodeReport {
  return decodeLegacySources({ manifest: manifestOf(root), root });
}

/** Decodes a tree whose manifest was built BEFORE `mutate` ran, which is the real hazard. */
function decodeAfter(
  files: readonly (readonly [string, string])[],
  mutate: (root: string) => void,
): DecodeReport {
  const root = tree(files);
  const manifest = manifestOf(root);
  mutate(root);
  return decodeLegacySources({ manifest, root });
}

function refusalAt(report: DecodeReport, sourcePath: string): DecodeReport["refusals"][number] {
  const found = report.refusals.find((entry) => entry.sourcePath === sourcePath);
  if (found === undefined) throw new Error(`no refusal for ${sourcePath}`);
  return found;
}

describe("decoding supported legacy bytes", () => {
  it("derives every record field from the bytes and the manifest, never from the path", () => {
    const report = decode(tree(GOOD));

    expect(report.version).toBe(LEGACY_DECODER_VERSION);
    expect(report.refusals).toEqual([]);
    expect(report.records.length).toBe(3);
    // The payload is the document MINUS its identity/time envelope. Asserted as an exact
    // object: an extra key invented from the path, or a dropped domain field, fails here.
    expect(report.records.map((record) => [record.sourcePath, record.payload])).toEqual([
      ["skills/lint.json", { skill: { license: "MIT", version: "1" } }],
      ["tasks/alpha.json", { owner: "bob" }],
      ["tasks/nested/mid.json", { owner: "alice" }],
    ]);
  });

  it("takes legacyId, declaredTime and kind from the source rather than defaulting them", () => {
    const report = decode(tree(GOOD));
    const byPath = new Map(report.records.map((record) => [record.sourcePath, record]));

    expect(byPath.get("tasks/alpha.json")?.legacyId).toBe("a");
    expect(byPath.get("tasks/alpha.json")?.declaredTime).toBe("2024-01-02T03:04:05.000Z");
    expect(byPath.get("tasks/alpha.json")?.kind).toBe("task");
    // Declared null stays null. A clock read here would make the same bytes decode
    // differently on every run, which is the property the whole package rests on.
    expect(byPath.get("tasks/nested/mid.json")?.declaredTime).toBeNull();
    expect(byPath.get("skills/lint.json")?.kind).toBe("skill");
    expect(byPath.get("skills/lint.json")?.declaredTime).toBeNull();
  });

  it("freezes every emitted record and its payload", () => {
    const [record] = decode(tree(GOOD)).records;

    expect(record).toBeDefined();
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record?.payload)).toBe(true);
  });

  it("decodes the same bytes into the same records twice", () => {
    const first = decode(tree(GOOD));
    const second = decode(tree([...GOOD].reverse()));

    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
  });
});

describe("bytes the decoder refuses rather than guesses", () => {
  it("refuses a file whose bytes changed after the manifest hashed them", () => {
    const report = decodeAfter(GOOD, (root) => {
      write(root, "tasks/alpha.json", '{"legacyId":"a","owner":"mallory","time":null}');
    });

    // Asserted as the whole refusal list rather than through a lookup helper: a decoder
    // that stopped checking digests produces NO refusal, and this form reddens on the
    // missing outcome instead of on a helper throwing about a lookup.
    expect(report.refusals.map((item) => [item.sourcePath, item.refusal.code, item.refusal.layer]))
      .toEqual([["tasks/alpha.json", "IMPORT_SOURCE_DIGEST_MISMATCH", "DECODE"]]);
    // The tampered file yields NO record, and the untouched files still decode.
    expect(report.records.map((record) => record.sourcePath))
      .toEqual(["skills/lint.json", "tasks/nested/mid.json"]);
    expect(report.refusals.length).toBe(1);
  });

  it("refuses an unsupported shape instead of decoding it as a task", () => {
    const report = decode(tree([
      ...GOOD,
      ["notes/readme.md", "# not a legacy record"],
      ["tasks/events.jsonl", '{"legacyId":"e"}\n{"legacyId":"f"}\n'],
    ]));

    expect(refusalAt(report, "notes/readme.md").refusal.code).toBe("IMPORT_SOURCE_UNSUPPORTED");
    expect(refusalAt(report, "notes/readme.md").refusal.layer).toBe("DECODE");
    expect(refusalAt(report, "tasks/events.jsonl").refusal.code).toBe("IMPORT_SOURCE_UNSUPPORTED");
    expect(report.records.length).toBe(3);
    expect(report.refusals.length).toBe(2);
  });

  it("refuses a top-level directory named after an Object.prototype member", () => {
    // `in` on the family table answered true for these, so the file decoded with
    // Object.prototype.toString (or Object.prototype itself) as its kind instead of refusing.
    const report = decode(tree([
      ...GOOD,
      ["constructor/x.json", '{"legacyId":"c","owner":"me"}'],
      ["toString/y.json", '{"legacyId":"t","owner":"me"}'],
      ["hasOwnProperty/z.json", '{"legacyId":"h","owner":"me"}'],
    ]));

    for (const path of ["constructor/x.json", "toString/y.json", "hasOwnProperty/z.json"]) {
      expect(refusalAt(report, path).refusal.code).toBe("IMPORT_SOURCE_UNSUPPORTED");
      expect(refusalAt(report, path).refusal.layer).toBe("DECODE");
    }
    expect(report.records.length).toBe(3);
    expect(report.records.every((record) => typeof record.kind === "string")).toBe(true);
    expect(report.refusals.length).toBe(3);
  });

  it("refuses malformed bytes and a non-record document with the same exact code", () => {
    const report = decode(tree([
      ["tasks/truncated.json", '{"legacyId":"t","owner":'],
      ["tasks/array.json", '[{"legacyId":"arr"}]'],
      ["tasks/untyped-time.json", '{"legacyId":"u","time":17}'],
      ["tasks/anonymous.json", '{"owner":"bob"}'],
    ]));

    for (const path of [
      "tasks/anonymous.json",
      "tasks/array.json",
      "tasks/truncated.json",
      "tasks/untyped-time.json",
    ]) {
      expect(refusalAt(report, path).refusal.code).toBe("IMPORT_SOURCE_MALFORMED");
      expect(refusalAt(report, path).refusal.layer).toBe("DECODE");
    }
    expect(report.records).toEqual([]);
    expect(report.refusals.length).toBe(4);
  });

  it("refuses bytes that admit two readings rather than picking one", () => {
    const report = decode(tree([
      ["tasks/two-ids.json", '{"id":"old","legacyId":"new","owner":"bob"}'],
      ["tasks/one-id.json", '{"id":"only","owner":"bob"}'],
    ]));
    const refused = refusalAt(report, "tasks/two-ids.json");

    expect(refused.refusal.code).toBe("IMPORT_SOURCE_AMBIGUOUS");
    expect(refused.refusal.layer).toBe("DECODE");
    // The positive control: the older `id` dialect alone is unambiguous and still decodes,
    // so the refusal above is about the DISAGREEMENT and not about `id` being present.
    expect(report.records.map((record) => record.legacyId)).toEqual(["only"]);
  });

  it("refuses a manifest-covered file that has since disappeared", () => {
    const report = decodeAfter(GOOD, (root) => {
      rmSync(join(root, "tasks", "alpha.json"));
    });

    expect(report.refusals.map((item) => [item.sourcePath, item.refusal.code, item.refusal.layer]))
      .toEqual([["tasks/alpha.json", "IMPORT_SOURCE_UNREADABLE", "DECODE"]]);
  });

  it("keeps a field named __proto__ as an ordinary payload field", () => {
    const report = decode(tree([
      ["tasks/proto.json", '{"__proto__":{"polluted":true},"legacyId":"p","owner":"ada"}'],
    ]));
    const [record] = report.records;

    // `JSON.parse` gives __proto__ an OWN property, but `payload[key] = value` would hit
    // the inherited setter: the field would vanish with no refusal AND the payload's
    // prototype would be replaced, which then fails isPlainRecord and reports the record
    // as CORRUPT_BYTES for a reason nobody can see. Both halves are asserted.
    expect(Object.keys(record?.payload ?? {})).toEqual(["__proto__", "owner"]);
    expect(Object.getPrototypeOf(record?.payload)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("refuses a manifest entry that points outside the frozen tree", () => {
    const root = tree(GOOD);
    const manifest = manifestOf(root);
    // A hand-built manifest: buildSourceManifest never emits an escaping path, but the
    // decoder takes the manifest as a PARAMETER and must not trust it.
    const forged = Object.freeze({
      ...manifest,
      entries: Object.freeze([
        Object.freeze({ digest: "0".repeat(64), path: "../outside.json", size: 2 }),
      ]),
    });

    const report = decodeLegacySources({ manifest: forged, root });

    expect(report.records).toEqual([]);
    expect(report.refusals.map((item) => [item.sourcePath, item.refusal.code, item.refusal.layer]))
      .toEqual([["../outside.json", "IMPORT_SOURCE_UNREADABLE", "DECODE"]]);
  });

  it("emits only codes and layers the frozen vocabulary declares", () => {
    const report = decode(tree([
      ...GOOD,
      ["notes/readme.md", "# not a legacy record"],
      ["tasks/truncated.json", '{"legacyId":"t","owner":'],
    ]));

    expect(report.refusals.length).toBe(2);
    for (const { refusal } of report.refusals) {
      expect(IMPORT_REFUSAL_CODES).toContain(refusal.code);
      expect(IMPORT_REFUSAL_LAYERS).toContain(refusal.layer);
      expect(refusal.outcome).toBe("REFUSED");
    }
  });
});

describe("the decoder reads only what the manifest covers", () => {
  it("ignores a file created after the manifest was built", () => {
    const report = decodeAfter(GOOD, (root) => {
      write(root, "tasks/smuggled.json", '{"legacyId":"s","owner":"eve"}');
    });

    expect(report.records.map((record) => record.sourcePath))
      .toEqual(["skills/lint.json", "tasks/alpha.json", "tasks/nested/mid.json"]);
    expect(report.refusals).toEqual([]);
  });

  it("refuses every entry when the manifest describes a different tree", () => {
    const other = tree(GOOD);
    const empty = tree([["tasks/other.json", '{"legacyId":"o"}']]);

    const report = decodeLegacySources({ manifest: manifestOf(other), root: empty });

    expect(report.records).toEqual([]);
    expect(report.refusals.length).toBe(3);
    for (const { refusal } of report.refusals) {
      expect(refusal.code).toBe("IMPORT_SOURCE_UNREADABLE");
      expect(refusal.layer).toBe("DECODE");
    }
  });
});
