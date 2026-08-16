import { describe, expect, it } from "vitest";

import {
  BENCHMARK_PROJECTION_CODES, BENCHMARK_PROJECTION_LAYERS,
} from "./benchmark-projection-vocabulary.js";
import { PROJECTED_RECORD_KEYS, PROJECTED_RECORD_VERSION } from "./benchmark-record-contracts.js";
import { FIXTURE_USAGE_ROW, completeRunRecordFixture } from "./benchmark-record-fixture.js";
import { projectBenchmarkRun } from "./benchmark-run-projection.js";

function refusalOf(input: unknown): { readonly code: string; readonly layer: string; readonly message: string } {
  const result = projectBenchmarkRun(input);
  if (result.ok) throw new Error("expected a refusal, got a projection");
  return result;
}

function withoutKey(key: string): Record<string, unknown> {
  const record: Record<string, unknown> = { ...completeRunRecordFixture() };
  delete record[key];
  return record;
}

/** One input per declared code, each pinning the exact layer that must answer it. */
const PRODUCERS: readonly { readonly code: string; readonly layer: string; readonly input: unknown }[] = [
  { code: "BENCHMARK_RECORD_NOT_PLAIN_DATA", layer: "BENCHMARK_INPUT", input: null },
  {
    code: "BENCHMARK_RECORD_VERSION_UNRECOGNISED", layer: "BENCHMARK_VERSION",
    input: { ...completeRunRecordFixture(), recordVersion: "moe-provider-run-record/2" },
  },
  {
    code: "BENCHMARK_RECORD_FIELD_ABSENT", layer: "BENCHMARK_SHAPE",
    input: withoutKey("providerRunRef"),
  },
  {
    code: "BENCHMARK_RECORD_FIELD_MALFORMED", layer: "BENCHMARK_SHAPE",
    input: { ...completeRunRecordFixture(), providerRunRef: "not-a-reference" },
  },
  {
    code: "BENCHMARK_ROW_BASIS_ABSENT", layer: "BENCHMARK_ROW",
    input: { ...completeRunRecordFixture(), usage: ["not-a-row"] },
  },
];

describe("every declared code has a producer", () => {
  it("produces each frozen code, from its own layer, from a real input", () => {
    const producedCodes = new Set<string>();
    const producedLayers = new Set<string>();
    let swept = 0;
    for (const { code, layer, input } of PRODUCERS) {
      const refusal = refusalOf(input);
      expect(refusal.code).toBe(code);
      expect(refusal.layer).toBe(layer);
      producedCodes.add(refusal.code);
      producedLayers.add(refusal.layer);
      swept += 1;
    }
    expect(swept).toBe(PRODUCERS.length);
    expect(swept).toBeGreaterThan(0);
    // A code no layer can emit cannot fail closed, so the vocabulary is asserted to be
    // exactly what production can produce — in both directions.
    expect([...producedCodes].sort()).toEqual([...BENCHMARK_PROJECTION_CODES].sort());
    expect([...producedLayers].sort()).toEqual([...BENCHMARK_PROJECTION_LAYERS].sort());
  });

  it("echoes no record content into any refusal message", () => {
    let swept = 0;
    for (const { input } of PRODUCERS) {
      const { message } = refusalOf(input);
      expect(message).not.toContain("claude-opus-5");
      expect(message).not.toContain("run-1");
      expect(message).not.toContain("e".repeat(64));
      swept += 1;
    }
    expect(swept).toBe(PRODUCERS.length);
    expect(swept).toBeGreaterThan(0);
  });
});

describe("fixtures are shared, so they are frozen", () => {
  it("refuses in-place mutation of a fixture at every depth", () => {
    const record = completeRunRecordFixture();
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.usage)).toBe(true);
    expect(Object.isFrozen(record.usage[0]?.measurement)).toBe(true);
    expect(Object.isFrozen(FIXTURE_USAGE_ROW.pricebookBinding)).toBe(true);
    // A shared fixture one consumer can mutate is a fixture every other consumer's
    // "pristine" baseline silently drifts under.
    expect(() => {
      (record.usage[0]?.measurement as { meter: string }).meter = "tampered";
    }).toThrow(TypeError);
    expect(record.usage[0]?.measurement.meter).toBe("input_tokens");
  });

  it("still admits a fixture variant built by spreading", () => {
    const base = completeRunRecordFixture();
    const variant = { ...base, launch: { ...base.launch, startedAt: null } };
    expect(projectBenchmarkRun(variant).ok).toBe(true);
  });
});

describe("the version seam", () => {
  it("admits only the pinned record revision", () => {
    expect(PROJECTED_RECORD_VERSION).toBe("moe-provider-run-record/1");
    expect(projectBenchmarkRun(completeRunRecordFixture()).ok).toBe(true);
  });

  it("refuses an unrecognised revision before it reads any field", () => {
    // Version is answered before shape on purpose: an unrecognised schema means the
    // harness cannot know which fields to expect, so a field complaint would be noise.
    const moved = { recordVersion: "moe-provider-run-record/2" };
    const refusal = refusalOf(moved);
    expect(refusal.code).toBe("BENCHMARK_RECORD_VERSION_UNRECOGNISED");
    expect(refusal.layer).toBe("BENCHMARK_VERSION");
  });

  it("refuses an absent revision as unrecognised rather than as an absent field", () => {
    const refusal = refusalOf(withoutKey("recordVersion"));
    expect(refusal.code).toBe("BENCHMARK_RECORD_VERSION_UNRECOGNISED");
    expect(refusal.layer).toBe("BENCHMARK_VERSION");
  });
});

describe("shape admission", () => {
  it("refuses every input that is not a plain record", () => {
    const inputs: readonly unknown[] = [null, undefined, "record", 42, true, [], () => undefined];
    let swept = 0;
    for (const input of inputs) {
      const refusal = refusalOf(input);
      expect(refusal.code).toBe("BENCHMARK_RECORD_NOT_PLAIN_DATA");
      expect(refusal.layer).toBe("BENCHMARK_INPUT");
      swept += 1;
    }
    expect(swept).toBe(inputs.length);
    expect(swept).toBeGreaterThan(0);
  });

  it("refuses a record missing any one required field", () => {
    const sweepable = PROJECTED_RECORD_KEYS.filter((key) => key !== "recordVersion");
    let swept = 0;
    for (const key of sweepable) {
      const refusal = refusalOf(withoutKey(key));
      expect(refusal.code).toBe("BENCHMARK_RECORD_FIELD_ABSENT");
      expect(refusal.layer).toBe("BENCHMARK_SHAPE");
      swept += 1;
    }
    expect(swept).toBe(PROJECTED_RECORD_KEYS.length - 1);
    expect(swept).toBe(18);
    expect(swept).toBeGreaterThan(0);
  });

  it("refuses a required field that is present but the wrong shape", () => {
    const base = completeRunRecordFixture();
    const malformed: readonly Record<string, unknown>[] = [
      { ...base, providerRunRef: "not-a-reference" },
      { ...base, launch: null },
      { ...base, usage: {} },
      { ...base, usageRefusals: "none" },
      { ...base, recordDigest: 42 },
      { ...base, observedStart: 17 },
      // A non-finite reading passes a bare `typeof "number"` check and would then flow
      // into the one place this package subtracts, publishing NaN as a KNOWN duration.
      {
        ...base,
        observedStart: { serverWallSeconds: 1_000, bootId: "boot-a", monotonicObservation: Number.NaN },
      },
      {
        ...base,
        observedEnd: {
          serverWallSeconds: Number.POSITIVE_INFINITY, bootId: "boot-a", monotonicObservation: 5_012,
        },
      },
    ];
    let swept = 0;
    for (const input of malformed) {
      const refusal = refusalOf(input);
      expect(refusal.code).toBe("BENCHMARK_RECORD_FIELD_MALFORMED");
      expect(refusal.layer).toBe("BENCHMARK_SHAPE");
      swept += 1;
    }
    expect(swept).toBe(malformed.length);
    expect(swept).toBeGreaterThan(0);
  });

  it("refuses a usage row that carries no readable measurement basis", () => {
    const base = completeRunRecordFixture();
    const rowless: readonly Record<string, unknown>[] = [
      { ...base, usage: ["not-a-row"] },
      { ...base, usage: [{ ...FIXTURE_USAGE_ROW, measurement: null }] },
      { ...base, usage: [{ ...FIXTURE_USAGE_ROW, measurement: { meter: "input_tokens" } }] },
      {
        ...base,
        usage: [{
          ...FIXTURE_USAGE_ROW,
          measurement: { ...FIXTURE_USAGE_ROW.measurement, quantity: Number.NaN },
        }],
      },
    ];
    let swept = 0;
    for (const input of rowless) {
      const refusal = refusalOf(input);
      expect(refusal.code).toBe("BENCHMARK_ROW_BASIS_ABSENT");
      expect(refusal.layer).toBe("BENCHMARK_ROW");
      swept += 1;
    }
    expect(swept).toBe(rowless.length);
    expect(swept).toBeGreaterThan(0);
  });
});

describe("three refusal sources, never flattened", () => {
  it("keeps the scheduler's issues and the provider's refusal in separate columns", () => {
    const record = completeRunRecordFixture();
    const result = projectBenchmarkRun(record);
    if (!result.ok) throw new Error("expected a projection");
    const { refusals } = result.projection;
    expect(Object.keys(refusals).sort()).toEqual(["provider", "scheduler"]);
    expect(refusals.scheduler).toEqual(record.usageRefusals);
    expect(refusals.scheduler[0]?.issues[0]?.code).toBe("BUDGET_OBSERVATION_SEQUENCE_GAP");
    expect(refusals.provider).toBeNull();
  });

  it("answers with its own vocabulary, which can appear in neither record column", () => {
    // The third source is the refusal RESULT, not a column: when the harness cannot
    // project, there is no projection to hold a column. That is what makes a harness
    // code structurally impossible to mistake for a scheduler or provider one.
    const refusal = refusalOf(null);
    expect(refusal.code).toBe("BENCHMARK_RECORD_NOT_PLAIN_DATA");
    expect(refusal.layer).toBe("BENCHMARK_INPUT");
    const projected = projectBenchmarkRun(completeRunRecordFixture());
    if (!projected.ok) throw new Error("expected a projection");
    for (const code of BENCHMARK_PROJECTION_CODES) {
      expect(JSON.stringify(projected.projection.refusals)).not.toContain(code);
    }
  });

  it("carries a provider seam refusal without moving it into the scheduler column", () => {
    const upstream = {
      ok: false as const, code: "TELEMETRY_MODEL_ABSENT", layer: "TELEMETRY_RESULT",
      message: "no admitted record names the model evidence this fact needs",
    };
    const result = projectBenchmarkRun({ ...completeRunRecordFixture(), upstreamRefusal: upstream });
    if (!result.ok) throw new Error("expected a projection");
    const { refusals } = result.projection;
    expect(refusals.provider).toEqual(upstream);
    expect(refusals.scheduler.length).toBe(1);
    expect(JSON.stringify(refusals.scheduler)).not.toContain("TELEMETRY_MODEL_ABSENT");
  });
});
