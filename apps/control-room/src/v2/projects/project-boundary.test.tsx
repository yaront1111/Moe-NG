import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ProjectBoundary,
  validateProjectPairingLink,
} from "./project-boundary.js";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

describe("project origin validation", () => {
  it.each([
    "http://127.0.0.1:39123",
    "  http://127.0.0.1:49123  ",
  ])("accepts only the daemon's exact plain origin: %s", (input) => {
    const href = input.trim();
    expect(validateProjectPairingLink(input)).toEqual({ href, ok: true });
  });

  it.each([
    "https://127.0.0.1:39123/#pair=SECRET-SECRET-1",
    "http://localhost:39123/#pair=SECRET-SECRET-1",
    "http://[::1]:39123/#pair=SECRET-SECRET-1",
    "https://example.com/#pair=SECRET-ONE",
    "file:///C:/tmp/index.html#pair=SECRET-TWO",
    "http://127.0.0.1:39123/?pair=QUERY-SECRET",
    "http://127.0.0.1:39123/other#pair=SECRET-SECRET-1",
    "http://127.0.0.1/#pair=SECRET-SECRET-1",
    "http://127.0.0.1:39123/#pair=SECRET-SECRET-1&extra=value",
    "http://127.0.0.1:39123/#pair=SECRET-SECRET-1&pair=SECOND-SECRET-1",
    "http://user:pass@127.0.0.1:39123/#pair=SECRET-SECRET-1",
    "http://127.0.0.1:39123/#pair=short",
    "http://127.0.0.1:39123/#pair=",
    "not a URL SECRET-THREE",
  ])("refuses an unsafe or authority-bearing link without echoing it: %s", (href) => {
    const result = validateProjectPairingLink(href);
    expect(result).toEqual({
      code: "PROJECT_PAIRING_LINK_INVALID",
      detail: "Paste the exact plain http://127.0.0.1 project origin from Moe.",
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("ProjectBoundary", () => {
  it("names the bound project and the isolated goals, tasks, and board boundary", () => {
    render(<ProjectBoundary openWindow={vi.fn()} projectId="proj-blue" />);

    expect(screen.getByTestId("cr.project.boundary").getAttribute("data-project-id"))
      .toBe("proj-blue");
    expect(screen.getByTestId("cr.project.id").textContent).toBe("proj-blue");
    expect(screen.getByTestId("cr.project.boundary").textContent)
      .toContain("isolated goals, tasks, and board");
    const manager = screen.getByRole("link", { name: /all projects/i });
    expect(manager.getAttribute("href")).toBe("http://127.0.0.2:39122");
    expect(manager.getAttribute("target")).toBe("_blank");
  });

  it("opens a valid alternate project link in a new tab, clears it, and keeps this tab bound", async () => {
    const openWindow = vi.fn();
    const user = userEvent.setup();
    render(<ProjectBoundary openWindow={openWindow} projectId="proj-blue" />);

    await user.click(screen.getByText("Open another project"));
    const input = screen.getByLabelText("Another project's origin") as HTMLInputElement;
    const href = "http://127.0.0.1:39124";
    await user.type(input, href);
    await user.click(screen.getByRole("button", { name: "Open isolated project" }));

    expect(openWindow).toHaveBeenCalledWith(href, "_blank", "noopener,noreferrer");
    expect(input.value).toBe("");
    expect(screen.getByTestId("cr.project.id").textContent).toBe("proj-blue");
  });

  it("refuses a non-loopback link without opening or displaying its token", async () => {
    const openWindow = vi.fn();
    const user = userEvent.setup();
    render(<ProjectBoundary openWindow={openWindow} projectId="proj-blue" />);

    await user.click(screen.getByText("Open another project"));
    const input = screen.getByLabelText("Another project's origin") as HTMLInputElement;
    await user.type(input, "https://evil.example/#pair=DO-NOT-ECHO");
    await user.click(screen.getByRole("button", { name: "Open isolated project" }));

    expect(openWindow).not.toHaveBeenCalled();
    const refusal = screen.getByRole("alert");
    expect(refusal.textContent).toContain("PROJECT_PAIRING_LINK_INVALID");
    expect(refusal.textContent).not.toContain("DO-NOT-ECHO");
    expect(input.value).toBe("");
  });
});
