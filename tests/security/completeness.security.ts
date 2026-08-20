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
 * THE FIFTH AXIS, RUNTIME-PROVIDER, EXPOSES NO TABLE — recorded here as a finding for its
 * owner rather than papered over. Its `runtime-provider-*-cases.ts` modules export SUITE
 * BUILDERS (`describe*(ledger, spec)`), and coverage is written into an in-memory `Ledger`
 * while the cases execute; with `pool: "forks"` and `isolate: true` that ledger cannot cross
 * a file boundary. `RUNTIME_PROVIDER_PARTITION` lists the 25 names with no arms, so reading
 * it would be precisely the static list this file forbids. The axis is NOT short of coverage
 * — its own slices assert `assertSweepsExactly` and `assertPositiveCounts` over all 25 × 3 —
 * so it is resolved from the axis's committed bytes: its LEDGER WRITE SITES. Deleting a case
 * deletes its write site, which is what keeps this real. Exporting a `{boundary, arm}` table
 * from that axis would let `runtimeProviderPairs` be deleted outright.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  hostileAfterCases,
  hostileBeforeCases,
  hostileRaceCases,
} from "./durable-store-boundary-scenarios.js";
import { INTEGRITY_HOSTILE_CASES } from "./integrity-hostile-cases.js";
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
  TRANSPORT_HOSTILE_CASES.map((entry) => [entry.boundary, entry.arm] as const);

const integrityPairs = (): readonly CoveredPair[] =>
  INTEGRITY_HOSTILE_CASES.map((entry) => [entry.constant, entry.arm] as const);

/** `phase` is read off the case rather than implied by its export, so a case filed under the
 *  wrong export resolves to the arm it actually declares. Race cases carry no phase field. */
const durableStorePairs = (): readonly CoveredPair[] => [
  ...[...hostileBeforeCases, ...hostileAfterCases].map(
    (entry) => [entry.boundary, entry.phase] as const,
  ),
  ...hostileRaceCases.map((entry) => [entry.boundary, "RACE"] as const),
];

/** Ten tables: five carrying `arm`, five race tables carrying none. The planning-graph and
 *  foundation-dispatch pairs are sibling MODULES rather than further exports of the
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
  ].map((entry) => [entry.constant, entry.arm] as const),
  ...[
    ...ACTIVATION_ADMISSION_RACES,
    ...EXPANSION_SUPERSESSION_RACES,
    ...SCHEDULER_DECISION_RACES,
    ...PLANNING_GRAPH_RACES,
    ...FOUNDATION_DISPATCH_RACES,
  ].map((entry) => [entry.constant, "RACE"] as const),
];

// ── The scanned axis ──────────────────────────────────────────────────────────────────────

/** Slices and their case builders only. The ledger's own definition and the shared fixture
 *  helpers name `boundary` too, and reading their bodies would invent cases nobody wrote. */
const RUNTIME_SOURCE = /^runtime-provider-.*(?:\.security|-cases)\.ts$/u;
/** A boundary literal. Group 1 is a slice-local binding; group 2 is a builder SPEC property. */
const ANCHOR = /\bconst\s+(?:boundary|BOUNDARY)\s*=\s*"([A-Z0-9_]+)"|\bboundary:\s*"([A-Z0-9_]+)"/gu;
/** `ledger.refused`, `refusedExactly`, `refusedWithoutLayer` and `refusedByManifestLayer` all
 *  pass the arm as the literal right after the boundary, on one line or wrapped. */
const ARM_SITE = /\b(?:boundary|BOUNDARY),\s*"(AFTER|BEFORE|RACE)"/gu;
/** `refusedSide` and `refusedObservation` push RACE without ever naming it. */
const RACE_SITE = /\brefused(?:Side|Observation)\(\s*(?:ledger,\s*)?(?:boundary|BOUNDARY),/gu;

interface Anchor {
  readonly at: number;
  readonly constant: string;
  readonly spec: boolean;
}

interface ArmSite {
  readonly arm: Arm;
  readonly at: number;
}

function runtimeProviderPairs(): readonly CoveredPair[] {
  const pairs: CoveredPair[] = [];
  const specs: string[] = [];
  const delegated: Arm[] = [];
  const files = readdirSync(LANE_ROOT).filter((entry) => RUNTIME_SOURCE.test(entry)).sort();
  for (const name of files) {
    const source = readFileSync(join(LANE_ROOT, name), "utf8");
    const anchors: readonly Anchor[] = [...source.matchAll(ANCHOR)].map((match) => ({
      at: match.index,
      constant: match[1] ?? match[2] ?? "",
      spec: match[1] === undefined,
    }));
    specs.push(...anchors.filter((anchor) => anchor.spec).map((anchor) => anchor.constant));
    const sites: readonly ArmSite[] = [
      ...[...source.matchAll(ARM_SITE)].map((m) => ({ arm: (m[1] ?? "") as Arm, at: m.index })),
      ...[...source.matchAll(RACE_SITE)].map((m) => ({ arm: "RACE" as Arm, at: m.index })),
    ];
    // A parameterised builder holds its arms in a file with NO boundary literal of its own
    // (`describeRenderBoundary` destructures `spec.boundary`). Those arms belong to every
    // boundary handed to the builder, so deleting one still reddens each boundary it serves.
    // The whole-file test matters: an unanchored site inside an ANCHORED file is DROPPED
    // instead, because crediting it to the render specs could hand a boundary an arm no case
    // gives it. Dropping is the fail-closed direction — the boundary reddens as uncovered.
    const delegating = anchors.length === 0;
    for (const site of sites) {
      const owner = anchors.filter((anchor) => anchor.at < site.at).at(-1);
      if (owner !== undefined) pairs.push([owner.constant, site.arm]);
      else if (delegating) delegated.push(site.arm);
    }
  }
  const inherited = specs.flatMap((constant) =>
    delegated.map((arm): CoveredPair => [constant, arm]));
  return Object.freeze([...pairs, ...inherited]);
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
