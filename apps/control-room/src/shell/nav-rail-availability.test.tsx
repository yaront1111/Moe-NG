import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { CONTROL_ROOM_NAV_ITEMS, NavRail } from "./nav-rail.js";

afterEach(cleanup);

it("keeps unavailable destinations visible, disabled, and tied to the supplied reason", () => {
  const reason = "The live attachment is a single daemon workspace.";
  render(<NavRail activeItem="Goals" narrow={false} unavailableReason={reason} />);

  const reasonNode = screen.getByText(reason);
  for (const label of CONTROL_ROOM_NAV_ITEMS) {
    const destination = screen.getByRole("button", { name: label });
    expect((destination as HTMLButtonElement).disabled).toBe(true);
    expect(destination.getAttribute("aria-current")).toBeNull();
    expect(destination.getAttribute("aria-describedby")).toBe(reasonNode.id);
  }
});

it("keeps configured destinations operable", async () => {
  const onNavigate = vi.fn();
  render(<NavRail activeItem="Goals" narrow={false} onNavigate={onNavigate} />);

  await userEvent.click(screen.getByRole("button", { name: "Approvals" }));
  expect(onNavigate).toHaveBeenCalledOnce();
  expect(onNavigate).toHaveBeenCalledWith("Approvals");
  expect(screen.getByRole("button", { name: "Goals" }).getAttribute("aria-current"))
    .toBe("page");
});
