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
