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
    // Plain words first, the launcher's own name after, in the one element the
    // no-touch cordum-app.test.tsx matches by regex.
    expect(items[0]?.textContent).toMatch(/^\s*Go to the terminal window where you started Moe - the foreground terminal that launched this project\./u);
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

  it("keeps the two pins the no-touch CordumApp seam test holds: one regex match and the button name", () => {
    render(<PairingConfirmation confirmationLabel={LABEL} onConfirm={vi.fn()} />);

    // getByText throws on more than one match, so the phrase must live in
    // exactly one element and no inline child may split it.
    expect(screen.getByText(/foreground terminal that launched this project/iu)).toBeTruthy();
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
      /^\s*Go to the terminal window where you started Moe Projects - the foreground terminal that launched the project manager\./u,
    )).toBeTruthy();
    expect(screen.queryByText(/launched this project/u)).toBeNull();
  });

  it("reports a bounced claim once busy returns to false while still mounted", () => {
    // <output> already carries an implicit status role, so the bounce is read
    // off its own node rather than by role alone. A polite live region is only
    // announced reliably when its TEXT changes inside a node that was already
    // there, so the node is mounted from the first render and stays the same
    // element throughout; only its words arrive.
    const bounce = (): Element | null => document.querySelector("p.cr2-pairing-bounce");
    const view = render(
      <PairingConfirmation busy={false} confirmationLabel={LABEL} onConfirm={vi.fn()} />,
    );
    const region = bounce();
    expect(region).not.toBeNull();
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("");

    view.rerender(<PairingConfirmation busy confirmationLabel={LABEL} onConfirm={vi.fn()} />);
    expect(bounce()).toBe(region);
    expect(bounce()?.textContent).toBe("");

    view.rerender(
      <PairingConfirmation busy={false} confirmationLabel={LABEL} onConfirm={vi.fn()} />,
    );
    expect(bounce()).toBe(region);
    expect(bounce()?.textContent).toMatch(/Not paired yet/u);
    expect(bounce()?.textContent).toMatch(/press the button again/u);
  });
});
