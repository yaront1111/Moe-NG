import { describe, expect, it } from "vitest";

import { RUN_NODE_STATUSES } from "../../live/live-runs.js";
import type { RunNodeStatus, RunNodeView } from "../../live/live-runs.js";
import {
  BOARD_COLUMNS, cardLine, columnOf, foldBoard, isStuck, nodesLine, untilWords,
} from "./board-columns.js";

const NOW = Date.parse("2026-09-04T08:00:00.000Z");

function node(status: RunNodeStatus, extra: Partial<RunNodeView> = {}): RunNodeView {
  return {
    accepted: null, claim: null, criterionIds: [], dependsOn: [], landing: null, lastActivityAt: null,
    nodeKey: `node-${status.toLowerCase()}`, nodeRef: `execution-${status.toLowerCase()}`, objective: `Objective for ${status}`, receipt: null,
    review: { escalated: false, findings: [], latestRoute: null, rounds: 0, unreadable: false, unsuccessfulRounds: 0, version: 0 },
    sharedKey: false, status, ...extra,
  };
}

describe("columnOf", () => {
  it("folds every daemon status into the six pipeline columns a person reads", () => {
    const seen = new Set<string>();
    for (const status of RUN_NODE_STATUSES) {
      const column = columnOf(node(status));
      expect(BOARD_COLUMNS).toContain(column);
      seen.add(column);
    }
    expect(columnOf(node("READY"))).toBe("PLANNED");
    expect(columnOf(node("IN_PROGRESS"))).toBe("WORKING");
    expect(columnOf(node("DELIVERED"))).toBe("REVIEW");
    expect(columnOf(node("ACCEPTED"))).toBe("VERIFIED");
    expect(columnOf(node("ACCEPTED", {
      landing: { branch: "master", code: null, files: ["a.ts"], outcome: "COMMITTED", sha: "4f2a91cdabcdef" },
    }))).toBe("LANDED");
    expect(columnOf(node("ACCEPTED", {
      landing: { branch: "master", code: null, files: ["a.ts"], outcome: "COMMITTED", sha: "a".repeat(40) },
    }), "a".repeat(40))).toBe("PUBLISHED");
  });

  it("keeps sent-back work in Planned and exhausted reviews in Review, marked stuck", () => {
    const rework = node("READY", {
      review: { ...node("READY").review, latestRoute: "REJECT_IMPLEMENTATION", rounds: 2, unsuccessfulRounds: 2 },
    });
    expect(columnOf(rework)).toBe("PLANNED");
    expect(isStuck(rework)).toBe(true);
    expect(columnOf(node("ESCALATION_REQUIRED"))).toBe("REVIEW");
    expect(isStuck(node("ESCALATION_REQUIRED"))).toBe(true);
    expect(isStuck(node("READY"))).toBe(false);
    expect(isStuck(node("ACCEPTED"))).toBe(false);
  });

  it("folds ledger-stop statuses into Planned as stuck, not a seventh column", () => {
    for (const status of ["BLOCKED", "REPLANNED", "UNATTRIBUTABLE"] as const) {
      expect(columnOf(node(status))).toBe("PLANNED");
      expect(isStuck(node(status))).toBe(true);
    }
    expect(columnOf(node("ESCALATED"))).toBe("REVIEW");
  });
});

describe("cardLine", () => {
  it("states one fact per column in a person's words, never a hash or enum", () => {
    expect(cardLine(node("READY"), "PLANNED", NOW)).toBe("ready for an agent");
    expect(cardLine(node("READY", { dependsOn: ["n-1", "n-2"] }), "PLANNED", NOW)).toBe("waiting on other work");
    const working = node("IN_PROGRESS", {
      claim: { active: true, claimedBy: "sess-wrap-abc", expiresAt: "2026-09-04T08:12:00.000Z", status: "OPEN" },
      lastActivityAt: "2026-09-04T07:45:00.000Z",
    });
    expect(cardLine(working, "WORKING", NOW)).toBe("an agent seat · lease ends in 12 min");
    expect(cardLine(node("DELIVERED", { lastActivityAt: "2026-09-04T07:58:00.000Z" }), "REVIEW", NOW))
      .toBe("delivered 2 min ago · waiting on the verifier");
    const rework = node("READY", {
      review: { ...node("READY").review, latestRoute: "REJECT_IMPLEMENTATION", rounds: 2, unsuccessfulRounds: 2 },
    });
    expect(cardLine(rework, "PLANNED", NOW)).toBe("sent back ×2 · rejected: implementation");
    expect(cardLine(node("ACCEPTED"), "VERIFIED", NOW)).toBe("verified");
    expect(cardLine(node("ACCEPTED", {
      landing: { branch: "master", code: null, files: ["a.ts"], outcome: "COMMITTED", sha: "4f2a91cdabcdef" },
    }), "LANDED", NOW)).toBe("landed on the workspace branch");
    expect(cardLine(node("ACCEPTED", {
      landing: { branch: null, code: "LANDING_BASELINE_MISSING", files: [], outcome: "REFUSED", sha: null },
    }), "VERIFIED", NOW)).toBe("verified · not landed yet");
    expect(cardLine(node("ACCEPTED", {
      landing: { branch: "master", code: null, files: ["a.ts"], outcome: "COMMITTED", sha: "4f2a91cdabcdef" },
    }), "PUBLISHED", NOW)).toBe("published");
    expect(cardLine(node("ESCALATION_REQUIRED"), "REVIEW", NOW)).toBe("every review attempt used; needs your decision");
    expect(cardLine(node("REPLANNED"), "PLANNED", NOW)).toBe("replanned into a successor goal");
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
  it("counts every pipeline column, names the stuck ones, and carries the top finding only on stuck cards", () => {
    const finding = { detail: "the ledger drops the second anchor", round: 1, ruleId: "R1", severity: "HIGH", subject: "evidence" };
    const fold = foldBoard([
      node("ACCEPTED", {
        nodeKey: "a",
        landing: { branch: "master", code: null, files: ["a.ts"], outcome: "COMMITTED", sha: "4f2a91cdabcdef" },
      }),
      node("IN_PROGRESS", { nodeKey: "b" }),
      node("READY", { nodeKey: "c" }),
      node("READY", { nodeKey: "d", review: { ...node("READY").review, findings: [finding], latestRoute: "REJECT_IMPLEMENTATION", rounds: 1, unsuccessfulRounds: 1 } }),
      node("ESCALATION_REQUIRED", { nodeKey: "e", review: { ...node("READY").review, findings: [finding], rounds: 3, unsuccessfulRounds: 3 } }),
      node("DELIVERED", { nodeKey: "f" }),
    ], NOW);
    expect(fold.counts).toEqual({
      LANDED: 1, PLANNED: 2, PUBLISHED: 0, REVIEW: 2, VERIFIED: 0, WORKING: 1,
    });
    expect(fold.total).toBe(6);
    expect(fold.stuck).toBe(2);
    expect(fold.cards.PLANNED.find((card) => card.node.nodeKey === "d")?.finding).toBe(finding.detail);
    expect(fold.cards.REVIEW.find((card) => card.node.nodeKey === "e")?.finding).toBe(finding.detail);
    expect(fold.cards.LANDED[0]?.finding).toBeNull();
    expect(nodesLine(fold)).toBe("6 nodes · 1 landed · 1 working · 2 stuck");
    expect(Object.isFrozen(fold.cards.PLANNED)).toBe(true);
  });

  it("publishes only the node whose landing matches the pushed commit", () => {
    const landed = node("ACCEPTED", {
      nodeKey: "published-node",
      landing: { branch: "master", code: null, files: ["a.ts"], outcome: "COMMITTED", sha: "a".repeat(40) },
    });
    const later = node("ACCEPTED", {
      nodeKey: "later-node",
      landing: { branch: "master", code: null, files: ["b.ts"], outcome: "COMMITTED", sha: "b".repeat(40) },
    });
    const fold = foldBoard([landed, later], NOW, "a".repeat(40));
    expect(fold.counts.PUBLISHED).toBe(1);
    expect(fold.counts.LANDED).toBe(1);
    expect(fold.cards.PUBLISHED.map((card) => card.node.nodeKey)).toEqual(["published-node"]);
    expect(fold.cards.LANDED.map((card) => card.node.nodeKey)).toEqual(["later-node"]);
    expect(fold.cards.PUBLISHED[0]?.line).toBe("published");
  });

  it.each([null, "", "abc", "g".repeat(40)])("keeps missing or incomplete matching SHA %s in Landed", (sha) => {
    const landed = node("ACCEPTED", {
      landing: { branch: "main", code: null, files: ["a.ts"], outcome: "COMMITTED", sha },
    });
    expect(columnOf(landed, sha)).toBe("LANDED");
  });

  it("recognizes a complete matching SHA-256 commit", () => {
    const landed = node("ACCEPTED", {
      landing: { branch: "main", code: null, files: ["a.ts"], outcome: "COMMITTED", sha: "a".repeat(64) },
    });
    expect(columnOf(landed, "a".repeat(64))).toBe("PUBLISHED");
  });

  it("speaks a single node without a plural and without empty counts", () => {
    expect(nodesLine(foldBoard([node("IN_PROGRESS")], NOW))).toBe("1 node · 1 working");
  });
});
