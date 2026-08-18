import { SHADOW_MISMATCH_DISPOSITIONS, SHADOW_PROJECTION_VERSION, projectLegacyImport } from "@moe/import";
import type { LegacyImportFacts } from "@moe/import";
import { describe, expect, it } from "vitest";

import { IMPORT_SHADOW_READ_LAYER } from "./import-shadow-contracts.js";
import type { ImportShadowComparison } from "./import-shadow-contracts.js";
import { compareImportShadow } from "./import-shadow-reader.js";
import {
  DIGEST,
  aggregateOf,
  recordOf,
  seedImport,
  withStore,
  witness,
} from "./import-shadow-test-fixtures.js";

/**
 * The PRODUCTION comparison edge — DoD item 4, and the consumer edge task
 * task-22cfca91c5134b24aaf3e5734444fb93 calls.
 *
 * Neither this suite nor `@moe/import` reimplements the daemon mapping: the legacy side goes
 * through the importer's own `projectLegacyImport`, the current side through the daemon's
 * `readImportShadowProjection`, and the diff through the importer's own
 * `compareShadowProjections`. Nothing here diffs anything by hand.
 *
 * The agreement case below is ALSO the convergence check for the two independent link-id
 * digests: the daemon computes its own SHA-256 over the declared canonical tuple rather than
 * calling the importer's helper, so if the two spellings ever diverge every LINK would report
 * absent on both sides and this test goes red.
 */

function factsOf(report: { readonly claims: LegacyImportFacts["claims"]; readonly links: LegacyImportFacts["links"] }): LegacyImportFacts {
  return { claims: report.claims, links: report.links };
}

function compared(result: ImportShadowComparison): Extract<ImportShadowComparison, { ok: true }> {
  if (!result.ok) throw new Error("compare refused: " + result.code + "/" + result.layer);
  return result;
}

describe("import shadow comparison — production entry point", () => {
  it("reports no mismatch when the daemon's independent mapping agrees with the importer's", () => {
    withStore((store) => {
      const report = seedImport(store, DIGEST, [
        recordOf({ payload: { dependsOn: ["task-9"], held: true, owner: "carol", parent: "epic-1" } }),
        recordOf({ legacyId: "task-2", payload: { owner: "bob" }, sourcePath: "tasks/two.json" }),
      ]);
      const result = compared(compareImportShadow(store, { manifestDigest: DIGEST }, factsOf(report)));

      expect(result.comparison.mismatches).toEqual([]);
      expect(result.comparison.refusals).toEqual([]);
      expect(result.comparison.version).toBe(SHADOW_PROJECTION_VERSION);
      // Agreement over a NONEMPTY projection, so an empty-vs-empty vacuous pass cannot hide here.
      expect(result.current.entities.length).toBe(5);
      expect(result.legacy.entities.length).toBe(result.current.entities.length);
      expect(new Set(result.current.entities.map((entity) => entity.kind)))
        .toEqual(new Set(["BLOCKER", "CLAIM", "LINK"]));
    });
  });

  it("routes the legacy side through the importer's own projector, not a local copy", () => {
    withStore((store) => {
      const report = seedImport(store, DIGEST, [recordOf()]);
      const result = compared(compareImportShadow(store, { manifestDigest: DIGEST }, factsOf(report)));

      expect(result.legacy).toEqual(projectLegacyImport(factsOf(report)));
    });
  });

  it("disposes a genuine disagreement as NEEDS_RECONCILIATION and never as agreement", () => {
    withStore((store) => {
      const report = seedImport(store, DIGEST, [recordOf()]);
      const drifted: LegacyImportFacts = {
        claims: report.claims.map((claim) => Object.freeze({ ...claim, principal: "mallory" })),
        links: report.links,
      };
      const result = compared(compareImportShadow(store, { manifestDigest: DIGEST }, drifted));

      const principal = result.comparison.mismatches.filter((one) => one.field === "principal");
      expect(principal.length).toBe(1);
      expect(principal[0]?.mismatchKind).toBe("FIELD_DIFFERS");
      expect(principal[0]?.legacyValue).toBe("mallory");
      expect(principal[0]?.currentValue).toBe("alice");
      for (const mismatch of result.comparison.mismatches) {
        expect(mismatch.disposition).toBe(SHADOW_MISMATCH_DISPOSITIONS[mismatch.mismatchKind]);
        expect(["NEEDS_RECONCILIATION", "UNKNOWN"]).toContain(mismatch.disposition);
      }
    });
  });

  it("short-circuits on a current-side refusal and never compares a half-built side", () => {
    withStore((store) => {
      const report = seedImport(store, DIGEST, [recordOf()]);
      const result = compareImportShadow(
        store,
        { manifestDigest: "d".repeat(64) },
        factsOf(report),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("IMPORT_SHADOW_ABSENT");
      expect(result.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expect(Object.hasOwn(result, "comparison")).toBe(false);
      expect(Object.hasOwn(result, "current")).toBe(false);
      expect(Object.hasOwn(result, "legacy")).toBe(false);
    });
  });

  it("refuses hostile legacy facts rather than letting the projector throw", () => {
    const hostile: readonly (readonly [string, unknown])[] = [
      ["null facts", null],
      ["missing claims", { links: [] }],
      ["claims not a list", { claims: 7, links: [] }],
      ["links not a list", { claims: [], links: "no" }],
      ["a null claim", { claims: [null], links: [] }],
      ["a claim with no provenance", { claims: [{ claimId: "c", principal: "p", status: "HISTORICAL" }], links: [] }],
    ];
    expect(hostile.length).toBeGreaterThan(0);
    expect(hostile.length).toBe(6);

    for (const [name, facts] of hostile) {
      withStore((store) => {
        seedImport(store, DIGEST, [recordOf()]);
        const result = compareImportShadow(
          store,
          { manifestDigest: DIGEST },
          facts as LegacyImportFacts,
        );

        expect(result.ok, name).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.code, name).toBe("IMPORT_SHADOW_LEGACY_UNREADABLE");
        expect(result.layer, name).toBe(IMPORT_SHADOW_READ_LAYER);
        expect(Object.hasOwn(result, "comparison")).toBe(false);
      });
    }
  });

  it("stays advisory: frozen, authority NONE, and carrying no command affordance", () => {
    withStore((store, path) => {
      const report = seedImport(store, DIGEST, [recordOf()]);
      const before = witness(store, path, aggregateOf(DIGEST));
      const result = compared(compareImportShadow(store, { manifestDigest: DIGEST }, factsOf(report)));

      expect(result.advisoryOnly).toBe(true);
      expect(result.authority).toBe("NONE");
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.comparison)).toBe(true);
      expect(Object.isFrozen(result.current)).toBe(true);
      expect(Object.isFrozen(result.current.entities)).toBe(true);
      const members = result as unknown as Record<string, unknown>;
      for (const name of Object.keys(result)) {
        expect(typeof members[name]).not.toBe("function");
      }
      expect(witness(store, path, aggregateOf(DIGEST))).toEqual(before);
    });
  });
});
