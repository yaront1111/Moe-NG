import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_EVENTS_PER_COMMIT } from "../../packages/store/src/store-contracts.js";
import { runImportShadow } from "./import-shadow.js";

/**
 * The one rail this file pins: the shadow is never more permissive than the durable
 * importer. Both tools now bind `maxEventsPerCommit` to the store's own
 * MAX_EVENTS_PER_COMMIT, and these fixtures sit on BOTH sides of that bound — a shadow
 * that certifies a snapshot one record over it would send an operator into a durable run
 * that refuses with IMPORT_TOO_LARGE_FOR_ONE_COMMIT, which is exactly the divergence a
 * shadow exists to rule out.
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
