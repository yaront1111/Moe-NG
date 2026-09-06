/**
 * A REAL LANDING, DRIVEN THROUGH THE REAL WRAPPER, for the deploy lane only.
 *
 * WHY THIS EXISTS. `repository.publish`'s last check refuses PUBLISH_GOAL_NOT_INTEGRATED while
 * the goal's execution-bearing nodes have no COMMITTED landing receipt
 * (`publication-goal-integration.ts:24`, `receipts.length === 0`), and `deployment.deploy`'s
 * prerequisite table (`bootstrap-sequence.ts:55`) reads a COMMITTED `repository.publish`
 * DECISION. So the deploy lane cannot reach the fake docker double until something LANDS.
 *
 * NOTHING IS SEEDED. The receipt is written by `node-lander.ts` running inside a real
 * `agent-wrapper-main.ts`, over the real delivery coordinator: baseline, seat, verifier,
 * landing. `seedLandingReceipt` in the daemon's own fixtures writes a literal sha and a
 * `D:/fixture-workspace` path, and a publish measured against that would be fabricated
 * authority - the exact thing DoD 2/3 forbid. Here the sha is git's.
 *
 * ONE THING IS A DOUBLE, AND IT IS THE SAME ONE `wrapper-lane.ts` DOUBLES: the seat. A real
 * provider seat cannot be asked to produce a specific edit on cue, and this lane is not
 * certifying provider behaviour - it needs a node whose files DIFFER from the staffing
 * baseline so the lander has something to commit. Everything downstream of the seat's exit is
 * the shipped wrapper.
 *
 * TEARDOWN IS OWNED HERE. The wrapper is killed in a `finally` on every exit path including the
 * refusing ones (epic rail 4), and its pid is returned so the caller's teardown assertion can
 * prove it. A leaked wrapper would keep staffing against a store the lane is about to delete.
 */
import type { ChildProcess } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { killTree } from "./daemon-children.js";
import { laneWorkspaceIdentity } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
import { WRAPPER_INTERVAL_MS, resolveLaneScratch, startWrapper, wrapperEnv } from "./wrapper-lane.js";

/** The one path the seat double writes. Root-relative, so the lander's own diff names it. */
export const LANDED_PATH = "landed-by-the-seat.txt";

/** Baseline, seat spawn, a verifier run and a commit, at a 500 ms wrapper interval. */
export const LANDING_BUDGET_MS = 180_000;

/** The lander's own words for a landing that produced a commit. */
const COMMITTED_LINE = /^\[lander] (\S+): COMMITTED /mu;

export interface LaneLanded {
  readonly ok: true;
  /** The workspace head AFTER the landing, read back from git rather than parsed from a log. */
  readonly sha: string;
  /** The wrapper's pid, for the caller's post-teardown orphan assertion. */
  readonly wrapperPid: number | null;
}

export interface LaneLandingRefused {
  readonly ok: false;
  /** The wrapper's own transcript. Its `[lander]`/`[verifier]` lines ARE the diagnosis. */
  readonly detail: string;
  readonly wrapperPid: number | null;
}

/**
 * Writes the landing seat double into `dir` and says which form this platform can run.
 *
 * THREE FILES FOR THE SAME REASON `wrapper-lane.ts` WRITES THREE: `agent-spawn-invocation.ts`
 * runs a win32 seat THROUGH cmd.exe as a command LINE, so the command has to be a `.cmd`; on
 * posix the spawner passes argv directly, so a `.sh` is the executable form. Both delegate to
 * one `.js` so the platforms cannot drift.
 *
 * The seat exits 0 - a landing needs an ACCEPTED node, and the wrapper classifies the exit
 * rather than asking the seat what happened. It ignores every argument the spawner appends,
 * because those are the provider CLI's own flags.
 */
export function landingSeatDouble(dir: string, workspace: string): { command: string } {
  const jsPath = join(dir, "landing-seat.js");
  const cmdPath = join(dir, "landing-seat.cmd");
  const shPath = join(dir, "landing-seat.sh");
  const target = JSON.stringify(join(workspace, LANDED_PATH));
  writeFileSync(jsPath,
    `require("node:fs").writeFileSync(${target}, "landed at " + new Date().toISOString() + "\\n");\n`
    + "process.exit(0);\n", "utf8");
  writeFileSync(cmdPath,
    `@echo off\r\n"${process.execPath}" "%~dp0landing-seat.js"\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
  writeFileSync(shPath,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/landing-seat.js"\n`, "utf8");
  chmodSync(shPath, 0o755);
  return { command: process.platform === "win32" ? cmdPath : shPath };
}

/**
 * Runs the real wrapper against the lane's board until the lander commits, then stops it.
 *
 * Returns the workspace head AFTER the landing: the publish approval must name a sha the
 * landing receipt's commit is an ANCESTOR of (`publicationGoalIntegrated` shells out to
 * `git merge-base --is-ancestor`), and the landing commit IS that head.
 */
export async function landLaneNode(lane: DaemonLane): Promise<LaneLanded | LaneLandingRefused> {
  const scratch = resolveLaneScratch(lane);
  if (scratch === null) {
    return { detail: "the lane's scratch directory could not be resolved", ok: false, wrapperPid: null };
  }
  const seat = landingSeatDouble(scratch.root, scratch.workspace);
  const tracked: ChildProcess[] = [];
  const watched = startWrapper(
    lane.repoRoot, wrapperEnv(scratch, seat.command, WRAPPER_INTERVAL_MS, true), tracked,
  );
  const wrapperPid = watched.child.pid ?? null;
  try {
    const committed = await watched.waitFor(COMMITTED_LINE, LANDING_BUDGET_MS);
    if (committed === null) {
      return { detail: watched.transcript().slice(-1600), ok: false, wrapperPid };
    }
    // READ BACK FROM GIT, never taken from the log line: the receipt's authority is the commit
    // the repository actually holds, and a transcript is only how the lane learned to look.
    const identity = laneWorkspaceIdentity(scratch.root);
    return identity === null
      ? { detail: `landed but the workspace head is unreadable: ${committed}`, ok: false, wrapperPid }
      : { ok: true, sha: identity.sha, wrapperPid };
  } finally {
    // EVERY EXIT PATH, including the timeout and the throw. The wrapper outliving this call
    // would staff against a store the lane deletes moments later.
    for (const child of [...tracked].reverse()) await killTree(child);
  }
}
