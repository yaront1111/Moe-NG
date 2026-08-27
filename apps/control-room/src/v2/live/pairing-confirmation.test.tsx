import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PairingConfirmation } from "./pairing-confirmation.js";

const LABEL = "abcd-ef01-2345";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

describe("PairingConfirmation first-run copy", () => {
  it("numbers the three steps and names Enter, lowercase, and the return trip", () => {
    render(<PairingConfirmation confirmationLabel={LABEL} onConfirm={vi.fn()} />);

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toMatch(/foreground terminal that launched this project/u);
    expect(within(items[0] as HTMLElement).getByLabelText("Pairing confirmation label").textContent)
      .toBe(LABEL);
    expect(items[1]?.textContent).toMatch(/lowercase/u);
    expect(items[1]?.textContent).toMatch(/press Enter/u);
    expect(items[2]?.textContent).toMatch(/press the button below/iu);
    expect(screen.getByText("ONE-TIME PAIRING")).toBeTruthy();
    expect(screen.queryByText("LOCAL OPERATOR CONFIRMATION")).toBeNull();
  });

  it("says the terminal stays silent and offers the reload that mints a new label", () => {
    render(<PairingConfirmation confirmationLabel={LABEL} onConfirm={vi.fn()} />);

    const card = screen.getByRole("region", { name: "Pair this browser with Moe" });
    expect(card.textContent).toMatch(/no prompt and no confirmation/u);
    expect(card.textContent).toMatch(/[Rr]eload this page/u);
    // No TTL number reaches this surface, so none may be printed.
    expect(card.textContent).not.toMatch(/\b60\b|seconds/u);
  });

  it("keeps the two strings the CordumApp seam test pins", () => {
    render(<PairingConfirmation confirmationLabel={LABEL} onConfirm={vi.fn()} />);

    expect(screen.getByText(/foreground terminal that launched this project/iu)).toBeTruthy();
    expect(screen.getByText(
      "Type this exact label into the foreground terminal that launched this project.",
    )).toBeTruthy();
    expect(screen.getByRole("button", { name: "I entered this label" })).toBeTruthy();
  });

  it("folds the Moe Projects prefix rule into a closed disclosure, and omits it for the manager", () => {
    render(<PairingConfirmation confirmationLabel={LABEL} onConfirm={vi.fn()} />);

    const details = document.querySelector("details.cr2-pairing-alt") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toMatch(/Moe Projects/u);
    expect(within(details).getByText(/INSTANCE id and one space/u)).toBeTruthy();
    expect(details.textContent).not.toMatch(/foreground terminal/u);

    cleanup();
    render(<PairingConfirmation confirmationLabel={LABEL} onConfirm={vi.fn()} scope="manager" />);
    expect(document.querySelector("details.cr2-pairing-alt")).toBeNull();
    expect(screen.getByText(
      "Type this exact label into the foreground terminal that launched the project manager.",
    )).toBeTruthy();
  });

  it("reports a bounced claim once busy returns to false while still mounted", () => {
    // <output> already carries an implicit status role, so the bounce is read
    // off its own node rather than by role alone.
    const bounce = (): Element | null => document.querySelector("p.cr2-pairing-bounce");
    const view = render(
      <PairingConfirmation busy={false} confirmationLabel={LABEL} onConfirm={vi.fn()} />,
    );
    expect(bounce()).toBeNull();

    view.rerender(<PairingConfirmation busy confirmationLabel={LABEL} onConfirm={vi.fn()} />);
    expect(bounce()).toBeNull();

    view.rerender(
      <PairingConfirmation busy={false} confirmationLabel={LABEL} onConfirm={vi.fn()} />,
    );
    expect(bounce()?.getAttribute("role")).toBe("status");
    expect(bounce()?.textContent).toMatch(/Not paired yet/u);
    expect(bounce()?.textContent).toMatch(/press the button again/u);
  });
});
