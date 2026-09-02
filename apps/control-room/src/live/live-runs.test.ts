import { describe, expect, it } from "vitest";

import { mapRunsAnswer, readRuns } from "./live-runs.js";

/**
 * The runs read client over the exact wire frames POST /runs/read emits (verified against
 * runs-read-contract.ts): a full RUNS frame with every node fact, a goal with no run and no
 * nodes, the route's own refusal, the listener's refusal, and frames whose nested rows drift.
 */

const NODE = Object.freeze({
  accepted: { verifierReceiptId: "receipt-a" },
  claim: { active: false, claimedBy: "sess-wrap-1", expiresAt: "2026-09-02T21:00:00.000Z", status: "RELEASED" },
  criterionIds: ["crit-1"], dependsOn: [], lastActivityAt: "2026-09-02T19:00:00.000Z",
  nodeKey: "node-a", objective: "Keep fields.",
  receipt: { byteCount: 120, exitCode: 0, outputSha256: "o".repeat(64), test: "pnpm test", workspace: "D:/unai" },
  review: { escalated: false, findings: [{ detail: "Fine.", round: 1, ruleId: "rule-1", severity: "MINOR", subject: "NODE node-a" }], latestRoute: "ACCEPT", rounds: 1, unreadable: false, unsuccessfulRounds: 0, version: 3 },
  sharedKey: false,
  status: "ACCEPTED",
});
const GOAL = Object.freeze({
  goalId: "goal-1", lifecycle: "EXECUTION_ENABLED", nodes: [NODE],
  run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-1" }, title: "Build it",
});
const TOTALS = Object.freeze({
  ACCEPTED: 1, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0, IN_PROGRESS: 0, READY: 0,
  UNATTRIBUTABLE: 0, goals: 1, nodes: 1,
});
const RUNS = Object.freeze({ goals: [GOAL], outcome: "RUNS", totals: TOTALS });

const response = (status: number, body: unknown): Response => ({ json: async () => body, status } as unknown as Response);

describe("mapRunsAnswer", () => {
  it("maps a full RUNS frame with every node fact intact", () => {
    expect(mapRunsAnswer(200, RUNS)).toStrictEqual({ goals: [GOAL], status: "RUNS", totals: TOTALS });
  });

  it("keeps a run-less, node-less goal honest", () => {
    const outcome = mapRunsAnswer(200, {
      goals: [{ goalId: "goal-0", lifecycle: "DRAFT", nodes: [], run: null, title: null }],
      outcome: "RUNS", totals: { ...TOTALS, ACCEPTED: 0, nodes: 0 },
    });
    expect(outcome).toMatchObject({ goals: [{ goalId: "goal-0", nodes: [], run: null, title: null }], status: "RUNS" });
  });

  it("carries refusals at their own layer", () => {
    expect(mapRunsAnswer(200, { code: "RUNS_READ_GOAL_UNKNOWN", layer: "RUNS_READ", outcome: "REFUSED" }))
      .toStrictEqual({ code: "RUNS_READ_GOAL_UNKNOWN", layer: "RUNS_READ", status: "REFUSED" });
    expect(mapRunsAnswer(503, { code: "LISTENER_RUNS_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER" }))
      .toStrictEqual({ code: "LISTENER_RUNS_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER", status: "REFUSED" });
  });

  it("reddens the whole answer when a nested row drifts", () => {
    const invalid = { code: "RUNS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_RUNS", status: "ERROR" };
    expect(mapRunsAnswer(500, { unexpected: true })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, outcome: "RUN" })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, status: "DONE" }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, claim: { active: true } }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, receipt: { exitCode: 0 } }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, nodes: [{ ...NODE, review: { ...NODE.review, findings: [{ detail: 1 }] } }] }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, goals: [{ ...GOAL, run: { ...GOAL.run, approval: "MAYBE" } }] })).toStrictEqual(invalid);
    expect(mapRunsAnswer(200, { ...RUNS, totals: { ...TOTALS, extra: 1 } })).toStrictEqual(invalid);
  });
});

describe("readRuns", () => {
  it("posts exactly {} and maps the reply; a transport failure is an ERROR", async () => {
    const bodies: string[] = [];
    const outcome = await readRuns({ "x-moe-csrf": "t" }, async (body) => { bodies.push(body); return response(200, RUNS); });
    expect(bodies).toEqual(["{}"]);
    expect(outcome.status).toBe("RUNS");
    expect(await readRuns({}, async () => { throw new Error("down"); }))
      .toStrictEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_RUNS", status: "ERROR" });
  });
});
