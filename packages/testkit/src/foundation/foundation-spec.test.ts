import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize } from "../canonical-json.js";
import { FOUNDATION_FIXTURES } from "./foundation-journey-fixtures.js";
import {
  FOUNDATION_EXPECTED_OUTCOME_VERSION,
  FOUNDATION_JOURNEYS,
  FOUNDATION_LABELS,
  FOUNDATION_OUTCOME_KINDS,
  buildFoundationManifest,
  evaluateAbsenceProbe,
  identifyFoundationFixture,
} from "./foundation-outcomes-fixtures.js";
import {
  FOUNDATION_ABSENCE_PROBES,
  FOUNDATION_MANIFEST,
  FOUNDATION_PARTITION_COUNTS,
  FOUNDATION_SCHEDULES,
  foundationPartition,
} from "./foundation-fault-schedule.js";
import { evaluateJ1Journey } from "./foundation-model-j1.js";
import type { J1Trace } from "./foundation-model-j1.js";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const foundationDirectory = join(repositoryRoot, "packages", "testkit", "src", "foundation");
const productionImportOfFoundation = /from\s+["'][^"']*foundation[\\/][^"']*["']/u;
const benchIdentifier = /BENCH[-_]/u;

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path === foundationDirectory || path.includes(`${sep}node_modules${sep}`)) continue;
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && /\.[cm]?ts$/u.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

function workedTrace(): J1Trace {
  return {
    acceptanceProofRef: "proof/j1-verified",
    attempt: {
      agentClaimsGreen: true,
      artifactRefs: ["artifact/patch.diff"],
      attemptRef: "attempt/j1-1",
      changedPaths: ["src/auth/token.ts"],
      receipts: [{ receiptRef: "receipt/tests", truthClass: "DAEMON_VERIFIED" }],
    },
    humanActions: ["goal.create", "graph.approve", "acceptance.final"],
  };
}

describe("foundation expected-outcome vocabulary", () => {
  it("closes the outcome vocabulary to exactly four kinds", () => {
    expect([...FOUNDATION_OUTCOME_KINDS]).toEqual([
      "EXPECTED_RED",
      "HONEST_UNKNOWN",
      "PASS_EXPECTED",
      "PRODUCTION_BEHAVIOR_ABSENT",
    ]);
  });

  it("owns a manifest version distinct from the schedule-coverage artifact", () => {
    expect(FOUNDATION_EXPECTED_OUTCOME_VERSION).toBe("moe-foundation-expected-outcome/1");
    expect(FOUNDATION_MANIFEST.version).toBe(FOUNDATION_EXPECTED_OUTCOME_VERSION);
    expect(canonicalize(FOUNDATION_MANIFEST)).not.toContain("moe-schedule-coverage/1");
    expect(canonicalize(FOUNDATION_MANIFEST)).not.toContain("SCHEDULE_");
  });

  it("maps every fixture and schedule to exactly one declared outcome", () => {
    const entryIds = FOUNDATION_MANIFEST.entries.map((entry) => entry.entryId);
    expect(new Set(entryIds).size).toBe(entryIds.length);
    expect([...entryIds].sort()).toEqual(entryIds);
    expect(entryIds).toEqual(
      [
        ...FOUNDATION_FIXTURES.map((fixture) => fixture.fixtureId),
        ...FOUNDATION_SCHEDULES.map((schedule) => schedule.scheduleId),
      ].sort(),
    );
    for (const entry of FOUNDATION_MANIFEST.entries) {
      expect(FOUNDATION_OUTCOME_KINDS).toContain(entry.outcome.kind);
    }
  });
});

describe("foundation manifest partitioning", () => {
  it("partitions the manifest across exactly the three owned journeys", () => {
    const union = FOUNDATION_JOURNEYS.flatMap((journey) => foundationPartition(journey));
    expect([...union].map((entry) => entry.entryId).sort()).toEqual(
      FOUNDATION_MANIFEST.entries.map((entry) => entry.entryId),
    );
    expect(union.length).toBe(FOUNDATION_MANIFEST.entries.length);
  });

  it("pins each partition size so a dropped schedule cannot pass unnoticed", () => {
    for (const journey of FOUNDATION_JOURNEYS) {
      expect(foundationPartition(journey).length).toBe(FOUNDATION_PARTITION_COUNTS[journey]);
      expect(foundationPartition(journey).length).toBeGreaterThan(0);
    }
  });
});

describe("foundation fixtures", () => {
  it("labels every fixture DEVELOPMENT_ONLY and NOT_CONFIRMATORY", () => {
    expect(FOUNDATION_LABELS).toEqual({ confirmatory: "NOT_CONFIRMATORY", use: "DEVELOPMENT_ONLY" });
    for (const fixture of FOUNDATION_FIXTURES) {
      expect(fixture.labels).toEqual(FOUNDATION_LABELS);
    }
  });

  it("pins a sha256 identity for every fixture through the landed evidence helpers", () => {
    for (const fixture of FOUNDATION_FIXTURES) {
      const identity = identifyFoundationFixture(fixture);
      expect(identity.algorithm).toBe("sha256");
      expect(identity.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(identity.digest).toBe(fixture.pinnedDigest);
    }
  });

  it("excludes volatile labels from fixture identity", () => {
    const [fixture] = FOUNDATION_FIXTURES;
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;
    const relabelled = { ...fixture, recordedAt: "2026-08-07T00:00:00.000Z", seed: "9" };
    expect(identifyFoundationFixture(relabelled).digest).toBe(fixture.pinnedDigest);
  });
});

describe("foundation absence probes", () => {
  it("gives every PRODUCTION_BEHAVIOR_ABSENT entry a resolvable probe", () => {
    const probeRefs = new Set(FOUNDATION_ABSENCE_PROBES.map((probe) => probe.probeRef));
    const claimed = new Set<string>();
    for (const entry of FOUNDATION_MANIFEST.entries) {
      if (entry.outcome.kind !== "PRODUCTION_BEHAVIOR_ABSENT") continue;
      expect(entry.outcome.missingSurface.length).toBeGreaterThan(0);
      expect(probeRefs).toContain(entry.outcome.probeRef);
      claimed.add(entry.outcome.probeRef);
    }
    expect([...claimed].sort()).toEqual([...probeRefs].sort());
  });

  it("reports ABSENT only while the named surface is missing from the export set", () => {
    for (const probe of FOUNDATION_ABSENCE_PROBES) {
      expect(probe.absentExportNames.length).toBeGreaterThan(0);
      expect(evaluateAbsenceProbe(probe, ["unrelatedExport"])).toEqual({ absent: true });
    }
  });

  it("goes red the moment a named surface appears in the export set", () => {
    for (const probe of FOUNDATION_ABSENCE_PROBES) {
      const [landed] = probe.absentExportNames;
      expect(landed).toBeDefined();
      if (landed === undefined) continue;
      expect(evaluateAbsenceProbe(probe, ["unrelatedExport", landed])).toEqual({
        absent: false,
        presentExportNames: [landed],
      });
    }
  });

  it("goes red on a pattern match even when the eventual name is unknown", () => {
    for (const probe of FOUNDATION_ABSENCE_PROBES) {
      if (probe.absentExportPattern === null) continue;
      const [named] = probe.absentExportNames;
      if (named === undefined) continue;
      const disguised = `${named}FromAnotherAuthor`;
      expect(evaluateAbsenceProbe(probe, [disguised])).toEqual({
        absent: false,
        presentExportNames: [disguised],
      });
    }
  });
});

describe("foundation determinism and held-out discipline", () => {
  it("builds a byte-identical manifest twice", () => {
    const first = buildFoundationManifest(FOUNDATION_FIXTURES, FOUNDATION_SCHEDULES);
    const second = buildFoundationManifest(FOUNDATION_FIXTURES, FOUNDATION_SCHEDULES);
    expect(canonicalize(first)).toBe(canonicalize(second));
    expect(first.manifestDigest).toBe(FOUNDATION_MANIFEST.manifestDigest);
  });

  it("carries no BENCH corpus identifier", async () => {
    for (const path of await sourceFiles(foundationDirectory)) {
      expect(benchIdentifier.test(await readFile(path, "utf8"))).toBe(false);
    }
    expect(benchIdentifier.test(canonicalize(FOUNDATION_MANIFEST))).toBe(false);
  });

  it("keeps the held-out models out of every production module", async () => {
    const violations: string[] = [];
    for (const path of await sourceFiles(join(repositoryRoot, "packages"))) {
      if (productionImportOfFoundation.test(await readFile(path, "utf8"))) {
        violations.push(relative(repositoryRoot, path));
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("J1 zero-work false-green oracle", () => {
  it("refuses an attempt trace that claims green with no work", () => {
    const trace: J1Trace = {
      ...workedTrace(),
      attempt: {
        agentClaimsGreen: true,
        artifactRefs: [],
        attemptRef: "attempt/j1-noop",
        changedPaths: [],
        receipts: [],
      },
    };
    expect(evaluateJ1Journey(trace)).toEqual({
      ok: false,
      refusal: "J1_ZERO_WORK_FALSE_GREEN",
    });
  });

  it("accepts a trace with real work and exactly three human actions", () => {
    expect(evaluateJ1Journey(workedTrace())).toEqual({
      acceptedRef: "proof/j1-verified",
      ok: true,
    });
  });
});
