import { describe, expect, it } from "vitest";

import * as benchmark from "./index.js";

const TEST_ONLY_EXPORTS = Object.freeze([
  "FIXTURE_OBSERVED_END",
  "FIXTURE_OBSERVED_END_OTHER_BOOT",
  "FIXTURE_OBSERVED_START",
  "FIXTURE_USAGE_ROW",
  "FIXTURE_USAGE_ROW_UNMEASURED",
  "completeRunRecordFixture",
  "unknownFactFixture",
  "unobservedRunRecordFixture",
] as const);

describe("the benchmark production surface", () => {
  it("exports projection behavior without retaining test-fixture imports", () => {
    expect(TEST_ONLY_EXPORTS).toHaveLength(8);
    expect(typeof benchmark.projectBenchmarkRun).toBe("function");
    for (const name of TEST_ONLY_EXPORTS) expect(name in benchmark, name).toBe(false);
  });
});
