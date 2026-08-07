import { describe, expect, it } from "vitest";

import { RUNTIME_LIFECYCLES } from "../../../packages/contracts/src/index.js";
import {
  GOAL_TRANSITIONS,
  GRAPH_REVISION_TRANSITIONS,
  PLANNING_RUN_TRANSITIONS,
  PROJECT_TRANSITIONS,
} from "../../../packages/core/src/index.js";
import { checkScheduleCoverage } from "../../../packages/testkit/src/schedule/schedule-checker.js";
import {
  RELEASE_SCHEDULE_FLOOR,
  SCHEDULE_COVERAGE_MANIFEST_VERSION,
  SCHEDULE_STRATUM_MINIMA,
} from "../../../packages/testkit/src/schedule/schedule-model.js";
import {
  CORE_OBLIGATIONS,
  CORE_OBLIGATION_COUNT,
} from "../../../packages/testkit/src/schedule/schedule-obligations.js";
import {
  CORE_INVARIANT_SCHEDULES,
} from "../../../packages/testkit/src/schedule/schedule-universe-invariants.js";
import {
  CORE_SCENARIO_SCHEDULES,
} from "../../../packages/testkit/src/schedule/schedule-universe-scenarios.js";
import {
  CORE_FAULT_BOUNDARIES,
  CORE_TRANSITION_TABLES,
  GENESIS_COMMANDS,
  GENESIS_STATE,
  NEVER_LEGAL_COMMANDS,
} from "../../../packages/testkit/src/schedule/schedule-universe-tables.js";

const CORE_SCHEDULE_UNIVERSE = [...CORE_INVARIANT_SCHEDULES, ...CORE_SCENARIO_SCHEDULES];

/** The landed tables, keyed exactly as the injected universe names their aggregates. */
const LANDED_TRANSITIONS = {
  GOAL: GOAL_TRANSITIONS,
  GRAPH_REVISION: GRAPH_REVISION_TRANSITIONS,
  PLANNING_RUN: PLANNING_RUN_TRANSITIONS,
  PROJECT: PROJECT_TRANSITIONS,
};

function buildManifest() {
  return checkScheduleCoverage({
    faultBoundaries: CORE_FAULT_BOUNDARIES,
    hitEvidence: [],
    knownAggregates: Object.keys(RUNTIME_LIFECYCLES),
    obligations: CORE_OBLIGATIONS,
    transitionTables: CORE_TRANSITION_TABLES,
    universe: CORE_SCHEDULE_UNIVERSE,
  });
}

function emptyRows(table) {
  return Object.entries(table).filter(([, fromStates]) => fromStates.length === 0)
    .map(([commandKind]) => commandKind).sort();
}

/**
 * A landed reducer table is (commandKind -> legal from-states). An empty row means either a
 * creation command (GENESIS) or a command no state admits; the two are declared separately so
 * a new empty row cannot slip in silently under either reading.
 */
function landedDomain(aggregate, table) {
  const genesis = GENESIS_COMMANDS[aggregate] ?? [];
  const neverLegal = NEVER_LEGAL_COMMANDS[aggregate] ?? [];
  return [...new Set(Object.entries(table).flatMap(([commandKind, fromStates]) => {
    if (fromStates.length > 0) return fromStates.map((fromState) => `${fromState}|${commandKind}`);
    if (genesis.includes(commandKind)) return [`${GENESIS_STATE}|${commandKind}`];
    if (neverLegal.includes(commandKind)) return [];
    throw new Error(`unclassified empty table row: ${aggregate} ${commandKind}`);
  }))].sort();
}

function authoredDomain(aggregate) {
  const table = CORE_TRANSITION_TABLES.find((entry) => entry.aggregate === aggregate);
  return [...new Set(table.edges.map((edge) => `${edge.fromState}|${edge.commandKind}`))].sort();
}

const manifest = buildManifest();

describe("CORE schedule coverage manifest", () => {
  it("keeps the authored tables in lockstep with every landed reducer", () => {
    expect(Object.keys(LANDED_TRANSITIONS).sort())
      .toEqual(CORE_TRANSITION_TABLES.map((table) => table.aggregate).sort());
    for (const [aggregate, table] of Object.entries(LANDED_TRANSITIONS)) {
      expect(authoredDomain(aggregate)).toEqual(landedDomain(aggregate, table));
    }
  });

  it("authors every state name from the aggregate's landed lifecycle", () => {
    for (const table of CORE_TRANSITION_TABLES) {
      const lifecycle = RUNTIME_LIFECYCLES[table.aggregate];
      const authored = new Set(table.edges.flatMap((edge) => [edge.fromState, edge.toState]));
      const foreign = [...authored]
        .filter((state) => state !== GENESIS_STATE && !lifecycle.includes(state));
      expect(foreign).toEqual([]);
      // GENESIS is a pseudo-state: it may be entered from nothing, never reached.
      expect(table.edges.filter((edge) => edge.toState === GENESIS_STATE)).toEqual([]);
    }
  });

  it("classifies every empty landed table row as genesis or never-legal", () => {
    for (const [aggregate, table] of Object.entries(LANDED_TRANSITIONS)) {
      const genesis = GENESIS_COMMANDS[aggregate] ?? [];
      const neverLegal = NEVER_LEGAL_COMMANDS[aggregate] ?? [];
      expect(genesis.filter((command) => neverLegal.includes(command))).toEqual([]);
      expect([...genesis, ...neverLegal].sort()).toEqual(emptyRows(table));
      for (const command of genesis) {
        expect(authoredDomain(aggregate)).toContain(`${GENESIS_STATE}|${command}`);
      }
      for (const command of neverLegal) {
        expect(authoredDomain(aggregate).some((entry) => entry.endsWith(`|${command}`)))
          .toBe(false);
      }
    }
  });

  it("registers exactly the closed CORE obligation namespace", () => {
    expect(CORE_OBLIGATIONS).toHaveLength(CORE_OBLIGATION_COUNT);
    const invariants = CORE_OBLIGATIONS.filter((entry) => entry.kind === "INVARIANT");
    const scenarios = CORE_OBLIGATIONS.filter((entry) => entry.kind === "SCENARIO");
    expect(invariants.map((entry) => entry.obligationId)).toEqual(
      Array.from({ length: 22 }, (_unused, index) => `CORE-I${index + 1}`));
    expect(scenarios.map((entry) => entry.obligationId)).toEqual(
      Array.from({ length: 14 }, (_unused, index) => `CORE-S${index + 1}`));
    for (const entry of CORE_OBLIGATIONS) {
      expect(entry.designAnchors.length).toBeGreaterThan(0);
      expect(entry.applicableStrata).toContain("TWO_EVENT");
    }
  });

  it("anchors the un-named fan-in and graph predicates under their carrying obligations", () => {
    const carriers = CORE_OBLIGATIONS
      .filter((entry) => entry.designAnchors.some((anchor) => anchor.includes("fan-in")))
      .map((entry) => entry.obligationId);
    expect(carriers).toEqual(["CORE-I6", "CORE-I8", "CORE-I14", "CORE-I15", "CORE-S13"]);
  });

  it("maps every obligation to at least one canonical schedule", () => {
    expect(manifest.manifestVersion).toBe(SCHEDULE_COVERAGE_MANIFEST_VERSION);
    expect(manifest.obligations).toHaveLength(CORE_OBLIGATION_COUNT);
    for (const entry of manifest.obligations) {
      expect(entry.scheduleIdentities.length).toBeGreaterThan(0);
      expect(entry.strata).toContain("TWO_EVENT");
    }
  });

  it("publishes the frozen stratum minima and meets them", () => {
    expect(manifest.strataMinima).toEqual(SCHEDULE_STRATUM_MINIMA);
    expect(manifest.strataMinima.TWO_EVENT.applicability).toBe("MANDATORY");
    expect(manifest.strataMinima.MULTI_EVENT.applicability).toBe("APPLICABLE_WHEN_DECLARED");
    const unmet = manifest.findings.filter((finding) =>
      finding.code === "SCHEDULE_STRATUM_MINIMUM_UNMET");
    expect(unmet).toEqual([]);
  });

  it("keeps every canonical schedule identity unique", () => {
    const identities = manifest.schedules.map((record) => record.identity);
    expect(new Set(identities).size).toBe(identities.length);
    expect(manifest.releaseBar.observedUniqueSchedules).toBe(CORE_SCHEDULE_UNIVERSE.length);
  });

  it("holds both coverage directions over the landed derived universe", () => {
    expect(manifest.universe.transitions.length).toBeGreaterThan(0);
    expect(manifest.universe.racePairs.length).toBeGreaterThan(0);
    expect(manifest.findings.filter((finding) =>
      finding.code === "SCHEDULE_UNIVERSE_UNCOVERED")).toEqual([]);
    expect(manifest.findings.filter((finding) =>
      finding.code === "SCHEDULE_TRANSITION_UNREACHABLE")).toEqual([]);
  });

  it("re-derives the universe independently and finds it fully claimed", () => {
    const expectedTransitions = new Set();
    const expectedPairs = new Set();
    for (const table of CORE_TRANSITION_TABLES) {
      const commandsByState = new Map();
      for (const edge of table.edges) {
        expectedTransitions.add(
          `${table.aggregate}|${edge.fromState}|${edge.commandKind}|${edge.toState}`);
        const commands = commandsByState.get(edge.fromState) ?? new Set();
        commandsByState.set(edge.fromState, commands.add(edge.commandKind));
      }
      for (const [fromState, commandSet] of commandsByState) {
        const commands = [...commandSet].sort();
        commands.forEach((first, index) => {
          for (const second of commands.slice(index + 1)) {
            expectedPairs.add(`${table.aggregate}|${fromState}|${first}|${second}`);
          }
        });
      }
    }
    expect(manifest.universe.transitions).toHaveLength(expectedTransitions.size);
    expect(manifest.universe.racePairs).toHaveLength(expectedPairs.size);

    const claimedTransitions = new Set();
    const claimedPairs = new Set();
    const claimedBoundaries = new Set();
    for (const definition of CORE_SCHEDULE_UNIVERSE) {
      for (const ref of definition.transitionRefs) {
        claimedTransitions.add(
          `${ref.aggregate}|${ref.fromState}|${ref.commandKind}|${ref.toState}`);
      }
      for (const ref of definition.racePairRefs) {
        const [first, second] = [...ref.commandKinds].sort();
        claimedPairs.add(`${ref.aggregate}|${ref.fromState}|${first}|${second}`);
      }
      for (const boundary of definition.faultBoundaryRefs) claimedBoundaries.add(boundary);
    }
    expect([...expectedTransitions].filter((key) => !claimedTransitions.has(key))).toEqual([]);
    expect([...expectedPairs].filter((key) => !claimedPairs.has(key))).toEqual([]);
    expect(CORE_FAULT_BOUNDARIES.filter((boundary) => !claimedBoundaries.has(boundary)))
      .toEqual([]);
  });

  it("reports zero FAIL verdicts", () => {
    expect(manifest.findings.filter((finding) => finding.verdict === "FAIL")).toEqual([]);
    expect(manifest.obligations.filter((entry) => entry.verdict === "FAIL")).toEqual([]);
    expect(manifest.verdict).not.toBe("FAIL");
  });

  it("allows no silent PASS and no unauditable UNKNOWN", () => {
    const codes = new Set();
    for (const entry of manifest.obligations) {
      if (entry.verdict === "PASS") {
        expect(entry.evidenceRefs.length).toBeGreaterThan(0);
        expect(entry.reachableTransitionRefs.length).toBeGreaterThan(0);
        expect(entry.reasonCodes).toEqual([]);
      } else {
        expect(entry.verdict).toBe("UNKNOWN");
        expect(entry.reasonCodes.length).toBeGreaterThan(0);
        for (const code of entry.reasonCodes) codes.add(code);
      }
    }
    expect([...codes].sort()).toEqual(["SCHEDULE_EVIDENCE_ABSENT"]);
    for (const finding of manifest.findings) {
      expect(finding.verdict).toBe("UNKNOWN");
      expect(finding.detail.length).toBeGreaterThan(0);
    }
  });

  it("injects and checks every landed aggregate, asserting none abstractly", () => {
    expect(CORE_TRANSITION_TABLES.map((table) => table.aggregate).sort())
      .toEqual(["GOAL", "GRAPH_REVISION", "PLANNING_RUN", "PROJECT"]);
    for (const table of CORE_TRANSITION_TABLES) {
      expect(Object.keys(RUNTIME_LIFECYCLES)).toContain(table.aggregate);
      expect(table.edges.length).toBeGreaterThan(0);
    }
    expect(manifest.findings.filter((finding) =>
      finding.code === "SCHEDULE_AGGREGATE_UNLANDED")).toEqual([]);
    const cited = new Set(CORE_SCHEDULE_UNIVERSE.flatMap((definition) => [
      ...definition.transitionRefs.map((ref) => ref.aggregate),
      ...definition.racePairRefs.map((ref) => ref.aggregate),
    ]));
    expect([...cited].sort()).toEqual(["GOAL", "GRAPH_REVISION", "PLANNING_RUN", "PROJECT"]);
  });

  it("keeps an auditable UNKNOWN path for an aggregate that has not landed", () => {
    const unlanded = checkScheduleCoverage({
      faultBoundaries: CORE_FAULT_BOUNDARIES,
      hitEvidence: [],
      knownAggregates: Object.keys(RUNTIME_LIFECYCLES),
      obligations: CORE_OBLIGATIONS,
      transitionTables: CORE_TRANSITION_TABLES.filter((table) =>
        table.aggregate !== "GRAPH_REVISION"),
      universe: CORE_SCHEDULE_UNIVERSE,
    });
    const named = unlanded.findings.filter((finding) =>
      finding.code === "SCHEDULE_AGGREGATE_UNLANDED");
    expect(named.length).toBeGreaterThan(0);
    for (const finding of named) {
      expect(finding.verdict).toBe("UNKNOWN");
      expect(finding.detail).toContain("GRAPH_REVISION");
    }
    expect(unlanded.verdict).toBe("UNKNOWN");
  });

  it("declares itself development-only engineering evidence", () => {
    expect(manifest.provenance).toEqual({
      classification: "DEVELOPMENT_ONLY_ENGINEERING_EVIDENCE",
      confirmatory: false,
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toMatch(/BENCH-/u);
    expect(serialized).not.toMatch(/"(?:I|S)\d+"/u);
  });

  it("records the release schedule floor as an unasserted UNKNOWN bar", () => {
    expect(manifest.releaseBar.floor).toBe(RELEASE_SCHEDULE_FLOOR);
    expect(manifest.releaseBar.status).toBe("UNKNOWN");
    expect(manifest.releaseBar.observedUniqueSchedules).toBeLessThan(RELEASE_SCHEDULE_FLOOR);
  });

  it("builds a deterministic digest", () => {
    expect(buildManifest().digest).toBe(manifest.digest);
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
