import { describe, expect, it } from "vitest";

import { BENCHMARK_UNKNOWN_BASES } from "./benchmark-projection-vocabulary.js";
import {
  FIXTURE_OBSERVED_END, FIXTURE_OBSERVED_END_OTHER_BOOT, FIXTURE_OBSERVED_START,
  completeRunRecordFixture, unknownFactFixture, unobservedRunRecordFixture,
} from "./benchmark-record-fixture.js";
import type { ProjectedRunRecord } from "./benchmark-record-contracts.js";
import { projectBenchmarkRun } from "./benchmark-run-projection.js";
import type { BenchmarkRunProjection } from "./benchmark-run-projection.js";

function project(record: ProjectedRunRecord): BenchmarkRunProjection {
  const result = projectBenchmarkRun(record);
  if (!result.ok) throw new Error(`expected a projection, got ${result.code}@${result.layer}`);
  return result.projection;
}

describe("declared is not observed", () => {
  it("keeps what was asked for and what the bytes said in separate columns", () => {
    const projection = project(completeRunRecordFixture());
    expect(projection.effort.declaredModelId).toEqual({ known: true, value: "claude-opus-5" });
    expect(projection.modelEvidence.observedModelId)
      .toEqual({ known: true, value: "claude-opus-5-20260101" });
  });

  it("never fills an absent observed model from the declared selection", () => {
    const base = completeRunRecordFixture();
    const absent = unknownFactFixture("TELEMETRY_MODEL_ABSENT", "TELEMETRY_RESULT");
    const projection = project({
      ...base,
      observedModel: { modelId: absent, snapshotKind: "ABSENT", snapshotEvidence: absent },
    });
    // The declared selection is still fully readable, so a substitution here would look
    // like a helpful default rather than the loss of the only evidence that the provider
    // ran the model it was asked to run.
    expect(projection.effort.declaredModelId).toEqual({ known: true, value: "claude-opus-5" });
    expect(projection.modelEvidence.observedModelId).toEqual({
      known: false, basis: "PRODUCER_DECLARED_UNKNOWN",
      code: "TELEMETRY_MODEL_ABSENT", layer: "TELEMETRY_RESULT",
    });
    expect(JSON.stringify(projection.modelEvidence)).not.toContain("claude-opus-5");
  });

  it("never fills achieved concurrency from the declared ceiling", () => {
    const projection = project(completeRunRecordFixture());
    expect(projection.settings.declaredConcurrencyCeiling).toEqual({ known: true, value: 4 });
    expect(projection.settings.achievedConcurrency).toEqual({
      known: false, basis: "PRODUCER_DECLARED_UNKNOWN",
      code: "TELEMETRY_ACHIEVED_CONCURRENCY_UNSUPPORTED", layer: "TELEMETRY_RESULT",
    });
    expect(projection.settings.concurrencyFact).toBe("DECLARED_CEILING_ONLY");
  });

  it("reports effort and profile revision from the declared selection alone", () => {
    const projection = project(completeRunRecordFixture());
    expect(projection.effort.reasoningEffort).toEqual({ known: true, value: "high" });
    expect(projection.effort.profileRevisionId).toEqual({ known: true, value: "profile-9" });
  });

  it("reports effort as UNKNOWN when the selection was unreadable, never from a digest", () => {
    const projection = project(unobservedRunRecordFixture());
    const expected = {
      known: false, basis: "SELECTION_UNREADABLE",
      code: "TELEMETRY_DECLARED_SELECTION_UNREADABLE", layer: "TELEMETRY_LAUNCH",
    };
    expect(projection.effort.reasoningEffort).toEqual(expected);
    expect(projection.effort.profileRevisionId).toEqual(expected);
    expect(projection.effort.declaredModelId).toEqual(expected);
  });
});

describe("two clocks, not reconciled", () => {
  it("reports the launcher pair and the daemon pair as separate columns", () => {
    const projection = project(completeRunRecordFixture());
    expect(projection.timing.launcherStartedAt)
      .toEqual({ known: true, value: "2026-08-16T10:00:00.000Z" });
    expect(projection.timing.launcherCompletedAt)
      .toEqual({ known: true, value: "2026-08-16T10:00:30.000Z" });
    expect(projection.timing.daemonStart).toEqual({ known: true, value: FIXTURE_OBSERVED_START });
    expect(projection.timing.daemonEnd).toEqual({ known: true, value: FIXTURE_OBSERVED_END });
  });

  it("derives its one duration from the daemon monotonic pair and from nothing else", () => {
    const projection = project(completeRunRecordFixture());
    // The fixture's monotonic delta is 12 while its wall delta is 30 and the launcher's
    // stamps are hours away, so reading any other source yields a different number.
    expect(projection.timing.daemonMonotonicDuration).toEqual({ known: true, value: 12 });
  });

  it("exposes no column that mixes the two observers", () => {
    const projection = project(completeRunRecordFixture());
    expect(Object.keys(projection.timing).sort()).toEqual([
      "daemonEnd", "daemonMonotonicDuration", "daemonStart",
      "launcherCompletedAt", "launcherStartedAt",
    ]);
  });

  it("reports the launcher stamps as UNKNOWN without borrowing the daemon readings", () => {
    const base = completeRunRecordFixture();
    const projection = project({
      ...base, launch: { ...base.launch, startedAt: null, completedAt: null },
    });
    const expected = { known: false, basis: "OBSERVATION_ABSENT", code: null, layer: null };
    expect(projection.timing.launcherStartedAt).toEqual(expected);
    expect(projection.timing.launcherCompletedAt).toEqual(expected);
    expect(projection.timing.daemonStart).toEqual({ known: true, value: FIXTURE_OBSERVED_START });
  });
});

describe("a duration needs one boot", () => {
  it("refuses a duration when the two observations carry different boot identities", () => {
    const base = completeRunRecordFixture();
    const projection = project({ ...base, observedEnd: FIXTURE_OBSERVED_END_OTHER_BOOT });
    // Both readings are fully present, so the ONLY reason this cell can be unknown is
    // the boot mismatch. A red here for a missing field would be a red for the wrong
    // rule, and the rule under test would stay unproven.
    expect(projection.timing.daemonStart.known).toBe(true);
    expect(projection.timing.daemonEnd.known).toBe(true);
    expect(projection.timing.daemonMonotonicDuration).toEqual({
      known: false, basis: "BOOT_IDENTITY_MISMATCH", code: null, layer: null,
    });
  });

  it("distinguishes an absent observation from a boot mismatch", () => {
    const base = completeRunRecordFixture();
    const projection = project({ ...base, observedEnd: null });
    expect(projection.timing.daemonMonotonicDuration).toEqual({
      known: false, basis: "OBSERVATION_ABSENT", code: null, layer: null,
    });
    expect(projection.timing.daemonEnd)
      .toEqual({ known: false, basis: "OBSERVATION_ABSENT", code: null, layer: null });
  });

  it("emits a duration for every same-boot pairing it is given, and none across boots", () => {
    const base = completeRunRecordFixture();
    const cases = [
      { end: FIXTURE_OBSERVED_END, derivable: true },
      { end: FIXTURE_OBSERVED_END_OTHER_BOOT, derivable: false },
      { end: null, derivable: false },
    ];
    let swept = 0;
    for (const { end, derivable } of cases) {
      const projection = project({ ...base, observedEnd: end });
      expect(projection.timing.daemonMonotonicDuration.known).toBe(derivable);
      swept += 1;
    }
    expect(swept).toBe(cases.length);
    expect(swept).toBeGreaterThan(0);
  });
});

describe("no imputation across arms", () => {
  it("leaves an incomplete record incomplete after a complete one was projected", () => {
    const completeFirst = project(completeRunRecordFixture());
    const incomplete = project(unobservedRunRecordFixture());
    expect(completeFirst.modelEvidence.observedModelId)
      .toEqual({ known: true, value: "claude-opus-5-20260101" });
    expect(incomplete.modelEvidence.observedModelId).toEqual({
      known: false, basis: "PRODUCER_DECLARED_UNKNOWN",
      code: "TELEMETRY_RESULT_ABSENT", layer: "TELEMETRY_RESULT",
    });
    expect(JSON.stringify(incomplete)).not.toContain("claude-opus-5-20260101");
  });

  it("projects the same record identically whichever arm was projected before it", () => {
    const afterComplete = (() => {
      project(completeRunRecordFixture());
      return project(unobservedRunRecordFixture());
    })();
    const alone = project(unobservedRunRecordFixture());
    expect(afterComplete).toEqual(alone);
  });

  it("carries the run identity verbatim rather than re-deriving three ids", () => {
    const record = completeRunRecordFixture();
    const projection = project(record);
    expect(projection.runIdentity).toEqual(record.providerRunRef);
  });
});

/** Collects every `basis` a projection actually emitted, at any depth. */
function collectBases(value: unknown, seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectBases(entry, seen);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const basis = record["basis"];
  if (typeof basis === "string") seen.add(basis);
  for (const entry of Object.values(record)) collectBases(entry, seen);
}

describe("every declared unknown basis has a producer", () => {
  it("emits each frozen basis from a real record, and declares none it cannot emit", () => {
    const base = completeRunRecordFixture();
    const projections = [
      project(unobservedRunRecordFixture()),
      project({ ...base, observedEnd: FIXTURE_OBSERVED_END_OTHER_BOOT }),
    ];
    const seen = new Set<string>();
    let swept = 0;
    for (const projection of projections) {
      collectBases(projection, seen);
      swept += 1;
    }
    expect(swept).toBe(projections.length);
    expect(swept).toBeGreaterThan(0);
    // Both directions: a basis with no producer cannot fail closed, and a basis produced
    // but never declared would be an unstable reason code escaping the frozen vocabulary.
    expect([...seen].sort()).toEqual([...BENCHMARK_UNKNOWN_BASES].sort());
  });
});
