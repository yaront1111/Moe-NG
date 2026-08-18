import { describe, expect, it } from "vitest";

import type { ImportShadowStorePort } from "./import-shadow-contracts.js";
import { compareImportShadow, readImportShadowProjection } from "./import-shadow-reader.js";
import {
  DIGEST,
  aggregateOf,
  capturedCommit,
  commitRaw,
  recordOf,
  seedImport,
  withStore,
  witness,
} from "./import-shadow-test-fixtures.js";

/**
 * Determinism and the read-only invariant.
 *
 * "This adapter is a pure read" is asserted here on BYTES — event count, decision count,
 * aggregate version, database file size and mtime — rather than taken on the signature's
 * promise. `applyImport` commits at `expectedVersion: 0`, so an accidental write would also
 * move the aggregate version, which is why the version is part of the witness.
 */

const RECORDS = [
  recordOf({ payload: { dependsOn: ["task-9"], held: true, owner: "carol", parent: "epic-1" } }),
  recordOf({ legacyId: "task-2", payload: { owner: "bob" }, sourcePath: "tasks/two.json" }),
];

function serialized(store: ImportShadowStorePort, digest = DIGEST): string {
  const read = readImportShadowProjection(store, { manifestDigest: digest });
  if (!read.ok) throw new Error(`read refused: ${read.code}/${read.layer}`);
  return JSON.stringify(read.projection);
}

describe("import shadow reader — unchanged durable bytes serialize identically", () => {
  it("answers byte-identically across repeated reads, and as the store grows around it", () => {
    withStore((store) => {
      seedImport(store, DIGEST, RECORDS);
      const first = serialized(store);
      const second = serialized(store);

      // An unrelated import lands. This manifest's own bytes did not change, so neither may
      // its projection — a reader that folded in whatever the store now holds would drift.
      const unrelated = "b".repeat(64);
      seedImport(store, unrelated, [recordOf({ legacyId: "other" })]);
      const third = serialized(store);

      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(serialized(store, unrelated)).not.toBe(first);
      expect(first.length).toBeGreaterThan(200);
    });
  });

  it("orders entities by a derived key, not by the order the mapper emitted them", () => {
    withStore((store) => {
      seedImport(store, DIGEST, RECORDS);
      const read = readImportShadowProjection(store, { manifestDigest: DIGEST });
      if (!read.ok) throw new Error(`read refused: ${read.code}/${read.layer}`);
      const { entities } = read.projection;

      const sorted = [...entities].sort((left, right) => (
        left.kind === right.kind
          ? Number(left.id > right.id) - Number(left.id < right.id)
          : Number(left.kind > right.kind) - Number(left.kind < right.kind)
      ));
      expect(entities.map((entity) => `${entity.kind}/${entity.id}`))
        .toEqual(sorted.map((entity) => `${entity.kind}/${entity.id}`));
      // The mapper emits CLAIM before its BLOCKER, so a list that merely kept emission order
      // would start with a CLAIM. Leading with the BLOCKER is what proves the sort ran.
      expect(entities[0]?.kind).toBe("BLOCKER");
      expect(entities.some((entity) => entity.kind === "CLAIM")).toBe(true);
    });
  });

  it("is blind to the order the records were discovered in", () => {
    let forward = "";
    let reversed = "";
    withStore((store) => {
      seedImport(store, DIGEST, RECORDS);
      forward = serialized(store);
    });
    withStore((store) => {
      seedImport(store, DIGEST, [...RECORDS].reverse());
      reversed = serialized(store);
    });

    expect(reversed).toBe(forward);
    expect(forward).not.toBe("");
  });
});

describe("import shadow reader — the read is advisory and moves nothing", () => {
  it("leaves every durable number and the database file untouched across read and compare", () => {
    withStore((store, path) => {
      const report = seedImport(store, DIGEST, RECORDS);
      const before = witness(store, path, aggregateOf(DIGEST));

      const read = readImportShadowProjection(store, { manifestDigest: DIGEST });
      const compared = compareImportShadow(
        store,
        { manifestDigest: DIGEST },
        { claims: report.claims, links: report.links },
      );

      expect(read.ok).toBe(true);
      expect(compared.ok).toBe(true);
      const after = witness(store, path, aggregateOf(DIGEST));
      expect(after).toEqual(before);
      // Named individually so a failure says WHICH invariant moved.
      expect(after.events).toBe(before.events);
      expect(after.decisions).toBe(before.decisions);
      expect(after.version).toBe(before.version);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });
  });

  it("touches only the two declared read members of the port it is handed", () => {
    withStore((store) => {
      seedImport(store, DIGEST, RECORDS);
      const touched: string[] = [];
      const watched = new Proxy(
        {
          commit: () => { throw new Error("the reader reached a writer"); },
          readEventHorizon: () => store.readEventHorizon(),
          readEvents: (aggregateId: string) => store.readEvents(aggregateId),
        },
        {
          get(target, property, receiver) {
            if (typeof property === "string") touched.push(property);
            return Reflect.get(target, property, receiver) as unknown;
          },
        },
      ) as unknown as ImportShadowStorePort;

      const read = readImportShadowProjection(watched, { manifestDigest: DIGEST });

      expect(read.ok).toBe(true);
      expect(touched.length).toBeGreaterThan(0);
      expect([...new Set(touched)].sort()).toEqual(["readEventHorizon", "readEvents"]);
    });
  });

  it("carries the advisory stamp on both arms and exposes no callable affordance", () => {
    withStore((store) => {
      const report = seedImport(store, DIGEST, RECORDS);
      const accepted = readImportShadowProjection(store, { manifestDigest: DIGEST });
      const refusedRead = readImportShadowProjection(store, { manifestDigest: "c".repeat(64) });
      const compared = compareImportShadow(
        store,
        { manifestDigest: DIGEST },
        { claims: report.claims, links: report.links },
      );

      for (const result of [accepted, refusedRead, compared]) {
        expect(result.advisoryOnly).toBe(true);
        expect(result.authority).toBe("NONE");
        expect(Object.isFrozen(result)).toBe(true);
        const members = result as unknown as Record<string, unknown>;
        for (const name of Object.keys(result)) {
          expect(typeof members[name]).not.toBe("function");
        }
      }
      expect(refusedRead.ok).toBe(false);
    });
  });

  it("never reconstructs a projection from a row a foreign writer planted", () => {
    withStore((store, path) => {
      seedImport(store, DIGEST, [recordOf()]);
      const before = witness(store, path, aggregateOf(DIGEST));
      const foreign = capturedCommit("e".repeat(64), [recordOf()]);
      commitRaw(store, { ...foreign, aggregateId: aggregateOf("c".repeat(64)) });

      const read = readImportShadowProjection(store, { manifestDigest: DIGEST });

      expect(read.ok).toBe(true);
      // The planted row landed on a DIFFERENT aggregate, so this manifest's projection and
      // its aggregate version are untouched even though the store's global counts moved.
      expect(witness(store, path, aggregateOf(DIGEST)).version).toBe(before.version);
      expect(serialized(store)).toBe(JSON.stringify(read.ok ? read.projection : null));
    });
  });
});
