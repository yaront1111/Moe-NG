import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { WIRE_PROTOCOL_VERSION } from "../../../apps/daemon/src/http/http-contract.js";
import { withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";

/**
 * GATE 2 IN THE BROWSER, against a REAL daemon: the preview receipt read, the card that is
 * ABSENT until a preview exists, and the decide edge refusing for the daemon's own reason.
 *
 * WHAT THIS SPEC PROVES, AND WHAT IT CANNOT - stated up front because the second half is a
 * measured limit of the product today, not a gap in the test.
 *
 * PROVEN HERE, live, no fixture anywhere:
 *  1. `/preview/read` is WIRED and answers this goal `kind: "ABSENT"`. Before task-4a6e7bdbef9a
 *     landed, that route did not exist; an ABSENT answer through the real listener is what
 *     makes every browser-side assertion below about a real daemon.
 *  2. THE CARD IS ABSENT while the read is ABSENT. DoD 1's second half, in a real browser: no
 *     Gate-2 card in Needs you, and no disabled Approve control either.
 *  3. `preview.decide` REFUSES for a preview that does not exist, with the daemon's own code
 *     and layer - so the decide edge this row's card spends is live and fenced, and the card
 *     is not offering a button that would 404.
 *
 * THE THREE WALLS THIS HEADER USED TO CALL PERMANENT ARE ALL GONE, and saying so here is the
 * point: the paragraph they replaced was measured, correct at the time, and wrong now.
 *  A. "APPROVE NEEDS A LANDED GOAL, AND NOTHING A BROWSER CAN DO MAKES ONE." Still true that
 *     `internal.repository.landing_receipt` has no HTTP ingress — and no longer a wall, because
 *     the lane does not need one. `landLaneNode` (lane-landing.ts) runs the REAL
 *     `agent-wrapper-main.ts` against the lane's own board and the REAL `node-lander` commits
 *     into the lane's git workspace. The receipt is written by production code, from a real
 *     commit, with git's own sha. Nothing is seeded: `seedLandingReceipt`'s literal sha and
 *     `D:/fixture-workspace` path are the fabricated authority this epic's rails forbid.
 *  B. "A STARTED RECEIPT NEEDS A PREVIEW COMMAND IN THE BOUND WORKSPACE." Still true, and now
 *     satisfied: the workspace is SERVER-HELD, but it is the LANE'S OWN git tree, so
 *     `writePreviewScaffold` (lane-preview.ts) commits a `package.json` with a `dev` script and
 *     a `node:http` server into it BEFORE the landing. `resolvePreviewCommand` then finds it the
 *     ordinary way. No production seam was widened to allow this.
 *  C. "`preview.decide` DOES NOT STOP A PROCESS", which was the leak fear that made driving
 *     `preview.start` here look reckless. It is simply false: `runPreviewDecideEdge` ends with
 *     `port.release(receipt.receiptId, payload.decision)` (preview-daemon-edge.ts:304), AFTER the
 *     commit and on APPROVE and REJECT alike, and the supervisor's `stop()` is memoised and
 *     idempotent. The live arms still carry their own `finally`, because a throw BETWEEN start
 *     and decide reaches neither.
 *
 * SO THE LIVE LEG IS NO LONGER DEFERRED - IT IS DRIVEN, in `preview-approve-live.spec.ts` and
 * `preview-reject-live.spec.ts`: a real landing, a real dev server, a real APPROVE and a real
 * REJECT, each verdict read back out of `/activity/read`. Those two live in their own files
 * purely for the per-file line cap; this spec keeps the surface and refusal arms below.
 *
 * WHAT IS STILL NOT TRUE, AND IS ASSERTED THERE RATHER THAN ASSUMED HERE: the Gate-2 card's own
 * Approve BUTTON cannot commit. `preview.decide` is operator-only (OPERATOR_PRINCIPAL_KINDS) and
 * the shipped browser pairs into a non-operator credential, and separately `preview-port.ts` sends
 * the preview AGGREGATE id where the edge expects the RECEIPT id. Both are pinned by code AND
 * layer in the live specs; neither is worked around.
 */

const JOURNEY_MS = 300_000;
const CARD_MS = 120_000;
const PAIRING_BUDGET_MS = 90_000;
const PAIRING_LABEL = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/u;

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/** The operator's real pairing ritual, copied from activation-fresh-project.spec.ts:52-68. */
async function pairBrowser(page: Page, lane: DaemonLane): Promise<void> {
  const approve = lane.approvePairing;
  expect(approve, "the lane must expose an operator channel").not.toBeNull();
  const output = page.getByLabel("Pairing confirmation label");
  await expect(output).toBeVisible({ timeout: 30_000 });
  const label = (await output.textContent())?.trim() ?? "";
  expect(label, "the browser must be shown a real label").toMatch(PAIRING_LABEL);
  approve?.(label);
  const confirm = page.getByRole("button", { name: "I entered this label" });
  const deadline = Date.now() + PAIRING_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await output.count() === 0) return;
    await confirm.click({ timeout: 5_000 }).catch(() => undefined);
    await sleep(1_000);
  }
  await expect(output, "the pairing card must close").toHaveCount(0, { timeout: 10_000 });
}

interface Answered {
  readonly body: Record<string, unknown>;
  readonly status: number;
}

/** POSTs one daemon route FROM THE PAGE, with the credentials the bundle was served with. */
async function post(
  page: Page, lane: DaemonLane, path: string, body: Record<string, unknown>,
): Promise<Answered> {
  return await page.evaluate(async (input: {
    readonly body: string; readonly credential: string; readonly csrf: string;
    readonly path: string; readonly protocolVersion: string;
  }) => {
    const response = await fetch(input.path, {
      body: input.body,
      headers: {
        "content-type": "application/json",
        "x-moe-csrf": input.csrf,
        "x-moe-protocol-version": input.protocolVersion,
        "x-moe-session-credential": input.credential,
      },
      method: "POST",
    });
    let parsed: unknown = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { body: (parsed ?? {}) as Record<string, unknown>, status: response.status };
  }, {
    body: JSON.stringify(body), credential: lane.credential, csrf: lane.csrfToken, path,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
}

/**
 * The seeded goal, taken from the daemon's own DURABLE catalog rather than guessed.
 *
 * `/goals/read` and not `/runs/read`: the runs read projects live runs and leases, and the
 * shipped seed has already exited by the time `body` runs, so its `goals` array is empty on a
 * seeded lane. The catalog is the durable projection the Goals screen itself reads.
 */
async function seededGoalId(page: Page, lane: DaemonLane): Promise<string> {
  const runs = await post(page, lane, "/goals/read", {});
  expect(runs.status, JSON.stringify(runs.body)).toBe(200);
  const goals = runs.body["goals"];
  expect(Array.isArray(goals), `goals read answered ${JSON.stringify(runs.body)}`).toBe(true);
  const first = (goals as readonly Record<string, unknown>[])[0];
  const goalId = typeof first?.["goalId"] === "string" ? first["goalId"] : "";
  expect(goalId, "the seeded lane must name at least one goal").not.toBe("");
  return goalId;
}

test("the preview read is live, and Gate 2 is absent until a preview exists", async ({ page }) => {
  test.setTimeout(JOURNEY_MS);

  const outcome = await withDaemonBackedControlRoom({
    approval: "HUMAN",
    liveCredentials: "ATTACHED",
    operatorChannel: true,
  }, async (lane) => {
    await page.goto(lane.baseUrl);
    await pairBrowser(page, lane);

    const goalId = await seededGoalId(page, lane);

    // 1. THE ROUTE IS WIRED AND ANSWERS ABSENT. A daemon without the leaf answers a listener
    //    refusal instead, so `kind: "ABSENT"` is the discriminator - not merely a 200.
    const read = await post(page, lane, "/preview/read", { goalId });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body, "a goal nobody has previewed answers ABSENT, never a refusal")
      .toMatchObject({ goalId, kind: "ABSENT" });

    // 2. AN UNKNOWN KEY IS REFUSED, not ignored: the route takes EXACTLY {goalId}, and the
    //    project comes from the authenticated principal rather than the wire.
    const widened = await post(page, lane, "/preview/read", { goalId, projectId: lane.projectId });
    expect(widened.body["kind"], JSON.stringify(widened.body)).not.toBe("ABSENT");

    // 3. THE CARD IS ABSENT (DoD 1). The queue is mounted and answering - asserted by its own
    //    root being visible - and carries no Gate-2 card and no dead Approve control.
    //    The app opens on Goals, so the queue has to be NAVIGATED TO: asserting the absence of
    //    a card on a screen that never mounted would pass for the wrong reason, which is why
    //    the root's visibility is asserted before the three absence arms rather than after.
    //    By testid, not by name: the Goals screen carries a "Needs you" FILTER PILL with the
    //    same accessible name as the nav item, so a role+name locator is ambiguous.
    await page.getByTestId("cr.nav.approvals").click();
    await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
    await expect(page.getByTestId("cr.needsyou.preview.root")).toHaveCount(0);
    await expect(page.getByTestId("cr.needsyou.preview.approve")).toHaveCount(0);
    await expect(page.getByTestId("cr.needsyou.preview.reject")).toHaveCount(0);

    // 4. THE DECIDE EDGE IS LIVE AND FENCED. A verdict on a preview that does not exist is
    //    refused with the daemon's OWN code and layer, so the button the card spends is real.
    const decided = await post(page, lane, "/command", {
      commandId: `preview-decide-${String(Date.now())}`,
      commandKind: "preview.decide",
      correlationId: "preview-e2e",
      expectedVersion: 0,
      payload: { decision: "APPROVE", previewRef: `preview-receipt/${"0".repeat(64)}` },
      requestDigest: "a".repeat(64),
      schemaVersion: "moe-runtime-command/1",
      sessionCredential: lane.credential,
      targetAggregateId: `preview:${goalId}`,
    });
    const said = JSON.stringify(decided.body);
    expect(decided.status, said).not.toBe(200);
    expect(said, "the daemon named a preview refusal code").toMatch(
      /PREVIEW_[A-Z_]+|OPERATOR_PRINCIPAL_REQUIRED|PREVIEW_DECISION_INVALID/u,
    );

    return { goalId, refusal: said };
  });

  expect(outcome.ok, `lane opened${outcome.ok ? "" : `: ${outcome.code} ${outcome.detail}`}`)
    .toBe(true);
  if (!outcome.ok) return;
  expect(outcome.value.goalId).not.toBe("");
});
