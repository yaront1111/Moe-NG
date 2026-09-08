/**
 * THE COMMITTED REGRESSION FOR `landLaneNode`, ON REAL FRESH LANES.
 *
 * WHAT FAILED BEFORE THE FIX, measured 2026-09-08 over 17 independent fresh seeded lanes and
 * recorded on the row (comment-7baa79e6): `landed.ok` was true 17/17, and the lane workspace
 * came back CLEAN 0/17. Every lane ended `M landed-by-the-seat.txt`, with the committed blob
 * (425c2ec) and the worktree blob (e648c1e) 2.9 s apart - the seat double had been restaffed
 * for a mission that was not the code node's, rewriting the target's landing file with a fresh
 * `new Date().toISOString()` AFTER the lander had already committed it. That is both reported
 * symptoms in one mechanism: a workspace that will not come clean, and a round whose
 * SUBMITTED_BYTES digest no longer matches the bytes on disk, which burns staffing attempts
 * until the landing budget is spent.
 *
 * WHY N INDEPENDENT LANES AND NOT REPEAT CALLS ON ONE. The owner ruled DoD 1's "repeatedly"
 * (comment-c21629a4): N SEPARATE fresh seeded lanes, one `landLaneNode` each. The helper's own
 * shape says the same thing - `retireSpecNode` deletes the node spec that `resolveLaneScratch`
 * matches on, so a second call against an already-landed lane cannot resolve a scratch at all
 * and would be measuring the resolver, not the landing.
 *
 * WHY N = 5. The per-lane failure probability before the fix was measured at 1.0 (0 clean
 * workspaces in 17 lanes), so this arm would have failed at the FIRST lane; five is chosen so
 * the arm also carries the "repeatedly" the DoD asks for, and so a per-lane probability as low
 * as 0.5 - an order of magnitude kinder to the bug than what was measured - would still be
 * caught 31 times in 32. At the measured 8.8 s a lane it costs under a minute of shared
 * browser-lane wall clock. N is a count of INDEPENDENT lanes, NOT a retry budget: every lane
 * asserts, and no lane's failure is forgiven because another passed.
 *
 * NOTHING HERE IS SEEDED AND NOTHING IS CLEANED UP TO PASS. The sha is git's, read back from
 * the workspace; the receipt is read through the production `readReviewLedgers`, never from a
 * `[lander]` log line; and a dirty workspace is reported as the failure it is rather than reset.
 */
import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";

import { readReviewLedgers } from "../../../apps/daemon/src/review/review-read-model.js";
import { survivingPids, withDaemonBackedControlRoom } from "./daemon-ports.js";
import { LANDED_PATH, landLaneNode, laneCompiledNodeRef } from "./lane-landing.js";
import { resolveLaneScratch } from "./wrapper-lane.js";

/** Lane open (daemon, seed, dev server) plus a real baseline/seat/verify/land round. */
const LANE_TIMEOUT_MS = 420_000;

/** Independent fresh lanes. See the header for why five, and why they are not retries. */
const LANES = 5;

/**
 * Git in the lane's own workspace, with GIT_* stripped from the child environment.
 *
 * The same neutering `git-landing-port.ts`'s `landingEnvironment()` does and for the same
 * reason: a GIT_DIR or GIT_WORK_TREE exported by whatever shell started the suite would point
 * these reads at the developer's own repository, and this arm would then assert cleanliness of
 * the wrong tree - passing while the lane workspace it is about to delete is dirty.
 */
function laneGit(cwd: string, args: readonly string[]): string {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  environment["GIT_OPTIONAL_LOCKS"] = "0";
  return execFileSync("git", [...args], {
    cwd, encoding: "utf8", env: environment, maxBuffer: 1_048_576,
    shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true,
  }).replace(/\r?\n$/u, "");
}

/**
 * One fresh seeded lane, landed once, asserted on, torn down in the harness's own `finally`.
 *
 * The scratch is resolved BEFORE `landLaneNode` because the helper retires the node spec that
 * `resolveLaneScratch` matches on; afterwards there is no lane directory to find, and the
 * post-landing reads would have nothing to read.
 */
async function landOneFreshLane(): Promise<void> {
  const outcome = await withDaemonBackedControlRoom(
    { fakeGh: "SUCCESS", liveCredentials: "ABSENT" },
    async (lane) => {
      const scratch = resolveLaneScratch(lane);
      expect(scratch, `the lane scratch for ${lane.projectId} did not resolve`).not.toBeNull();
      if (scratch === null) return;
      const baselineSha = scratch.workspaceSha;

      const landed = await landLaneNode(lane);

      // ASKED FIRST, whatever else is about to fail. A wrapper that outlived the helper keeps
      // staffing against a store this lane deletes moments from now, and every later assertion
      // in this file - and in every gate that runs after it - would be measured against a tree
      // something is still writing to.
      const orphans = landed.wrapperPid === null ? [] : await survivingPids([landed.wrapperPid]);
      expect(orphans, `wrapper pid ${String(landed.wrapperPid)} outlived landLaneNode`).toEqual([]);

      expect(landed.ok, landed.ok ? "landed" : `landLaneNode refused: ${landed.detail}`).toBe(true);
      if (!landed.ok) return;

      // READ BACK FROM GIT, never parsed from the transcript: the sha's authority is the commit
      // the repository holds. Different from the pre-landing head, or nothing was committed.
      const head = laneGit(scratch.workspace, ["rev-parse", "--verify", "HEAD^{commit}"]);
      expect(landed.sha, "the returned sha is not the workspace head").toBe(head);
      expect(landed.sha, "the head did not move, so nothing landed").not.toBe(baselineSha);

      // THE REGRESSION. Dirty here means a seat rewrote a committed landing after the fact.
      // It is reported, never reset: resetting would be deleting the evidence of the bug.
      const status = laneGit(scratch.workspace, ["status", "--porcelain"]);
      expect(status, `the lane workspace is dirty after landLaneNode:\n${status}`).toBe("");

      // THE RECEIPT, THROUGH THE PRODUCTION READ PATH. A `[lander]` line is how the helper
      // learned to look; `readReviewLedgers` is what `publication-goal-integration.ts` asks,
      // and a policy line can never answer it at all.
      const nodeRef = laneCompiledNodeRef(scratch);
      expect(nodeRef, "the compiled execution node is unresolvable after landing").not.toBeNull();
      if (nodeRef === null) return;
      const store = SqliteEventStore.openForProject(scratch.storePath, scratch.projectId);
      let receipt;
      try {
        receipt = readReviewLedgers(store, scratch.projectId, new Set([nodeRef])).landings.get(nodeRef);
      } finally { store.close(); }
      expect(receipt, `no landing receipt is filed for ${nodeRef}`).toBeDefined();
      expect(receipt?.outcome, `landing receipt refusal: ${JSON.stringify(receipt?.refusal)}`)
        .toBe("COMMITTED");
      expect(receipt?.subjectRef, "the receipt names another node").toBe(nodeRef);
      expect(receipt?.commit?.sha, "the receipt's commit is not the head the helper returned")
        .toBe(landed.sha);
      expect((receipt?.commit?.files ?? []).join(","), "the seat's file is not in the commit")
        .toContain(LANDED_PATH);
    },
  );
  expect(outcome.ok, outcome.ok ? "lane closed" : `${outcome.code}: ${outcome.detail}`).toBe(true);
}

test("landLaneNode lands the code node and leaves a clean workspace on five fresh lanes",
  async () => {
    test.setTimeout(LANE_TIMEOUT_MS);
    // EVERY lane runs and EVERY lane's outcome is reported, so a red names which lane failed and
    // how many did - a tally is what makes an intermittent legible. `landOneFreshLane` throws on
    // its first failed assertion, so the tally below is printed before that failure propagates.
    const tally: string[] = [];
    try {
      for (let lane = 1; lane <= LANES; lane += 1) {
        await landOneFreshLane();
        tally.push(`lane ${String(lane)}/${String(LANES)}: landed, clean, receipt COMMITTED`);
      }
    } finally {
      const heading = `##### LANE TALLY passed=${String(tally.length)}/${String(LANES)} #####`;
      process.stdout.write([heading, ...tally, ""].join("\n"));
    }
    expect(tally, "not every fresh lane landed cleanly").toHaveLength(LANES);
  });
