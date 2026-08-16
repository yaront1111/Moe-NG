/**
 * Durable-store hostile-caller coverage.
 *
 * This is deliberately not disaster-recovery fault coverage.  The fault lane
 * asks whether interrupted execution leaves coherent state; this security lane
 * asks whether forged, stale, replayed, or racing caller input is denied by the
 * production boundary that owns the decision.  Fault injection is therefore
 * used only as a race latch, never as a crash-point sweep.
 */

import { afterAll, describe, expect, it } from "vitest";

import { BOUNDARY_ROSTER } from "./boundary-roster.security.js";
import { assertRefusedWith, cleanupHostileRoots } from "./hostile-harness.js";
import {
  DURABLE_BOUNDARY_NAMES,
  hostileAfterCases,
  hostileBeforeCases,
  hostileRaceCases,
  runRefusalCase,
  runRaceCase,
} from "./durable-store-boundary-scenarios.js";

afterAll(cleanupHostileRoots);

const rosterNames = BOUNDARY_ROSTER
  .filter((entry) => entry.axis === "durable-store")
  .map((entry) => entry.constant)
  .sort();

describe("durable-store roster coverage", () => {
  it("takes the durable-store subset from the committed roster in both directions", () => {
    expect(DURABLE_BOUNDARY_NAMES).toHaveLength(14);
    expect([...DURABLE_BOUNDARY_NAMES].sort()).toStrictEqual(rosterNames);
  });

  it.each(DURABLE_BOUNDARY_NAMES)("generates hostile BEFORE and AFTER cases for %s", (boundary) => {
    expect(hostileBeforeCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
    expect(hostileAfterCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
    expect(hostileRaceCases.filter((entry) => entry.boundary === boundary).length).toBeGreaterThan(0);
  });
});

describe("hostile durable-store races", () => {
  for (const hostileCase of hostileRaceCases) {
    it(`RACE ${hostileCase.boundary}: ${hostileCase.question}`, async () => {
      const result = await runRaceCase(hostileCase);
      expect(result.admittedSides).toBe(1);
      expect(result.outcome.left.status === "fulfilled" || result.outcome.right.status === "fulfilled").toBe(true);
      assertRefusedWith(result.refusal, hostileCase.expected);
      expect(result.durableEvents).toBe(1);
      expect(result.winnerPayloads).toStrictEqual([result.winner]);
    });
  }
});

describe("hostile durable-store caller input", () => {
  for (const hostileCase of [...hostileBeforeCases, ...hostileAfterCases]) {
    it(`${hostileCase.phase} ${hostileCase.boundary}: ${hostileCase.question}`, async () => {
      const result = await runRefusalCase(hostileCase);
      assertRefusedWith(result.refusal, hostileCase.expected);
      if (hostileCase.upstream !== undefined) {
        expect(result.upstream).toStrictEqual(hostileCase.upstream);
      }
      expect(result.durableRecords).toBe(hostileCase.preexistingRecords);
      expect(result.truth).toBe("UNKNOWN");
      expect(result.authority).toBe("NONE");
    });
  }
}
);
