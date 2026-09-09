/**
 * GATE 2's OTHER ANSWER, live: send the product back with a finding against a named node, and
 * prove the daemon recorded the verdict WITHOUT MOVING ANYTHING.
 *
 * ITS OWN FRESH LANE, and that is forced rather than tidy. `previewReceiptId` is a function of
 * (projectId, goalId, sha) (preview-receipt-contracts.ts:96), so a second decide against the
 * APPROVE arm's receipt would answer REPLAYED and reject nothing. A fresh lane means a fresh
 * landing, which means a fresh sha, which means a receipt this arm is the first to decide.
 *
 * THE DoD SAYS THE REJECTED NODE GOES TO "REWORK". PRODUCTION HAS NO SUCH STATE AND MUST NOT GROW
 * ONE. `RUN_NODE_STATUSES` (runs-read-contract.ts:28-31) is ACCEPTED, BLOCKED, DELIVERED,
 * ESCALATED, ESCALATION_REQUIRED, IN_PROGRESS, READY, REPLANNED, UNATTRIBUTABLE — nine words, none
 * of them REWORK — and `preview-rejection-invariants.test.tsx` encodes the governor ruling with a
 * source sweep that REDS on any REWORK spelling in the control room. `runPreviewDecideEdge` writes
 * one decision record and performs NO node transition. So this arm asserts THE RULING: the verdict
 * and its findings are durable and readable, the named node's status is BYTE-IDENTICAL across the
 * rejection, and the runs read contains no REWORK spelling at all. Adding a REWORK state to
 * satisfy the sentence would redden a landed test and reverse a ruling.
 *
 * A FINDING NAMES A NODE **KEY**, NOT THE runs read's `nodeRef` — and the negative arm below is
 * how that stops being a detail. `runPreviewDecideEdge:242` builds its admissible set from
 * `readGoalLandingStatus(...).nodes`, which is a roster of `node.nodeKey`
 * (preview-goal-landing.ts:61,79). The runs read projects `nodeRef` as a `compiledExecutionRef`
 * (runs-read.ts:100) — a DIFFERENT value — and `preview-card.tsx:120` puts exactly that into the
 * select's option values. So the browser's own rejection payload is refused
 * PREVIEW_DECISION_INVALID @ REQUEST even before the authorization wall this row documents. Both
 * spellings are dispatched below, as the operator, so neither refusal can be attributed to the
 * other's layer.
 */
import { expect, test } from "@playwright/test";

import { previewAggregateId } from "../../../apps/daemon/src/preview/preview-receipt-contracts.js";
import { withDaemonBackedControlRoom } from "./daemon-ports.js";
import type { DaemonLane } from "./daemon-ports.js";
import {
  CARD_MS, LANE_TIMEOUT_MS, assertStopped, laneCardNodeRef, landForPreview, landedNodeKeys,
  landedNodeStatus, pair, previewPid, readDecisionRecord, seededGoalId,
} from "./lane-preview-arms.js";
import {
  decideLanePreview, lanePost, readActivityVerdicts, startLanePreview,
} from "./lane-preview.js";

const childPids: number[] = [];
const FINDING_DETAIL = "The heading is wrong: it must name the product, not the lane.";

/**
 * "NOTHING MOVED", TAKEN FROM THREE AUTHORITIES AT ONCE, so the claim cannot rest on one that
 * happens not to know this goal.
 *
 * `/runs/read` IS CALLED IN PROJECT SCOPE, and that is measured rather than stylistic: a
 * `{goalRef}` read resolves the goal through `catalogBoundGoals` (runs-read.ts:267), the seeded
 * lane's goal is not bound to a source document, and the route answers
 * RUNS_READ_GOAL_UNKNOWN @ RUNS_READ before it ever looks at a node — asserted as its own fact
 * below rather than worked around silently. So the board's own answer is captured whole, and the
 * node-shaped evidence comes from `readGoalLandingStatus`, which IS the roster
 * `runPreviewDecideEdge:242` itself consults and is exactly what a REWORK transition would move.
 */
async function boardState(lane: DaemonLane, goalId: string): Promise<string> {
  const runs = await lanePost(lane, "/runs/read", {});
  expect(runs.status, JSON.stringify(runs.body)).toBe(200);
  expect(runs.body["outcome"], JSON.stringify(runs.body)).toBe("RUNS");
  const preview = await lanePost(lane, "/preview/read", { goalId });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  // NO REWORK SPELLING IN ANY OF IT. Swept over the whole bodies rather than one field, because a
  // seventh column would arrive as a new member long before it arrived as a `status` value.
  for (const body of [runs.body, preview.body]) {
    expect(JSON.stringify(body)).not.toContain("REWORK");
  }
  return JSON.stringify({
    landing: landedNodeStatus(lane, goalId), preview: preview.body, runs: runs.body,
  });
}

test("gate 2 live: REJECT records findings against the named node and moves nothing on the board",
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
        const preview = await startLanePreview(lane, goalId, sha);
        expect(preview.ok ? "ok" : `START: ${preview.detail}`).toBe("ok");
        if (!preview.ok) throw new Error("unreachable: the assertion above fails first");
        childPids.push(previewPid(lane, preview.receiptId));
        let decided = false;
        try {
          // THE ADMISSIBLE ROSTER, from the same authority the decide edge consults.
          const nodeKeys = landedNodeKeys(lane, goalId);
          expect(nodeKeys.length, "the landed goal names at least one node").toBeGreaterThan(0);
          const nodeKey = nodeKeys[0] ?? "";

          await page.goto(lane.baseUrl, { waitUntil: "domcontentloaded" });
          await pair(page, lane);
          await page.getByTestId("cr.nav.approvals").click();
          await expect(page.getByTestId("cr.needsyou.root")).toBeVisible({ timeout: CARD_MS });
          await expect(page.getByTestId("cr.needsyou.preview.root")).toBeVisible({ timeout: CARD_MS });
          // THE CARD CANNOT NAME A NODE ON THIS LANE, and that is a MEASURED fact rather than a
          // gap in the test. `previewOfferFor` fills the chooser from the RUNS read
          // (needs-you-preview.ts:75-82), which cannot answer for a goal that is not bound to a
          // source document — so `facts.nodes` is empty, the select is DISABLED and the card shows
          // its own `nonodes` hint. Asserting that, inside a card whose root is already visible,
          // is what keeps this from being an absence on a screen that never mounted.
          await expect(page.getByTestId("cr.needsyou.preview.nonodes")).toBeVisible();
          await expect(page.getByTestId("cr.needsyou.preview.node")).toBeDisabled();
          await expect(page.getByTestId("cr.needsyou.preview.reject")).toBeDisabled();

          const before = await boardState(lane, goalId);

          // NEGATIVE ARM, AT ITS OWN LAYER. `laneCardNodeRef` returns the REAL
          // `compiledExecutionRef` for this lane's node — the exact spelling `preview-card.tsx:120`
          // puts in the select's option values — and it is NOT in the landing roster the decide
          // edge admits. Dispatched as the OPERATOR so the authorization wall cannot answer in its
          // place.
          const cardRef = laneCardNodeRef(lane) ?? "";
          expect(cardRef, "the card's spelling is a compiled execution ref").not.toBe("");
          expect(cardRef, "and it is NOT the key a finding must name").not.toBe(nodeKey);
          const asNodeRef = await decideLanePreview(lane, preview.receiptId, "REJECT",
            [{ detail: FINDING_DETAIL, nodeRef: cardRef }], goalId);
          const refusedSaid = JSON.stringify(asNodeRef.body);
          expect(refusedSaid, "refused by CODE").toContain("PREVIEW_DECISION_INVALID");
          expect(refusedSaid, "and by LAYER").toContain("REQUEST");

          // AND THE REFUSAL COMMITTED NOTHING: no verdict exists yet.
          const beforeVerdicts = await readActivityVerdicts(lane);
          expect(beforeVerdicts.filter((entry) => entry.commandKind === "preview.decide"),
            "a refused decide is not a decision").toEqual([]);

          // A GOAL-SCOPED RUNS READ REFUSES ON THIS LANE, by its own code and layer — stated here
          // so `boardState`'s project scope is a measured choice, not an unexplained one.
          const scopedRuns = await lanePost(lane, "/runs/read", { goalRef: goalId });
          const scopedSaid = JSON.stringify(scopedRuns.body);
          expect(scopedSaid, "refused by CODE").toContain("RUNS_READ_GOAL_UNKNOWN");
          expect(scopedSaid, "and by LAYER").toContain("RUNS_READ");

          // THE REAL REJECTION, by the configured operator, naming a node of the landed goal.
          const answer = await decideLanePreview(lane, preview.receiptId, "REJECT",
            [{ detail: FINDING_DETAIL, nodeRef: nodeKey }], goalId);
          decided = true;
          expect(JSON.stringify(answer.body), "REJECT is accepted")
            .toContain("PREVIEW_DECISION_RECORDED");

          // THE VERDICT, FROM THE DAEMON — project scope, because the goal-scoped read refuses
          // above and `preview:<goalId>` is not in the goal-scoped target set either.
          const entries = await readActivityVerdicts(lane);
          const verdicts = entries.filter((entry) => entry.commandKind === "preview.decide");
          expect(verdicts.length, JSON.stringify(entries)).toBe(1);
          expect(verdicts[0]).toMatchObject({
            commandKind: "preview.decide", disposition: "COMMITTED",
            targetAggregateId: previewAggregateId(goalId), verdict: "REJECT",
          });

          // THE FINDINGS ARE DURABLE AND NAME THE NODE, read back through the production read of
          // the committed decision rather than from the page — the card's own findings list only
          // renders what its LOCAL state remembers sending.
          const record = readDecisionRecord(lane, answer.commandId);
          expect(record, `the decision must be readable back: ${answer.commandId}`).not.toBeNull();
          expect(record?.decision).toBe("REJECT");
          expect(record?.findings).toEqual([{ detail: FINDING_DETAIL, nodeRef: nodeKey }]);

          // NOTHING MOVED. The board's own answer, the preview receipt and the landing roster are
          // BYTE-IDENTICAL across the rejection, and `boardState` has already refused any REWORK
          // spelling in either body.
          expect(await boardState(lane, goalId)).toBe(before);
          // The ONLY thing that moved is the decision record itself: exactly one new entry.
          expect(entries.length, "the rejection added exactly one activity entry")
            .toBe(beforeVerdicts.length + 1);
        } finally {
          if (!decided) {
            await decideLanePreview(lane, preview.receiptId, "APPROVE", undefined, goalId)
              .catch(() => undefined);
          }
        }
      });
      expect(result.ok ? "ok" : `${result.code}: ${result.detail}`).toBe("ok");
    } finally { await assertStopped(started, childPids); }
  });
