import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ContextBar } from "./context-bar.js";

/**
 * shell-02 / truth-10: the CARDS Compact / Instrument / Ledger group is a
 * pressed-button switch that no surface reads - nothing in the app matches
 * `[data-treatment`, so pressing Ledger changes no pixel. Until a board slice
 * consumes the choice it must read like every other unbacked affordance in this
 * product (the nav rail's SOON chip), not like a live control.
 *
 * Frozen in ARIA, not natively: a natively disabled button leaves the tab order
 * and swallows pointer events, so the reason it is frozen (a tooltip, and the
 * SOON chip's title on a plain span) could only ever be reached with a mouse.
 * `aria-disabled` keeps the pill focusable, announced as unavailable, and
 * described by the same sentence the chip gives the mouse.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  unloadSheets();
});

const TREATMENT_IDS = ["compact", "instrument", "ledger"] as const;

function renderBar(spies: { onTreatment: () => void; onToggleProof: () => void }): void {
  render(
    <ContextBar
      eyebrow="PROJECT"
      onToggleProof={spies.onToggleProof}
      onTreatment={spies.onTreatment}
      proofOpen={false}
      title="Goals"
      treatment="Compact"
    />,
  );
}

function pill(id: string): HTMLButtonElement {
  return screen.getByTestId(`cr.shell.treatment.${id}`) as HTMLButtonElement;
}

/** The element the 980px rule targets: the wrapper the SOON chip sits in. */
function treatmentGroup(): Element {
  const group = screen.getByTestId("cr.shell.treatment.unavailable").closest(".cr2-treatment");
  if (group === null) throw new Error("the SOON chip is not inside the treatment group");
  return group;
}

/**
 * jsdom evaluates no @media rule, but it does resolve the cascade - specificity
 * and order - of every top-level rule in a sheet installed as a <style> node. The
 * two sheets are installed in BOTH orders because the bundle's order is decided
 * by import statements in cordum-shell.tsx, which this bar does not own.
 */
const SHELL_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-shell.css"), "utf8");
const BAR_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-context-bar.css"), "utf8");
const ORDERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["shell first", [SHELL_CSS, BAR_CSS]],
  ["bar first", [BAR_CSS, SHELL_CSS]],
];

/** jsdom applies only media lists that name `screen`; relabelling the breakpoint stands in for a narrow viewport. */
function atNarrowViewport(css: string): string {
  return css.replaceAll("@media (max-width: 980px)", "@media screen");
}

function loadSheets(...sheets: readonly string[]): void {
  unloadSheets();
  for (const css of sheets) {
    const style = document.createElement("style");
    style.setAttribute("data-cascade", "");
    style.textContent = css;
    document.head.append(style);
  }
}

function unloadSheets(): void {
  for (const style of [...document.head.querySelectorAll("style[data-cascade]")]) style.remove();
}

describe("shell-02: the CARDS treatment group does not pose as a live control", () => {
  it("freezes every treatment pill in ARIA, not natively, and says why in words", () => {
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    for (const id of TREATMENT_IDS) {
      expect(pill(id).disabled, id).toBe(false);
      expect(pill(id).getAttribute("aria-disabled"), id).toBe("true");
      expect(pill(id).getAttribute("aria-label"), id).toContain("not available yet");
    }
  });

  it("keeps the frozen pills focusable, so the reason can be reached without a mouse", () => {
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    for (const id of TREATMENT_IDS) {
      pill(id).focus();
      expect(document.activeElement, id).toBe(pill(id));
    }
  });

  it("describes each pill with the same reason the SOON chip gives the mouse", () => {
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    const reason = screen.getByTestId("cr.shell.treatment.unavailable").getAttribute("title") ?? "";
    expect(reason).not.toBe("");
    for (const id of TREATMENT_IDS) {
      const describedBy = pill(id).getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(describedBy)?.textContent, id).toBe(reason);
    }
  });

  it("carries the product's SOON marker beside the CARDS label", () => {
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    expect(screen.getByTestId("cr.shell.treatment.unavailable").textContent).toBe("SOON");
  });

  it("keeps the pinned pressed state while refusing the press, by pointer and by key", async () => {
    const user = userEvent.setup();
    const onTreatment = vi.fn();
    renderBar({ onTreatment, onToggleProof: vi.fn() });

    await user.click(pill("ledger"));
    pill("ledger").focus();
    await user.keyboard("{Enter} ");
    expect(onTreatment).not.toHaveBeenCalled();
    expect(pill("compact").getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves the Proof toggle live (the freeze is scoped to the dead group)", async () => {
    const user = userEvent.setup();
    const onToggleProof = vi.fn();
    renderBar({ onTreatment: vi.fn(), onToggleProof });

    await user.click(screen.getByTestId("cr.shell.proof.toggle"));
    expect(onToggleProof).toHaveBeenCalledTimes(1);
  });
});

describe("shell-02: the bar's corrections outrank the shell's base rules in either sheet order", () => {
  it.each(ORDERS)("paints the frozen pills as frozen - %s", (_, order) => {
    loadSheets(...order);
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    for (const id of TREATMENT_IDS) {
      const style = getComputedStyle(pill(id));
      expect(style.cursor, id).toBe("not-allowed");
      expect(Number(style.opacity), id).toBeLessThan(1);
    }
  });

  it.each(ORDERS)("keeps the live accent ink off the held choice - %s", (_, order) => {
    // Control first: the shell alone paints the held choice in its live ink, so
    // the difference measured next is the correction's doing.
    loadSheets(SHELL_CSS);
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    const liveInk = getComputedStyle(pill("compact")).color;
    expect(liveInk).not.toBe("");
    cleanup();

    loadSheets(...order);
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    expect(getComputedStyle(pill("compact")).color).not.toBe(liveInk);
  });

  it.each(ORDERS)("drops the frozen group below 980px - %s", (_, order) => {
    loadSheets(...order.map(atNarrowViewport));
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    expect(getComputedStyle(treatmentGroup()).display).toBe("none");
  });

  it.each(ORDERS)("keeps the group on a wide screen - %s", (_, order) => {
    loadSheets(...order);
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    expect(getComputedStyle(treatmentGroup()).display).toBe("flex");
  });

  it("hides the spoken reason the way assistive technology can still read it", () => {
    loadSheets(SHELL_CSS, BAR_CSS);
    renderBar({ onTreatment: vi.fn(), onToggleProof: vi.fn() });
    const reason = document.getElementById(pill("compact").getAttribute("aria-describedby") ?? "");
    if (reason === null) throw new Error("no element carries the pill's description");
    const style = getComputedStyle(reason);
    expect(style.position).toBe("absolute");
    expect(style.getPropertyValue("clip-path")).toBe("inset(50%)");
    expect(style.width).toBe("1px");
    expect(style.height).toBe("1px");
  });
});
