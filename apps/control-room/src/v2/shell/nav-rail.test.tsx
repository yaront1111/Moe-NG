import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NavRail } from "./nav-rail.js";

afterEach(cleanup);

describe("product navigation", () => {
  it("keeps products and decisions primary while disclosing technical destinations", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(<NavRail onNavigate={navigate} />);

    expect(screen.getByRole("button", { name: "Products" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs you" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Runs" })).toBeNull();
    const tools = screen.getByRole("button", { name: "Technical tools" });
    expect(tools.getAttribute("aria-expanded")).toBe("false");
    await user.click(tools);
    expect(tools.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(navigate).toHaveBeenCalledWith({ kind: "runs" });
  });

  it("keeps the selected technical destination visible on a direct visit", () => {
    render(<NavRail activeId="health" onNavigate={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Technical tools" }).getAttribute("aria-expanded"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "Health" }).getAttribute("aria-current")).toBe("page");
    expect(within(screen.getByTestId("cr.nav.primary")).getAllByRole("button")).toHaveLength(2);
  });

  it("opens technical tools when navigation changes to a technical destination", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<NavRail activeId="goals" onNavigate={vi.fn()} />);
    const tools = screen.getByRole("button", { name: "Technical tools" });
    expect(tools.getAttribute("aria-expanded")).toBe("false");
    rerender(<NavRail activeId="policy" onNavigate={vi.fn()} />);
    expect(tools.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Policy" }).getAttribute("aria-current")).toBe("page");
    await user.click(tools);
    expect(tools.getAttribute("aria-expanded")).toBe("false");
  });

  it("preserves an unavailable technical destination's refusal after disclosure", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(<NavRail destinations={[]} onNavigate={navigate} />);
    await user.click(screen.getByRole("button", { name: "Technical tools" }));
    const runs = screen.getByRole("button", { name: /Runs not available yet/u }) as HTMLButtonElement;

    expect(runs.disabled).toBe(true);
    expect(runs.getAttribute("data-unavailable-reason")).toBe("NAV_DESTINATION_NOT_BUILT");
    await user.click(runs);
    expect(navigate).not.toHaveBeenCalled();
  });
});
