import { SHADOW_PROJECTION_VERSION } from "@moe/import";
import { describe, expect, it } from "vitest";

import { IMPORT_SHADOW_READ_LAYER } from "./import-shadow-contracts.js";
import type { ImportShadowRead } from "./import-shadow-contracts.js";
import { readImportShadowProjection } from "./import-shadow-reader.js";
import {
  DIGEST,
  aggregateOf,
  recordOf,
  seedImport,
  withStore,
  witness,
} from "./import-shadow-test-fixtures.js";

/**
 * The daemon's independent new-side read of a committed legacy import, over a REAL
 * file-backed SqliteEventStore.
 *
 * Rows are seeded through PRODUCTION `applyImport` — see `import-shadow-test-fixtures.ts`
 * for why that composition is the honest way to get durable bytes here and why a
 * hand-written payload would not be.
 */

function accepted(read: ImportShadowRead): {
  readonly entities: readonly {
    readonly fields: Readonly<Record<string, string>>;
    readonly id: string;
    readonly kind: string;
  }[];
  readonly version: string;
} {
  if (!read.ok) throw new Error(`read refused: ${read.code}/${read.layer}`);
  return read.projection;
}

describe("import shadow reader — accepted control", () => {
  it("projects both imported records onto nonempty CLAIM entities", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [
        recordOf(),
        recordOf({ legacyId: "task-2", payload: { owner: "bob" }, sourcePath: "tasks/two.json" }),
      ]);
      const projection = accepted(readImportShadowProjection(store, { manifestDigest: DIGEST }));

      expect(projection.version).toBe(SHADOW_PROJECTION_VERSION);
      const claims = projection.entities.filter((entity) => entity.kind === "CLAIM");
      expect(claims.length).toBe(2);
      expect(claims.map((claim) => claim.fields["principal"]).sort()).toEqual(["alice", "bob"]);
      expect(claims.map((claim) => claim.fields["sourcePath"]).sort())
        .toEqual(["tasks/one.json", "tasks/two.json"]);
      expect(new Set(claims.map((claim) => claim.fields["status"])))
        .toEqual(new Set(["HISTORICAL"]));
      for (const claim of claims) {
        expect(Object.keys(claim.fields).sort()).toEqual(["principal", "sourcePath", "status"]);
      }
    });
  });

  it("emits a BLOCKER only for a SUSPENDED claim, derived from that claim's own status", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [
        recordOf({ payload: { held: true, owner: "carol" } }),
        recordOf({ legacyId: "task-2", payload: { owner: "bob" }, sourcePath: "tasks/two.json" }),
      ]);
      const projection = accepted(readImportShadowProjection(store, { manifestDigest: DIGEST }));

      const blockers = projection.entities.filter((entity) => entity.kind === "BLOCKER");
      expect(blockers.length).toBe(1);
      expect(blockers[0]?.fields).toEqual({ basis: "SUSPENDED_CLAIM", holder: "carol" });
      const suspended = projection.entities
        .filter((entity) => entity.kind === "CLAIM" && entity.fields["status"] === "SUSPENDED");
      expect(suspended.length).toBe(1);
      expect(blockers[0]?.id).toBe(suspended[0]?.id);
    });
  });

  it("maps declared legacy edges onto LINK entities with the four declared fields", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [
        recordOf({ payload: { dependsOn: ["task-9"], owner: "alice", parent: "epic-1" } }),
      ]);
      const projection = accepted(readImportShadowProjection(store, { manifestDigest: DIGEST }));

      const links = projection.entities.filter((entity) => entity.kind === "LINK");
      expect(links.length).toBe(2);
      for (const link of links) {
        expect(Object.keys(link.fields).sort()).toEqual(["evidenceOnly", "from", "kind", "to"]);
        expect(link.fields["evidenceOnly"]).toBe("true");
        expect(link.id).toMatch(/^[0-9a-f]{64}$/u);
      }
      expect(links.map((link) => link.fields["kind"]).sort()).toEqual(["CONTAINS", "RELATED"]);
    });
  });
});

describe("import shadow reader — known-empty is a fact, not an unavailability", () => {
  it("returns ok with ZERO LINK and ZERO BLOCKER entities for a linkless HISTORICAL claim", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf({ payload: { owner: "alice" } })]);
      const read = readImportShadowProjection(store, { manifestDigest: DIGEST });

      expect(read.ok).toBe(true);
      const projection = accepted(read);
      expect(projection.entities.filter((entity) => entity.kind === "LINK")).toEqual([]);
      expect(projection.entities.filter((entity) => entity.kind === "BLOCKER")).toEqual([]);
      expect(projection.entities.filter((entity) => entity.kind === "CLAIM").length).toBe(1);
    });
  });

  it("distinguishes known-empty from absent: an unseeded manifest refuses IMPORT_SHADOW_ABSENT", () => {
    withStore((store) => {
      seedImport(store, DIGEST, [recordOf()]);
      const read = readImportShadowProjection(store, { manifestDigest: "d".repeat(64) });

      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("unreachable");
      expect(read.code).toBe("IMPORT_SHADOW_ABSENT");
      expect(read.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expect(Object.hasOwn(read, "projection")).toBe(false);
      expect(Object.hasOwn(read, "entities")).toBe(false);
    });
  });
});

describe("import shadow reader — the read moves no durable byte", () => {
  it("leaves event count, decision count, aggregate version, file size and mtime identical", () => {
    withStore((store, path) => {
      seedImport(store, DIGEST, [
        recordOf({ payload: { held: true, owner: "carol", parent: "epic-1" } }),
        recordOf({ legacyId: "task-2", payload: { owner: "bob" }, sourcePath: "tasks/two.json" }),
      ]);
      const before = witness(store, path, aggregateOf(DIGEST));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const read = readImportShadowProjection(store, { manifestDigest: DIGEST });
        expect(read.ok).toBe(true);
        expect(witness(store, path, aggregateOf(DIGEST))).toEqual(before);
      }

      expect(before.events).toBe(2);
      expect(before.version).toBe(2);
    });
  });
});
