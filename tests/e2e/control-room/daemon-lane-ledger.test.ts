import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DAEMON_LANE_RECORD, V0_2_DEFERRED_SCENARIOS } from "./daemon-lane-ledger.js";
import {
  DAEMON_LANE_OWNER,
  DECLARED_SCENARIO_COUNT,
  UNCOMPOSED_OWNER,
  coveredScenarios,
  unknownScenarios,
} from "./journey-coverage.js";

/**
 * Node-lane guards for the daemon-backed lane's ledger. Named `*.test.ts`, not
 * `*.spec.ts`, so it runs in the fast `pnpm test:e2e` lane and never launches a
 * browser — this arithmetic should fail in milliseconds, not behind a daemon.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT costs nothing to commit: marking a lane
 * OWNED and letting the reader infer that the eighteen scenarios underneath it
 * moved. They did not. Every assertion below is written so that a status flip, a
 * lost journey, or a re-pointed owner goes RED rather than quietly reading as
 * progress.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..", "..", "..");

/**
 * A hop-counted root breaks silently if this file moves, and the existence checks
 * below would then all fail — or worse, all pass against some other tree. Anchor
 * it on two files only the real root has.
 */
function repoRoot(): string {
  if (!existsSync(join(REPO_ROOT, "package.json"))
    || !existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))) {
    throw new Error(`DAEMON_LANE_ROOT_UNRESOLVED: ${REPO_ROOT} is not the repository root`);
  }
  return REPO_ROOT;
}

describe("the daemon-backed lane's ownership and its limits", () => {
  const LANE_SPEC = readFileSync(join(HERE, "daemon-board.spec.ts"), "utf8");
  const laneTitles = new Set(
    [...LANE_SPEC.matchAll(/^test\("((?:[^"\\]|\\.)*)"/gmu)].map(([, title]) => title),
  );
  const daemonRows = unknownScenarios()
    .filter((scenario) => scenario.cause === "NO_DAEMON_BACKED_BROWSER_LANE");

  it("names the task that owns the lane and the file that is the lane", () => {
    expect(DAEMON_LANE_OWNER).toContain("task-3767f2cd8ac94e4b9e9e82a3dc29af11");
    expect(DAEMON_LANE_OWNER).toContain("OWNED");
    expect(DAEMON_LANE_OWNER).toContain(DAEMON_LANE_RECORD.journeyFile);
    // Fail closed on a rename: an owner pointing at a file that no longer exists
    // is the same lie as an UNOWNED lane, just harder to notice.
    expect(existsSync(join(repoRoot(), DAEMON_LANE_RECORD.journeyFile))).toBe(true);
  });

  /**
   * THE LOAD-BEARING ASSERTION. The record claims a browser drives this lane; this
   * checks the named test is actually DECLARED in the file that would run it, from
   * a line-anchored opener so a title quoted in a doc comment cannot stand in for
   * an executing test.
   */
  it("resolves the lane record to a journey daemon-board.spec.ts declares", () => {
    // Non-vacuity first: a spec that failed to read, or whose declaration style
    // changed, would make the membership check below pass over nothing.
    expect(laneTitles.size).toBeGreaterThan(0);
    expect(laneTitles.has(DAEMON_LANE_RECORD.journeyTitle)).toBe(true);
    expect(DAEMON_LANE_RECORD.proves.trim()).not.toBe("");
    // The limits are half the record. A lane that only advertises what it proves
    // is how eighteen obligations get retired by implication.
    expect(DAEMON_LANE_RECORD.doesNotProve.trim()).not.toBe("");
    expect(DAEMON_LANE_RECORD.owner).toBe(DAEMON_LANE_OWNER);
  });

  it("keeps every daemon-backed row UNKNOWN and explicitly dated to v0.2", () => {
    // Pinned as a whole list, not a count: covering one of these must move this
    // list AND the v0.2 list below in the same edit, and a swap for a duplicate
    // fails here where a count would not.
    expect(daemonRows.map((row) => row.id)).toEqual([
      "CR-J1-001", "CR-J2-002", "CR-J2-003", "CR-J3-001", "CR-J3-002", "CR-J3-003",
      "CR-J4-001", "CR-J4-002", "CR-J5-001", "CR-A11Y-002", "CR-LAG-001", "CR-DOC-001",
    ]);
    for (const row of daemonRows) {
      expect(row.owner, `${row.id} owner`).toBe(DAEMON_LANE_OWNER);
      expect(row.missingInput, `${row.id} names v0.2`).toContain("v0.2");
    }
  });

  /**
   * The SURFACE_NOT_COMPOSED rows used to share the daemon lane's owner string
   * while it read UNOWNED. Now that the string names a task, sharing it would claim
   * that task owns work it never took, so they carry their own owner and this pins
   * them apart.
   */
  it("does not hand the uncomposed surfaces to the lane owner", () => {
    const uncomposedRows = unknownScenarios()
      .filter((scenario) => scenario.cause === "SURFACE_NOT_COMPOSED");
    expect(uncomposedRows.map((row) => row.id)).toEqual([
      "CR-J5-002", "CR-S10-001", "CR-CMD-001",
    ]);
    for (const row of uncomposedRows) {
      expect(row.owner).not.toBe(DAEMON_LANE_OWNER);
    }
    expect(uncomposedRows.slice(0, 2).map((row) => row.owner))
      .toEqual([UNCOMPOSED_OWNER, UNCOMPOSED_OWNER]);
    expect(uncomposedRows[2]?.owner).toContain("command-authored action metadata surface");
  });

  /**
   * The hand-written v0.2 list against the matrix it describes. Both are written by
   * hand, so neither can be derived from the other and pass vacuously — and a row
   * flipped to COVERED without editing the list goes RED here.
   */
  it("defers exactly the eighteen UNKNOWN scenarios to v0.2", () => {
    expect(V0_2_DEFERRED_SCENARIOS).toHaveLength(18);
    expect(V0_2_DEFERRED_SCENARIOS).toEqual(unknownScenarios().map((scenario) => scenario.id));
    expect(coveredScenarios()).toHaveLength(2);
    const covered = new Set(coveredScenarios().map((scenario) => scenario.id));
    expect(V0_2_DEFERRED_SCENARIOS.filter((id) => covered.has(id))).toEqual([]);
    expect(V0_2_DEFERRED_SCENARIOS.length + covered.size).toBe(DECLARED_SCENARIO_COUNT);
  });
});
