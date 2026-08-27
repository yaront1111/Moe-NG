import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import type { JSX } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ProofInspector } from "./proof-inspector.js";
import type { ProofPayload } from "./proof-context.js";

/**
 * The proof drawer is the product's evidence surface, so the two things it must
 * never do are lie about what it can open and go silent for anyone not driving a
 * mouse. Both arms below fail against the drawer as first shipped:
 *
 * - `cr.shell.inspector.open` rendered a primary-styled button whose only handler
 *   was an optional prop no caller ever supplied (`grep -rn onOpenReceipt` found
 *   the declaration, the destructure and the call site and nothing else), so the
 *   owner's click did nothing and said nothing.
 * - the Escape handler hung off the `<aside>`, focus never entered the drawer and
 *   was dropped on `<body>` when it closed, and the narrow-width sheet never
 *   carried the `[role='dialog'][aria-modal='true']` contract that
 *   a11y/keyboard-map.ts already special-cases by this exact testid.
 */

const CLAIM: ProofPayload = Object.freeze({
  factId: "goal-live-1.live.ready",
  label: "Ready",
  truthClass: "DAEMON_VERIFIED",
  value: "9 steps",
});

interface StubMediaQueryList {
  matches: boolean;
  readonly media: string;
  readonly addEventListener: () => void;
  readonly removeEventListener: () => void;
}

/**
 * jsdom 30 implements neither `window.matchMedia` nor media evaluation, which is
 * exactly why the drawer treats a missing `matchMedia` as "wide". Stubbing it is
 * the only way to reach the narrow branch from a unit test.
 */
function stubViewport(matches: boolean): void {
  const list: StubMediaQueryList = {
    addEventListener: () => undefined,
    matches,
    media: "(max-width: 980px)",
    removeEventListener: () => undefined,
  };
  vi.stubGlobal("matchMedia", () => list);
}

/** A toggle plus the drawer: the shape the shell mounts, so focus has somewhere to return to. */
function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <main id="cr2-main" tabIndex={-1}>
        <button data-testid="opener" onClick={() => setOpen(true)} type="button">Proof</button>
      </main>
      <ProofInspector onClose={() => setOpen(false)} open={open} payload={CLAIM} />
    </div>
  );
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the proof drawer offers no receipt it cannot open", () => {
  it("states the receipt is unavailable instead of rendering a button that does nothing", () => {
    render(<ProofInspector onClose={vi.fn()} open payload={CLAIM} />);

    const shown = screen.getByTestId("cr.shell.inspector.open");
    expect(shown.tagName).toBe("P");
    expect(shown.querySelector("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /receipt/iu })).toBeNull();
    // The claim's own class decides the noun; the shell contract pins the word.
    expect(shown.textContent).toContain("receipt");
    expect(shown.textContent).toContain("SOON");
  });

  it("renders the real control, and fires it, once a caller can open a receipt", async () => {
    const user = userEvent.setup();
    const onOpenReceipt = vi.fn();
    render(
      <ProofInspector onClose={vi.fn()} onOpenReceipt={onOpenReceipt} open payload={CLAIM} />,
    );

    const control = screen.getByTestId("cr.shell.inspector.open");
    expect(control.tagName).toBe("BUTTON");
    await user.click(control);
    expect(onOpenReceipt).toHaveBeenCalledTimes(1);
    expect(onOpenReceipt).toHaveBeenCalledWith(CLAIM);
  });
});

describe("the proof drawer is reachable without a mouse", () => {
  it("moves focus into the drawer when it opens", () => {
    render(<ProofInspector onClose={vi.fn()} open payload={CLAIM} />);

    expect(document.activeElement).toBe(screen.getByTestId("cr.shell.inspector.title"));
  });

  it("closes on Escape pressed from outside the drawer", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <div>
        <button data-testid="outside" type="button">Elsewhere</button>
        <ProofInspector onClose={onClose} open payload={CLAIM} />
      </div>,
    );

    screen.getByTestId("outside").focus();
    expect(document.activeElement).toBe(screen.getByTestId("outside"));
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to whatever opened it rather than dropping it on the body", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId("opener"));
    expect(document.activeElement).toBe(screen.getByTestId("cr.shell.inspector.title"));

    await user.click(screen.getByTestId("cr.shell.inspector.close"));

    expect(screen.queryByTestId("cr.shell.inspector")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("opener"));
  });

  it("returns focus to the opener under the StrictMode the app actually mounts in", async () => {
    const user = userEvent.setup();
    render(<StrictMode><Harness /></StrictMode>);

    await user.click(screen.getByTestId("opener"));
    await user.click(screen.getByTestId("cr.shell.inspector.close"));

    // StrictMode replays the open effect, so a per-run capture would record the
    // drawer's own heading as the opener and fall back to #cr2-main on close.
    expect(document.activeElement).toBe(screen.getByTestId("opener"));
  });

  it("leaves an Escape another handler already took", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <div onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }}>
        <button data-testid="deeper" type="button">Inside something modal</button>
        <ProofInspector onClose={onClose} open payload={CLAIM} />
      </div>,
    );

    screen.getByTestId("deeper").focus();
    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("announces a claim that lands while the drawer is already open", () => {
    render(<ProofInspector onClose={vi.fn()} open payload={CLAIM} />);

    const live = screen.getByTestId("cr.shell.inspector.live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.contains(screen.getByTestId("cr.shell.inspector.claim"))).toBe(true);
  });
});

describe("the proof drawer keeps the dialog contract the keyboard map expects", () => {
  it("is a plain complementary region when it sits beside the main column", () => {
    render(<ProofInspector onClose={vi.fn()} open payload={CLAIM} />);

    const drawer = screen.getByTestId("cr.shell.inspector");
    expect(drawer.getAttribute("role")).toBeNull();
    expect(drawer.getAttribute("aria-modal")).toBeNull();
    expect(screen.queryByTestId("cr.shell.inspector.scrim")).toBeNull();
  });

  it("becomes a modal dialog with a dismiss scrim once it covers the main column", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    stubViewport(true);
    render(<ProofInspector onClose={onClose} open payload={CLAIM} />);

    const drawer = screen.getByTestId("cr.shell.inspector");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");

    // The dialog's own labelled Close button is the accessible way out, so the
    // scrim stays out of the a11y tree rather than duplicating that name -
    // the same shape src/shell/inspector-sheet.tsx already uses for a backdrop.
    const scrim = screen.getByTestId("cr.shell.inspector.scrim");
    expect(scrim.tagName).toBe("DIV");
    expect(scrim.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("button", { name: "Close inspector" })).toHaveLength(1);

    await user.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
