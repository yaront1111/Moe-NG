import { describe, expect, it } from "vitest";

import { RUNS_READ_CODES, runsRefused } from "./runs-read-contract.js";

describe("runs read refusal helper", () => {
  it("stamps the route's own layer and admits only the closed runs-read roster", () => {
    expect(RUNS_READ_CODES.map((code) => runsRefused(code))).toStrictEqual([
      { code: "RUNS_READ_CAPABILITY_DENIED", layer: "RUNS_READ", outcome: "REFUSED" },
      { code: "RUNS_READ_GOAL_UNKNOWN", layer: "RUNS_READ", outcome: "REFUSED" },
      { code: "RUNS_READ_PROJECT_MISMATCH", layer: "RUNS_READ", outcome: "REFUSED" },
      { code: "RUNS_READ_UNREADABLE", layer: "RUNS_READ", outcome: "REFUSED" },
    ]);
    if (false) {
      // @ts-expect-error a foreign or misspelled code is outside the closed runs-read vocabulary
      runsRefused("PLANNING_RUN_READ_RUN_UNKNOWN");
    }
  });
});
