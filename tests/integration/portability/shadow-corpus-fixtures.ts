/**
 * The copied-project corpus and the case table for the projection shadow matrix.
 *
 * DATA ONLY. No assertions, no store access, no projection logic — those belong to
 * the harness and the suite. This file's whole job is to declare a corpus that can
 * actually SEE a regression, and a case table whose expected values are imported
 * from the owning package roots rather than spelled here.
 *
 * WHY EVERY VOCABULARY IS IMPORTED, never typed out: a locally spelled code or
 * disposition is a SECOND vocabulary. It drifts silently, and the drift surfaces
 * as a green test asserting something production stopped emitting. Every expected
 * mismatch kind comes from `SHADOW_MISMATCH_KINDS`, every disposition is looked up
 * in `SHADOW_MISMATCH_DISPOSITIONS`, and every refusal code from
 * `IMPORT_SHADOW_REFUSAL_CODES` at `IMPORT_SHADOW_READ_LAYER`.
 *
 * WHY THE CORPUS LOOKS THE WAY IT DOES. The daemon mapper emits a BLOCKER entity
 * only for a SUSPENDED claim, and a HISTORICAL claim emitting none is a FACT about
 * that claim rather than a gap. Likewise a claim with no `parent`/`dependsOn` has
 * KNOWN-EMPTY links, not unavailable ones. Those two distinctions are the semantic
 * hinge of the adapter, so the corpus carries all four combinations; a corpus that
 * never exercises them cannot detect a regression in them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  IMPORT_SHADOW_READ_LAYER, IMPORT_SHADOW_REFUSAL_CODES,
} from "@moe/daemon";
import { SHADOW_MISMATCH_DISPOSITIONS, SHADOW_MISMATCH_KINDS } from "@moe/import";
import type { ShadowDisposition, ShadowMismatchKind } from "@moe/import";

/** `applyImport`'s known-field set; anything else in a payload is unmapped. */
export const KNOWN_FIELDS: readonly string[] = Object.freeze([
  "dependsOn", "held", "owner", "parent",
]);

export const PROJECT_ID = "moe-shadow-corpus";

/** One legacy source document, as it sits on disk in a copied project. */
export interface CorpusFile {
  /** Manifest-relative path; the decoder only accepts `.json` under tasks/ or skills/. */
  readonly path: string;
  readonly document: Readonly<Record<string, unknown>>;
}

/**
 * Four claims, chosen so every mapper branch is represented:
 *  - `task-linked`      HISTORICAL, has BOTH a parent (CONTAINS) and dependsOn (RELATED)
 *  - `task-empty-links` HISTORICAL, KNOWN-EMPTY links — no parent, no dependsOn
 *  - `task-historical`  HISTORICAL with a link, so "historical" is not confounded with "no links"
 *  - `task-suspended`   SUSPENDED (`held: true`), the ONLY claim that yields a BLOCKER
 */
export const CORPUS: readonly CorpusFile[] = Object.freeze([
  Object.freeze({
    path: "tasks/linked.json",
    document: Object.freeze({
      legacyId: "task-linked",
      time: "2024-03-04T05:06:07.000Z",
      owner: "alice",
      parent: "task-historical",
      dependsOn: Object.freeze(["task-empty-links"]),
    }),
  }),
  Object.freeze({
    path: "tasks/empty-links.json",
    document: Object.freeze({
      legacyId: "task-empty-links",
      time: "2024-03-04T05:06:08.000Z",
      owner: "bob",
    }),
  }),
  Object.freeze({
    path: "tasks/historical.json",
    document: Object.freeze({
      legacyId: "task-historical",
      time: "2024-03-04T05:06:09.000Z",
      owner: "carol",
      dependsOn: Object.freeze(["task-empty-links"]),
    }),
  }),
  Object.freeze({
    path: "tasks/suspended.json",
    document: Object.freeze({
      legacyId: "task-suspended",
      time: "2024-03-04T05:06:10.000Z",
      owner: "dave",
      held: true,
    }),
  }),
]);

/** The claim whose `held: true` is the only source of a BLOCKER entity. */
export const SUSPENDED_LEGACY_ID = "task-suspended";
/** The claim with no parent and no dependsOn: links are KNOWN-EMPTY, not unavailable. */
export const EMPTY_LINKS_LEGACY_ID = "task-empty-links";

/**
 * Write the corpus as REAL FILES so `buildSourceManifest` and `decodeLegacySources`
 * walk bytes on disk exactly as they would for a copied project. A corpus held only
 * in memory would never produce the manifest digest this task has to record.
 */
export function materialiseCorpus(root: string, files: readonly CorpusFile[] = CORPUS): void {
  for (const file of files) {
    const target = join(root, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, `${JSON.stringify(file.document, null, 2)}\n`, "utf8");
  }
}

// --- the case table ----------------------------------------------------------

export type CaseExpectation =
  | {
    readonly outcome: "MISMATCH";
    readonly kind: ShadowMismatchKind;
    readonly disposition: ShadowDisposition;
  }
  | {
    readonly outcome: "REFUSAL";
    readonly code: (typeof IMPORT_SHADOW_REFUSAL_CODES)[number];
    readonly layer: typeof IMPORT_SHADOW_READ_LAYER;
  }
  | { readonly outcome: "MATCH" }
  /**
   * MEASURED: an unmapped legacy payload field is absorbed by the IMPORTER as a
   * reconciliation finding and never reaches the shadow comparison. `FIELD_UNMAPPED`
   * is unreachable through `compareImportShadow` because both sides' entities come
   * from production mappers that emit exactly the declared field keys; producing an
   * extra key would mean hand-building a `ShadowProjection`, which DoD 1 and task
   * rail 1 forbid. The row therefore pins the boundary, not an invented verdict.
   */
  | { readonly outcome: "ABSORBED_UPSTREAM" };

export interface MatrixCase {
  readonly name: string;
  /** Which DoD-2 row this covers, so the table can be checked for completeness. */
  readonly row: string;
  readonly expectation: CaseExpectation;
}

/** Dispositions are LOOKED UP, never restated — the map is production's own. */
function mismatch(kind: ShadowMismatchKind): CaseExpectation {
  return { outcome: "MISMATCH", kind, disposition: SHADOW_MISMATCH_DISPOSITIONS[kind] };
}

function refusal(code: (typeof IMPORT_SHADOW_REFUSAL_CODES)[number]): CaseExpectation {
  return { outcome: "REFUSAL", code, layer: IMPORT_SHADOW_READ_LAYER };
}

export const MATRIX_CASES: readonly MatrixCase[] = Object.freeze([
  { name: "exact match over the whole corpus", row: "matched", expectation: { outcome: "MATCH" } },
  {
    name: "a legacy claim field altered on the legacy side only",
    row: "changed",
    expectation: mismatch("FIELD_DIFFERS"),
  },
  {
    name: "an entity committed on legacy but absent from the durable current side",
    row: "absent-current",
    expectation: mismatch("ENTITY_ABSENT_ON_CURRENT"),
  },
  {
    name: "an entity present on the current side but absent from the legacy facts",
    row: "absent-legacy",
    expectation: mismatch("ENTITY_ABSENT_ON_LEGACY"),
  },
  {
    name: "a legacy payload field outside the mapped field set",
    row: "unmapped-field",
    expectation: { outcome: "ABSORBED_UPSTREAM" },
  },
  {
    name: "a manifest digest that is not 64 lowercase hex",
    row: "malformed",
    expectation: refusal("IMPORT_SHADOW_INPUT_INVALID"),
  },
  {
    name: "a store whose readEvents throws",
    row: "unreadable",
    expectation: refusal("IMPORT_SHADOW_STORE_UNREADABLE"),
  },
]);

/** Exported so the suite can assert the matrix is POSITIVE before running anything. */
export const MATRIX_CASE_COUNT = MATRIX_CASES.length;

/** The DoD-2 rows the table must cover; the suite asserts each appears at least once. */
export const REQUIRED_ROWS: readonly string[] = Object.freeze([
  "matched", "changed", "absent-current", "absent-legacy", "unmapped-field",
  "malformed", "unreadable",
]);

/** Re-exported so the suite never spells a kind locally either. */
export { SHADOW_MISMATCH_DISPOSITIONS, SHADOW_MISMATCH_KINDS };
export { IMPORT_SHADOW_READ_LAYER, IMPORT_SHADOW_REFUSAL_CODES };
