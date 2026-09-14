import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { RunNodeFindingView, RunNodeView, RunsOutcome } from "../../live/live-runs.js";
import { escalationItems } from "./needs-you-escalation.js";
import { NeedsYou, resultKeyOf } from "./needs-you.js";

afterEach(cleanup);
const FINDING: RunNodeFindingView = { detail: "Which session expiry policy should be implemented?", round: 4,
  ruleId: "authentication-undecided", severity: "MAJOR", subject: "CRITERION CRT-AUTH" };
const CATALOG: GoalCatalogFrame = { connection: "CONNECTED", detail: "", goals: [], outcome: "GOALS" };
const offer = (version = 5) => ({ commandEnvelopeVersion: "moe-runtime-command/1", commandId: `offer-${version}`,
  commandKind: "escalation.decide", expectedVersion: version, inputSchemaVersion: "moe-review-command/1", targetAggregateId: "execution-own" });
function surface(version = 5): SurfaceFrame {
  return { connection: "CONNECTED", detail: "", offers: [offer(version)], outcome: "SURFACE", planningGoalRefs: {}, steps: [] };
}
function node(version = 5, nodeRef = "execution-own", unreadable = false, findings: readonly RunNodeFindingView[] = [FINDING]): RunNodeView {
  return { accepted: null, claim: null, criterionIds: ["CRT-AUTH"], declaredMigrations: null, dependsOn: [], lastActivityAt: null,
    nodeKey: "api", nodeRef, objective: "Implement sign in", landing: null, receipt: null,
    review: { escalated: false, findings, latestRoute: "ESCALATE", rounds: 4, unreadable, unsuccessfulRounds: 4, version },
    sharedKey: false, status: "ESCALATION_REQUIRED" };
}
function runs(nodes: readonly RunNodeView[] = [node()]): RunsOutcome {
  return { status: "RUNS", goals: [{ goalId: "goal-own", lifecycle: "EXECUTION_ENABLED", nodes, publish: null,
    run: { approval: "BOUND", lifecycle: "ACTIVATED", reviewable: false, runId: "run-own" }, title: "Own" }],
    totals: { ACCEPTED: 0, BLOCKED: 0, DELIVERED: 0, ESCALATED: 0, ESCALATION_REQUIRED: nodes.length, IN_PROGRESS: 0,
      READY: 0, REPLANNED: 0, UNATTRIBUTABLE: 0, goals: 1, nodes: nodes.length } };
}
function items(read: RunsOutcome | null = runs(), version = 5) { return escalationItems(surface(version), read, CATALOG); }

it("joins reported findings to the exact offered node and review version", () => {
  const [item] = items(runs([node(5, "execution-other", false, [{ ...FINDING, detail: "FOREIGN" }]), node()]));
  expect(item?.escalation).toMatchObject({ findingsState: "CURRENT", findings: [FINDING], affordance: offer() });
  expect(JSON.stringify(item)).not.toContain("FOREIGN");
});

it.each([
  ["missing", null, "MISSING"],
  ["unrelated", runs([node(5, "execution-other")]), "MISSING"],
  ["stale", runs([node(3)]), "STALE"],
  ["ahead", runs([node(7)]), "STALE"],
  ["unreadable", runs([node(5, "execution-own", true)]), "UNREADABLE"],
  ["refused", { code: "RUNS_READ_UNREADABLE", layer: "RUNS_READ", status: "ERROR" }, "UNREADABLE"],
] as const)("does not show %s findings as the offered review", (_label, read, expected) => {
  expect(items(read)[0]?.escalation).toMatchObject({ findingsState: expected, findings: [] });
});

it("renders literal reported issues before the attempt decision", () => {
  const hostile = '<img src=x onerror="window.secret()">';
  const data = { countLabel: "1", items: items(runs([node(5, "execution-own", false, [{ ...FINDING, detail: hostile }])])), note: null };
  const { container } = render(<NeedsYou data={data} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  const detail = screen.getByText(hostile);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText(/MAJOR/).textContent).toContain("authentication-undecided");
  expect(screen.getByText("CRITERION CRT-AUTH")).toBeTruthy();
  expect(screen.getByText("Review summary: up to 8 findings.")).toBeTruthy();
  expect(screen.getByText("Another attempt does not answer unresolved product questions.")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Allow one more attempt on api" });
  expect(detail.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

it.each([
  [null, "Latest review details have not arrived yet."],
  [runs([node(3)]), "Latest review details are refreshing to match this decision."],
  [runs([node(5, "execution-own", true)]), "Latest review details could not be read."],
] as const)("keeps a decision read-only until its reported issues are current", async (read, message) => {
  const decide = vi.fn();
  render(<NeedsYou data={{ countLabel: "1", items: items(read), note: null }} onDecide={decide} onOpenBoard={vi.fn()} />);
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.queryByText(FINDING.detail)).toBeNull();
  const buttons = [screen.getByRole("button", { name: /^Allow one more attempt on / }), screen.getByRole("button", { name: /^Replan .+ from its findings$/ })];
  for (const button of buttons) { expect((button as HTMLButtonElement).disabled).toBe(true); await userEvent.click(button); }
  expect(decide).not.toHaveBeenCalled();
});

it("distinguishes an empty current summary from missing evidence", () => {
  render(<NeedsYou data={{ countLabel: "1", items: items(runs([node(5, "execution-own", false, [])])), note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByText("No findings were included in the latest review summary.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement).disabled).toBe(false);
});

it("does not reuse an earlier successful decision for a later review", () => {
  const oldItem = items()[0]!;
  const nextItem = items(runs([node(7)]), 7)[0]!;
  expect(resultKeyOf(nextItem)).not.toBe(resultKeyOf(oldItem));
  const results = new Map([[resultKeyOf(oldItem), { busy: false, outcome: { ok: true as const, commandId: "old-allow" } }]]);
  const { rerender } = render(<NeedsYou data={{ countLabel: "1", items: [oldItem], note: null }} decisionResults={results} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Allow one more attempt on api" }).textContent).toBe("Allowed");
  rerender(<NeedsYou data={{ countLabel: "1", items: [nextItem], note: null }} decisionResults={results} onDecide={vi.fn()} onOpenBoard={vi.fn()} />);
  const button = screen.getByRole("button", { name: "Allow one more attempt on api" }) as HTMLButtonElement;
  expect(button.textContent).toBe("Allow one more attempt"); expect(button.disabled).toBe(false);
  expect(screen.queryByText("Allowed. One more review attempt is approved for this node.")).toBeNull();
});
