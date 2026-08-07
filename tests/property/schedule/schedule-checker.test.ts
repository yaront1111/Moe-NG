import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { checkScheduleCoverage } from "../../../packages/testkit/src/schedule/schedule-checker.js";
import {
  RELEASE_SCHEDULE_FLOOR,
  SCHEDULE_COVERAGE_MANIFEST_VERSION,
  SCHEDULE_STRATUM_MINIMA,
  canonicalScheduleForm,
  canonicalScheduleText,
  scheduleIdentity,
} from "../../../packages/testkit/src/schedule/schedule-model.js";

const ALPHA_EDGES = [
  { commandKind: "alpha.create", fromState: "GENESIS", toState: "OPEN" },
  { commandKind: "alpha.tick", fromState: "OPEN", toState: "OPEN" },
  { commandKind: "alpha.close", fromState: "OPEN", toState: "DONE" },
];
const ALPHA_TABLE = { aggregate: "ALPHA", edges: ALPHA_EDGES };
const BOUNDARIES = ["boundary.commit"];
const KNOWN_AGGREGATES = ["ALPHA", "BETA"];

function transition(fromState, commandKind, toState, aggregate = "ALPHA") {
  return { aggregate, commandKind, fromState, toState };
}

function racePair(fromState, first, second, aggregate = "ALPHA") {
  return { aggregate, commandKinds: [first, second], fromState };
}

const ALPHA_TRANSITION_REFS = [
  transition("GENESIS", "alpha.create", "OPEN"),
  transition("OPEN", "alpha.tick", "OPEN"),
  transition("OPEN", "alpha.close", "DONE"),
];
const ALPHA_RACE_REFS = [racePair("OPEN", "alpha.close", "alpha.tick")];

function obligation(obligationId, applicableStrata = ["TWO_EVENT"]) {
  return {
    applicableStrata,
    designAnchors: [`design 20.1 #${obligationId}`],
    kind: "INVARIANT",
    obligationId,
    title: `synthetic ${obligationId}`,
  };
}

function schedule(overrides = {}) {
  return {
    faultBoundaryRefs: ["boundary.commit"],
    obligationRefs: ["SYN-1"],
    racePairRefs: ALPHA_RACE_REFS,
    scheduleId: "SYN-SCHEDULE-1",
    stratum: "TWO_EVENT",
    transitionRefs: ALPHA_TRANSITION_REFS,
    ...overrides,
  };
}

function evidenceFor(universe) {
  return universe.map((definition, index) => ({
    evidenceRef: `synthetic/run/${index}`,
    scheduleIdentity: scheduleIdentity(definition),
  }));
}

function check(overrides = {}) {
  const universe = overrides.universe ?? [schedule()];
  const input = {
    faultBoundaries: BOUNDARIES,
    hitEvidence: overrides.hitEvidence ?? evidenceFor(universe),
    knownAggregates: KNOWN_AGGREGATES,
    obligations: overrides.obligations ?? [obligation("SYN-1")],
    transitionTables: overrides.transitionTables ?? [ALPHA_TABLE],
    universe,
  };
  return checkScheduleCoverage(input);
}

function codesFor(manifest, obligationId) {
  const entry = manifest.obligations.find((item) => item.obligationId === obligationId);
  return entry === undefined ? null : { codes: [...entry.reasonCodes], verdict: entry.verdict };
}

function findingCodes(manifest) {
  return manifest.findings.map((finding) => finding.code);
}

describe("checkScheduleCoverage fail-closed paths", () => {
  it("passes only when mapped, reachable, and hit by evidence", () => {
    const manifest = check();
    expect(manifest.manifestVersion).toBe(SCHEDULE_COVERAGE_MANIFEST_VERSION);
    expect(manifest.verdict).toBe("PASS");
    expect(findingCodes(manifest)).toEqual([]);
    const entry = manifest.obligations[0];
    expect(entry.verdict).toBe("PASS");
    expect(entry.scheduleIdentities.length).toBeGreaterThan(0);
    expect(entry.evidenceRefs).toEqual(["synthetic/run/0"]);
    expect(entry.reachableTransitionRefs.length).toBe(3);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.obligations)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it("never reports PASS without hit evidence", () => {
    const manifest = check({ hitEvidence: [] });
    expect(manifest.verdict).toBe("UNKNOWN");
    expect(codesFor(manifest, "SYN-1")).toEqual({
      codes: ["SCHEDULE_EVIDENCE_ABSENT"],
      verdict: "UNKNOWN",
    });
  });

  it("fails an obligation with no mapped schedule", () => {
    const manifest = check({ obligations: [obligation("SYN-1"), obligation("SYN-2")] });
    expect(manifest.verdict).toBe("FAIL");
    expect(codesFor(manifest, "SYN-2")).toEqual({
      codes: ["SCHEDULE_OBLIGATION_UNMAPPED"],
      verdict: "FAIL",
    });
    expect(findingCodes(manifest)).toContain("SCHEDULE_OBLIGATION_UNMAPPED");
  });

  it("fails a schedule mapped to an unregistered obligation", () => {
    const universe = [schedule({ obligationRefs: ["SYN-1", "SYN-404"] })];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(findingCodes(manifest)).toContain("SCHEDULE_OBLIGATION_UNMAPPED");
  });

  it("fails a schedule that claims universe items while citing no obligation", () => {
    const universe = [schedule(), schedule({ obligationRefs: [], scheduleId: "SYN-ORPHAN" })];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(manifest.findings.some((finding) =>
      finding.code === "SCHEDULE_OBLIGATION_UNMAPPED"
      && finding.detail.includes("SYN-ORPHAN"))).toBe(true);
  });

  it("treats a blank evidence reference as absent evidence", () => {
    const universe = [schedule()];
    const manifest = check({
      universe,
      hitEvidence: [{ evidenceRef: "  ", scheduleIdentity: scheduleIdentity(universe[0]) }],
    });
    expect(manifest.verdict).toBe("UNKNOWN");
    expect(codesFor(manifest, "SYN-1")).toEqual({
      codes: ["SCHEDULE_EVIDENCE_ABSENT"],
      verdict: "UNKNOWN",
    });
  });

  it("fails duplicate canonical schedule identities", () => {
    const universe = [
      schedule(),
      schedule({ obligationRefs: ["SYN-2"], scheduleId: "SYN-SCHEDULE-2" }),
    ];
    const manifest = check({
      obligations: [obligation("SYN-1"), obligation("SYN-2")],
      universe,
    });
    expect(manifest.verdict).toBe("FAIL");
    expect(findingCodes(manifest)).toContain("SCHEDULE_IDENTITY_DUPLICATE");
    expect(codesFor(manifest, "SYN-1").codes).toContain("SCHEDULE_IDENTITY_DUPLICATE");
    expect(codesFor(manifest, "SYN-2").codes).toContain("SCHEDULE_IDENTITY_DUPLICATE");
  });

  it("fails a transition absent from the injected tables", () => {
    const universe = [
      schedule({
        transitionRefs: [...ALPHA_TRANSITION_REFS, transition("OPEN", "alpha.tick", "DONE")],
      }),
    ];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(codesFor(manifest, "SYN-1")).toEqual({
      codes: ["SCHEDULE_TRANSITION_UNREACHABLE"],
      verdict: "FAIL",
    });
  });

  it("fails a race pair absent from the derived pair universe", () => {
    const universe = [
      schedule({
        racePairRefs: [...ALPHA_RACE_REFS, racePair("GENESIS", "alpha.create", "alpha.tick")],
      }),
    ];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(codesFor(manifest, "SYN-1").codes).toEqual(["SCHEDULE_TRANSITION_UNREACHABLE"]);
  });

  it("fails an aggregate outside the known vocabulary instead of parking it UNKNOWN", () => {
    const universe = [
      schedule({
        transitionRefs: [...ALPHA_TRANSITION_REFS, transition("OPEN", "gamma.go", "DONE", "GAMMA")],
      }),
    ];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(codesFor(manifest, "SYN-1").codes).toEqual(["SCHEDULE_TRANSITION_UNREACHABLE"]);
  });

  it("fails an unregistered fault boundary", () => {
    const universe = [schedule({ faultBoundaryRefs: ["boundary.commit", "boundary.ghost"] })];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(codesFor(manifest, "SYN-1").codes).toEqual(["SCHEDULE_FAULT_BOUNDARY_UNREGISTERED"]);
  });

  it("fails when a derived transition is claimed by no schedule", () => {
    const universe = [
      schedule({ transitionRefs: ALPHA_TRANSITION_REFS.slice(0, 2) }),
    ];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(findingCodes(manifest)).toEqual(["SCHEDULE_UNIVERSE_UNCOVERED"]);
    expect(manifest.findings[0].detail).toContain("alpha.close");
  });

  it("fails when a derived race pair is claimed by no schedule", () => {
    const universe = [schedule({ racePairRefs: [] })];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(findingCodes(manifest)).toContain("SCHEDULE_UNIVERSE_UNCOVERED");
  });

  it("fails when a registered fault boundary is claimed by no schedule", () => {
    const universe = [schedule({ faultBoundaryRefs: [] })];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(findingCodes(manifest)).toContain("SCHEDULE_UNIVERSE_UNCOVERED");
    expect(codesFor(manifest, "SYN-1").codes).toContain("SCHEDULE_STRATUM_MINIMUM_UNMET");
  });

  it("fails a stratum minimum that the mapped schedules do not meet", () => {
    const manifest = check({
      obligations: [obligation("SYN-1", ["TWO_EVENT", "MULTI_EVENT"])],
    });
    expect(manifest.verdict).toBe("FAIL");
    expect(codesFor(manifest, "SYN-1")).toEqual({
      codes: ["SCHEDULE_STRATUM_MINIMUM_UNMET"],
      verdict: "FAIL",
    });
    expect(manifest.strataMinima).toEqual(SCHEDULE_STRATUM_MINIMA);
  });

  it("enforces the mandatory stratum even when the obligation omits it", () => {
    const universe = [schedule({ stratum: "MULTI_EVENT" })];
    const manifest = check({ obligations: [obligation("SYN-1", [])], universe });
    expect(manifest.verdict).toBe("FAIL");
    expect(codesFor(manifest, "SYN-1")).toEqual({
      codes: ["SCHEDULE_STRATUM_MINIMUM_UNMET"],
      verdict: "FAIL",
    });
    expect(manifest.findings.some((finding) => finding.detail.includes("TWO_EVENT"))).toBe(true);
  });

  it("reports UNKNOWN with an auditable code for an un-landed aggregate", () => {
    const universe = [
      schedule({
        transitionRefs: [
          ...ALPHA_TRANSITION_REFS,
          transition("DRAFT", "beta.advance", "READY", "BETA"),
        ],
      }),
    ];
    const manifest = check({ universe });
    expect(manifest.verdict).toBe("UNKNOWN");
    expect(codesFor(manifest, "SYN-1")).toEqual({
      codes: ["SCHEDULE_AGGREGATE_UNLANDED"],
      verdict: "UNKNOWN",
    });
    const finding = manifest.findings.find(
      (item) => item.code === "SCHEDULE_AGGREGATE_UNLANDED",
    );
    expect(finding.verdict).toBe("UNKNOWN");
    expect(finding.detail).toContain("BETA");
  });

  it("prefers FAIL over UNKNOWN when both are present", () => {
    const universe = [
      schedule({
        transitionRefs: [
          ...ALPHA_TRANSITION_REFS,
          transition("DRAFT", "beta.advance", "READY", "BETA"),
          transition("OPEN", "alpha.tick", "DONE"),
        ],
      }),
    ];
    const manifest = check({ universe, hitEvidence: [] });
    expect(manifest.verdict).toBe("FAIL");
    expect(codesFor(manifest, "SYN-1").verdict).toBe("FAIL");
  });

  it("publishes the release floor as an unasserted UNKNOWN bar", () => {
    const manifest = check();
    expect(manifest.releaseBar).toEqual({
      floor: RELEASE_SCHEDULE_FLOOR,
      observedUniqueSchedules: 1,
      status: "UNKNOWN",
    });
    expect(RELEASE_SCHEDULE_FLOOR).toBe(10000);
    expect(manifest.provenance).toEqual({
      classification: "DEVELOPMENT_ONLY_ENGINEERING_EVIDENCE",
      confirmatory: false,
    });
  });

  it("derives the universe mechanically from the injected tables", () => {
    const manifest = check();
    expect(manifest.universe.transitions).toHaveLength(3);
    expect(manifest.universe.racePairs).toEqual([
      { aggregate: "ALPHA", commandKinds: ["alpha.close", "alpha.tick"], fromState: "OPEN" },
    ]);
    expect(manifest.universe.faultBoundaries).toEqual(BOUNDARIES);
  });

  it("produces an identical digest across repeated runs", () => {
    expect(check().digest).toBe(check().digest);
    expect(check().digest).not.toBe(check({ hitEvidence: [] }).digest);
  });
});

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function shuffle(items, next) {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const target = next() % (index + 1);
    const held = out[index];
    out[index] = out[target];
    out[target] = held;
  }
  return out;
}

function shuffleKeys(record, next) {
  const out = {};
  for (const key of shuffle(Object.keys(record), next)) {
    out[key] = record[key];
  }
  return out;
}

function permuted(definition, next) {
  return shuffleKeys({
    faultBoundaryRefs: shuffle(definition.faultBoundaryRefs, next),
    labels: {
      instanceIds: [`instance-${next()}`],
      recordedAt: `2026-08-0${(next() % 9) + 1}T00:00:00.000Z`,
      seedLabel: `seed-${next()}`,
    },
    obligationRefs: shuffle(definition.obligationRefs, next),
    racePairRefs: shuffle(definition.racePairRefs, next).map((pair) =>
      shuffleKeys({ ...pair, commandKinds: shuffle(pair.commandKinds, next) }, next)),
    scheduleId: `volatile-${next()}`,
    stratum: definition.stratum,
    transitionRefs: shuffle(definition.transitionRefs, next).map((ref) => shuffleKeys(ref, next)),
  }, next);
}

describe("canonical schedule identity", () => {
  const baseline = schedule();

  it("is stable under permuted ids, timestamps, seeds, and key order", () => {
    const expectedText = canonicalScheduleText(baseline);
    const expectedIdentity = scheduleIdentity(baseline);
    for (let seed = 1; seed <= 64; seed += 1) {
      const next = xorshift32(seed * 2654435761);
      const variant = permuted(baseline, next);
      expect(canonicalScheduleText(variant)).toBe(expectedText);
      expect(scheduleIdentity(variant)).toBe(expectedIdentity);
    }
  });

  it("is idempotent over its own canonical form", () => {
    const form = canonicalScheduleForm(baseline);
    expect(canonicalScheduleForm(form)).toEqual(form);
    expect(scheduleIdentity(form)).toBe(scheduleIdentity(baseline));
  });

  it("binds the identity to sha256 of the canonical text", () => {
    const digest = createHash("sha256").update(canonicalScheduleText(baseline), "utf8").digest("hex");
    expect(scheduleIdentity(baseline)).toBe(digest);
  });

  it("separates distinct semantic content", () => {
    const identities = new Set([
      scheduleIdentity(baseline),
      scheduleIdentity(schedule({ stratum: "MULTI_EVENT" })),
      scheduleIdentity(schedule({ faultBoundaryRefs: [] })),
      scheduleIdentity(schedule({ racePairRefs: [] })),
      scheduleIdentity(
        schedule({ transitionRefs: [transition("OPEN", "alpha.tick", "DONE")] }),
      ),
      scheduleIdentity(
        schedule({ transitionRefs: [transition("OPEN", "alpha.tick", "OPEN")] }),
      ),
    ]);
    expect(identities.size).toBe(6);
  });

  it("ignores duplicate refs when forming the canonical set", () => {
    const doubled = schedule({
      faultBoundaryRefs: ["boundary.commit", "boundary.commit"],
      racePairRefs: [...ALPHA_RACE_REFS, racePair("OPEN", "alpha.tick", "alpha.close")],
      transitionRefs: [...ALPHA_TRANSITION_REFS, ...ALPHA_TRANSITION_REFS],
    });
    expect(scheduleIdentity(doubled)).toBe(scheduleIdentity(baseline));
  });
});
