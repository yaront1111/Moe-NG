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
  it("keeps results independent for two goals with the same local node name", () => {
    const items = ["a", "b"].map((suffix) => ({
      actionLabel: "Open the goal", detail: "Needs review", goalId: `goal-${suffix}`,
      headline: "Review exhausted", kind: "ESCALATION" as const, planningRunRef: `run-${suffix}`, title: suffix,
      escalation: { affordance: { commandKind: "escalation.decide", targetAggregateId: `execution-${suffix}` },
        latestRoute: "REJECT_PLAN", nodeKey: "api", unsuccessfulRounds: 3 },
    }));
    render(<NeedsYou data={{ countLabel: "2", items, note: null }} onDecide={vi.fn()} onOpenBoard={vi.fn()}
      decisionResults={new Map([["execution-a", { busy: false, outcome: { ok: true, commandId: "allowed-a" } }]])} />);
    const buttons = screen.getAllByRole("button", { name: "Allow more attempts on api" });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
  });
  it("renders one card per decision with its goal, headline, detail and one action", async () => {
    const onOpenBoard = vi.fn();
    render(<NeedsYou data={DATA} onOpenBoard={onOpenBoard} />);
    expect(screen.getByTestId("cr.needsyou.count").textContent).toBe("2 DECISIONS · NEEDS YOU");
    const plan = screen.getByTestId("cr.needsyou.item.plan-approval.goal-1");
    expect(plan.textContent).toContain("Plan · Alpha");
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
      escalation: { affordance: { commandKind: "escalation.decide", targetAggregateId: "node-x" }, latestRoute: "REJECT_PLAN", nodeKey: "node-x", unsuccessfulRounds: 3 },
      goalId: "goal-1", headline: "A node's review is exhausted", kind: "ESCALATION" as const, planningRunRef: "run-1", title: "Alpha",
    };
    const data: NeedsYouData = { countLabel: "1 DECISION · NEEDS YOU", items: [item], note: null };
    const { rerender } = render(<NeedsYou data={data} onDecide={onEscalate} onOpenBoard={vi.fn()} />);
    expect(screen.getByTestId("cr.needsyou.item.escalation.node-x").textContent).toContain("Review exhausted · Alpha");
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
    expect(screen.getByTestId("cr.needsyou.result.node-x").textContent).toContain("That didn't go through.");
    expect(screen.getByTestId("cr.needsyou.result.node-x").textContent).toContain("REVIEW_ESCALATION_NOT_REACHED @ DAEMON_PREREQUISITE");
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

  /**
   * A REFUSED CLOSE REACHES THE OPERATOR AS THE DAEMON'S OWN CODE, VERBATIM.
   *
   * The close card is the one place a `goal.close` refusal is ever seen, and "could not close"
   * on its own cannot tell an unverified criterion from a daemon fault. Both codes below were
   * MEASURED off a real daemon, not invented:
   *   - GOAL_CLOSE_CRITERIA_UNVERIFIED is child 2's goal-level gate
   *     (goal-close-prerequisite.ts:31-32, rostered :54, layer :60).
   *   - BOOTSTRAP_PREREQUISITE_MISSING is what the LIVE UnAI store actually answered on
   *     2026-09-05 for a 10/10-verified goal: `goal.close` requires a committed
   *     `approval.decide` (bootstrap-sequence.ts:22) and that project has none, so the
   *     generic bootstrap gate refuses before any goal handler runs. The card must carry
   *     THAT code too — an operator who is shown only the friendly sentence has no string
   *     to search for.
   *
   * Asserted as the exact `CODE @ LAYER` text, so a paraphrase or a swallowed layer reddens.
   */
  it.each([
    ["GOAL_CLOSE_CRITERIA_UNVERIFIED", "DAEMON_PREREQUISITE"],
    ["BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE"],
    ["TRANSPORT_REQUEST_FAILED", "CONTROL_ROOM_TRANSPORT"],
  ])("renders a refused close as %s verbatim", (code, layer) => {
    const item = {
      actionLabel: "Open the goal", close: { affordance: { commandKind: "goal.close" } },
      detail: "All 10 acceptance criteria verified by the daemon's verifier.",
      goalId: "goal-1", headline: "Everything the contract states is verified",
      kind: "READY_TO_CLOSE" as const, planningRunRef: "run-1", title: "Alpha",
    };
    render(<NeedsYou
      data={{ countLabel: "1 DECISION · NEEDS YOU", items: [item], note: null }}
      decisionResults={new Map([["goal-1", { busy: false, outcome: { code, layer, ok: false as const } }]])}
      onDecide={vi.fn()}
      onOpenBoard={vi.fn()}
    />);
    const note = screen.getByTestId("cr.needsyou.result.goal-1").textContent ?? "";
    expect(note).toContain("That didn't go through.");
    expect(note).toContain(`${code} @ ${layer}`);
    // The refusal is not mistaken for success: the "Closed." line must NOT appear.
    expect(note).not.toContain("Closed. The goal is complete");
    // And the control stays live, so the operator can act once the cause is fixed.
    expect((screen.getByTestId("cr.needsyou.close.goal-1") as HTMLButtonElement).disabled).toBe(false);
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
