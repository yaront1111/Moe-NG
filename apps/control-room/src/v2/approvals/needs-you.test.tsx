import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NeedsYou } from "./needs-you.js";
import type { NeedsYouData } from "./needs-you-model.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

const DATA: NeedsYouData = {
  countLabel: "2 DECISIONS · NEEDS YOU",
  items: [
    {
      actionLabel: "Review the plan", detail: "The daemon offers approval for planning run run-1.",
      goalId: "goal-1", headline: "A plan is waiting for your approval", kind: "PLAN_APPROVAL",
      planningRunRef: "run-1", title: "Alpha",
    },
    {
      actionLabel: "Review the contract", detail: "contract-2 · 7 requirements · 10 acceptance criteria.",
      goalId: "goal-2", headline: "A Product Contract is waiting at Gate 1", kind: "GATE_1",
      planningRunRef: "run-2", title: "Beta",
    },
  ],
  note: null,
};

describe("the Needs-you queue", () => {
  it("renders one card per decision with its goal, headline, detail and one action", async () => {
    const onOpenBoard = vi.fn();
    render(<NeedsYou data={DATA} onOpenBoard={onOpenBoard} />);
    expect(screen.getByTestId("cr.needsyou.count").textContent).toBe("2 DECISIONS · NEEDS YOU");
    const plan = screen.getByTestId("cr.needsyou.item.plan-approval.goal-1");
    expect(plan.textContent).toContain("PLAN · Alpha");
    expect(plan.textContent).toContain("A plan is waiting for your approval");
    expect(screen.getByTestId("cr.needsyou.item.gate-1.goal-2").textContent).toContain("contract-2");
    expect(screen.queryByTestId("cr.needsyou.note")).toBeNull();
    const button = screen.getByTestId("cr.needsyou.open.gate-1.goal-2");
    expect(button.getAttribute("aria-label")).toBe("Review the contract for Beta");
    await userEvent.click(button);
    expect(onOpenBoard).toHaveBeenCalledWith("goal-2", "run-2", "Beta");
  });

  it("offers the inline escalation decision and shows the daemon's answer beside it", async () => {
    const onEscalate = vi.fn();
    const item = {
      actionLabel: "Open the goal", detail: "node-x failed review 3 times.",
      escalation: { affordance: { commandKind: "escalation.decide" }, latestRoute: "REJECT_PLAN", nodeKey: "node-x", unsuccessfulRounds: 3 },
      goalId: "goal-1", headline: "A node's review is exhausted", kind: "ESCALATION" as const, planningRunRef: "run-1", title: "Alpha",
    };
    const data: NeedsYouData = { countLabel: "1 DECISION · NEEDS YOU", items: [item], note: null };
    const { rerender } = render(<NeedsYou data={data} onDecide={onEscalate} onOpenBoard={vi.fn()} />);
    expect(screen.getByTestId("cr.needsyou.item.escalation.node-x").textContent).toContain("REVIEW EXHAUSTED · Alpha");
    await userEvent.click(screen.getByTestId("cr.needsyou.escalate.node-x"));
    expect(onEscalate).toHaveBeenCalledWith(item);
    // The second answer: replan the work instead of retrying it.
    await userEvent.click(screen.getByTestId("cr.needsyou.replan.node-x"));
    expect(onEscalate).toHaveBeenLastCalledWith(item, "REPLAN");
    rerender(<NeedsYou data={data} decisionResults={new Map([["node-x", { busy: false, choice: "REPLAN", outcome: { commandId: "c", ok: true } }]])} onDecide={onEscalate} onOpenBoard={vi.fn()} />);
    expect(screen.getByTestId("cr.needsyou.result.node-x").textContent).toContain("Replanned.");
    expect((screen.getByTestId("cr.needsyou.replan.node-x") as HTMLButtonElement).disabled).toBe(true);
    rerender(<NeedsYou data={data} decisionResults={new Map([["node-x", { busy: false, outcome: { commandId: "c", ok: true } }]])} onDecide={onEscalate} onOpenBoard={vi.fn()} />);
    expect(screen.getByTestId("cr.needsyou.result.node-x").textContent).toContain("Allowed.");
    expect((screen.getByTestId("cr.needsyou.escalate.node-x") as HTMLButtonElement).disabled).toBe(true);
    rerender(<NeedsYou data={data} decisionResults={new Map([["node-x", { busy: false, outcome: { code: "REVIEW_ESCALATION_NOT_REACHED", layer: "DAEMON_PREREQUISITE", ok: false } }]])} onDecide={onEscalate} onOpenBoard={vi.fn()} />);
    expect(screen.getByTestId("cr.needsyou.result.node-x").textContent).toBe("REFUSED · REVIEW_ESCALATION_NOT_REACHED · DAEMON_PREREQUISITE");
  });

  it("asks twice before closing a goal, then shows the daemon's answer", async () => {
    const onDecide = vi.fn();
    const item = {
      actionLabel: "Open the goal", close: { affordance: { commandKind: "goal.close" } },
      detail: "All 10 acceptance criteria verified by the daemon's verifier.",
      goalId: "goal-1", headline: "Everything the contract states is verified", kind: "READY_TO_CLOSE" as const,
      planningRunRef: "run-1", title: "Alpha",
    };
    const data: NeedsYouData = { countLabel: "1 DECISION · NEEDS YOU", items: [item], note: null };
    const { rerender } = render(<NeedsYou data={data} onDecide={onDecide} onOpenBoard={vi.fn()} />);
    const button = screen.getByTestId("cr.needsyou.close.goal-1");
    expect(button.textContent).toBe("Close the goal");
    await userEvent.click(button);
    // First click arms; nothing is sent, and the card offers a way back.
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByTestId("cr.needsyou.close.goal-1").textContent).toBe("Confirm: close the goal");
    await userEvent.click(screen.getByTestId("cr.needsyou.close.goal-1.cancel"));
    expect(screen.getByTestId("cr.needsyou.close.goal-1").textContent).toBe("Close the goal");
    await userEvent.click(screen.getByTestId("cr.needsyou.close.goal-1"));
    await userEvent.click(screen.getByTestId("cr.needsyou.close.goal-1"));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith(item);
    rerender(<NeedsYou data={data} decisionResults={new Map([["goal-1", { busy: false, outcome: { commandId: "c", ok: true } }]])} onDecide={onDecide} onOpenBoard={vi.fn()} />);
    expect(screen.getByTestId("cr.needsyou.result.goal-1").textContent).toContain("Closed.");
    expect((screen.getByTestId("cr.needsyou.close.goal-1") as HTMLButtonElement).disabled).toBe(true);
    // Without the daemon's offer the card carries no close button at all.
    const { close: _close, ...unoffered } = item;
    cleanup();
    render(<NeedsYou data={{ ...data, items: [unoffered] }} onDecide={onDecide} onOpenBoard={vi.fn()} />);
    expect(screen.queryByTestId("cr.needsyou.close.goal-1")).toBeNull();
  });

  it("states the empty queue as an invitation and carries the daemon's note", () => {
    render(<NeedsYou
      data={{ countLabel: "0 DECISIONS · NEEDS YOU", items: [], note: "The daemon's offers have not arrived yet." }}
      onOpenBoard={vi.fn()}
    />);
    expect(screen.getByTestId("cr.needsyou.empty").textContent).toContain("Nothing needs you right now.");
    expect(screen.getByTestId("cr.needsyou.note").textContent).toContain("offers have not arrived");
    expect(screen.queryByTestId("cr.needsyou.list")).toBeNull();
  });
});
