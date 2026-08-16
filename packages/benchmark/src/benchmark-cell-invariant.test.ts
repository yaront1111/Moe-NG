/**
 * The two-directional cell invariant, asserted against real projections at every depth.
 *
 * WHY A WALKER RATHER THAN PER-COLUMN ASSERTIONS. The rule is about every cell the
 * projection emits, and the columns that leaked were the ones nobody wrote an assertion
 * for. A walker cannot be one column behind the projection: a cell added to a new column
 * is walked the day it exists, and the pinned count reddens if a column silently leaves.
 *
 * WHY BOTH DIRECTIONS. The package documented only one half — "an unknown cell never
 * carries a `value` key" — and asserted only that half, which is why
 * `{known: true, value: undefined}` and `{known: false, code: undefined}` stayed green
 * through a full suite and eight mutation drills. The mirror is here: a KNOWN cell always
 * carries a value, and an unknown whose basis names a PRODUCER always carries that
 * producer's non-null code and layer.
 *
 * THIS ASSERTS AGAINST THE PRODUCTION SURFACE. Every projection below comes from
 * `projectBenchmarkRun`; nothing here re-implements a projection rule, so no assertion can
 * be satisfied by a test helper instead of the code under test.
 */

import { describe, expect, it } from "vitest";

import { BENCHMARK_UNKNOWN_BASES } from "./benchmark-projection-vocabulary.js";
import {
  FIXTURE_OBSERVED_END_OTHER_BOOT, completeRunRecordFixture, unobservedRunRecordFixture,
} from "./benchmark-record-fixture.js";
import { projectBenchmarkRun } from "./benchmark-run-projection.js";

const BASE = completeRunRecordFixture();

/** Every projected cell, with the path it was found at so a failure names it. */
interface CellSighting {
  readonly path: string;
  readonly cell: Readonly<Record<string, unknown>>;
}

function collectCells(value: unknown, path: string, seen: CellSighting[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectCells(entry, `${path}[${index}]`, seen));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record["known"] === "boolean") seen.push({ path, cell: record });
  for (const [key, entry] of Object.entries(record)) collectCells(entry, `${path}.${key}`, seen);
}

/** The two bases that name a PRODUCER, and therefore must carry its code and layer. */
const PRODUCER_ATTRIBUTED = new Set(["PRODUCER_DECLARED_UNKNOWN", "SELECTION_UNREADABLE"]);

/**
 * One cell reduced to the facts the invariant is about, so a diff reads at a glance.
 *
 * `valueKeyMatchesKnown` is the rule in BOTH directions and is deliberately one field: a
 * known cell must carry a value, and an unknown must carry no `value` key at all. A
 * `value` present but `undefined` counts as absent, because that is exactly the shape the
 * leak produced and `Object.hasOwn` alone would call it satisfied.
 */
function invariantOf({ path, cell }: CellSighting): Record<string, unknown> {
  const known = cell["known"] === true;
  const basis = cell["basis"];
  const attributed = typeof basis === "string" && PRODUCER_ATTRIBUTED.has(basis);
  return {
    path,
    valueKeyMatchesKnown: known
      ? Object.hasOwn(cell, "value") && cell["value"] !== undefined
      : !Object.hasOwn(cell, "value"),
    basisDeclared: known || (BENCHMARK_UNKNOWN_BASES as readonly string[]).includes(String(basis)),
    attributionOk: known
      || (attributed
        ? typeof cell["code"] === "string" && typeof cell["layer"] === "string"
        : cell["code"] === null && cell["layer"] === null),
  };
}

function cellsOf(record: Record<string, unknown>): CellSighting[] {
  const result = projectBenchmarkRun(record);
  if (!result.ok) throw new Error(`expected a projection, got ${result.code}@${result.layer}`);
  const seen: CellSighting[] = [];
  collectCells(result.projection, "projection", seen);
  return seen;
}

describe("the cell invariant holds in BOTH directions at every depth", () => {
  const PROJECTED_ARMS: readonly { readonly label: string; readonly record: Record<string, unknown> }[] = [
    { label: "complete", record: { ...completeRunRecordFixture() } },
    { label: "unobserved", record: { ...unobservedRunRecordFixture() } },
    { label: "boot mismatch", record: { ...BASE, observedEnd: FIXTURE_OBSERVED_END_OTHER_BOOT } },
    {
      label: "launch stamps unobserved",
      record: { ...BASE, launch: { ...BASE.launch, startedAt: null, completedAt: null } },
    },
  ];

  it("gives every KNOWN cell a value and every producer UNKNOWN its code and layer", () => {
    let swept = 0;
    let cellCount = 0;
    for (const { label, record } of PROJECTED_ARMS) {
      const cells = cellsOf(record);
      // A walker over zero cells asserts nothing at all and passes; the count is what
      // stops this from going vacuous if the projection shape ever changes underneath it.
      expect({ label, cells: cells.length > 0 }).toEqual({ label, cells: true });
      const violations = cells
        .map(invariantOf)
        .filter((cell) => !(cell["valueKeyMatchesKnown"] && cell["basisDeclared"] && cell["attributionOk"]));
      expect({ label, violations }).toEqual({ label, violations: [] });
      cellCount += cells.length;
      swept += 1;
    }
    expect(swept).toBe(PROJECTED_ARMS.length);
    expect(swept).toBeGreaterThan(0);
    // 32 cells on the complete arm, 31 on the unobserved one (it carries a single usage
    // row rather than two), 32 on each remaining variant. Pinned rather than merely
    // non-zero so a column silently dropped from the projection reddens here.
    expect(cellCount).toBe(127);
  });

  it("rejects both a known cell with no value and an unknown carrying one", () => {
    // The walker's own discriminator, pinned in both directions so the walker cannot go
    // one-sided the way the documented invariant once was.
    const cases: readonly { readonly label: string; readonly cell: Record<string, unknown> }[] = [
      { label: "known with an undefined value", cell: { known: true, value: undefined } },
      { label: "known with no value key", cell: { known: true } },
      { label: "known with a value", cell: { known: true, value: "observed" } },
      { label: "unknown with no value key", cell: { known: false, basis: "OBSERVATION_ABSENT" } },
      {
        label: "unknown carrying a value",
        cell: { known: false, basis: "OBSERVATION_ABSENT", value: 0 },
      },
    ];
    const observed = Object.fromEntries(cases.map(({ label, cell }) =>
      [label, invariantOf({ path: "probe", cell })["valueKeyMatchesKnown"]]));
    expect(observed).toEqual({
      "known with an undefined value": false,
      "known with no value key": false,
      "known with a value": true,
      "unknown with no value key": true,
      "unknown carrying a value": false,
    });
    expect(cases.length).toBeGreaterThan(0);
  });
});
