import { describe, expect, it } from "vitest";

import { RUN_NODE_STATUSES } from "../../live/live-runs.js";
import type { RunNodeStatus, RunNodeView } from "../../live/live-runs.js";
import { BOARD_COLUMNS, cardLine, columnOf, foldBoard, nodesLine, untilWords } from "./board-columns.js";

const NOW = Date.parse("2026-09-04T08:00:00.000Z");

function node(status: RunNodeStatus, extra: Partial<RunNodeView> = {}): RunNodeView {
  return {
    accepted: null, claim: null, criterionIds: [], dependsOn: [], landing: null, lastActivityAt: null,
    nodeKey: `node-${status.toLowerCase()}`, objective: `Objective for ${status}`, receipt: null,
    review: { escalated: false, findings: [], latestRoute: null, rounds: 0, unreadable: false, unsuccessfulRounds: 0, version: 0 },
    sharedKey: false, status, ...extra,
  };
}

describe("columnOf", () => {
  it("folds every one of the daemon's nine statuses into exactly one of the six columns", () => {
    const seen = new Set<string>();
    for (const status of RUN_NODE_STATUSES) {
      const column = columnOf(node(status));
      expect(BOARD_COLUMNS).toContain(column);
      seen.add(column);
    }
    // READY splits by rounds, so the plain sweep reaches five columns; REWORK needs a round.
    expect(seen.size).toBe(5);
    expect(columnOf(node("READY", { review: { ...node("READY").review, latestRoute: "REJECT_IMPLEMENTATION", rounds: 2, unsuccessfulRounds: 2 } }))).toBe("REWORK");
  });

  it("splits READY on whether a review round exists, which the daemon itself conflates", () => {
    expect(columnOf(node("READY"))).toBe("QUEUED");
    expect(columnOf(node("READY", { review: { ...node("READY").review, rounds: 1, unsuccessfulRounds: 1 } }))).toBe("REWORK");
  });

  it("folds the five stop statuses into BLOCKED", () => {
    for (const status of ["BLOCKED", "ESCALATED", "ESCALATION_REQUIRED", "REPLANNED", "UNATTRIBUTABLE"] as const) {
      expect(columnOf(node(status))).toBe("BLOCKED");
    }
  });
});

describe("cardLine", () => {
  it("states one fact per column, in a person's words", () => {
    expect(cardLine(node("READY"), "QUEUED", NOW)).toBe("ready for an agent");
    expect(cardLine(node("READY", { dependsOn: ["n-1", "n-2"] }), "QUEUED", NOW)).toBe("after n-1, n-2");
    const working = node("IN_PROGRESS", {
      claim: { active: true, claimedBy: "sess-wrap-abc", expiresAt: "2026-09-04T08:12:00.000Z", status: "OPEN" },
      lastActivityAt: "2026-09-04T07:45:00.000Z",
    });
    expect(cardLine(working, "WORKING", NOW)).toBe("an agent seat · lease ends in 12 min");
    expect(cardLine(node("DELIVERED", { lastActivityAt: "2026-09-04T07:58:00.000Z" }), "REVIEW", NOW))
      .toBe("delivered 2 min ago · waiting on the verifier");
    const rework = node("READY", { review: { ...node("READY").review, latestRoute: "REJECT_IMPLEMENTATION", rounds: 2, unsuccessfulRounds: 2 } });
    expect(cardLine(rework, "REWORK", NOW)).toBe("sent back ×2 · rejected: implementation");
    expect(cardLine(node("ACCEPTED"), "DONE", NOW)).toBe("verified");
    expect(cardLine(node("ACCEPTED", { landing: { branch: "master", code: null, files: ["a.ts"], outcome: "COMMITTED", sha: "4f2a91cdabcdef" } }), "DONE", NOW))
      .toBe("verified · committed 4f2a91cd");
    expect(cardLine(node("ACCEPTED", { landing: { branch: null, code: "LANDING_BASELINE_MISSING", files: [], outcome: "REFUSED", sha: null } }), "DONE", NOW))
      .toBe("verified · not committed: LANDING_BASELINE_MISSING");
    expect(cardLine(node("ESCALATION_REQUIRED"), "BLOCKED", NOW)).toBe("every review attempt used; needs your decision");
    expect(cardLine(node("REPLANNED"), "BLOCKED", NOW)).toBe("replanned into a successor goal");
  });

  it("marks a second attempt on a WORKING card and an expired lease plainly", () => {
    const retry = node("IN_PROGRESS", {
      claim: { active: true, claimedBy: "sess-wrap-abc", expiresAt: "2026-09-04T07:00:00.000Z", status: "OPEN" },
      review: { ...node("IN_PROGRESS").review, latestRoute: "REJECT_PLAN", rounds: 1, unsuccessfulRounds: 1 },
    });
    expect(cardLine(retry, "WORKING", NOW)).toBe("an agent seat · lease expired · retry 2");
  });
});

describe("untilWords", () => {
  it("speaks minutes, hours and days ahead, and null once the instant has passed", () => {
    expect(untilWords("2026-09-04T08:05:00.000Z", NOW)).toBe("in 5 min");
    expect(untilWords("2026-09-04T11:00:00.000Z", NOW)).toBe("in 3 h");
    expect(untilWords("2026-09-06T08:00:00.000Z", NOW)).toBe("in 2 d");
    expect(untilWords("2026-09-04T07:59:00.000Z", NOW)).toBeNull();
    expect(untilWords("not an instant", NOW)).toBeNull();
  });
});

describe("foldBoard", () => {
  it("counts every column, names the stuck ones, and carries the top finding only where why is the next question", () => {
    const finding = { detail: "the ledger drops the second anchor", round: 1, ruleId: "R1", severity: "HIGH", subject: "evidence" };
    const fold = foldBoard([
      node("ACCEPTED", { nodeKey: "a" }),
      node("IN_PROGRESS", { nodeKey: "b" }),
      node("READY", { nodeKey: "c" }),
      node("READY", { nodeKey: "d", review: { ...node("READY").review, findings: [finding], latestRoute: "REJECT_IMPLEMENTATION", rounds: 1, unsuccessfulRounds: 1 } }),
      node("ESCALATION_REQUIRED", { nodeKey: "e", review: { ...node("READY").review, findings: [finding], rounds: 3, unsuccessfulRounds: 3 } }),
      node("DELIVERED", { nodeKey: "f" }),
    ], NOW);
    expect(fold.counts).toEqual({ BLOCKED: 1, DONE: 1, QUEUED: 1, REVIEW: 1, REWORK: 1, WORKING: 1 });
    expect(fold.total).toBe(6);
    expect(fold.stuck).toBe(2);
    expect(fold.cards.REWORK[0]?.finding).toBe(finding.detail);
    expect(fold.cards.BLOCKED[0]?.finding).toBe(finding.detail);
    expect(fold.cards.DONE[0]?.finding).toBeNull();
    expect(nodesLine(fold)).toBe("6 nodes · 1 done · 2 working · 2 stuck");
    expect(Object.isFrozen(fold.cards.QUEUED)).toBe(true);
  });

  it("speaks a single node without a plural and without empty counts", () => {
    expect(nodesLine(foldBoard([node("IN_PROGRESS")], NOW))).toBe("1 node · 1 working");
  });
});
