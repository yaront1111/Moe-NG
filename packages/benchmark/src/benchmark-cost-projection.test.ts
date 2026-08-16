import { describe, expect, it } from "vitest";

import { BENCHMARK_COST_BASES } from "./benchmark-projection-vocabulary.js";
import {
  FIXTURE_USAGE_ROW, completeRunRecordFixture, unobservedRunRecordFixture,
} from "./benchmark-record-fixture.js";
import type { ProjectedRunRecord } from "./benchmark-record-contracts.js";
import { projectBenchmarkRun } from "./benchmark-run-projection.js";
import type { BenchmarkRunProjection } from "./benchmark-run-projection.js";

function project(record: ProjectedRunRecord): BenchmarkRunProjection {
  const result = projectBenchmarkRun(record);
  if (!result.ok) throw new Error(`expected a projection, got ${result.code}@${result.layer}`);
  return result.projection;
}

describe("a binding is not a cost", () => {
  it("reports each usage row's pricebook binding verbatim as its cost basis", () => {
    const [row] = project(completeRunRecordFixture()).costClass;
    expect(row?.pricebookBinding).toEqual(FIXTURE_USAGE_ROW.pricebookBinding);
    expect(row?.costBasis).toBe("PRICEBOOK_BINDING");
    expect(row?.quantity).toEqual({ known: true, value: 4 });
  });

  it("exposes no derived price on a cost row", () => {
    const [row] = project(completeRunRecordFixture()).costClass;
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "costBasis", "coverage", "identity", "meter", "pricebookBinding", "quantity",
      "sequence", "source", "truncated",
    ]);
    // quantity 4 against a 1500-micro unit price. 6000 appears nowhere in the record,
    // so a list price presented as an actual cost cannot hide among the real numbers.
    expect(JSON.stringify(row)).not.toContain("6000");
  });

  it("reports a row with no binding as unpriced rather than as a zero cost", () => {
    const rows = project(completeRunRecordFixture()).costClass;
    const unpriced = rows[1];
    expect(unpriced?.pricebookBinding).toBeNull();
    expect(unpriced?.costBasis).toBe("NO_BINDING");
    expect(JSON.stringify(unpriced)).not.toContain("Micros");
  });

  it("emits every declared cost basis and declares none it cannot emit", () => {
    const rows = project(completeRunRecordFixture()).costClass;
    const seen = new Set<string>();
    let swept = 0;
    for (const row of rows) {
      seen.add(row.costBasis);
      swept += 1;
    }
    expect(swept).toBe(rows.length);
    expect(swept).toBeGreaterThan(0);
    expect([...seen].sort()).toEqual([...BENCHMARK_COST_BASES].sort());
    expect(Object.isFrozen(BENCHMARK_COST_BASES)).toBe(true);
  });

  it("projects one cost row per usage row and drops none", () => {
    const record = completeRunRecordFixture();
    const rows = project(record).costClass;
    expect(rows.length).toBe(record.usage.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.identity)).toEqual(["usage-1", "usage-2"]);
  });
});

describe("null is not zero", () => {
  it("renders no unobserved reading anywhere in the projection as a zero", () => {
    const serialised = JSON.stringify(project(unobservedRunRecordFixture()));
    expect(serialised).not.toContain('"value":0');
    // Positive control: the walk above can only mean something if a projection that DOES
    // hold observations puts values where this one puts none.
    expect(JSON.stringify(project(completeRunRecordFixture()))).toContain('"value":');
  });

  it("reports an unmeasured usage quantity as UNKNOWN rather than as a zero", () => {
    const unpriced = project(completeRunRecordFixture()).costClass[1];
    expect(unpriced?.quantity)
      .toEqual({ known: false, basis: "QUANTITY_ABSENT", code: null, layer: null });
  });

  it("carries every unobserved token count with its producing authority's code", () => {
    const counts = project(unobservedRunRecordFixture()).counts;
    const expected = {
      known: false, basis: "PRODUCER_DECLARED_UNKNOWN",
      code: "TELEMETRY_RESULT_ABSENT", layer: "TELEMETRY_RESULT",
    };
    let swept = 0;
    for (const cell of [
      counts.inputTokens, counts.outputTokens, counts.cacheCreationInputTokens,
      counts.cacheReadInputTokens, counts.turns, counts.sequence,
    ]) {
      expect(cell).toEqual(expected);
      swept += 1;
    }
    expect(swept).toBe(6);
    expect(swept).toBeGreaterThan(0);
  });

  it("carries a coverage short of complete through rather than dropping it", () => {
    const complete = project(completeRunRecordFixture());
    expect(complete.counts.tokenCoverage).toBe("COMPLETE");
    expect(complete.costClass[1]?.coverage).toBe("PARTIAL");
    const unobserved = project(unobservedRunRecordFixture());
    expect(unobserved.counts.tokenCoverage).toBe("UNKNOWN");
    expect(unobserved.counts.stepCoverage).toBe("UNKNOWN");
  });
});

describe("evidence receipts are carried, never recomputed", () => {
  it("reports both stream receipt digests and the record digest verbatim", () => {
    const record = completeRunRecordFixture();
    const receipt = project(record).evidenceReceipt;
    expect(receipt.stdoutReceiptDigest).toEqual({ known: true, value: "c".repeat(64) });
    expect(receipt.stderrReceiptDigest).toEqual({ known: true, value: "d".repeat(64) });
    expect(receipt.recordDigest).toBe(record.recordDigest);
  });

  it("reports a tampered record digest verbatim instead of re-deriving or refusing it", () => {
    // The codec is the only authority on what a record is; recomputing the digest here
    // would be a second, drifting opinion about bytes that already have one. The harness
    // carries the digest so a later reader can compare it, and forms no view of its own.
    const record = { ...completeRunRecordFixture(), recordDigest: "f".repeat(64) };
    const result = projectBenchmarkRun(record);
    expect(result.ok).toBe(true);
    expect(project(record).evidenceReceipt.recordDigest).toBe("f".repeat(64));
  });

  it("reports every reproducibility digest from the launch facts verbatim", () => {
    const record = completeRunRecordFixture();
    const reproducibility = project(record).reproducibility;
    expect(reproducibility).toEqual({
      effectDigest: { known: true, value: "effect-digest" },
      activationDigest: { known: true, value: "activation-digest" },
      runtimeBindingDigest: { known: true, value: "runtime-binding-digest" },
      quotedRuntimeDigest: { known: true, value: "quoted-runtime-digest" },
      freshRuntimeDigest: { known: true, value: "fresh-runtime-digest" },
      pinnedClosureDigest: { known: true, value: "pinned-closure-digest" },
      observationDigest: { known: true, value: "observation-digest" },
    });
  });

  it("reports an absent reproducibility digest as UNKNOWN, never as an empty string", () => {
    const base = completeRunRecordFixture();
    const projection = project({
      ...base, launch: { ...base.launch, freshRuntimeDigest: null },
    });
    expect(projection.reproducibility.freshRuntimeDigest)
      .toEqual({ known: false, basis: "OBSERVATION_ABSENT", code: null, layer: null });
    expect(projection.reproducibility.pinnedClosureDigest)
      .toEqual({ known: true, value: "pinned-closure-digest" });
  });
});
