import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { LiveSetup } from "../../live/live-config.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { LiveNeedsYou } from "./live-needs-you.js";

/**
 * The live queue over a stubbed wire: the affordance surface and the goal catalog answer
 * over fetch, coverage through the injected reader. The arm proves each source lands as a
 * card and that the count handed to the shell equals the cards on screen.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const SETUP = {
  client: { commands: {} }, headers: { authorization: "Bearer live" }, ok: true,
  projectId: "project-live-1", projection: "moe.board", sessionCredential: "cred-live-1",
  subscriberId: "control-room-1", transport: { sendCommand: vi.fn() },
} as unknown as LiveSetup;

const CATALOG = {
  goals: [
    { brief: { instructions: "i", title: "Plan me" }, goalId: "goal-plan", planningRunRef: "run-plan", truthClass: "DAEMON_VERIFIED" },
    { brief: { instructions: "i", title: "Gate me" }, goalId: "goal-gate", planningRunRef: "run-gate", truthClass: "DAEMON_VERIFIED" },
  ],
  nextCursor: null, outcome: "GOALS",
};
const SURFACE = {
  nextAllowedCommands: [{
    commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-approve-plan",
    commandKind: "approval.decide_intent", expectedVersion: 3,
    inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "run-plan",
  }],
  outcome: "SURFACE", planningGoalRefs: { "run-plan": "goal-plan" }, steps: [],
};

function stubWire(): void {
  vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
    if (path === "/affordances/read") return { json: async () => SURFACE, status: 200 } as unknown as Response;
    if (path === "/goals/read") return { json: async () => CATALOG, status: 200 } as unknown as Response;
    throw new Error(`unexpected fetch path ${path}`);
  }));
}

const gatePending: DocumentCoverageOutcome = {
  contracts: [{ contractId: "contract-gate", gate1: "PENDING", requirements: [], revisionDigest: "d".repeat(64), revisionId: "rev-1" }],
  document: { byteLength: 1, contentSha256: "b".repeat(64), displayPath: "PRD.md" },
  goals: [{ goalId: "goal-gate", lastActivityAt: null, lifecycle: "DRAFT", planningRunRef: "run-gate", title: "Gate me" }],
  sections: null, status: "COVERAGE",
  totals: { contracts: 1, criteria: 0, goals: 1, planned: 0, requirements: 0, verified: 0 },
};

describe("LiveNeedsYou", () => {
  it("lists the offered plan approval and the pending contract, and reports the count", async () => {
    stubWire();
    const onCount = vi.fn();
    const readCoverage = vi.fn(async (goalId: string): Promise<DocumentCoverageOutcome> =>
      goalId === "goal-gate" ? gatePending
        : { code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "DOCUMENT_COVERAGE_READ", status: "REFUSED" });
    render(<LiveNeedsYou onCount={onCount} onOpenBoard={vi.fn()} readCoverage={readCoverage} setup={SETUP} />);
    await waitFor(() => {
      expect(screen.getByTestId("cr.needsyou.item.plan-approval.goal-plan")).toBeTruthy();
      expect(screen.getByTestId("cr.needsyou.item.gate-1.goal-gate")).toBeTruthy();
    });
    expect(screen.getByTestId("cr.needsyou.count").textContent).toBe("2 DECISIONS · NEEDS YOU");
    expect(onCount).toHaveBeenLastCalledWith(2);
    expect(readCoverage).toHaveBeenCalledWith("goal-plan");
    expect(readCoverage).toHaveBeenCalledWith("goal-gate");
  });

  it("spends the daemon's escalation offer through the port and shows the answer", async () => {
    stubWire();
    const offer = {
      commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-esc", commandKind: "escalation.decide",
      expectedVersion: 4, inputSchemaVersion: "moe-review-command/1", targetAggregateId: "node-x",
    };
    vi.stubGlobal("fetch", vi.fn(async (path: string): Promise<Response> => {
      if (path === "/affordances/read") return { json: async () => ({ ...SURFACE, nextAllowedCommands: [offer] }), status: 200 } as unknown as Response;
      if (path === "/goals/read") return { json: async () => CATALOG, status: 200 } as unknown as Response;
      throw new Error(`unexpected fetch path ${path}`);
    }));
    const runs: RunsOutcome = {
      goals: [{ goalId: "goal-plan", lifecycle: "EXECUTION_ENABLED", nodes: [{
        accepted: null, claim: null, criterionIds: [], dependsOn: [], lastActivityAt: null, nodeKey: "node-x", objective: "o",
        review: { escalated: false, latestRoute: "REJECT_PLAN", rounds: 3, unreadable: false, unsuccessfulRounds: 3, version: 4 },
        status: "ESCALATION_REQUIRED" }], run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-plan" }, title: "Plan me" }],
      status: "RUNS",
      totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: 1, IN_PROGRESS: 0, READY: 0, goals: 1, nodes: 1 },
    };
    const submit = vi.fn(async () => ({ commandId: "cmd-esc", ok: true as const }));
    render(<LiveNeedsYou escalationPort={{ submit }} onOpenBoard={vi.fn()} readRuns={async () => runs} setup={SETUP} />);
    const button = await screen.findByTestId("cr.needsyou.escalate.node-x");
    expect(screen.getByTestId("cr.needsyou.item.escalation.node-x").textContent).toContain("Plan me");
    button.click();
    await waitFor(() => { expect(screen.getByTestId("cr.needsyou.result.node-x").textContent).toContain("Allowed."); });
    expect(submit).toHaveBeenCalledWith(offer, "node-x");
  });

  it("shows an honest empty queue without a coverage reader", async () => {
    stubWire();
    render(<LiveNeedsYou onOpenBoard={vi.fn()} setup={SETUP} />);
    await screen.findByTestId("cr.needsyou.item.plan-approval.goal-plan");
    expect(screen.queryByTestId("cr.needsyou.item.gate-1.goal-gate")).toBeNull();
    expect(screen.getByTestId("cr.needsyou.count").textContent).toBe("1 DECISION · NEEDS YOU");
  });
});
