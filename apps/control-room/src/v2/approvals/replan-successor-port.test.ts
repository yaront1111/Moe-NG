import { describe, expect, it } from "vitest";
import type { RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import type { NeedsYouItem } from "./needs-you-model.js";
import { replanInstructions } from "./replan-successor-port.js";

const node = (nodeRef: string, detail: string): RunNodeView => ({
  accepted: null, claim: null, criterionIds: [], dependsOn: [], landing: null, lastActivityAt: null,
  nodeKey: "api", nodeRef, objective: "Implement API", receipt: null,
  review: { escalated: true, findings: [{ detail, round: 3, ruleId: "check", severity: "MAJOR", subject: "API" }],
    latestRoute: "REJECT_PLAN", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 },
  sharedKey: false, status: "REPLANNED",
});

describe("replan scoped source", () => {
  it("carries only the exhausted execution's findings when goals reuse local node names", () => {
    const item: NeedsYouItem = {
      actionLabel: "Open", detail: "", escalation: { affordance: { targetAggregateId: "execution-own" },
        latestRoute: "REJECT_PLAN", nodeKey: "api", unsuccessfulRounds: 3 },
      goalId: "goal-own", headline: "Replan", kind: "ESCALATION", planningRunRef: "run-own", title: "Own",
    };
    const runs: RunsOutcome = {
      status: "RUNS", goals: [
        { goalId: "goal-other", lifecycle: "EXECUTION_ENABLED", nodes: [node("execution-other", "FOREIGN FINDING")], publish: null, run: null, title: "Other" },
        { goalId: "goal-own", lifecycle: "EXECUTION_ENABLED", nodes: [node("execution-own", "OWN FINDING")], publish: null, run: null, title: "Own" },
      ], totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 0,
        IN_PROGRESS: 0, READY: 0, REPLANNED: 2, UNATTRIBUTABLE: 0, goals: 2, nodes: 2 },
    };
    const instructions = replanInstructions(item, runs);
    expect(instructions).toContain("OWN FINDING");
    expect(instructions).not.toContain("FOREIGN FINDING");
  });
});
