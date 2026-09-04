import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SurfaceFrame, SurfaceStep } from "../../live/live-board-feed.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import { ProviderPauseProvider } from "../shell/pause-context.js";
import type { ProviderPause } from "../shell/pause-context.js";
import { deriveGoalStatus } from "./goal-status.js";
import { GoalStatusStrip, LiveGoalStatus } from "./goal-status-strip.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const GOAL = "goal-1";
const RUN = "run-1";

function coverage(overrides: {
  readonly gate1?: "APPROVED" | "PENDING"; readonly lifecycle?: string | null; readonly verified?: number; readonly contracts?: number;
} = {}): DocumentCoverageOutcome {
  const contracts = overrides.contracts ?? 1;
  return {
    contracts: Array.from({ length: contracts }, (_, index) => ({
      contractId: `c-${String(index)}`, gate1: overrides.gate1 ?? "APPROVED", plane: "V1", requirements: [{
        criteria: ["n1", "n2"].map((nodeKey) => ({ criterionId: `crit-${nodeKey}`, nodeKey, statement: "s", status: "PLANNED" as const })),
        requirementId: "req-1", statement: "r",
      }], revisionDigest: "d", revisionId: "r",
    })),
    document: { byteLength: 10, contentSha256: "a".repeat(64), displayPath: "PRD.md" },
    goals: [{ goalId: GOAL, lastActivityAt: null, lifecycle: overrides.lifecycle ?? "EXECUTION_ENABLED", planningRunRef: RUN, title: "Alpha" }],
    sections: null, status: "COVERAGE",
    totals: { contracts, criteria: 4, goals: 1, planned: 0, requirements: 2, unattributable: 0, verified: overrides.verified ?? 2 },
  };
}

function node(key: string, status: SurfaceStep["status"], extra: Partial<SurfaceStep> = {}): SurfaceStep {
  return { aggregateId: key, claim: null, kind: "node.deliver", missing: [], status, version: 1, ...extra };
}

function surface(offers: readonly Record<string, unknown>[], steps: readonly SurfaceStep[] = []): SurfaceFrame {
  return { connection: "CONNECTED", detail: "", offers, outcome: "SURFACE", steps };
}

const PAUSE: ProviderPause = {
  lastLine: "Claude usage limit reached. Your limit will reset at 11:30 (UTC).",
  provider: "claude", resetAt: "2026-09-03T11:30:00.000Z", since: "2026-09-03T10:00:00.000Z",
  workItemId: "node.deliver@n2",
};
// Spelled out, never built by calling the production formatter: an expectation that calls
// `pauseResetWords` would pass for any output it returns. Only the locale call is shared,
// which is the point - this box's locale must not decide the arm.
const WAITING = `Waiting for the provider limit to reset at ${new Date("2026-09-03T11:30:00.000Z").toLocaleString()}`;
const WORKING_STEPS: readonly SurfaceStep[] = [
  node("n1", "COMMITTED"), node("n2", "READY", { claim: { claimedBy: "sess-wrap-1", expiresAt: "2026-09-03T11:00:00.000Z" } }),
];

describe("deriveGoalStatus", () => {
  it("walks the stages in the order a goal moves through them", () => {
    expect(deriveGoalStatus({ coverage: { code: "DOCUMENT_COVERAGE_READ_GOAL_UNBOUND", layer: "L", status: "REFUSED" }, goalId: GOAL, runId: RUN, surface: null }))
      .toMatchObject({ next: { anchor: "plan" }, stage: "NO_PRD" });
    expect(deriveGoalStatus({ coverage: coverage({ gate1: "PENDING" }), goalId: GOAL, runId: RUN, surface: null }))
      .toMatchObject({ next: { anchor: "contract", label: "Review the contract" }, stage: "CONTRACT" });
    const planOffer = surface([{ commandKind: "approval.decide_intent", targetAggregateId: RUN }]);
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, runId: RUN, surface: planOffer }))
      .toMatchObject({ next: { anchor: "plan" }, stage: "PLAN" });
    const exhausted = surface(
      [{ commandKind: "escalation.decide", targetAggregateId: "n2" }],
      [node("n1", "COMMITTED"), node("n2", "BLOCKED", { missing: ["escalation"] })],
    );
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, runId: RUN, surface: exhausted }))
      .toMatchObject({ agents: { accepted: 1, blocked: 1, total: 2, working: 0 }, headline: "1 node has used every review attempt.", stage: "ESCALATION" });
    const replanned = surface([], [node("n1", "COMMITTED"), node("n2", "BLOCKED", { missing: ["replan"] })]);
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, runId: RUN, surface: replanned }))
      .toMatchObject({ agents: { accepted: 1, blocked: 0, replanned: 1, total: 2, working: 0 }, headline: "1 node was replanned into a successor goal.", next: { anchor: "board" }, stage: "REPLANNED" });
    const working = surface([], [node("n1", "COMMITTED"), node("n2", "READY", { claim: { claimedBy: "sess-wrap-1", expiresAt: "2026-09-03T11:00:00.000Z" } })]);
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, runId: RUN, surface: working }))
      .toMatchObject({ headline: "Agents are working: 1 of 2 nodes accepted.", next: { anchor: "board" }, progress: { criteria: 4, verified: 2 }, stage: "WORKING" });
    const done = surface([{ commandKind: "goal.close", targetAggregateId: GOAL }], [node("n1", "COMMITTED")]);
    expect(deriveGoalStatus({ coverage: coverage({ verified: 4 }), goalId: GOAL, runId: RUN, surface: done }))
      .toMatchObject({ next: { anchor: "needs-you", label: "Close the goal" }, stage: "READY_TO_CLOSE" });
    expect(deriveGoalStatus({ coverage: coverage({ verified: 4 }), goalId: GOAL, runId: RUN, surface: surface([], [node("n1", "COMMITTED")]) }))
      .toMatchObject({ next: { label: "Read the board" }, stage: "READY_TO_CLOSE" });
    expect(deriveGoalStatus({ coverage: coverage({ lifecycle: "COMPLETED", verified: 4 }), goalId: GOAL, runId: RUN, surface: null }))
      .toMatchObject({ stage: "CLOSED" });
    expect(deriveGoalStatus({ coverage: null, goalId: GOAL, runId: RUN, surface: null })).toMatchObject({ next: { anchor: null }, stage: "UNKNOWN" });
  });

  it("tells a WORKING goal to wait for the provider limit, naming the reset and the seat's work item", () => {
    const working = surface([], WORKING_STEPS);
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, paused: PAUSE, runId: RUN, surface: working }))
      .toMatchObject({
        headline: "Agents are working: 1 of 2 nodes accepted.",
        next: {
          anchor: "board",
          detail: "The claude seat hit its limit on node.deliver@n2; the wrapper staffs again at 2026-09-03T11:30:00.000Z.",
          label: WAITING,
        },
        stage: "WORKING",
      });
    // An instant this box cannot parse is shown RAW; "Invalid Date" would hide a live pause.
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, paused: { ...PAUSE, resetAt: "whenever" }, runId: RUN, surface: working })
      .next.label).toBe("Waiting for the provider limit to reset at whenever");
  });

  it("says exactly what it says today when no pause is known, whether the key is null or absent", () => {
    const working = surface([], WORKING_STEPS);
    const today = {
      detail: "1 node is claimed right now. Nothing needs you until a review is exhausted.",
      label: "Watch the board",
    };
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, paused: null, runId: RUN, surface: working }).next)
      .toMatchObject(today);
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, runId: RUN, surface: working }).next).toMatchObject(today);
  });

  it("leaves every stage but WORKING alone while the provider is paused", () => {
    // A goal whose criteria are all verified is closed by the operator, not by the wrapper;
    // and an exhausted review still needs a decision. Neither waits on a provider limit.
    const done = surface([{ commandKind: "goal.close", targetAggregateId: GOAL }], [node("n1", "COMMITTED")]);
    expect(deriveGoalStatus({ coverage: coverage({ verified: 4 }), goalId: GOAL, paused: PAUSE, runId: RUN, surface: done }))
      .toMatchObject({ next: { anchor: "needs-you", label: "Close the goal" }, stage: "READY_TO_CLOSE" });
    const exhausted = surface(
      [{ commandKind: "escalation.decide", targetAggregateId: "n2" }],
      [node("n1", "COMMITTED"), node("n2", "BLOCKED", { missing: ["escalation"] })],
    );
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, paused: PAUSE, runId: RUN, surface: exhausted }))
      .toMatchObject({ next: { label: "Decide the escalation" }, stage: "ESCALATION" });
    expect(deriveGoalStatus({ coverage: coverage({ gate1: "PENDING" }), goalId: GOAL, paused: PAUSE, runId: RUN, surface: null }))
      .toMatchObject({ next: { label: "Review the contract" }, stage: "CONTRACT" });
    expect(deriveGoalStatus({ coverage: coverage({ lifecycle: "COMPLETED", verified: 4 }), goalId: GOAL, paused: PAUSE, runId: RUN, surface: null }))
      .toMatchObject({ next: { label: "Read the record" }, stage: "CLOSED" });
  });

  it("still waits on the limit when the pause named another goal's work item, and when nothing is claimed", () => {
    // The wrapper serves ONE provider, so every WORKING goal waits; the detail names the item
    // so a person can see the limit fired somewhere else.
    const elsewhere = { ...PAUSE, workItemId: "node.deliver@other-goal-node" };
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, paused: elsewhere, runId: RUN, surface: surface([], WORKING_STEPS) }).next.detail)
      .toBe("The claude seat hit its limit on node.deliver@other-goal-node; the wrapper staffs again at 2026-09-03T11:30:00.000Z.");
    // Nothing claimed: still WORKING, and still waiting - nothing will be staffed until the reset.
    const idle = surface([], [node("n1", "COMMITTED"), node("n2", "READY")]);
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, paused: PAUSE, runId: RUN, surface: idle }))
      .toMatchObject({ agents: { working: 0 }, next: { label: WAITING }, stage: "WORKING" });
  });

  it("puts a pending contract before a plan offer, and a plan offer before working agents", () => {
    const both = surface([{ commandKind: "approval.decide_intent", targetAggregateId: RUN }], [node("n1", "READY")]);
    expect(deriveGoalStatus({ coverage: coverage({ gate1: "PENDING" }), goalId: GOAL, runId: RUN, surface: both }).stage).toBe("CONTRACT");
    expect(deriveGoalStatus({ coverage: coverage(), goalId: GOAL, runId: RUN, surface: both }).stage).toBe("PLAN");
  });
});

describe("GoalStatusStrip", () => {
  it("shows the stage, the headline, the facts and a link to the next step's section", () => {
    const working = surface([], [node("n1", "COMMITTED"), node("n2", "READY")]);
    render(<GoalStatusStrip status={deriveGoalStatus({ coverage: coverage(), goalId: GOAL, runId: RUN, surface: working })} />);
    expect(screen.getByTestId("cr.goalstatus.stage").textContent).toBe("Agents working");
    expect(screen.getByTestId("cr.goalstatus.facts").textContent).toBe("2 of 4 criteria verified · 1 of 2 nodes accepted");
    expect(screen.getByTestId("cr.goalstatus.next").getAttribute("href")).toBe("#cr-goal-board");
    expect(screen.getByTestId("cr.goalstatus.root").getAttribute("data-stage")).toBe("WORKING");
  });
});

describe("LiveGoalStatus", () => {
  it("reads the opened goal's coverage through the page's reader and derives from the shared surface", async () => {
    const read = vi.fn(async (_goalId: string) => coverage({ gate1: "PENDING" }));
    render(<LiveGoalStatus goalId={GOAL} pollMs={60_000} read={read} runId={RUN} surface={null} />);
    expect((await screen.findByTestId("cr.goalstatus.stage")).textContent).toBe("Contract at Gate 1");
    expect(read).toHaveBeenCalledWith(GOAL);
  });

  it("takes the pause from the shell's context and derives the waiting next step from it", async () => {
    const read = async (): Promise<DocumentCoverageOutcome> => coverage();
    const working = surface([], WORKING_STEPS);
    render(
      <ProviderPauseProvider value={PAUSE}>
        <LiveGoalStatus goalId={GOAL} pollMs={60_000} read={read} runId={RUN} surface={working} />
      </ProviderPauseProvider>,
    );
    // findByTEXT, not findByTestId: the element exists from the first paint holding the
    // UNKNOWN stage's "Wait", so a testid lookup would settle before the coverage lands.
    await screen.findByText(WAITING);
    expect(screen.getByTestId("cr.goalstatus.next").textContent).toBe(WAITING);
    cleanup();
    // No provider above it: the strip says what it says today.
    render(<LiveGoalStatus goalId={GOAL} pollMs={60_000} read={read} runId={RUN} surface={working} />);
    await screen.findByText("Watch the board");
    expect(screen.getByTestId("cr.goalstatus.next").textContent).toBe("Watch the board");
  });
});
