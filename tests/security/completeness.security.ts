/**
 * THE COVERAGE RATCHET — CLOSED. The whole-roster completeness gate.
 *
 * `boundary-roster.security.ts` proves the roster MATCHES the source in both directions.
 * That is a statement about enumeration, not about coverage: the day an entry lands with no
 * hostile case, the roster stays green and DoD 1 of the security fault matrix quietly
 * becomes a claim again. This file is the third leg — every roster entry resolves to at
 * least one BEFORE, one AFTER and one RACE case in a sibling slice, the five axis subsets
 * partition the roster exactly, and a boundary that loses its coverage reddens BY NAME.
 *
 * NO LITERAL LIST OF COVERED CONSTANTS APPEARS ANYWHERE BELOW, and no count is written down.
 * Every membership answer is reduced from a sibling's REAL case entries and the total is
 * derived from the parsed roster, so a boundary added tomorrow moves the assertion instead of
 * breaking it. A hand list would agree with itself forever — the "a generated table cannot
 * police its own generator" failure — and would make this task's mutation drills unfalsifiable.
 *
 * THE ROSTER IS READ AS TEXT, not imported, though `BOUNDARY_ROSTER` is exported. The roster
 * file calls `describe()` at module scope, so importing it would re-register its cases inside
 * this file's fork and inflate the lane's count. Every sibling slice avoids it the same way.
 *
 * FOUR OF THE FIVE AXES EXPOSE AN IMPORTABLE CASE TABLE, in four different shapes, and the
 * heterogeneity is the point: normalising it in one place is what stops the five slices
 * drifting apart. `arm` is a field on the transport, integrity and scheduler CASE tables;
 * the scheduler's three RACE tables carry no arm at all; durable-store names its subject
 * `boundary` rather than `constant` and splits BEFORE/AFTER across two exports.
 *
 * THE FIFTH AXIS, RUNTIME-PROVIDER, CROSSES FORKS WITH RUN-SCOPED RECEIPTS. Each slice writes
 * only ledger entries reached by an executing Vitest case. This file runs last and resolves
 * those receipts against both the directory listing of executable slices and the served
 * roster. Comments, imports, static tables and unreachable calls therefore earn no credit.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, inject, it } from "vitest";

import {
  hostileAfterCases,
  hostileBeforeCases,
  hostileRaceCases,
} from "./durable-store-boundary-scenarios.js";
import { INTEGRITY_HOSTILE_CASES } from "./integrity-hostile-cases.js";
import { readSliceReceipts, resolveExecutedCoverage } from "./lane-receipts.js";
import { PROJECT_INTEGRITY_HOSTILE_CASES } from "./project-integrity-hostile-cases.js";
import { POLICY_SLICE_HOSTILE_CASES } from "./policy-slice-hostile-cases.js";
import {
  ACTIVATION_ADMISSION_CASES,
  ACTIVATION_ADMISSION_RACES,
  EXPANSION_SUPERSESSION_CASES,
  EXPANSION_SUPERSESSION_RACES,
  SCHEDULER_DECISION_CASES,
  SCHEDULER_DECISION_RACES,
} from "./scheduler-activation-hostile-cases.js";
import {
  FOUNDATION_DISPATCH_CASES,
  FOUNDATION_DISPATCH_RACES,
} from "./foundation-dispatch-hostile-cases.js";
import {
  PLANNING_GRAPH_CASES,
  PLANNING_GRAPH_RACES,
} from "./planning-graph-hostile-cases.js";
import {
  POLICY_RISK_CASES,
  POLICY_RISK_RACES,
} from "./policy-risk-hostile-cases.js";
import {
  PROJECT_ADMISSION_CASES,
  PROJECT_ADMISSION_RACES,
} from "./project-admission-hostile-cases.js";
import { PROJECT_TRANSPORT_HOSTILE_CASES } from "./project-transport-hostile-cases.js";
import { TRANSPORT_HOSTILE_CASES } from "./transport-hostile-cases.js";

const LANE_ROOT = dirname(fileURLToPath(import.meta.url));
const ROSTER_FILE = join(LANE_ROOT, "boundary-roster.security.ts");

type Arm = "AFTER" | "BEFORE" | "RACE";
const ARMS: readonly Arm[] = Object.freeze(["BEFORE", "AFTER", "RACE"]);

/** One resolved case: the boundary it exercises, and which arm it exercises it on. */
type CoveredPair = readonly [string, Arm];

interface RosterRow {
  readonly axis: string;
  readonly constant: string;
  readonly file: string;
}

const ROSTER_ROW =
  /\{\s*constant:\s*"([A-Za-z0-9_]+)",\s*file:\s*"([^"]+)",\s*axis:\s*"([a-z-]+)"\s*\}/gu;

function rosterRows(): readonly RosterRow[] {
  const source = readFileSync(ROSTER_FILE, "utf8");
  return Object.freeze(
    [...source.matchAll(ROSTER_ROW)].map((match) => ({
      axis: match[3] ?? "",
      constant: match[1] ?? "",
      file: match[2] ?? "",
    })),
  );
}

const ROSTER = rosterRows();
/** Derived from what was parsed, never enumerated: a sixth axis would appear here on its own. */
const AXES: readonly string[] = Object.freeze([...new Set(ROSTER.map((row) => row.axis))].sort());

// ── The four table-backed axes ────────────────────────────────────────────────────────────

const transportPairs = (): readonly CoveredPair[] =>
  [...TRANSPORT_HOSTILE_CASES, ...PROJECT_TRANSPORT_HOSTILE_CASES]
    .map((entry) => [entry.boundary, entry.arm] as const);

const integrityPairs = (): readonly CoveredPair[] =>
  [...INTEGRITY_HOSTILE_CASES, ...PROJECT_INTEGRITY_HOSTILE_CASES, ...POLICY_SLICE_HOSTILE_CASES]
    .map((entry) => [entry.constant, entry.arm] as const);

/** `phase` is read off the case rather than implied by its export, so a case filed under the
 *  wrong export resolves to the arm it actually declares. Race cases carry no phase field. */
const durableStorePairs = (): readonly CoveredPair[] => [
  ...[...hostileBeforeCases, ...hostileAfterCases].map(
    (entry) => [entry.boundary, entry.phase] as const,
  ),
  ...hostileRaceCases.map((entry) => [entry.boundary, "RACE"] as const),
];

/** Subject modules pair tables carrying `arm` with race tables carrying none. The planning-graph,
 *  foundation-dispatch, and policy-risk pairs are sibling MODULES rather than further exports of the
 *  hostile-cases file, so they must be named here: this builder enumerates tables, and a
 *  table it does not import is read as an uncovered roster row rather than as a missing
 *  registration (task-c5be7926, then task-120403f7). Registering a TABLE is not the literal
 *  covered-constant list this file forbids — no constant is named here, and a table whose
 *  cases are deleted still reports its rows as uncovered. */
const schedulerActivationPairs = (): readonly CoveredPair[] => [
  ...[
    ...ACTIVATION_ADMISSION_CASES,
    ...EXPANSION_SUPERSESSION_CASES,
    ...SCHEDULER_DECISION_CASES,
    ...PLANNING_GRAPH_CASES,
    ...FOUNDATION_DISPATCH_CASES,
    ...PROJECT_ADMISSION_CASES,
    ...POLICY_RISK_CASES,
  ].map((entry) => [entry.constant, entry.arm] as const),
  ...[
    ...ACTIVATION_ADMISSION_RACES,
    ...EXPANSION_SUPERSESSION_RACES,
    ...SCHEDULER_DECISION_RACES,
    ...PLANNING_GRAPH_RACES,
    ...FOUNDATION_DISPATCH_RACES,
    ...PROJECT_ADMISSION_RACES,
    ...POLICY_RISK_RACES,
  ].map((entry) => [entry.constant, "RACE"] as const),
];

// ── The executed-receipt axis ─────────────────────────────────────────────────────────────

const RUNTIME_SLICE = /^runtime-provider-.*\.security\.ts$/u;
const RUNTIME_SLICE_FILES = Object.freeze(
  readdirSync(LANE_ROOT).filter((entry) => RUNTIME_SLICE.test(entry)).sort(),
);
const RUNTIME_RECEIPTS = readSliceReceipts(
  inject("securityReceiptsDir"),
  inject("securityRunId"),
);
const RUNTIME_ROSTER = Object.freeze(
  ROSTER.filter(({ axis }) => axis === "runtime-provider").map(({ constant }) => constant),
);
const RUNTIME_COVERAGE = resolveExecutedCoverage({
  receipts: RUNTIME_RECEIPTS,
  roster: RUNTIME_ROSTER,
  sliceFiles: RUNTIME_SLICE_FILES,
});

function runtimeProviderPairs(): readonly CoveredPair[] {
  return Object.freeze(
    RUNTIME_COVERAGE.pairs.map(({ arm, boundary }) => [boundary, arm] as CoveredPair),
  );
}

// ── Normalisation ─────────────────────────────────────────────────────────────────────────

const RESOLVERS: Readonly<Record<string, () => readonly CoveredPair[]>> = Object.freeze({
  "durable-store": durableStorePairs,
  integrity: integrityPairs,
  "runtime-provider": runtimeProviderPairs,
  "scheduler-activation": schedulerActivationPairs,
  transport: transportPairs,
});

const AXIS_PAIRS = new Map<string, readonly CoveredPair[]>(
  AXES.map((axis) => [axis, RESOLVERS[axis]?.() ?? []]),
);
const ALL_PAIRS: readonly CoveredPair[] = Object.freeze(
  [...AXIS_PAIRS.values()].flatMap((pairs) => [...pairs]),
);

const into = <T,>(index: Map<string, Set<T>>, key: string, value: T): void => {
  const bucket = index.get(key) ?? new Set<T>();
  bucket.add(value);
  index.set(key, bucket);
};

const armsOf = new Map<string, Set<Arm>>();
const axesOf = new Map<string, Set<string>>();
for (const [axis, pairs] of AXIS_PAIRS) {
  for (const [constant, arm] of pairs) {
    into(armsOf, constant, arm);
    into(axesOf, constant, axis);
  }
}

const label = (row: RosterRow): string => `${row.constant} (${row.file})`;
const ROSTERED = new Map(ROSTER.map((row) => [row.constant, row]));

describe("executed coverage is complete and attributable", () => {
  it("reads a positive receipt from every executable runtime-provider slice", () => {
    expect(RUNTIME_SLICE_FILES.length).toBeGreaterThan(0);
    expect(RUNTIME_RECEIPTS).toHaveLength(RUNTIME_SLICE_FILES.length);
  });

  it("reports no stable receipt diagnostic", () => {
    const message = RUNTIME_COVERAGE.diagnostics
      .map(({ code, detail }) => `${code}: ${detail}`)
      .join("\n");
    expect(RUNTIME_COVERAGE.diagnostics, message).toEqual([]);
  });

  it("matches executed and served runtime-provider boundaries in both directions", () => {
    const roster = new Set(RUNTIME_ROSTER);
    const executed = new Set(RUNTIME_COVERAGE.pairs.map(({ boundary }) => boundary));
    expect(RUNTIME_ROSTER.filter((boundary) => !executed.has(boundary))).toEqual([]);
    expect([...executed].filter((boundary) => !roster.has(boundary)).sort()).toEqual([]);
  });

  it("records a positive executed count for every boundary arm", () => {
    const counts = new Map<string, number>();
    for (const { entries } of RUNTIME_RECEIPTS) {
      for (const { arm, boundary } of entries) {
        const key = `${boundary}#${arm}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect(RUNTIME_ROSTER.flatMap((boundary) =>
      ARMS.filter((arm) => (counts.get(`${boundary}#${arm}`) ?? 0) === 0)
        .map((arm) => `${boundary}#${arm}`))).toEqual([]);
  });
});

describe("coverage resolution is not vacuous", () => {
  it("parses a positive number of roster rows carrying every axis", () => {
    expect(ROSTER.length).toBeGreaterThan(0);
    // A regex that matched only the first shape would still be "positive"; the axis set is
    // what catches a parse that silently dropped four fifths of the roster.
    expect(AXES.length).toBeGreaterThan(1);
    expect(AXES.filter((axis) => RESOLVERS[axis] === undefined)).toEqual([]);
  });

  it("resolves a positive case count on every axis", () => {
    expect(AXES.filter((axis) => (AXIS_PAIRS.get(axis) ?? []).length === 0)).toEqual([]);
  });
});

describe("every declared boundary has BEFORE, AFTER and RACE coverage", () => {
  it("names every roster entry missing an arm", () => {
    expect(ALL_PAIRS.length).toBeGreaterThan(0);
    const missing = ROSTER.flatMap((row) => {
      const arms = armsOf.get(row.constant) ?? new Set<Arm>();
      return ARMS.filter((arm) => !arms.has(arm)).map((arm) => `${label(row)} has no ${arm} case`);
    });
    expect(missing).toEqual([]);
  });
});

describe("the union of the axis subsets equals the roster", () => {
  it("roster minus union is empty", () => {
    expect(ALL_PAIRS.length).toBeGreaterThan(0);
    expect(ROSTER.filter((row) => !armsOf.has(row.constant)).map(label)).toEqual([]);
  });

  it("union minus roster is empty", () => {
    expect(ALL_PAIRS.length).toBeGreaterThan(0);
    expect([...armsOf.keys()].filter((name) => !ROSTERED.has(name)).sort()).toEqual([]);
  });
});

describe("the axis subsets partition the roster", () => {
  it("claims no boundary on two axes", () => {
    expect(ALL_PAIRS.length).toBeGreaterThan(0);
    expect(
      [...axesOf.entries()]
        .filter(([, axes]) => axes.size > 1)
        .map(([name, axes]) => `${name} claimed by ${[...axes].sort().join(", ")}`),
    ).toEqual([]);
  });

  it("claims every roster entry on exactly the axis the roster tags it with", () => {
    expect(ALL_PAIRS.length).toBeGreaterThan(0);
    expect(
      ROSTER.filter((row) => {
        const axes = axesOf.get(row.constant);
        return axes === undefined || axes.size !== 1 || !axes.has(row.axis);
      }).map((row) => `${label(row)} rostered ${row.axis}, covered by ${
        [...(axesOf.get(row.constant) ?? [])].sort().join(", ") || "nothing"
      }`),
    ).toEqual([]);
  });

  it("sums the axis subset sizes to the roster size", () => {
    expect(ALL_PAIRS.length).toBeGreaterThan(0);
    const total = AXES.reduce(
      (sum, axis) => sum + new Set((AXIS_PAIRS.get(axis) ?? []).map(([name]) => name)).size,
      0,
    );
    expect(total).toBe(ROSTER.length);
  });
});
