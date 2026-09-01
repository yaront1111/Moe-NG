import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { FIXTURE_GOALS_DATA } from "./goals-fixtures.js";
import { GoalsHome } from "./goals-home.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

it("disables goal creation with the exact backend prerequisite instead of discarding prose", async () => {
  const user = userEvent.setup();
  const create = vi.fn();
  const reason = "Goal creation is unavailable until this daemon persists the operator's goal prose.";
  render(
    <GoalsHome
      createDisabledReason={reason}
      data={FIXTURE_GOALS_DATA}
      initialCreating
      onCreateGoal={create}
      onOpenBoard={vi.fn()}
    />,
  );

  const button = screen.getByTestId("cr.goals.new") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toBe(reason);
  expect(button.textContent).toContain("New goal");
  await user.click(button);
  expect(screen.queryByTestId("cr.goals.newgoal.form")).toBeNull();
  expect(create).not.toHaveBeenCalled();
});
