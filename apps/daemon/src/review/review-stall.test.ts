import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { EMPTY_REVIEW_LINEAGE, recordReviewRound } from "@moe/review";
import type { ReviewFinding, ReviewLineage } from "@moe/review";
import { afterEach, describe, expect, it } from "vitest";

import { closeStores as closeBootstrapStores, PROJECT_ID as COMPILED_PROJECT } from "../bootstrap/bootstrap-test-fixtures.js";
import { createRunsReadPort } from "../http/runs-read.js";
import { reviewWorld } from "../orchestrator/wrapper-review-test-fixtures.js";
import type { ReviewOutcome } from "./review-ledger.js";
import type { ReviewRoundRecord } from "./review-read-model.js";
import { readReviewLedger } from "./review-read-model.js";
import { reviewStall } from "./review-stall.js";
import {
  PROJECT_ID, SUBJECT_REF, closeStores, envelope, escalationPayload, finding, hex64, openStore, packageItems, send,
} from "./review-test-fixtures.js";

/**
 * A stalled review requires the human decision at once (addendum 2026-09-15).
 *
 * Measured on UnAI: after its first rejection one node re-verified a byte-identical workspace and
 * filed the same finding in rounds 2, 3, 5, 7, 9 and 11 - each a full seat run - and every
 * "allow one more attempt" bought exactly one more identical round.
 */
const worlds: ReturnType<typeof reviewWorld>[] = [];
afterEach(async () => {
  for (const w of worlds) await w.finishSeat();
  closeStores();
  closeBootstrapStores();
  for (const w of worlds.splice(0)) rmSync(w.workspace, { recursive: true, force: true });
});

type Store = ReturnType<typeof openStore>;
const version = (store: Store) => readReviewLedger(store, PROJECT_ID, SUBJECT_REF).version;
function round(store: Store, findings: readonly Record<string, unknown>[], items = packageItems()): ReviewOutcome {
  const at = version(store);
  return send(store, envelope("review.submit", at, { findings, packageItems: items, round: at + 1, subjectRef: SUBJECT_REF },
    `cmd-round-${String(at + 1)}`));
}
const codeOf = (outcome: ReviewOutcome) => outcome.ok ? "EFFECTS_COMMITTED" : `${outcome.refusedBy}:${outcome.code}`;
const changedTree = () => packageItems().map((item) => item.kind === "INTEGRATED_TREE" ? { ...item, digest: hex64("f2") } : item);

describe("a repeat on an unchanged review input", () => {
  it("requires the decision at the stall instead of spending the third round", () => {
    const store = openStore();
    expect(codeOf(round(store, [finding()]))).toBe("EFFECTS_COMMITTED");
    expect(codeOf(round(store, [finding()]))).toBe("EFFECTS_COMMITTED");

    expect(reviewStall(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds)).toEqual([1, 2]);
    expect(codeOf(round(store, [finding()]))).toBe("DAEMON_PREREQUISITE:REVIEW_ESCALATION_REQUIRED");
  });

  it("admits the decision at the stall, and the allowed round escalates if it repeats again", () => {
    const store = openStore();
    round(store, [finding()]);
    round(store, [finding()]);

    expect(codeOf(send(store, envelope("escalation.decide", version(store), escalationPayload(), "cmd-allow"))))
      .toBe("EFFECTS_COMMITTED");
    expect(codeOf(round(store, [finding()]))).toBe("EFFECTS_COMMITTED");

    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds.at(-1)?.routing.route).toBe("ESCALATE");
  });

  it("keeps the automatic retry when the captured input changed", () => {
    const store = openStore();
    round(store, [finding()]);
    round(store, [finding()], changedTree());

    expect(reviewStall(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).rounds)).toEqual([]);
    expect(codeOf(round(store, [finding()], changedTree()))).toBe("EFFECTS_COMMITTED");
  });

  it("keeps the automatic retry when the findings changed", () => {
    const store = openStore();
    round(store, [finding()]);
    round(store, [finding({ ruleId: "rule-other" })]);

    expect(codeOf(round(store, [finding()]))).toBe("EFFECTS_COMMITTED");
  });
});

describe("what a stall is measured on", () => {
  const OWN: ReviewFinding = { detail: "own gap", ruleId: "own", severity: "MAJOR", subject: { kind: "NODE", locator: "n" } };
  const FOREIGN = (nodeKey: string): ReviewFinding => ({ attributedTo: { criterionIds: ["c-1"], nodeKey }, detail: "foreign",
    ruleId: "foreign", severity: "MAJOR", subject: { kind: "ARTIFACT", locator: "ci.yml" } });
  function rounds(shapes: ReadonlyArray<readonly [readonly ReviewFinding[], string]>): ReviewRoundRecord[] {
    let lineage: ReviewLineage = EMPTY_REVIEW_LINEAGE;
    return shapes.map(([findings, digest], index) => {
      const result = recordReviewRound(lineage, { findings, round: index + 1 });
      if (!result.ok) throw new Error(result.code);
      lineage = result.value.lineage;
      return { lineage, reviewInputDigest: digest, round: index + 1, routing: result.value.routing } as unknown as ReviewRoundRecord;
    });
  }

  it("ignores attributed findings on both sides", () => {
    expect(reviewStall(rounds([[[OWN, FOREIGN("a")], "d"], [[OWN, FOREIGN("b")], "d"]]))).toEqual([1, 2]);
  });

  it("never counts a round with only attributed findings as stalled", () => {
    expect(reviewStall(rounds([[[FOREIGN("a")], "d"], [[FOREIGN("a")], "d"]]))).toEqual([]);
  });

  it("reports the whole consecutive run", () => {
    expect(reviewStall(rounds([[[OWN], "a"], [[OWN], "b"], [[OWN], "b"], [[OWN], "b"]]))).toEqual([2, 3, 4]);
  });
});

describe("a stalled compiled node", () => {
  const GAP = [{ ruleId: "api-incomplete", detail: "Still missing; no product answer arrived.", severity: "MAJOR",
    subject: { kind: "NODE", locator: "node-slice" } }];
  async function stalledWorld() {
    const w = reviewWorld(); worlds.push(w);
    for (let at = 0; at < 2; at += 1) {
      expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
      expect(await w.dispatch(w.requests.at(-1)!, "review.submit", { subjectRef: w.nodeRef, round: at + 1,
        packageItems: [], findings: GAP }, at)).toMatchObject({ ok: true });
      await w.finishSeat();
    }
    return w;
  }
  const decide = (w: ReturnType<typeof reviewWorld>, extra: Record<string, unknown> = {}) => send(w.store, {
    ...envelope("escalation.decide", readReviewLedger(w.store, COMPILED_PROJECT, w.nodeRef).version,
      { decision: "ALLOW_MORE_ATTEMPTS", escalationRef: w.nodeRef, subjectRef: w.nodeRef, ...extra }, randomUUID()),
    projectId: COMPILED_PROJECT });

  it("is not staffed again and shows as needing a decision", async () => {
    const w = await stalledWorld();

    expect((await w.wrapper.runOnce()).spawned).toEqual([]);
    const view = createRunsReadPort({ projectId: COMPILED_PROJECT, store: w.store }).readRuns({});
    if (!("goals" in view)) throw new Error("runs read refused");
    const node = view.goals.flatMap((goal) => goal.nodes).find((row) => row.nodeRef === w.nodeRef);
    expect(node?.status).toBe("ESCALATION_REQUIRED");
  });

  it("needs new instructions before one more attempt", async () => {
    const w = await stalledWorld();

    expect(codeOf(decide(w))).toBe("DAEMON_PREREQUISITE:REVIEW_STALL_GUIDANCE_REQUIRED");
    expect(codeOf(decide(w, { implementationGuidance: "Use the approved server-session design." }))).toBe("EFFECTS_COMMITTED");
    expect((await w.wrapper.runOnce()).spawned).toMatchObject([{ outcome: "SPAWNED" }]);
  });
});
