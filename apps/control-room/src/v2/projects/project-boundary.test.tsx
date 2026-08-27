import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PROJECT_MANAGER_HOME,
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
  });

  it("shows one quiet row when unpaired: no manager link or form outside the closed switch", () => {
    render(<ProjectBoundary openWindow={vi.fn()} projectId={null} />);

    const section = screen.getByTestId("cr.project.boundary");
    expect(section.getAttribute("data-state")).toBe("unbound");
    expect(screen.getByTestId("cr.project.id").textContent).toBe("Not paired yet");
    expect(screen.queryByRole("link", { name: /all projects/i })).toBeNull();
    const details = section.querySelector("details.cr2-project-switch") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const outside = section.textContent!.replace(details.textContent!, "");
    expect(outside).toContain("Not paired yet");
    expect(outside).not.toContain("127.0.0.2");
    expect(outside).not.toContain("isolated goals");
    expect(outside).not.toContain("PAIRING REQUIRED");
    expect(screen.getByText("Open another project")).toBeTruthy();
  });

  // A null projectId covers three different daemon states - handshake still in
  // flight, awaiting the operator's label, and a refused claim - and only the
  // middle one renders a pairing control under this panel. So the note may state
  // the binding rule and MUST NOT direct anyone at a control it cannot see.
  it("states the binding rule as a fact and directs at no control", () => {
    const { rerender } = render(<ProjectBoundary openWindow={vi.fn()} projectId={null} />);

    expect(screen.getByTestId("cr.project.note").textContent)
      .toBe("This tab is bound to one project once its session pairs.");

    rerender(<ProjectBoundary openWindow={vi.fn()} projectId="proj-blue" />);
    expect(screen.queryByTestId("cr.project.note")).toBeNull();
  });

  // The panel is handed one bit - a project id or nothing - so its machine state
  // names that binding, never a pairing status the daemon alone can report.
  it("reports the binding it was handed, not a pairing status it cannot observe", () => {
    const { rerender } = render(<ProjectBoundary openWindow={vi.fn()} projectId={null} />);

    expect(screen.getByTestId("cr.project.boundary").getAttribute("data-state")).toBe("unbound");

    rerender(<ProjectBoundary openWindow={vi.fn()} projectId="proj-blue" />);
    expect(screen.getByTestId("cr.project.boundary").getAttribute("data-state")).toBe("bound");
  });

  it("states the project manager address as a conditional fact inside the switch", () => {
    render(<ProjectBoundary openWindow={vi.fn()} projectId="proj-blue" />);

    expect(screen.queryByRole("link", { name: /all projects/i })).toBeNull();
    const link = screen.getByRole("link", { name: "127.0.0.2:39122" });
    expect(link.getAttribute("href")).toBe(PROJECT_MANAGER_HOME);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.closest("details.cr2-project-switch")).not.toBeNull();
    expect(link.closest("p")!.textContent).toMatch(/^If you started Moe Projects/u);
    expect(screen.getByTestId("cr.project.boundary").textContent)
      .not.toContain("create, start, stop");
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

  it("refuses with the sentence first and the code@layer behind Details", async () => {
    const user = userEvent.setup();
    render(<ProjectBoundary openWindow={vi.fn()} projectId="proj-blue" />);

    await user.click(screen.getByText("Open another project"));
    const input = screen.getByLabelText("Another project's origin") as HTMLInputElement;
    // A browser URL bubble on `type="url"` would pre-empt this refusal for the
    // likeliest typo, so the app - not the browser - must state every refusal.
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("url");
    await user.type(input, "https://evil.example/#pair=DO-NOT-ECHO");
    await user.click(screen.getByRole("button", { name: "Open isolated project" }));

    const alert = screen.getByRole("alert");
    const text = alert.textContent!;
    expect(text).toContain("Paste the exact plain http://127.0.0.1");
    expect(text.indexOf("Paste the exact plain"))
      .toBeLessThan(text.indexOf("PROJECT_PAIRING_LINK_INVALID"));
    expect(alert.querySelector("details > summary")!.textContent).toBe("Details");
    expect(alert.querySelector("details code")!.textContent)
      .toBe("PROJECT_PAIRING_LINK_INVALID@CONTROL_ROOM_PROJECT_MANAGER");
    expect(text).not.toContain("DO-NOT-ECHO");
  });
});
