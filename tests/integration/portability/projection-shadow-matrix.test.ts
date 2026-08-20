/**
 * The projection and copied-project shadow matrix.
 *
 * WHAT IS UNDER TEST: the daemon shadow adapter shipped by
 * task-80fce1d1d625453098bd526d61c5ddb8 — `compareImportShadow` and
 * `readImportShadowProjection`, reached by BARE SPECIFIER from `@moe/daemon`.
 * The durable current side is populated by the production writer
 * `commitLegacyImport` shipped by task-6d319381967a4ca5b746c2538f537e72.
 *
 * THIS SUITE NEVER CONSTRUCTS THE CURRENT PROJECTION (DoD 1, task rail 1). It
 * never calls `projectLegacyImport` for the current side, never assembles a
 * `ShadowProjection` literal, and never reaches BoardProjection or
 * WorkClaimLedger. `compareImportShadow` reads the current side itself, at one
 * horizon it captures, through `readImportShadowProjection`. The suite's only
 * jobs are to supply legacy facts the IMPORTER derived and to read the verdict.
 * A matrix that built both sides would be comparing one function with itself,
 * and every "agreement" it reported would be meaningless — which is exactly what
 * the step-9 tautology drill exists to prove is not happening here.
 *
 * The only permitted relative reach is `tools/import/*`, which cannot have a bare
 * specifier because `tools/` is not a workspace package (pnpm globs `apps/*`,
 * `adapters/*`, `packages/*`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareImportShadow } from "@moe/daemon";
import { SqliteEventStore } from "@moe/store";
import type { ImportShadowComparison } from "@moe/daemon";

import {
  CORPUS, IMPORT_SHADOW_READ_LAYER, MATRIX_CASES, MATRIX_CASE_COUNT, REQUIRED_ROWS,
  SHADOW_MISMATCH_DISPOSITIONS, SUSPENDED_LEGACY_ID,
} from "./shadow-corpus-fixtures.js";
import { PORTABILITY_SOURCE_COMMIT } from "./portability-source-commit.js";
import { ingestCorpus, inventoryOf, storeFactsOf, withCorpus } from "./shadow-corpus-harness.js";
import type { StoreFacts } from "./shadow-corpus-harness.js";

/** Narrow to the compared arm, failing loudly with the refusal's own code. */
function compared(result: ImportShadowComparison) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`comparison refused: ${result.code} at ${result.layer}`);
  }
  return result;
}

describe("projection shadow matrix — the generated case table", () => {
  it("declares a POSITIVE number of cases", () => {
    // A generated matrix that silently produced zero cases passes while testing
    // nothing; epic rail 2 names this explicitly.
    expect(MATRIX_CASE_COUNT).toBeGreaterThan(0);
    expect(MATRIX_CASES.length).toBe(MATRIX_CASE_COUNT);
  });

  it("covers every DoD-2 row at least once", () => {
    const rows = new Set(MATRIX_CASES.map((entry) => entry.row));
    for (const required of REQUIRED_ROWS) {
      expect(rows.has(required), `row "${required}" is not covered`).toBe(true);
    }
    // A count alone would still pass if two cases covered one row while another
    // row was dropped, so the row SET is what is asserted.
    expect([...rows].sort()).toEqual([...REQUIRED_ROWS].sort());
  });

  it("gives every case a distinct name", () => {
    expect(new Set(MATRIX_CASES.map((entry) => entry.name)).size).toBe(MATRIX_CASES.length);
  });
});

describe("projection shadow matrix — the accepted control", () => {
  it("reports ZERO mismatches when the legacy facts are the ones just committed", () => {
    withCorpus("control", ({ corpusRoot, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);

      // The SAME facts the importer derived, against the durable rows it wrote.
      const result = compared(compareImportShadow(
        store, { manifestDigest: ingested.manifestDigest }, ingested.facts,
      ));

      expect(result.comparison.mismatches).toEqual([]);
      expect(result.comparison.refusals).toEqual([]);
      // The contract's advisory posture, on the accepted arm.
      expect(result.advisoryOnly).toBe(true);
      expect(result.authority).toBe("NONE");
    });
  });

  it("compares a NONEMPTY corpus, so zero mismatches is not zero work", () => {
    withCorpus("control-nonempty", ({ corpusRoot, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);

      // Without this, an empty projection on both sides would also report zero
      // mismatches and the control above would prove nothing at all.
      expect(ingested.facts.claims.length).toBeGreaterThan(0);
      expect(ingested.facts.links.length).toBeGreaterThan(0);
      expect(ingested.manifestDigest).toMatch(/^[0-9a-f]{64}$/u);

      const result = compared(compareImportShadow(
        store, { manifestDigest: ingested.manifestDigest }, ingested.facts,
      ));
      // The current side really carries entities — it was read from durable rows.
      expect(result.current.entities.length).toBeGreaterThan(0);
      expect(result.comparison.mismatches).toEqual([]);
    });
  });
});

describe("projection shadow matrix — the mismatch arms", () => {
  it("reports FIELD_DIFFERS when one CLAIM field is altered on the LEGACY side only", () => {
    withCorpus("changed", ({ corpusRoot, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const target = ingested.facts.claims[0];
      if (target === undefined) throw new Error("corpus produced no claims");

      // The legacy side is caller data; the durable side keeps what was committed.
      const drifted = {
        claims: ingested.facts.claims.map((claim) => claim === target
          ? { ...claim, principal: "someone-else" }
          : claim),
        links: ingested.facts.links,
      };

      const result = compared(compareImportShadow(
        store, { manifestDigest: ingested.manifestDigest }, drifted,
      ));
      const differs = result.comparison.mismatches.filter(
        (entry) => entry.mismatchKind === "FIELD_DIFFERS",
      );
      expect(differs.length).toBeGreaterThan(0);
      const first = differs[0];
      if (first === undefined) throw new Error("no FIELD_DIFFERS mismatch");
      expect(first.mismatchKind).toBe("FIELD_DIFFERS");
      expect(first.disposition).toBe(SHADOW_MISMATCH_DISPOSITIONS.FIELD_DIFFERS);
      // Both sides populated AND different — a mismatch reporting one empty side
      // would be an absence wearing the wrong kind.
      expect(first.legacyValue).not.toBeNull();
      expect(first.currentValue).not.toBeNull();
      expect(first.legacyValue).not.toBe(first.currentValue);
    });
  });

  it("reports ENTITY_ABSENT_ON_CURRENT when a claim was never committed durably", () => {
    withCorpus("absent-current", ({ corpusRoot, openScratchStore, store }) => {
      // A SUBSET committed to the real store...
      const subset = ingestCorpus(corpusRoot, store,
        (record) => record.legacyId !== SUSPENDED_LEGACY_ID);
      // ...and the FULL legacy facts derived through the same production chain
      // against a throwaway store, so nothing here hand-builds a projection.
      const full = ingestCorpus(corpusRoot, openScratchStore("full"));
      expect(full.facts.claims.length).toBeGreaterThan(subset.facts.claims.length);

      const result = compared(compareImportShadow(
        store, { manifestDigest: subset.manifestDigest }, full.facts,
      ));
      const absent = result.comparison.mismatches.filter(
        (entry) => entry.mismatchKind === "ENTITY_ABSENT_ON_CURRENT",
      );
      expect(absent.length).toBeGreaterThan(0);
      const first = absent[0];
      if (first === undefined) throw new Error("no ENTITY_ABSENT_ON_CURRENT mismatch");
      expect(first.disposition)
        .toBe(SHADOW_MISMATCH_DISPOSITIONS.ENTITY_ABSENT_ON_CURRENT);
      // This arm is only meaningful because the current side came from durable
      // rows: a suite building that side itself could not produce an absence.
      expect(first.currentValue).toBeNull();
    });
  });

  it("reports ENTITY_ABSENT_ON_LEGACY, dispositioned UNKNOWN rather than a defect", () => {
    withCorpus("absent-legacy", ({ corpusRoot, openScratchStore, store }) => {
      const full = ingestCorpus(corpusRoot, store);
      const reduced = ingestCorpus(corpusRoot, openScratchStore("reduced"),
        (record) => record.legacyId !== SUSPENDED_LEGACY_ID);
      expect(reduced.facts.claims.length).toBeLessThan(full.facts.claims.length);

      const result = compared(compareImportShadow(
        store, { manifestDigest: full.manifestDigest }, reduced.facts,
      ));
      const absent = result.comparison.mismatches.filter(
        (entry) => entry.mismatchKind === "ENTITY_ABSENT_ON_LEGACY",
      );
      expect(absent.length).toBeGreaterThan(0);
      const first = absent[0];
      if (first === undefined) throw new Error("no ENTITY_ABSENT_ON_LEGACY mismatch");
      // The asymmetry is deliberate: a fact only the NEW side has is UNKNOWN to
      // this comparison, not a legacy defect. Asserting the disposition pins that.
      expect(first.disposition).toBe(SHADOW_MISMATCH_DISPOSITIONS.ENTITY_ABSENT_ON_LEGACY);
      expect(first.disposition).toBe("UNKNOWN");
      expect(first.legacyValue).toBeNull();
    });
  });

  it("treats KNOWN-EMPTY links and a HISTORICAL claim as facts, not as gaps", () => {
    withCorpus("known-empty", ({ corpusRoot, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const result = compared(compareImportShadow(
        store, { manifestDigest: ingested.manifestDigest }, ingested.facts,
      ));

      // The claim with no parent and no dependsOn has KNOWN-EMPTY links, and a
      // HISTORICAL claim emits no BLOCKER. Collapsing either into "unavailable"
      // is how a shadow comparison starts inventing reconciliation work.
      const linkOrBlocker = result.comparison.mismatches.filter(
        (entry) => entry.entityKind === "LINK" || entry.entityKind === "BLOCKER",
      );
      expect(linkOrBlocker).toEqual([]);
      expect(result.comparison.refusals).toEqual([]);

      // And the absence is asserted as a positive fact about the projection: the
      // ONLY blocker present is the one the SUSPENDED claim produced.
      const blockers = result.current.entities.filter((entity) => entity.kind === "BLOCKER");
      expect(blockers.length).toBe(1);
      const historical = result.current.entities.filter(
        (entity) => entity.kind === "CLAIM" && entity.fields["status"] === "HISTORICAL",
      );
      expect(historical.length).toBeGreaterThan(0);
    });
  });
});

describe("projection shadow matrix — the unmapped-field boundary", () => {
  /**
   * MEASURED, and it differs from what the plan anticipated.
   *
   * The plan's unmapped-field arm expects `FIELD_UNMAPPED` / UNKNOWN out of the
   * comparison. That kind is UNREACHABLE through `compareImportShadow` with any
   * honest corpus, and the reason is structural rather than incidental:
   * `compareFields` reports unmapped only when a field key is outside
   * `fieldsFor(kind)`, but BOTH sides' entities are built by production mappers
   * that emit exactly the declared keys — `projectLegacyImport` (shadow-projection.ts:60)
   * for the legacy side and the daemon mapper for the current side. Producing an
   * extra key would require assembling a `ShadowProjection` by hand, which DoD 1
   * and task rail 1 forbid outright.
   *
   * So the honest thing this suite CAN pin, and does, is the boundary itself: an
   * unmapped legacy payload field is absorbed UPSTREAM by the importer as a
   * reconciliation finding, and must never be silently invented as a shadow
   * mismatch or refusal downstream. Probed on a corpus carrying `unmappedThing`:
   * mismatchKinds=[] and refusalCodes=[].
   */
  it("absorbs an unmapped legacy payload field upstream, inventing no shadow verdict", () => {
    const withExtra = [...CORPUS, {
      path: "tasks/extra.json",
      document: {
        legacyId: "task-extra", time: "2024-03-04T05:06:11.000Z",
        owner: "erin", unmappedThing: "surprise",
      },
    }];

    withCorpus("unmapped", ({ corpusRoot, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);

      // The IMPORTER is the layer that knows the field is unmapped, and it says so.
      const finding = ingested.reconciliations.find(
        (entry) => JSON.stringify(entry).includes("unmappedThing"),
      );
      expect(finding, "the importer recorded no finding for the unmapped field").toBeDefined();

      const result = compared(compareImportShadow(
        store, { manifestDigest: ingested.manifestDigest }, ingested.facts,
      ));
      // Downstream invents nothing: the shadow comparison neither reports a
      // mismatch for a field it never saw nor manufactures a refusal for it.
      expect(result.comparison.mismatches).toEqual([]);
      expect(result.comparison.refusals).toEqual([]);
      // And no entity carries the unmapped key on either side.
      const keys = new Set(result.current.entities.flatMap((e) => Object.keys(e.fields)));
      expect(keys.has("unmappedThing")).toBe(false);
    }, withExtra);
  });
});

/** A refusal must not have moved a single byte (DoD 4). */
function expectStoreUntouched(before: StoreFacts, after: StoreFacts): void {
  expect(after.eventCount).toBe(before.eventCount);
  expect(after.decisionCount).toBe(before.decisionCount);
  expect(after.databaseSize).toBe(before.databaseSize);
  expect(after.databaseMtimeMs).toBe(before.databaseMtimeMs);
}

describe("projection shadow matrix — the refusal arms", () => {
  /** Narrow to the refused arm, reporting what came back if it was accepted. */
  function refused(result: ImportShadowComparison) {
    expect(result.ok, "expected a refusal, got a comparison").toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    // Advisory posture holds on the REFUSED arm too, not only on the accepted one.
    expect(result.advisoryOnly).toBe(true);
    expect(result.authority).toBe("NONE");
    return result;
  }

  it("refuses a manifestDigest that is not 64 lowercase hex", () => {
    withCorpus("input-invalid", ({ corpusRoot, databasePath, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const before = storeFactsOf(store, databasePath);

      const result = refused(compareImportShadow(
        store, { manifestDigest: "NOT-A-DIGEST" }, ingested.facts,
      ));
      expect(result.code).toBe("IMPORT_SHADOW_INPUT_INVALID");
      expect(result.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expectStoreUntouched(before, storeFactsOf(store, databasePath));
    });
  });

  it("refuses a well-formed digest with no committed aggregate", () => {
    withCorpus("absent", ({ corpusRoot, databasePath, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const before = storeFactsOf(store, databasePath);

      const result = refused(compareImportShadow(
        store, { manifestDigest: "a".repeat(64) }, ingested.facts,
      ));
      expect(result.code).toBe("IMPORT_SHADOW_ABSENT");
      expect(result.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      // Distinct from a malformed digest: the shape was fine, the import was not there.
      expect(result.code).not.toBe("IMPORT_SHADOW_INPUT_INVALID");
      expectStoreUntouched(before, storeFactsOf(store, databasePath));
    });
  });

  it("refuses when readEvents THROWS, rather than propagating the throw", () => {
    withCorpus("store-throws", ({ corpusRoot, databasePath, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const before = storeFactsOf(store, databasePath);

      const port = {
        readEventHorizon: () => store.readEventHorizon(),
        readEvents: () => { throw new Error("disk went away"); },
      };
      const result = refused(compareImportShadow(
        port, { manifestDigest: ingested.manifestDigest }, ingested.facts,
      ));
      expect(result.code).toBe("IMPORT_SHADOW_STORE_UNREADABLE");
      expect(result.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expectStoreUntouched(before, storeFactsOf(store, databasePath));
    });
  });

  it("refuses when readEvents answers a NON-LIST, rather than crashing on .length", () => {
    withCorpus("store-non-list", ({ corpusRoot, databasePath, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const before = storeFactsOf(store, databasePath);

      // The adapter's own comment: a crash is not a refusal. So this asserts a
      // typed refusal came back, not that a TypeError escaped.
      const port = {
        readEventHorizon: () => store.readEventHorizon(),
        readEvents: () => ({ length: 3 } as unknown as never),
      };
      const result = refused(compareImportShadow(
        port, { manifestDigest: ingested.manifestDigest }, ingested.facts,
      ));
      expect(result.code).toBe("IMPORT_SHADOW_STORE_UNREADABLE");
      expect(result.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expectStoreUntouched(before, storeFactsOf(store, databasePath));
    });
  });

  it("refuses HORIZON_DRIFT when the horizon moves between the two reads", () => {
    withCorpus("horizon-drift", ({ corpusRoot, databasePath, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const before = storeFactsOf(store, databasePath);

      // Real reads throughout; only the horizon answer advances, which is exactly
      // the concurrent-write condition the adapter exists to detect.
      let horizonCalls = 0;
      const port = {
        readEventHorizon: () => {
          horizonCalls += 1;
          return store.readEventHorizon() + BigInt(horizonCalls > 1 ? 1 : 0);
        },
        readEvents: (aggregateId: string) => store.readEvents(aggregateId),
      };
      const result = refused(compareImportShadow(
        port, { manifestDigest: ingested.manifestDigest }, ingested.facts,
      ));
      expect(result.code).toBe("IMPORT_SHADOW_HORIZON_DRIFT");
      expect(result.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      // NO partial comparison came back: a projection assembled across two states
      // would be a mixture of both.
      expect(result).not.toHaveProperty("comparison");
      expect(horizonCalls).toBeGreaterThan(1);
      expectStoreUntouched(before, storeFactsOf(store, databasePath));
    });
  });

  it("refuses LEGACY_UNREADABLE when the caller's legacy facts cannot be projected", () => {
    withCorpus("legacy-unreadable", ({ corpusRoot, databasePath, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const before = storeFactsOf(store, databasePath);

      // The legacy side is CALLER data — bytes read out of a frozen project — so
      // the adapter wraps the projection in a try/catch. A shape it cannot walk
      // must refuse, not throw.
      const hostile = { claims: null, links: null } as unknown as typeof ingested.facts;
      const result = refused(compareImportShadow(
        store, { manifestDigest: ingested.manifestDigest }, hostile,
      ));
      expect(result.code).toBe("IMPORT_SHADOW_LEGACY_UNREADABLE");
      expect(result.layer).toBe(IMPORT_SHADOW_READ_LAYER);
      expect(result).not.toHaveProperty("comparison");
      expectStoreUntouched(before, storeFactsOf(store, databasePath));
    });
  });
});

describe("projection shadow matrix — upstream codes are PRESERVED, never restamped", () => {
  /**
   * The adapter forwards the decoder's own code and layer verbatim
   * (`forwardRefusal`, import-shadow-reader.ts:112) precisely so malformed bytes
   * stay distinguishable from an unsupported schema. A test asserting only
   * `ok === false` would stay green if the daemon layer started answering first
   * and swallowed the finer upstream code — which is the regression these two
   * arms exist to catch, and why each pins the LAYER as well as the code.
   */
  function plantRow(
    store: SqliteEventStore, digest: string, over: Partial<{
      eventType: string; domainSchemaVersion: string; payload: Uint8Array;
    }>,
  ): void {
    const aggregateId = `legacy-import:${digest}`;
    store.commit({
      aggregateId,
      commandBytes: new TextEncoder().encode(`plant-${digest}`),
      commandId: `plant-${digest}`,
      committedAt: "2024-03-04T05:06:07.000Z",
      events: [{
        eventId: `planted-${digest}`,
        eventType: over.eventType ?? "legacy.task.imported",
        domainSchemaVersion: over.domainSchemaVersion ?? "moe-import-event-facts/1",
        payload: over.payload ?? new TextEncoder().encode("{}"),
      }],
      expectedVersion: store.getAggregateVersion(aggregateId),
    });
  }

  it("forwards the IMPORTER's code when a committed row's payload cannot decode", () => {
    withCorpus("tampered-bytes", ({ corpusRoot, databasePath, openScratchStore, store }) => {
      // A fresh store whose ONLY row for this digest is the tampered one.
      const facts = ingestCorpus(corpusRoot, openScratchStore("facts"));
      const planted = openScratchStore("planted");
      plantRow(planted, facts.manifestDigest, {
        payload: new TextEncoder().encode("not-canonical-json"),
      });
      const before = storeFactsOf(store, databasePath);

      const result = compareImportShadow(
        planted, { manifestDigest: facts.manifestDigest }, facts.facts,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("a tampered row was projected");
      // The IMPORTER's own vocabulary, not a daemon code.
      expect(result.code.startsWith("IMPORT_EVENT_")).toBe(true);
      expect(result.layer).not.toBe(IMPORT_SHADOW_READ_LAYER);
      expectStoreUntouched(before, storeFactsOf(store, databasePath));
    });
  });

  it("answers SCHEMA_UNSUPPORTED at its OWN layer for an envelope schema it declines", () => {
    withCorpus("schema-unsupported", ({ corpusRoot, openScratchStore }) => {
      const facts = ingestCorpus(corpusRoot, openScratchStore("facts2"));
      const planted = openScratchStore("planted2");
      plantRow(planted, facts.manifestDigest, {
        domainSchemaVersion: "moe-import-event-facts/999",
      });

      const result = compareImportShadow(
        planted, { manifestDigest: facts.manifestDigest }, facts.facts,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("an unsupported envelope schema was projected");
      // This one IS the daemon's own call — the ENVELOPE is its concern — so the
      // code and layer are both its own. Kept distinct from the arm above on
      // purpose: that is the whole point of not restamping.
      expect(result.code).toBe("IMPORT_SHADOW_SCHEMA_UNSUPPORTED");
      expect(result.layer).toBe(IMPORT_SHADOW_READ_LAYER);
    });
  });
});

describe("projection shadow matrix — determinism and provenance", () => {
  /**
   * The checkout the whole matrix ran against, captured ONCE. A matrix whose
   * halves ran against different trees is comparing two systems, so this is
   * recorded on every case result and asserted identical across all of them.
   */
  const SOURCE_COMMIT = PORTABILITY_SOURCE_COMMIT;

  interface CaseRecord {
    readonly manifestDigest: string;
    readonly mismatchCount: number;
    readonly serialized: string;
    readonly sourceCommit: string;
  }

  /** One full pass over the corpus, recording provenance on every case. */
  function runMatrix(label: string): readonly CaseRecord[] {
    const records: CaseRecord[] = [];
    for (const variant of ["whole", "subset"] as const) {
      withCorpus(`${label}-${variant}`, ({ corpusRoot, openScratchStore, store }) => {
        const ingested = variant === "whole"
          ? ingestCorpus(corpusRoot, store)
          : ingestCorpus(corpusRoot, store, (r) => r.legacyId !== SUSPENDED_LEGACY_ID);
        const legacy = variant === "whole"
          ? ingested
          : ingestCorpus(corpusRoot, openScratchStore(`${variant}-full`));

        const result = compared(compareImportShadow(
          store, { manifestDigest: ingested.manifestDigest }, legacy.facts,
        ));
        records.push({
          manifestDigest: ingested.manifestDigest,
          mismatchCount: result.comparison.mismatches.length,
          // The ordered comparison output, verbatim. Nothing is excluded: the
          // comparator has no clock and no random source, so a subset comparison
          // would pass every gate while proving nothing.
          serialized: JSON.stringify(result.comparison),
          sourceCommit: SOURCE_COMMIT,
        });
      });
    }
    return records;
  }

  it("records the SAME source commit on every case", () => {
    expect(SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    const records = runMatrix("provenance");
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.sourceCommit).toBe(SOURCE_COMMIT);
    }
  });

  it("derives a STABLE manifest digest for the same corpus bytes", () => {
    const records = runMatrix("digest");
    const digests = new Set(records.map((record) => record.manifestDigest));
    // Every case here shares one corpus, so the importer's own digest — never
    // recomputed locally — must be identical across all of them.
    expect(digests.size).toBe(1);
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("produces byte-identical ordered output across two runs over unchanged bytes", () => {
    const first = runMatrix("run-a");
    const second = runMatrix("run-b");

    expect(first.length).toBe(second.length);
    expect(first.length).toBeGreaterThan(0);
    for (const [index, record] of first.entries()) {
      const other = second[index];
      if (other === undefined) throw new Error(`run B is missing case ${String(index)}`);
      // Byte-identical serialization...
      expect(other.serialized).toBe(record.serialized);
      // ...AND the same count, so a difference cannot hide inside a
      // serialization that happens to sort equal.
      expect(other.mismatchCount).toBe(record.mismatchCount);
      expect(other.manifestDigest).toBe(record.manifestDigest);
    }
    // At least one case must actually carry mismatches, or "identical" would be
    // two empty strings agreeing.
    expect(first.some((record) => record.mismatchCount > 0)).toBe(true);
  });
});

describe("projection shadow matrix — the untouched-bytes proof", () => {
  /**
   * DoD 4, asserted on BYTES rather than on promises. `ImportShadowStorePort`
   * declares only `readEventHorizon` and `readEvents`, so a write is not merely
   * unexpected — it is unrepresentable through the port the adapter holds. It is
   * measured anyway, because this suite hands the adapter a REAL store and the
   * guarantee is about what the adapter DOES with it, not about what its type
   * would permit.
   */
  it("leaves the copied corpus and the durable store untouched across every arm", () => {
    withCorpus("untouched", ({ corpusRoot, databasePath, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);

      // Baselines taken AFTER ingest: the writer is allowed to write, the
      // shadow read is not.
      const corpusBefore = inventoryOf(corpusRoot);
      const storeBefore = storeFactsOf(store, databasePath);
      expect(Object.keys(corpusBefore).length).toBeGreaterThan(0);
      // ...and the durable side really carries rows, so "unchanged" below is
      // never 0 == 0. Without this the whole read-only proof goes vacuous the
      // day the ingest stops committing, and stays green while doing it.
      expect(storeBefore.eventCount).toBeGreaterThan(0);

      const request = { manifestDigest: ingested.manifestDigest };
      // Accepted arm, plus one refusal of every shape reachable from a real store.
      compareImportShadow(store, request, ingested.facts);
      compareImportShadow(store, { manifestDigest: "NOT-A-DIGEST" }, ingested.facts);
      compareImportShadow(store, { manifestDigest: "a".repeat(64) }, ingested.facts);
      compareImportShadow(
        store, request, { claims: null, links: null } as unknown as typeof ingested.facts,
      );
      compareImportShadow(
        { readEventHorizon: () => store.readEventHorizon(),
          readEvents: () => { throw new Error("nope"); } },
        request, ingested.facts,
      );

      // CORPUS: entry-for-entry, digest AND size AND mtime.
      expect(inventoryOf(corpusRoot)).toEqual(corpusBefore);
      // STORE: counts and file bytes and mtime.
      expectStoreUntouched(storeBefore, storeFactsOf(store, databasePath));
    });
  });

  it("proves the inventory can actually FAIL — a green light must be wired to something", () => {
    withCorpus("inventory-control", ({ corpusRoot }) => {
      const before = inventoryOf(corpusRoot);
      const target = Object.keys(before)[0];
      if (target === undefined) throw new Error("corpus produced no files");

      // Deliberately touch one file in the scratch copy. If the inventory cannot
      // see this, every "untouched" assertion above is a green light wired to
      // nothing.
      const full = join(corpusRoot, target);
      writeFileSync(full, `${readFileSync(full, "utf8")} `, "utf8");

      const after = inventoryOf(corpusRoot);
      expect(after).not.toEqual(before);
      expect(after[target]?.digest).not.toBe(before[target]?.digest);
      expect(after[target]?.size).not.toBe(before[target]?.size);
      // Every OTHER file is still identical, so the control is specific rather
      // than "something somewhere changed".
      for (const key of Object.keys(before)) {
        if (key !== target) expect(after[key]).toEqual(before[key]);
      }
    });
  });

  it("proves the STORE side can fail too — counts that never move prove nothing", () => {
    withCorpus("store-control", ({ corpusRoot, databasePath, store }) => {
      // Snapshot BEFORE the writer runs, so the only thing that can move the
      // facts is the production import commit.
      const before = storeFactsOf(store, databasePath);
      expect(before.eventCount).toBe(0);

      ingestCorpus(corpusRoot, store);
      const after = storeFactsOf(store, databasePath);

      // The corpus inventory has a control above; the store side had none, so
      // `expectStoreUntouched` was an equality nothing had shown could break.
      expect(after.eventCount).toBeGreaterThan(before.eventCount);
      expect(() => { expectStoreUntouched(before, after); }).toThrow();
    });
  });

  it("keeps the advisory posture and exposes nothing that could activate", () => {
    withCorpus("advisory", ({ corpusRoot, store }) => {
      const ingested = ingestCorpus(corpusRoot, store);
      const accepted = compareImportShadow(
        store, { manifestDigest: ingested.manifestDigest }, ingested.facts,
      );
      const refusedResult = compareImportShadow(
        store, { manifestDigest: "NOT-A-DIGEST" }, ingested.facts,
      );

      // BOTH arms, as the contract promises.
      for (const result of [accepted, refusedResult]) {
        expect(result.advisoryOnly).toBe(true);
        expect(result.authority).toBe("NONE");
      }

      // Task rail 3: the result is frozen DATA and no method. Nothing here can
      // activate imported state, select a best tool, or perform a cutover —
      // asserted structurally rather than by reading the implementation.
      expect(Object.isFrozen(accepted)).toBe(true);
      const methods = Object.entries(accepted)
        .filter(([, value]) => typeof value === "function")
        .map(([key]) => key);
      expect(methods).toEqual([]);
      if (!accepted.ok) throw new Error("expected the accepted arm");
      // Every disposition is one of the two advisory arms; there is no third.
      for (const entry of accepted.comparison.mismatches) {
        expect(["NEEDS_RECONCILIATION", "UNKNOWN"]).toContain(entry.disposition);
      }
    });
  });
});
