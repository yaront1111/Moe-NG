import { describe, expect, it } from "vitest";

import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import { mapReleaseAnswer } from "../../live/live-release.js";
import type { ReleaseOutcome } from "../../live/live-release.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { deriveNeedsYou } from "./needs-you-model.js";

/**
 * The Needs-you derivation over the three daemon answers it reads. Every arm names the
 * ONE fact that puts a decision in the queue, and the negative arms show that the same
 * goal without that fact produces nothing: a plan approval exists only as a daemon OFFER,
 * a Gate 1 item only as a PENDING contract, ready-to-close only as full verification on an
 * open goal.
 */

function catalog(goals: GoalCatalogFrame["goals"]): GoalCatalogFrame {
  return { connection: "CONNECTED", detail: "", goals, outcome: "GOALS" };
}
const entry = (goalId: string, title: string): GoalCatalogFrame["goals"][number] => ({
  binding: null, brief: { instructions: "build", title }, goalId,
  planningRunRef: `run-${goalId}`, truthClass: "DAEMON_VERIFIED",
});
function surface(offers: readonly Record<string, unknown>[]): SurfaceFrame {
  return {
    connection: "CONNECTED", detail: "", offers, outcome: "SURFACE", planningGoalRefs: {}, steps: [],
  };
}
const approvalOffer = (runId: string): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: `cmd-${runId}`,
  commandKind: "approval.decide_intent", expectedVersion: 2,
  inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: runId,
});

/**
 * The daemon's REAL `goal.close` offer, captured verbatim off `POST /affordances/read` on the
 * LIVE UnAI store (project `unai`, 2026-09-05) and re-targeted per arm. Only `targetAggregateId`
 * moves; the other five keys are the recorded bytes.
 *
 * Recorded frame:
 *   {"commandEnvelopeVersion":"moe-runtime-command/1",
 *    "commandId":"c3606f5b-1e81-4b6d-a48d-981ec90d35d8","commandKind":"goal.close",
 *    "expectedVersion":2,"inputSchemaVersion":"moe-bootstrap-command/1",
 *    "targetAggregateId":"goal-c9d9850b-ccef-4c14-8893-a162e3aaf679"}
 *
 * WHY THE REAL BYTES MATTER HERE. `commandId` is a daemon-minted UUID, not the `cmd-<id>` slug a
 * hand-written fixture reaches for, and `resolvePlanningOffers` emits EXACTLY these six keys
 * (affordance-planning-offers.ts, `offer`). An offer carrying a seventh key, or missing one,
 * is not what the browser will ever be handed.
 */
const closeOffer = (goalId: string): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "c3606f5b-1e81-4b6d-a48d-981ec90d35d8",
  commandKind: "goal.close",
  expectedVersion: 2,
  inputSchemaVersion: "moe-bootstrap-command/1",
  targetAggregateId: goalId,
});
function coverage(
  goalId: string, verified: number, criteria: number,
  gate1: "APPROVED" | "PENDING", lifecycle: string,
): DocumentCoverageOutcome {
  return {
    contracts: [{
      contractId: `contract-${goalId}`, gate1, plane: "V1",
      requirements: [{
        criteria: Array.from({ length: criteria }, (_, i) => ({
          criterionId: `crit-${String(i)}`, nodeKey: null, nodeTestStatus: null, statement: "s",
          status: i < verified ? "VERIFIED" as const : "PLANNED" as const,
        })),
        requirementId: "req-1", statement: "r",
      }],
      revisionDigest: "d".repeat(64), revisionId: "rev-1",
    }],
    document: { byteLength: 10, contentSha256: "b".repeat(64), displayPath: "PRD.md" },
    goals: [{ goalId, lastActivityAt: null, lifecycle, planningRunRef: `run-${goalId}`, title: "t" }],
    sections: null,
    status: "COVERAGE",
    totals: { contracts: 1, criteria, goals: 1, planned: criteria - verified, requirements: 1, unattributable: 0, verified },
  };
}

describe("deriveNeedsYou", () => {
  it("waits for the catalog and carries a catalog refusal as the note", () => {
    expect(deriveNeedsYou({ catalog: null, coverage: new Map(), surface: null })).toMatchObject({
      countLabel: "Waiting for goals", items: [],
    });
    const refused = deriveNeedsYou({
      catalog: { connection: "CONNECTED", detail: "GOAL_CATALOG_READ_CAPABILITY_DENIED", goals: [], outcome: "REFUSED" },
      coverage: new Map(), surface: null,
    });
    expect(refused.items).toEqual([]);
    expect(refused.note).toContain("GOAL_CATALOG_READ_CAPABILITY_DENIED");
  });

  it("lists a plan approval only when the daemon offers approval.decide_intent for that run", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-a", "Alpha"), entry("goal-b", "Beta")]),
      coverage: new Map(),
      surface: surface([approvalOffer("run-goal-b")]),
    });
    expect(data.items.map((item) => [item.kind, item.goalId, item.actionLabel])).toEqual([
      ["PLAN_APPROVAL", "goal-b", "Review the plan"],
    ]);
    expect(data.countLabel).toBe("1 decision needs you");
    expect(data.note).toBeNull();
    expect(deriveNeedsYou({
      catalog: catalog([entry("goal-b", "Beta")]), coverage: new Map(),
      surface: surface([{ ...approvalOffer("run-goal-b"), commandKind: "approval.decide" }]),
    }).items).toEqual([]);
  });

  it("lists a Gate 1 item per PENDING contract and a ready-to-close item for a verified open goal", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-p", "Pending"), entry("goal-d", "Done"), entry("goal-c", "Closed")]),
      coverage: new Map([
        ["goal-p", coverage("goal-p", 0, 4, "PENDING", "DRAFT")],
        ["goal-d", coverage("goal-d", 3, 3, "APPROVED", "EXECUTION_ENABLED")],
        ["goal-c", coverage("goal-c", 3, 3, "APPROVED", "COMPLETED")],
      ]),
      surface: surface([]),
    });
    expect(data.items.map((item) => [item.kind, item.goalId])).toEqual([
      ["GATE_1", "goal-p"], ["READY_TO_CLOSE", "goal-d"],
    ]);
    expect(data.items[0]?.detail).not.toContain("contract-goal-p");
    expect(data.items[0]?.detail).toContain("4 acceptance criteria");
    expect(data.items[1]?.detail).toContain("All 3 acceptance criteria verified");
    expect(data.items[1]?.detail).toContain("not offering to close it yet");
    expect(data.items[1]?.close).toBeUndefined();
    expect(data.countLabel).toBe("2 decisions need you");
  });

  it("carries the close decision only when the daemon offers goal.close for that goal", () => {
    const offer = closeOffer("goal-d");
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-d", "Done")]),
      coverage: new Map([["goal-d", coverage("goal-d", 3, 3, "APPROVED", "EXECUTION_ENABLED")]]),
      surface: surface([offer]),
    });
    expect(data.items[0]).toMatchObject({ close: { affordance: offer }, kind: "READY_TO_CLOSE" });
    expect(data.items[0]?.detail).toContain("Close the goal when you are satisfied");
    // The affordance is carried THROUGH, byte for byte: the port spends the daemon's own
    // (commandId, expectedVersion, schema) and a model that rebuilt any of them would spend a
    // command the daemon never offered.
    expect(data.items[0]?.close?.affordance).toBe(offer);
    expect(Object.keys(data.items[0]?.close?.affordance ?? {}).sort()).toEqual([
      "commandEnvelopeVersion", "commandId", "commandKind",
      "expectedVersion", "inputSchemaVersion", "targetAggregateId",
    ]);
  });

  /**
   * THE TWO STATES ON THE SAME COVERAGE. n/n verified is NOT what puts a Close control on the
   * card; the daemon's OFFER is. Both arms below hold coverage at 3/3 and move only the offer,
   * so nothing but the offer can explain the difference.
   *
   * State (b) is the one that matters. The daemon can — and on the live UnAI loop DOES — refuse
   * a close for a goal whose criteria are all verified, so a control that is always live would
   * dispatch straight into a refusal. The honest sentence is the better answer, and this arm
   * exists to stop a later change from replacing it with a button.
   */
  it("offers no close action for an n/n verified goal the daemon is not offering to close", () => {
    const verified = coverage("goal-d", 3, 3, "APPROVED", "EXECUTION_ENABLED");
    const withOffer = deriveNeedsYou({
      catalog: catalog([entry("goal-d", "Done")]),
      coverage: new Map([["goal-d", verified]]),
      surface: surface([closeOffer("goal-d")]),
    });
    const withoutOffer = deriveNeedsYou({
      catalog: catalog([entry("goal-d", "Done")]),
      coverage: new Map([["goal-d", verified]]),
      // A surface carrying a goal.close for a DIFFERENT goal, so the arm proves the offer is
      // matched by target and not merely counted.
      surface: surface([closeOffer("goal-other")]),
    });
    expect(withOffer.items[0]?.kind).toBe("READY_TO_CLOSE");
    expect(withoutOffer.items[0]?.kind).toBe("READY_TO_CLOSE");
    expect(withOffer.items[0]?.close).toBeDefined();
    expect(withoutOffer.items[0]?.close).toBeUndefined();
    expect(withoutOffer.items[0]?.detail)
      .toContain("The daemon is not offering to close it yet; open the goal to see why");
    expect(withoutOffer.items[0]?.detail).not.toContain("Close the goal when you are satisfied");
  });

  /**
   * A CLOSED GOAL LEAVES THE QUEUE ENTIRELY. Not a disabled control, not a spent one: no item,
   * so there is nothing left to click a second time. `OPEN_LIFECYCLES` is what draws this line,
   * and the arm holds the offer PRESENT while moving only the lifecycle — a stale offer left on
   * one poll's surface must not resurrect the decision.
   */
  it("drops the ready-to-close decision once the goal's lifecycle is COMPLETED", () => {
    const closed = deriveNeedsYou({
      catalog: catalog([entry("goal-d", "Done")]),
      coverage: new Map([["goal-d", coverage("goal-d", 3, 3, "APPROVED", "COMPLETED")]]),
      surface: surface([closeOffer("goal-d")]),
    });
    expect(closed.items).toEqual([]);
    expect(closed.countLabel).toBe("0 decisions need you");
  });

  it("orders plans before contracts before closes, then by title", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-z", "Zulu"), entry("goal-a", "Alpha"), entry("goal-m", "Mike")]),
      coverage: new Map([
        ["goal-z", coverage("goal-z", 0, 1, "PENDING", "DRAFT")],
        ["goal-a", coverage("goal-a", 0, 1, "PENDING", "DRAFT")],
      ]),
      surface: surface([approvalOffer("run-goal-m")]),
    });
    expect(data.items.map((item) => `${item.kind}:${item.title}`)).toEqual([
      "PLAN_APPROVAL:Mike", "GATE_1:Alpha", "GATE_1:Zulu",
    ]);
  });

  it("lists an escalation per escalation.decide offer, named through the runs read", () => {
    const offer = {
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-esc-1", commandKind: "escalation.decide",
      expectedVersion: 4, inputSchemaVersion: "moe-review-command/1", targetAggregateId: "execution-node-x",
    };
    const runs: RunsOutcome = {
      goals: [{
        goalId: "goal-a", lifecycle: "EXECUTION_ENABLED",
        nodes: [{
          accepted: null, claim: null, criterionIds: [], dependsOn: [], lastActivityAt: null, nodeKey: "node-x", nodeRef: "execution-node-x",
          objective: "o", landing: null, receipt: null, review: { escalated: false, findings: [], latestRoute: "REJECT_PLAN", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 }, sharedKey: false,
          status: "ESCALATION_REQUIRED",
        }],
        publish: null, run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-goal-a" }, title: "Alpha",
      }],
      status: "RUNS",
      totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 1, IN_PROGRESS: 0, READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: 1 },
    };
    const data = deriveNeedsYou({ catalog: catalog([entry("goal-a", "Alpha")]), coverage: new Map(), runs, surface: surface([offer]) });
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      escalation: { affordance: offer, latestRoute: "REJECT_PLAN", nodeKey: "node-x", unsuccessfulRounds: 3 },
      goalId: "goal-a", kind: "ESCALATION", planningRunRef: "run-goal-a", title: "Alpha",
    });
    expect(data.items[0]?.detail).toBe("o failed review 3 times (last: rejected: same finding again). Allow more attempts, or replan the work into a successor goal that carries these findings.");
    // Without the runs read the node is still listed, named by itself, with no goal to open.
    const bare = deriveNeedsYou({ catalog: catalog([entry("goal-a", "Alpha")]), coverage: new Map(), surface: surface([offer]) });
    expect(bare.items[0]).toMatchObject({ goalId: "", planningRunRef: "", title: "node execution-node-x" });
    expect(bare.items[0]?.detail).toContain("three or more times");
  });

  it("does not invent a decision from partial verification or a refused coverage read", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-h", "Half"), entry("goal-r", "Refused")]),
      coverage: new Map<string, DocumentCoverageOutcome>([
        ["goal-h", coverage("goal-h", 2, 3, "APPROVED", "EXECUTION_ENABLED")],
        ["goal-r", { code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "DOCUMENT_COVERAGE_READ", status: "REFUSED" }],
      ]),
      surface: null,
    });
    expect(data.items).toEqual([]);
    expect(data.note).toContain("offers have not arrived");
  });
});

/**
 * GATE 3 IN THE QUEUE. Two arms carry DoD 4 and they are a pair: an item that appears but
 * never clears is a queue that grows forever, so the disappearance arm is not optional
 * politeness -- it is the half that proves the entry has an exit.
 *
 * WHY THE RECEIPT CLEARS IT AND NOT THE OFFER. `affordance-planning-offers.ts` withholds
 * `release.decide` only where no commit has landed and deliberately withholds NOTHING after
 * that, so the offer OUTLIVES the release. If this derivation keyed on the offer alone the
 * released goal below would still be listed, which is exactly what the second arm catches.
 */

/** The daemon's `release.decide` offer: the same six keys `offer()` mints, targeting the
 *  release aggregate `releaseDossierAggregateId` dictates. */
const releaseOffer = (goalId: string): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "e28f1a90-6f37-4a1c-9a1e-5b7c0f2d4411",
  commandKind: "release.decide",
  expectedVersion: 4,
  inputSchemaVersion: "moe-bootstrap-command/1",
  targetAggregateId: `release:${goalId}`,
});

/** A `/release/read` PRESENT answer, DECODED BY THE PRODUCTION DECODER so a fixture that
 *  drifts from the daemon's exact-key shape fails here instead of propping up a green arm. */
function releaseRead(
  goalId: string,
  unknownCount: number,
  receipt: { outcome: "RELEASED" | "REFUSED"; refusalCode: string | null } | null,
): ReleaseOutcome {
  const criteria = [
    { command: "pnpm test", criterionId: "crit-0", exitCode: "0", gaps: [], landing: "a".repeat(40),
      nodeKey: "node-0", receiptSha: "c".repeat(40), title: "Covered" },
    ...Array.from({ length: unknownCount }, (_, index) => ({
      command: "pnpm test", criterionId: `crit-u${String(index)}`, exitCode: "0",
      gaps: [{ code: "EVIDENCE_UNVERIFIED", criterionId: `crit-u${String(index)}`, detail: "No receipt cites it." }],
      landing: "UNKNOWN", nodeKey: `node-u${String(index)}`, receiptSha: "c".repeat(40), title: "Unmeasured",
    })),
  ];
  const answer = mapReleaseAnswer(200, {
    evidence: {
      ancestryMeasured: true, criteria, goalId, goalTitle: "t", preview: null,
      receipt: receipt === null ? null : {
        dossierSha256: "b".repeat(64), outcome: receipt.outcome,
        prUrl: receipt.outcome === "RELEASED" ? "https://github.com/owner/unai/pull/7" : null,
        receiptId: "release-receipt-1", refusalCode: receipt.refusalCode, sha: "a".repeat(40),
      },
      reviewRounds: [], sha: "a".repeat(40),
    },
    kind: "PRESENT",
  });
  if (answer.status !== "PRESENT") throw new Error(`fixture rejected by mapReleaseAnswer: ${JSON.stringify(answer)}`);
  return answer;
}

describe("deriveNeedsYou and Gate 3", () => {
  it("lists a goal whose evidence is ready, with the UNKNOWN count kept out of covered", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-r", "Releasable")]), coverage: new Map(),
      releases: new Map([["goal-r", releaseRead("goal-r", 2, null)]]),
      surface: surface([releaseOffer("goal-r")]),
    });
    expect(data.items.map((item) => [item.kind, item.goalId])).toEqual([["RELEASE", "goal-r"]]);
    const item = data.items[0];
    if (item === undefined) throw new Error("expected the release item");
    expect(item.headline).toBe("Your work is ready to release and needs your verdict");
    // 1 covered of 3, with the 2 unmeasured named as their own number: an operator reading
    // "3 of 3" in the queue would open the goal already believing the evidence is complete.
    expect(item.detail).toContain("Evidence covered 1 of 3");
    expect(item.detail).toContain("UNKNOWN 2 could not be re-measured");
    expect(item.detail).not.toContain("covered 3 of 3");
    // The offer travels VERBATIM so the release port spends the daemon's own bytes.
    expect(item.release?.affordance).toEqual(releaseOffer("goal-r"));
    expect(item.release).toMatchObject({ covered: 1, sha: "a".repeat(40), total: 3, unknown: 2 });
  });

  it("STOPS listing the goal once a RELEASED receipt exists, even though the offer survives", () => {
    const released = deriveNeedsYou({
      catalog: catalog([entry("goal-r", "Releasable")]), coverage: new Map(),
      releases: new Map([["goal-r", releaseRead("goal-r", 0, { outcome: "RELEASED", refusalCode: null })]]),
      // THE OFFER IS STILL ON THE SURFACE. The daemon keeps offering it, so an item derived
      // from the offer alone would never clear and the queue would grow forever.
      surface: surface([releaseOffer("goal-r")]),
    });
    expect(released.items).toEqual([]);
    expect(released.countLabel).toBe("0 decisions need you");
  });

  it("keeps listing a REFUSED release and names the code that refused it", () => {
    const data = deriveNeedsYou({
      catalog: catalog([entry("goal-r", "Releasable")]), coverage: new Map(),
      releases: new Map([["goal-r",
        releaseRead("goal-r", 1, { outcome: "REFUSED", refusalCode: "RELEASE_EVIDENCE_INCOMPLETE" })]]),
      surface: surface([releaseOffer("goal-r")]),
    });
    expect(data.items.map((item) => item.kind)).toEqual(["RELEASE"]);
    // A refused release is still waiting on a person, and the operator is told WHICH code
    // refused rather than being shown the same "ready to release" line twice.
    expect(data.items[0]?.headline).toBe("A release was refused and needs you again");
    expect(data.items[0]?.detail).toContain("last attempt refused RELEASE_EVIDENCE_INCOMPLETE");
  });

  it("lists nothing without the daemon's offer, and nothing before the read answers", () => {
    const unoffered = deriveNeedsYou({
      catalog: catalog([entry("goal-r", "Releasable")]), coverage: new Map(),
      releases: new Map([["goal-r", releaseRead("goal-r", 0, null)]]),
      surface: surface([]),
    });
    // No offer means the daemon is not accepting the decision: an item here would be a queue
    // entry whose control dispatches into a refusal.
    expect(unoffered.items).toEqual([]);
    const unread = deriveNeedsYou({
      catalog: catalog([entry("goal-r", "Releasable")]), coverage: new Map(),
      surface: surface([releaseOffer("goal-r")]),
    });
    expect(unread.items).toEqual([]);
    const absent = deriveNeedsYou({
      catalog: catalog([entry("goal-r", "Releasable")]), coverage: new Map(),
      releases: new Map<string, ReleaseOutcome>([["goal-r", { goalId: "goal-r", status: "ABSENT" }]]),
      surface: surface([releaseOffer("goal-r")]),
    });
    expect(absent.items).toEqual([]);
  });

  it("ignores another goal's release offer and a differently targeted one", () => {
    const wrongTarget = deriveNeedsYou({
      catalog: catalog([entry("goal-r", "Releasable")]), coverage: new Map(),
      releases: new Map([["goal-r", releaseRead("goal-r", 0, null)]]),
      // The BARE goal id, which `release-decide-command.ts` refuses RELEASE_TARGET_INVALID for.
      surface: surface([{ ...releaseOffer("goal-r"), targetAggregateId: "goal-r" }]),
    });
    expect(wrongTarget.items).toEqual([]);
    const otherGoal = deriveNeedsYou({
      catalog: catalog([entry("goal-r", "Releasable")]), coverage: new Map(),
      releases: new Map([["goal-r", releaseRead("goal-r", 0, null)]]),
      surface: surface([releaseOffer("goal-other")]),
    });
    expect(otherGoal.items).toEqual([]);
  });
});
