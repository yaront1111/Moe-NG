import { describe, expect, it } from "vitest";

import { DETERMINISTIC_TIME_SENTINEL, IMPORT_REFUSAL_CODES } from "./import-contract.js";
import type { ImportProvenance, ImportedClaim, LegacyLink } from "./import-contract.js";
import {
  SHADOW_ENTITY_FIELDS,
  SHADOW_ENTITY_KINDS,
  SHADOW_MISMATCH_DISPOSITIONS,
  SHADOW_PROJECTION_VERSION,
  SHADOW_WHOLE_ENTITY_FIELD,
} from "./shadow-contract.js";
import type { ShadowMismatch, ShadowProjection } from "./shadow-contract.js";
import { compareShadowProjections, projectLegacyImport } from "./shadow-projection.js";

/**
 * The shadow contract is ADVISORY. Every assertion below is about what it REPORTS; none
 * of it may move authority, and the vocabulary has no arm that could.
 *
 * The comparison runs over plain data on both sides deliberately (see the task's
 * planningNotes): @moe/import declares zero dependencies and the daemon's BoardProjection
 * lives at the top of the graph, so this package declares its own versioned target
 * vocabulary and a consumer wires the two together. A comparator that takes DATA cannot
 * reach an authority-bearing store by construction.
 */

function provenanceOf(sourcePath: string): ImportProvenance {
  return Object.freeze({
    manifestDigest: "manifest-digest",
    sourceDigest: `digest-of-${sourcePath}`,
    sourcePath,
    sourceTime: DETERMINISTIC_TIME_SENTINEL,
    timeBasis: "MANIFEST_SENTINEL",
  });
}

function claimOf(claimId: string, principal: string, held: boolean): ImportedClaim {
  return Object.freeze({
    claimId,
    principal,
    provenance: provenanceOf(`tasks/${claimId}.json`),
    status: held ? "SUSPENDED" : "HISTORICAL",
  });
}

const LINK: LegacyLink = Object.freeze({
  evidenceOnly: true,
  from: "parent",
  kind: "CONTAINS",
  provenance: provenanceOf("tasks/child.json"),
  to: "child",
});

const IMPORTED = Object.freeze({
  claims: Object.freeze([claimOf("held", "alice", true), claimOf("plain", "bob", false)]),
  links: Object.freeze([LINK]),
});

function entity(kind: string, id: string, fields: Record<string, string>): ShadowProjection["entities"][number] {
  return Object.freeze({ fields: Object.freeze(fields), id, kind }) as ShadowProjection["entities"][number];
}

function projection(entities: readonly ShadowProjection["entities"][number][]): ShadowProjection {
  return Object.freeze({ entities: Object.freeze([...entities]), version: SHADOW_PROJECTION_VERSION });
}

function keyed(mismatch: ShadowMismatch): string {
  return [mismatch.entityKind, mismatch.entityId, mismatch.field, mismatch.mismatchKind].join("|");
}

describe("projecting an import onto the frozen target vocabulary", () => {
  it("maps claims, holds and links onto declared kinds and declared fields only", () => {
    const projected = projectLegacyImport(IMPORTED);

    expect(projected.version).toBe(SHADOW_PROJECTION_VERSION);
    expect(projected.entities.map((item) => [item.kind, item.id])).toEqual([
      ["BLOCKER", "held"],
      ["CLAIM", "held"],
      ["CLAIM", "plain"],
      ["LINK", projected.entities[3]?.id],
    ]);
    for (const item of projected.entities) {
      expect(SHADOW_ENTITY_KINDS).toContain(item.kind);
      expect(Object.keys(item.fields).sort()).toEqual([...SHADOW_ENTITY_FIELDS[item.kind]]);
    }
  });

  it("derives the blocker from the legacy hold rather than inventing a status", () => {
    const projected = projectLegacyImport(IMPORTED);
    const blockers = projected.entities.filter((item) => item.kind === "BLOCKER");

    // Exactly one claim was held, so exactly one blocker exists. A second blocker would
    // mean an unheld claim had been promoted into one.
    expect(blockers.map((item) => [item.id, item.fields["holder"]])).toEqual([["held", "alice"]]);
    expect(projected.entities.find((item) => item.kind === "CLAIM" && item.id === "held")?.fields)
      .toEqual({ principal: "alice", sourcePath: "tasks/held.json", status: "SUSPENDED" });
  });

  it("gives two links that differ only in field boundaries different identities", () => {
    const first = projectLegacyImport({
      claims: [],
      links: [Object.freeze({ ...LINK, from: "a", to: "b:c" })],
    });
    const second = projectLegacyImport({
      claims: [],
      links: [Object.freeze({ ...LINK, from: "a:b", to: "c" })],
    });

    // A joined "a:b:c" key would collide these two distinct links onto one entity.
    expect(second.entities[0]?.id).not.toBe(first.entities[0]?.id);
  });
});

describe("comparing a legacy projection against the new-side one", () => {
  it("reports field-level differences, absences and unmapped fields in one total order", () => {
    const legacy = projection([
      entity("CLAIM", "plain", { principal: "bob", sourcePath: "tasks/plain.json", status: "HISTORICAL" }),
      entity("BLOCKER", "plain", { basis: "SUSPENDED_CLAIM", holder: "bob" }),
    ]);
    const current = projection([
      entity("CLAIM", "plain", { principal: "carol", sourcePath: "tasks/plain.json", tier: "gold" }),
    ]);

    const comparison = compareShadowProjections(legacy, current);

    expect(comparison.version).toBe(SHADOW_PROJECTION_VERSION);
    expect(comparison.mismatches.map(keyed)).toEqual([
      "BLOCKER|plain|*|ENTITY_ABSENT_ON_CURRENT",
      "CLAIM|plain|principal|FIELD_DIFFERS",
      "CLAIM|plain|status|FIELD_ABSENT_ON_CURRENT",
      "CLAIM|plain|tier|FIELD_UNMAPPED",
    ]);
    expect(comparison.mismatches.map((item) => [item.legacyValue, item.currentValue])).toEqual([
      [null, null],
      ["bob", "carol"],
      ["HISTORICAL", null],
      [null, "gold"],
    ]);
  });

  it("reports an unmapped field with the exact shadow code and layer rather than dropping it", () => {
    const legacy = projection([entity("CLAIM", "plain", { principal: "bob", tier: "gold" })]);
    const current = projection([entity("CLAIM", "plain", { principal: "bob" })]);

    const comparison = compareShadowProjections(legacy, current);

    expect(comparison.refusals.length).toBe(1);
    expect(comparison.refusals[0]?.code).toBe("IMPORT_SHADOW_FIELD_UNMAPPED");
    expect(comparison.refusals[0]?.layer).toBe("SHADOW");
    expect(IMPORT_REFUSAL_CODES).toContain(comparison.refusals[0]?.code);
    // Reported on BOTH surfaces: the typed refusal AND the ordered mismatch list, so a
    // caller reading either one sees it.
    expect(comparison.mismatches.map(keyed)).toEqual(["CLAIM|plain|tier|FIELD_UNMAPPED"]);
  });

  it("refuses an entity whose kind the frozen vocabulary does not declare", () => {
    const legacy = projection([entity("EPIC", "e1", { principal: "bob" })]);

    const comparison = compareShadowProjections(legacy, projection([]));

    // A kind nobody declared must not fall out of a kind-keyed walk unnoticed.
    expect(comparison.refusals.map((item) => item.code)).toEqual(["IMPORT_SHADOW_FIELD_UNMAPPED"]);
    expect(comparison.mismatches.map((item) => [item.entityKind, item.field, item.mismatchKind]))
      .toEqual([["EPIC", SHADOW_WHOLE_ENTITY_FIELD, "FIELD_UNMAPPED"]]);
  });

  it("never disposes a mismatch as anything that could carry authority", () => {
    const legacy = projection([
      entity("CLAIM", "gone", { principal: "bob", sourcePath: "tasks/gone.json", status: "HISTORICAL" }),
    ]);
    const current = projection([entity("CLAIM", "new", { principal: "dave" })]);

    const comparison = compareShadowProjections(legacy, current);

    expect(comparison.mismatches.length).toBe(2);
    for (const mismatch of comparison.mismatches) {
      expect(["NEEDS_RECONCILIATION", "UNKNOWN"]).toContain(mismatch.disposition);
      expect(mismatch.disposition).toBe(SHADOW_MISMATCH_DISPOSITIONS[mismatch.mismatchKind]);
    }
    expect(comparison.mismatches.map((item) => [item.entityId, item.mismatchKind])).toEqual([
      ["gone", "ENTITY_ABSENT_ON_CURRENT"],
      ["new", "ENTITY_ABSENT_ON_LEGACY"],
    ]);
  });

  it("orders identically however the caller ordered the entities it supplied", () => {
    const entities = [
      entity("CLAIM", "held", { principal: "alice", sourcePath: "tasks/held.json", status: "SUSPENDED" }),
      entity("BLOCKER", "held", { basis: "SUSPENDED_CLAIM", holder: "alice" }),
      entity("CLAIM", "plain", { principal: "bob", sourcePath: "tasks/plain.json", status: "HISTORICAL" }),
    ];

    const forward = compareShadowProjections(projection(entities), projection([]));
    const reverse = compareShadowProjections(projection([...entities].reverse()), projection([]));

    // BLOCKER and CLAIM share the id "held" by construction, so an order keyed on id
    // alone is not total: these two runs would disagree.
    expect(forward.mismatches.map(keyed)).toEqual([
      "BLOCKER|held|*|ENTITY_ABSENT_ON_CURRENT",
      "CLAIM|held|*|ENTITY_ABSENT_ON_CURRENT",
      "CLAIM|plain|*|ENTITY_ABSENT_ON_CURRENT",
    ]);
    expect(reverse.mismatches.map(keyed)).toEqual(forward.mismatches.map(keyed));
  });

  it("treats an absent __proto__ field as absent rather than as the prototype", () => {
    const legacy = projection([entity("CLAIM", "plain", { principal: "bob" })]);
    const current = projection([
      entity("CLAIM", "plain", { ...Object.fromEntries([["__proto__", "sneaky"]]), principal: "bob" }),
    ]);

    const comparison = compareShadowProjections(legacy, current);

    // Reading `fields["__proto__"]` off the legacy side returns the prototype OBJECT, not
    // undefined, so `?? null` would not fire and a non-string would reach the report.
    expect(comparison.mismatches.map(keyed)).toEqual(["CLAIM|plain|__proto__|FIELD_UNMAPPED"]);
    expect(comparison.mismatches[0]?.legacyValue).toBeNull();
    expect(comparison.mismatches[0]?.currentValue).toBe("sneaky");
  });

  it("reports nothing when both sides agree", () => {
    const both = projection([
      entity("CLAIM", "plain", { principal: "bob", sourcePath: "tasks/plain.json", status: "HISTORICAL" }),
    ]);

    const comparison = compareShadowProjections(both, both);

    // The positive control for every assertion above: without it, a comparator that
    // reported everything as a mismatch would still satisfy the counts.
    expect(comparison.mismatches).toEqual([]);
    expect(comparison.refusals).toEqual([]);
  });
});
