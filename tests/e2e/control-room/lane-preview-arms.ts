/**
 * THE PARTS BOTH LIVE GATE-2 ARMS SHARE: pairing, the landing, the goal id, the dev server's pid
 * and the teardown assertion.
 *
 * WHY A MODULE AND NOT A HELPER INSIDE ONE SPEC. The APPROVE and REJECT arms need SEPARATE LANES —
 * `previewReceiptId` is a function of (projectId, goalId, sha), so a second decide against the
 * approved lane's receipt answers REPLAYED rather than rejecting anything — and importing one
 * `.spec.ts` from another would REGISTER ITS TESTS TWICE. So the shared half lives here, where it
 * is imported by both and run by neither.
 *
 * THE TRACKED-PID ARRAY IS A PARAMETER, never module state. Playwright may run the two specs in
 * one worker, and a shared array would let one arm's teardown assert over the other arm's pids —
 * which passes or fails for reasons that have nothing to do with either.
 */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SqliteEventStore } from "@moe/store";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { createCompiledNodeSource } from "../../../apps/daemon/src/orchestrator/compiled-node-source.js";
import { DEFAULT_OPERATOR_PRINCIPAL_ID } from "../../../apps/daemon/src/operator-identity.js";
import { readPreviewDecision } from "../../../apps/daemon/src/preview/preview-daemon-edge.js";
import type { PreviewDecisionRecord } from "../../../apps/daemon/src/preview/preview-daemon-edge.js";
import { readGoalLandingStatus } from "../../../apps/daemon/src/preview/preview-goal-landing.js";
import { readPreviewReceipt } from "../../../apps/daemon/src/preview/preview-ledger.js";
import { lanePids, survivingPids } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
import { LANDING_BUDGET_MS, landLaneNode } from "./lane-landing.js";
import { writePreviewScaffold } from "./lane-preview.js";
import { readGoalCatalogOverHttp } from "./prd-boundary-readers.js";

/** A landing, a dev server, a browser and a daemon. The landing budget is a floor, not the cost. */
export const LANE_TIMEOUT_MS = LANDING_BUDGET_MS + 420_000;
export const CARD_MS = 120_000;

/**
 * Types the pairing label back on the daemon's own operator channel, exactly as an operator would.
 * HAND-MIRRORED from `deploy-fake-docker.spec.ts:113-126` for the reason stated there: the pairing
 * dialog is the daemon's, and a private copy that drifts pairs against a screen it no longer shows.
 */
export async function pair(page: Page, lane: DaemonLane): Promise<void> {
  const label = page.getByLabel("Pairing confirmation label");
  await expect(label).toBeVisible({ timeout: 30_000 });
  const value = (await label.textContent())?.trim() ?? "";
  expect(value).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u);
  expect(lane.approvePairing).not.toBeNull(); lane.approvePairing?.(value);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && await label.count() !== 0) {
    await page.getByRole("button", { name: "I entered this label" }).click({ timeout: 2000 })
      .catch(() => undefined);
    await page.waitForTimeout(250);
  }
  await expect(label).toHaveCount(0);
}

/** The lane's own store. Opened per call and closed in a `finally`: a held handle blocks teardown. */
function laneStore(lane: DaemonLane): SqliteEventStore {
  return SqliteEventStore.openForProject(
    join(dirname(lane.catalogPath), "store.sqlite"), lane.projectId,
  );
}

/**
 * The dev server's pid, read off the durable receipt — `/preview/read` withholds it on purpose.
 *
 * IT ASSERTS RATHER THAN ANSWERING NULL. A null here would be pushed onto nothing, and the
 * teardown's `survivingPids` would then prove that no number was tracked instead of that no
 * process survived. The receipt of a STARTED preview always carries a pid (`preview-runner.ts:189`
 * records `handle.pid`), so a null is a defect worth failing on, not a case to tolerate.
 */
export function previewPid(lane: DaemonLane, receiptId: string): number {
  const store = laneStore(lane);
  try {
    const read = readPreviewReceipt(store, lane.projectId, receiptId);
    const pid = read.ok ? read.receipt.pid : null;
    expect(pid, `a STARTED receipt must carry the dev server's pid: ${receiptId}`)
      .toEqual(expect.any(Number));
    return pid ?? 0;
  } finally { store.close(); }
}

/**
 * The node keys a finding may name, from the SAME authority the decide edge consults.
 *
 * `readGoalLandingStatus(...).nodes` is a roster of NODE KEYS (preview-goal-landing.ts:61-63,79),
 * and `runPreviewDecideEdge` refuses any finding whose `nodeRef` is outside it. It is deliberately
 * NOT the `nodeRef` the runs read projects — that is a `compiledExecutionRef` — which is why the
 * reject arm asserts the runs-read value is REFUSED and this one is accepted.
 */
export function landedNodeKeys(lane: DaemonLane, goalId: string): readonly string[] {
  const store = laneStore(lane);
  try {
    const status = readGoalLandingStatus(store, lane.projectId, goalId);
    expect(status.allLanded, `the goal must be fully landed: ${JSON.stringify(status)}`).toBe(true);
    return status.nodes;
  } finally { store.close(); }
}

/**
 * The `compiledExecutionRef` the CARD would put in its node-select — the OTHER spelling.
 *
 * WHY NOT `laneCompiledNodeRef(resolveLaneScratch(lane))`. `resolveLaneScratch` requires
 * `node-specs/node.json` to still exist (wrapper-lane.ts:206), and `landLaneNode` DELETES every
 * spec in that directory (`retireSpecNode`) before it lands — deliberately, so the bare key cannot
 * be staffed. So the scratch resolves only BEFORE a landing, and any caller that asks afterwards
 * gets null. Measured 2026-09-07. This asks the store the same question `laneCompiledNodeRef`
 * asks, through the same `createCompiledNodeSource` seam the production composition uses, so it
 * needs no spec file: `workspace`/`testCommand` are null because listing needs no host facts.
 */
export function laneCardNodeRef(lane: DaemonLane): string | null {
  const store = laneStore(lane);
  try {
    return createCompiledNodeSource({
      projectId: lane.projectId, store, testCommand: null, workspace: null,
    }).nodes()[0]?.nodeRef ?? null;
  } finally { store.close(); }
}

/**
 * The WHOLE landing status — `{allLanded, missing, nodes}` — as one comparable string.
 *
 * This is the node-shaped authority a REWORK transition would have to move, and it is the same
 * one the decide edge consults, so comparing it across a rejection is what makes "nothing moved"
 * a measurement rather than a hope.
 */
export function landedNodeStatus(lane: DaemonLane, goalId: string): string {
  const store = laneStore(lane);
  try {
    return JSON.stringify(readGoalLandingStatus(store, lane.projectId, goalId));
  } finally { store.close(); }
}

/**
 * The committed `preview.decide` record — the production read that carries the FINDINGS.
 *
 * `/activity/read` states a decision's facts and carries no payload (activity-read.ts), so the
 * roster an operator named is read through `readPreviewDecision`, which re-validates the record
 * against the command that wrote it. The principal is the daemon's CONFIGURED operator, which the
 * lane names nowhere: it sets no MOE_PRINCIPAL_ID, so `daemon-store-dependencies.ts:46` falls back
 * to `DEFAULT_OPERATOR_PRINCIPAL_ID` — imported here rather than typed as `"operator-local"`.
 */
export function readDecisionRecord(
  lane: DaemonLane, commandId: string,
): PreviewDecisionRecord | null {
  const store = laneStore(lane);
  try {
    return readPreviewDecision(store, lane.projectId, DEFAULT_OPERATOR_PRINCIPAL_ID, commandId);
  } finally { store.close(); }
}

/** The seeded goal, from the daemon's DURABLE catalog. `/runs/read` is empty on a seeded lane. */
export async function seededGoalId(lane: DaemonLane): Promise<string> {
  const catalog = await readGoalCatalogOverHttp(lane.daemonOrigin, lane.repoRoot,
    lane.credential, lane.csrfToken);
  const goalId = "goals" in catalog ? catalog.goals[0]?.goalId ?? null : null;
  expect(goalId, `the seeded lane must expose a goal: ${JSON.stringify(catalog)}`).not.toBeNull();
  return goalId ?? "";
}

/**
 * Commits the preview scaffold, lands the node for real, and answers the sha git actually holds.
 *
 * NO SKIP, NO EARLY RETURN. DoD 1 is explicit: a lane with no landing receipt FAILS, carrying the
 * wrapper's own `[lander]`/`[verifier]` transcript, because a green skip would report the absence
 * of a preview as the presence of a passing test.
 */
export async function landForPreview(lane: DaemonLane, pids: number[]): Promise<string> {
  const scaffoldSha = writePreviewScaffold(lane.workspace);
  expect(scaffoldSha, "the scaffold is a real commit git resolves").toMatch(/^[0-9a-f]{40}$/u);
  const landed = await landLaneNode(lane);
  // ASSERTED, not skipped past. `if (pid !== null) push(pid)` silently contributes NOTHING when
  // the pid is absent, and the teardown assertion downstream then proves the absence of a number
  // rather than the death of a process — a leak check that cannot fail is worse than none.
  expect(landed.wrapperPid, "the wrapper must report a pid the teardown can assert on")
    .toEqual(expect.any(Number));
  if (landed.wrapperPid !== null) pids.push(landed.wrapperPid);
  expect(landed.ok ? "ok" : `LANDING: ${landed.detail}`).toBe("ok");
  if (!landed.ok) throw new Error("unreachable: the assertion above fails first");
  expect(landed.sha, "the lander commits a real sha").toMatch(/^[0-9a-f]{40}$/u);
  expect(landed.sha, "the landing moves the head off the lane baseline").not.toBe(lane.workspaceSha);
  expect(landed.sha, "and off the scaffold commit it was stacked on").not.toBe(scaffoldSha);
  return landed.sha;
}

/**
 * Nothing this arm started is still running, and the scratch tree is gone.
 *
 * THE DEV SERVER IS COUNTED, and it is the pid that matters most: a leaked preview holds a
 * loopback port, so the NEXT preview cannot bind and the failure surfaces far from its cause.
 */
export async function assertStopped(lane: DaemonLane | undefined, pids: readonly number[]): Promise<void> {
  expect(lane, "the real daemon and server must have started").toBeDefined();
  if (lane === undefined) return;
  expect(await survivingPids([...lanePids(lane), ...pids])).toEqual([]);
  expect(existsSync(dirname(lane.catalogPath))).toBe(false);
}
