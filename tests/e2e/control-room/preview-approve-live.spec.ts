/**
 * GATE 2, DRIVEN END TO END ON A REAL LANDED GOAL — the two walls `preview-approve.spec.ts` used
 * to call permanent, demolished and replaced with what is actually measured.
 *
 * EVERY LINK IN THE CHAIN IS PRODUCTION. A REAL git workspace the lane commits a preview scaffold
 * into; a REAL landing written by `node-lander.ts` inside a REAL `agent-wrapper-main.ts` (nothing
 * seeded — `seedLandingReceipt`'s literal sha is exactly the fabricated authority the rails
 * forbid); a REAL `preview.start` that resolves the command, spawns a REAL dev server, probes its
 * port and proves the LISTENER BELONGS TO THE CHILD TREE; a REAL `preview.decide` committed to the
 * durable ledger; and the verdict read back out of `/activity/read`. The ONLY double anywhere is
 * the wrapper's SEAT, for the reason `wrapper-lane.ts` gives — a provider cannot be asked to
 * produce a specific edit on cue.
 *
 * WHY A PREVIEW LANE NAMES `fakeDocker`. It is not deploying anything. `fakeDocker !== undefined`
 * is the EXISTING switch that gives a lane a git workspace, `MOE_NODE_WORKSPACE` and a
 * landing-capable node spec (daemon-ports.ts:618/504/151). The docker doubles ride along
 * completely unused: this spec dispatches no `deployment.*` command. Adding a dedicated flag
 * would have meant editing `daemon-ports.ts`, which is outside this row's scope.
 *
 * WHAT THE BROWSER BUTTON CANNOT DO, MEASURED RATHER THAN ASSUMED, AND PINNED BY LAYER. The
 * Gate-2 card renders against a really-running product — asserted below — but its Approve control
 * cannot commit, for two INDEPENDENT reasons, and the arms pin each at its own layer because the
 * first one masks the second:
 *   WALL A, AUTHORIZATION. `preview.decide` is in `OPERATOR_PRINCIPAL_KINDS`
 *     (daemon-command-vocabulary.ts:365) and is deliberately NOT in the registry's paired-human
 *     widening (daemon-command-registry.ts:344-355), which admits only the intent wire, the
 *     criterion kinds, `repository.publish` and the clarification answer. The shipped browser
 *     pairs into a NON-operator credential (main.tsx:128 -> live-handshake.ts:170-186). So a
 *     paired human is refused OPERATOR_PRINCIPAL_REQUIRED @ DAEMON_AUTHORIZATION. That is the
 *     epic's own rail — human gates are operator-only — so this row asserts it rather than
 *     widening it.
 *   WALL B, THE REQUEST. `preview-port.ts:51-63` sends `previewRef = affordance.targetAggregateId`
 *     = `preview:<goalId>`, but the decide edge spends that value as a RECEIPT ID
 *     (preview-daemon-edge.ts:225 -> preview-ledger.ts:89), which is a sha256 hex. `PreviewFacts`
 *     already carries the right value (`receiptId`, needs-you-preview.ts:109) and the port never
 *     reads it. Dispatched AS THE OPERATOR so wall A cannot answer first, that payload refuses
 *     PREVIEW_GOAL_NOT_LANDED @ GOAL_AUTHORITY. `preview-port.test.ts:60` cannot see this: its
 *     fixture affordance uses one arbitrary string for both ids.
 * The verdict this spec asserts is therefore committed by the CONFIGURED OPERATOR — which
 * `lane.credential` provably is (session-authenticator.ts:98-105) — and read back from the
 * daemon's own answer, never from component state.
 */
import { expect, test } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { previewAggregateId } from "../../../apps/daemon/src/preview/preview-receipt-contracts.js";
import { mintLaneOperatorSeat, withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
import {
  CARD_MS, LANE_TIMEOUT_MS, assertStopped, landForPreview, pair, previewPid, seededGoalId,
} from "./lane-preview-arms.js";
import {
  PREVIEW_PAGE_MARKER, decideLanePreview, lanePost, readActivityVerdicts, startLanePreview,
} from "./lane-preview.js";

/** Every pid this spec is answerable for beyond the lane's own: the wrapper and the dev server. */
const childPids: number[] = [];

test("gate 2 live: a real landing starts a real preview and APPROVE commits a verdict /activity/read carries",
  async ({ page }) => {
    test.setTimeout(LANE_TIMEOUT_MS);
    let started: DaemonLane | undefined;
    childPids.length = 0;
    try {
      const result = await withDaemonBackedControlRoom({
        fakeDocker: "SUCCESS", liveCredentials: "ATTACHED", operatorChannel: true,
      }, async (lane) => {
        started = lane;
        const sha = await landForPreview(lane, childPids);
        const goalId = await seededGoalId(lane);

        // THE MINTED SEAT IS REFUSED, and asserting it here is what proves the fence is live
        // rather than absent. It is a durable HUMAN principal and still not the CONFIGURED
        // operator, which is the same class of refusal the paired browser gets.
        const wrongSeat = await startLanePreview(lane, goalId, sha,
          mintLaneOperatorSeat(lane).credential);
        expect(wrongSeat.ok, "a non-operator seat may not start a preview").toBe(false);
        if (!wrongSeat.ok) {
          expect(wrongSeat.detail, "refused by CODE").toContain("OPERATOR_PRINCIPAL_REQUIRED");
          expect(wrongSeat.detail, "and by LAYER").toContain("DAEMON_AUTHORIZATION");
        }

        const preview = await startLanePreview(lane, goalId, sha);
        expect(preview.ok ? "ok" : `START: ${preview.detail}`).toBe("ok");
        if (!preview.ok) throw new Error("unreachable: the assertion above fails first");
        childPids.push(previewPid(lane, preview.receiptId));
        let decided = false;
        try {
          expect(preview.receiptId, "the receipt id is a sha256 digest, not the aggregate id")
            .toMatch(/^[0-9a-f]{64}$/u);
          expect(preview.url, "the daemon detected the server's own announced origin")
            .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

          await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
          await pair(page, lane);
          // BY TESTID: the Goals screen carries a "Needs you" FILTER PILL with the same
          // accessible name as the nav item, so a role+name locator is a strict-mode violation.
          await page.getByTestId("cr.nav.approvals").click();
          await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
          // THE CARD IS PRESENT, against a product that is really serving. Its container is
          // asserted before anything is read out of it.
          await expect(page.getByTestId("cr.needsyou.preview.root")).toBeVisible({ timeout: CARD_MS });
          await expect(page.getByTestId("cr.needsyou.preview.link")).toContainText(preview.url);

          // DoD 4, THE LIVE DRIVE, DONE BY A COMMITTED ARM RATHER THAN A DELETED PROBE: open the
          // product the daemon just started, in the real browser, and photograph it. A screenshot
          // taken by a throwaway script is a LEAD; one taken here is re-runnable evidence. The
          // path goes to the OS temp directory, never into the repository, and the run PRINTS it
          // so a row comment can carry the path and its sha256.
          // A SECOND TAB, never a navigation away: the card is what the rest of this arm acts on,
          // and `goBack` would remount the whole app and re-poll for it. It is also what the card
          // itself does — its link carries target="_blank".
          const shot = join(tmpdir(), `moe-gate2-preview-${String(Date.now())}.png`);
          const product = await page.context().newPage();
          try {
            await product.goto(preview.url, { waitUntil: "domcontentloaded" });
            await expect(product.getByRole("heading", { name: PREVIEW_PAGE_MARKER })).toBeVisible();
            await product.screenshot({ path: shot });
            process.stdout.write(`LIVE_DRIVE_SCREENSHOT ${shot}\n`);
          } finally { await product.close(); }

          // WALL A, at its own layer. Clicking the real button in the real browser commits
          // NOTHING, so the activity read still carries no preview verdict afterwards.
          await page.getByTestId("cr.needsyou.preview.approve").click();
          await expect(page.getByTestId("cr.needsyou.preview.said")).toHaveCount(0);
          const beforeAnyDecide = await readActivityVerdicts(lane);
          expect(beforeAnyDecide.filter((entry) => entry.commandKind === "preview.decide"),
            "the paired browser's click committed nothing").toEqual([]);
          const paired = await decideLanePreview(lane, preview.receiptId, "APPROVE", undefined,
            goalId, mintLaneOperatorSeat(lane).credential);
          const pairedSaid = JSON.stringify(paired.body);
          expect(pairedSaid, "refused by CODE").toContain("OPERATOR_PRINCIPAL_REQUIRED");
          expect(pairedSaid, "and by LAYER").toContain("DAEMON_AUTHORIZATION");

          // WALL B, dispatched AS THE OPERATOR so wall A cannot answer for it: the aggregate id
          // the browser sends as `previewRef` is not a receipt id and never resolves one.
          const asAggregate = await decideLanePreview(lane, previewAggregateId(goalId), "APPROVE",
            undefined, goalId);
          const aggregateSaid = JSON.stringify(asAggregate.body);
          expect(aggregateSaid, "refused by CODE").toContain("PREVIEW_GOAL_NOT_LANDED");
          expect(aggregateSaid, "and by LAYER").toContain("GOAL_AUTHORITY");

          // THE OPERATOR'S OWN VERDICT, committed for real.
          const answer = await decideLanePreview(lane, preview.receiptId, "APPROVE", undefined, goalId);
          decided = true;
          expect(JSON.stringify(answer.body), "APPROVE is accepted").toContain("PREVIEW_DECISION_RECORDED");

          // READ BACK FROM THE DAEMON, never from the page: a decision that never reached the
          // store cannot pass this. PROJECT scope, because `preview:<goalId>` is not in the
          // goal-scoped target set (activity-read.ts:133-145).
          const entries = await readActivityVerdicts(lane);
          const verdicts = entries.filter((entry) => entry.commandKind === "preview.decide");
          expect(verdicts.length, JSON.stringify(entries)).toBe(1);
          expect(verdicts[0]).toMatchObject({
            commandKind: "preview.decide", disposition: "COMMITTED",
            targetAggregateId: previewAggregateId(goalId), verdict: "APPROVE",
          });
          // PRINTED so the row comment quotes the daemon's own record rather than a paraphrase.
          process.stdout.write(`LIVE_DRIVE_DECISION ${JSON.stringify(verdicts[0])}\n`);

          // AND THE GOAL-SCOPED READ CANNOT ANSWER AT ALL ON THIS LANE — asserted by its own CODE
          // and LAYER rather than by an empty list, because a REFUSED body carries no `entries`
          // and an empty-list assertion would pass for the refusal instead of for the filtering
          // it claims to measure. `targetsOf` (activity-read.ts:133) resolves a goal through
          // `catalogBoundGoals`, and the seeded lane's goal is not bound to a source document, so
          // the read refuses before scoping is ever reached. Measured 2026-09-07; this is exactly
          // why DoD 2's read-back is taken in PROJECT scope above.
          const scoped = await lanePost(lane, "/activity/read", { goalRef: goalId });
          const scopedSaid = JSON.stringify(scoped.body);
          expect(scopedSaid, "refused by CODE").toContain("ACTIVITY_READ_GOAL_UNKNOWN");
          expect(scopedSaid, "and by LAYER").toContain("ACTIVITY_READ");
        } finally {
          // EVERY EXIT PATH, INCLUDING A THROW BETWEEN START AND DECIDE. `preview.decide` is the
          // only HTTP way to stop the server (`port.release`, preview-daemon-edge.ts:304); the
          // lane's own teardown would reach it through the daemon's process tree, but a spec that
          // relied on that would be relying on the platform rather than on the product.
          if (!decided) {
            await decideLanePreview(lane, preview.receiptId, "APPROVE", undefined, goalId)
              .catch(() => undefined);
          }
        }
      });
      expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
    } finally { await assertStopped(started, childPids); }
  });
