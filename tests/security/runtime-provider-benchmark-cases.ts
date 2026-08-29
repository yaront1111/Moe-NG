/**
 * THE BENCHMARK PROJECTION CASES — the 23rd runtime-provider boundary.
 *
 * NOT a `*.security.ts` file: it registers its suite into the slice that calls it, exactly as
 * `describeSliceInvariants`, the render cases and the supervision cases do, so these run inside
 * `runtime-provider-launch.security.ts` and are counted there.
 *
 * WHY IT ARRIVED LATE, recorded because it is the completeness check working. The roster grew
 * this axis from 22 to 23 mid-task when `BENCHMARK_PROJECTION_LAYERS` was tagged
 * `runtime-provider`. `assertRosterPartition` reddened naming the count, which is precisely what
 * it exists to do: a boundary added to the roster and forgotten here cannot pass silently.
 *
 * THE BASELINE RECORD IS PRODUCTION'S OWN. `completeRunRecordFixture()` is exported by
 * @moe/benchmark, so every case below mutates ONE field of a record the projector genuinely
 * accepts — asserted first. Hand-rolling a "valid" record would let a case pass at the input or
 * version layer while claiming to test the shape layer.
 */

import { expect } from "vitest";

import {
  BENCHMARK_PROJECTION_LAYERS,
} from "../../packages/benchmark/src/benchmark-projection-vocabulary.js";
import { completeRunRecordFixture } from "../../packages/benchmark/src/benchmark-record-fixture.js";
import { projectBenchmarkRun } from "../../packages/benchmark/src/benchmark-run-projection.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import {
  describeRuntimeProviderCases as describe,
  itRuntimeProviderCase as it,
} from "./runtime-provider-case-capture.js";
import { RUNTIME_BOUND as BOUND, hostile, layerOf } from "./runtime-provider-ledger.js";
import type { Ledger } from "./runtime-provider-ledger.js";

const BOUNDARY = "BENCHMARK_PROJECTION_LAYERS";

export function describeBenchmarkProjectionBoundary(ledger: Ledger): void {
  const INPUT = layerOf(BENCHMARK_PROJECTION_LAYERS, "BENCHMARK_INPUT");
  const VERSION = layerOf(BENCHMARK_PROJECTION_LAYERS, "BENCHMARK_VERSION");
  const SHAPE = layerOf(BENCHMARK_PROJECTION_LAYERS, "BENCHMARK_SHAPE");

  describe(BOUNDARY, () => {
    const notPlain = { code: "BENCHMARK_RECORD_NOT_PLAIN_DATA", layer: INPUT };
    const project = (value: unknown): unknown => projectBenchmarkRun(hostile(value));

    it("BEFORE — a record that is not readable plain data is refused at the input layer", async () => {
      const outcome = await probeBefore(
        BOUND,
        async () => project(null),
        async () => project("a provider wrote this"),
      );
      ledger.refused(BOUNDARY, "BEFORE", outcome.probe, notPlain);
      ledger.refused(BOUNDARY, "BEFORE", outcome.effect, notPlain);
    });

    it("AFTER — an absent field and a malformed one keep DISTINCT codes at the SHAPE layer", async () => {
      const good = completeRunRecordFixture() as unknown as Record<string, unknown>;
      // The baseline record really is accepted, so the two mutations below are provably what
      // the projector refused rather than something already wrong with the fixture.
      expect((projectBenchmarkRun(hostile(good)) as { ok: boolean }).ok).toBe(true);
      const { providerRunRef: _dropped, ...absent } = good;
      const outcome = await probeAfter(
        BOUND,
        async () => project(absent),
        async () => project({ ...good, providerRunRef: 7 }),
      );
      ledger.refused(BOUNDARY, "AFTER", outcome.effect, {
        code: "BENCHMARK_RECORD_FIELD_ABSENT", layer: SHAPE,
      });
      ledger.refused(BOUNDARY, "AFTER", outcome.probe, {
        code: "BENCHMARK_RECORD_FIELD_MALFORMED", layer: SHAPE,
      });
    });

    it("RACE — an unrecognised revision and a non-record contend, answering at DIFFERENT layers", async () => {
      const outcome = await probeRacing(
        BOUND,
        async () => project({ recordVersion: "moe-provider-run/99" }),
        async () => project([completeRunRecordFixture()]),
      );
      ledger.refusedSide(BOUNDARY, outcome.left, {
        code: "BENCHMARK_RECORD_VERSION_UNRECOGNISED", layer: VERSION,
      });
      ledger.refusedSide(BOUNDARY, outcome.right, notPlain);
    });
  });
}
