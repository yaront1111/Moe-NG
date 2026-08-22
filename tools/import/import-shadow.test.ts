import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SHADOW_PROJECTION_VERSION } from "../../packages/import/src/index.js";
import { MAX_EVENTS_PER_COMMIT } from "../../packages/store/src/store-contracts.js";
import { runImportShadow } from "./import-shadow.js";

/**
 * Two rails this file pins.
 *
 * The shadow is never more permissive than the durable importer. Both tools now bind
 * `maxEventsPerCommit` to the store's own MAX_EVENTS_PER_COMMIT, and these fixtures sit
 * on BOTH sides of that bound, and a shadow that certifies a snapshot one record over it
 * would send an operator into a durable run that refuses with
 * IMPORT_TOO_LARGE_FOR_ONE_COMMIT, which is exactly the divergence a shadow exists to
 * rule out.
 *
 * The `--current` file speaks the comparator's version or it is not compared. The
 * contract promises that vocabulary drift surfaces as a VISIBLE version mismatch at the
 * consumer; a reader that stamped SHADOW_PROJECTION_VERSION over whatever the file said
 * would turn that promise into a comparison of two unrelated vocabularies reported with
 * full confidence.
 *
 * The fixture counts are DERIVED from the constant rather than written as literals, so a
 * store that moves its cap moves this suite with it instead of leaving it green and stale.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** A legacy snapshot the production decoder accepts: one .json per record under tasks/. */
function snapshotOf(count: number): string {
  const root = mkdtempSync(join(tmpdir(), "moe-import-shadow-"));
  roots.push(root);
  mkdirSync(join(root, "tasks"));
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(root, "tasks", `${String(index)}.json`),
      JSON.stringify({
        legacyId: `task-${String(index)}`,
        owner: "alice",
        time: "2024-03-04T05:06:07.000Z",
      }),
    );
  }
  return root;
}

describe("runImportShadow per-commit bound", () => {
  it("refuses one record over the store's cap with the durable importer's own code", () => {
    const result = runImportShadow([snapshotOf(MAX_EVENTS_PER_COMMIT + 1)]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.text)).toMatchObject({
      code: "IMPORT_TOO_LARGE_FOR_ONE_COMMIT",
      layer: "APPLY",
      outcome: "REFUSED",
    });
  });

  it("completes at exactly the store's cap, so the refusal above is the bound, not a blanket", () => {
    const result = runImportShadow([snapshotOf(MAX_EVENTS_PER_COMMIT)]);
    expect(result.code).toBe(0);
    const report: unknown = JSON.parse(result.text);
    expect(report).toMatchObject({ outcome: "COMPLETED" });
    expect((report as { counts: { records: number } }).counts.records).toBe(MAX_EVENTS_PER_COMMIT);
  });
});

/** A new-side projection file as an operator would hand it over: whatever JSON they wrote. */
function currentOf(document: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "moe-import-shadow-current-"));
  roots.push(root);
  const path = join(root, "current.json");
  writeFileSync(path, JSON.stringify(document));
  return path;
}

describe("runImportShadow --current version", () => {
  const FOREIGN_VERSION = "moe-shadow-projection/2";

  it("refuses a projection speaking a version this comparator does not, before comparing", () => {
    // Guards the fixture: the case below is vacuous the day the constant catches up.
    expect(FOREIGN_VERSION).not.toBe(SHADOW_PROJECTION_VERSION);
    const current = currentOf({ entities: [], version: FOREIGN_VERSION });
    const result = runImportShadow([snapshotOf(1), "--current", current]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.text)).toMatchObject({
      code: "IMPORT_SOURCE_UNSUPPORTED",
      layer: "INPUT",
      outcome: "REFUSED",
    });
  });

  it("refuses a projection that declares no version at all, rather than assuming ours", () => {
    const current = currentOf({ entities: [] });
    const result = runImportShadow([snapshotOf(1), "--current", current]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.text)).toMatchObject({
      code: "IMPORT_SOURCE_UNSUPPORTED",
      layer: "INPUT",
      outcome: "REFUSED",
    });
  });

  it("still compares a projection that speaks the comparator's version", () => {
    const current = currentOf({ entities: [], version: SHADOW_PROJECTION_VERSION });
    const result = runImportShadow([snapshotOf(1), "--current", current]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.text)).toMatchObject({
      outcome: "COMPLETED",
      shadowVersion: SHADOW_PROJECTION_VERSION,
    });
  });
});

/**
 * (kind, id) is the comparator's key and it keeps the FIRST entity under a key. A
 * `--current` file carrying two conflicting rows for one key therefore decides the whole
 * comparison by document order, and the operator is handed a confident mismatch list over
 * a file that contradicts itself. The duplicate must be answered at the input boundary.
 *
 * Three controls sit against that refusal so it is a bound and not a blanket: identical
 * duplicates collapse losslessly (they admit one reading, not two), one id under two kinds
 * is two entities, and the key is a pair rather than a joined string.
 */
describe("runImportShadow --current duplicate identity", () => {
  const projection = (entities: readonly unknown[]): string =>
    currentOf({ entities, version: SHADOW_PROJECTION_VERSION });

  it("refuses two rows for one (kind, id) whose fields disagree, not keeping either", () => {
    const current = projection([
      { fields: { principal: "alice", status: "HELD" }, id: "task-0", kind: "CLAIM" },
      { fields: { principal: "bob", status: "HELD" }, id: "task-0", kind: "CLAIM" },
    ]);
    const result = runImportShadow([snapshotOf(1), "--current", current]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.text)).toMatchObject({
      code: "IMPORT_SOURCE_AMBIGUOUS",
      layer: "INPUT",
      outcome: "REFUSED",
    });
  });

  it("collapses a byte-identical duplicate onto the report the single row produces", () => {
    // One root for both runs: the report carries the manifest digest, so a second
    // snapshot would differ for a reason that has nothing to do with the duplicate.
    const root = snapshotOf(1);
    const row = { fields: { principal: "alice", status: "HELD" }, id: "task-0", kind: "CLAIM" };
    const once = runImportShadow([root, "--current", projection([row])]);
    const twice = runImportShadow([root, "--current", projection([row, row])]);
    expect(twice.code).toBe(0);
    expect(JSON.parse(twice.text)).toMatchObject({ outcome: "COMPLETED" });
    expect(JSON.parse(twice.text)).toStrictEqual(JSON.parse(once.text));
  });

  it("keeps one id under two kinds, which is two entities and no contradiction", () => {
    const current = projection([
      { fields: { principal: "alice" }, id: "shared", kind: "CLAIM" },
      { fields: { holder: "bob" }, id: "shared", kind: "BLOCKER" },
    ]);
    const result = runImportShadow([snapshotOf(1), "--current", current]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.text)).toMatchObject({ outcome: "COMPLETED" });
  });

  it("keys on the pair, so two rows a joined key would merge are still two entities", () => {
    // The collision `index()` in shadow-projection.ts declines to have: a joined
    // `kind:id` reads these as one key. Undeclared kinds are representable here because
    // the input boundary does not narrow `kind`, and the comparator maps an unknown kind
    // to no fields rather than refusing.
    const current = projection([
      { fields: { principal: "alice" }, id: ":x", kind: "CLAIM" },
      { fields: { principal: "bob" }, id: "x", kind: "CLAIM:" },
    ]);
    const result = runImportShadow([snapshotOf(1), "--current", current]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.text)).toMatchObject({ outcome: "COMPLETED" });
  });
});
