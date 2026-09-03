import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CordumShell } from "../shell/cordum-shell.js";

/**
 * Where the four panel rows go, and why the status strip must not float.
 *
 * THE DEFECT. `.cr2-panel` declares `grid-template-rows: auto auto minmax(0,1fr)
 * auto` and relied on AUTO-PLACEMENT to fill them: context bar, banner slot,
 * stage, strip. But the banner slot is empty in the healthy state - ConnectionBanner
 * renders null while the relay is CONNECTED (status-strip.tsx) - and
 * `.cr2-bannerslot:empty { display: none }` then removes it as a grid item. Every
 * later child shifts up one row: the stage lands in an `auto` row (so it grows to
 * its content and never scrolls) and the STRIP inherits `minmax(0,1fr)`. On a
 * short page that stretched row parks "EVENT RELAY" in the middle of the screen
 * (03-goals-home.png, y=718 of 960); on a tall one the panel outgrows the shell's
 * `100dvh; overflow: hidden` and the strip - plus the bottom of the list - is
 * clipped away with nothing left to scroll (19-mobile-fixtures.png, 390x844).
 *
 * WHAT THIS TEST CAN SEE. jsdom runs no layout, so a pinned strip cannot be
 * measured here. It CAN read the cascade, and the defect is a cascade fact: the
 * row a child occupies was inferred from its siblings instead of stated. So each
 * child's `grid-row` is asserted explicitly, and asserted to be the SAME whether
 * the banner is rendered or not - which is precisely the invariant auto-placement
 * broke. The 1fr shell row is asserted the same way. Real layout was confirmed
 * separately against the daemon-hosted bundle.
 */

const SHELL_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-shell.css"), "utf8");

interface Rows { readonly bar: string; readonly slot: string; readonly stage: string; readonly strip: string }

function panelRows(root: HTMLElement): Rows {
  const rowOf = (selector: string): string => {
    const node = root.querySelector(selector);
    if (node === null) throw new Error(`missing panel child: ${selector}`);
    const computed = window.getComputedStyle(node);
    // jsdom does not expand the `grid-row` shorthand, so read either spelling and
    // fall back to `auto` - which is exactly what auto-placement leaves behind.
    return computed.getPropertyValue("grid-row") || computed.gridRowStart;
  };
  return {
    bar: rowOf(".cr2-panel > .cr2-contextbar"),
    slot: rowOf(".cr2-panel > .cr2-bannerslot"),
    stage: rowOf(".cr2-panel > .cr2-stage"),
    strip: rowOf(".cr2-panel > .cr2-statusstrip"),
  };
}

function mount(connection: "CONNECTED" | "DISCONNECTED"): HTMLElement {
  const { container } = render(<CordumShell connection={connection} title="Goals" />);
  const style = document.createElement("style");
  style.textContent = SHELL_CSS;
  document.head.append(style);
  return container.firstElementChild as HTMLElement;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  for (const style of [...document.head.querySelectorAll("style")]) style.remove();
});

describe("the shell's four panel rows are stated, not inferred from who rendered", () => {
  it("puts the banner slot in a row of its own and the strip in the last row", () => {
    expect(panelRows(mount("DISCONNECTED"))).toEqual({ bar: "1", slot: "2", stage: "3", strip: "4" });
  });

  it("keeps every row identical when the healthy relay renders no banner at all", () => {
    const healthy = mount("CONNECTED");
    // The empty slot really is removed - this is the condition that used to shift
    // the stage and the strip up one row each.
    expect(window.getComputedStyle(healthy.querySelector(".cr2-bannerslot") as HTMLElement).display)
      .toBe("none");
    expect(panelRows(healthy)).toEqual({ bar: "1", slot: "2", stage: "3", strip: "4" });
  });

  it("holds the panel and the stage to the viewport so main is what scrolls", () => {
    const root = mount("CONNECTED");
    const shell = window.getComputedStyle(root);
    const panel = window.getComputedStyle(root.querySelector(".cr2-panel") as HTMLElement);
    expect(shell.gridTemplateRows).toBe("minmax(0, 1fr)");
    expect(shell.height).toBe("100dvh");
    expect(shell.overflow).toBe("hidden");
    expect(panel.gridTemplateRows).toBe("auto auto minmax(0, 1fr) auto");
    // Without this a grid item's automatic minimum size is its content, so a long
    // list re-inflates the panel past the shell and the strip leaves the screen.
    expect(panel.minHeight).toBe("0px");
  });

});

/** Declarations of one top-level rule, by exact selector text. */
function ruleProps(selector: string): Readonly<Record<string, string>> {
  const source = SHELL_CSS.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: Record<string, string> = {};
  for (const [, selectors = "", declarations = ""] of source.matchAll(/([^{}@]+)\{([^{}]*)\}/gu)) {
    if (!selectors.split(",").map((one) => one.trim()).includes(selector)) continue;
    for (const declaration of declarations.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0) found[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return found;
}

describe("shell controls keep their own shape and say what they do", () => {
  it("leaves each control its own corner radius when focus lands on it", () => {
    // `.cr2-shell :focus-visible` is (0,2,0) and beat every pill, chip and field:
    // tabbing to a pill re-cut it to 8px corners and blur snapped it back.
    const focus = ruleProps(".cr2-shell :focus-visible");
    expect(focus.outline).toBe("2px solid var(--cr-accent-text)");
    expect(focus["border-radius"]).toBeUndefined();
  });

  it("draws the chip legend's toggle as a disclosure that turns", () => {
    expect(ruleProps('.cr2-legend-toggle > span[aria-hidden="true"]').display).toBe("none");
    const chevron = ruleProps(".cr2-legend-toggle::before");
    expect(chevron.content).toBe('""');
    expect(chevron["border-right"]).toContain("currentColor");
    expect(chevron.transform).toContain("rotate(45deg)");
    expect(ruleProps('.cr2-legend-toggle[aria-expanded="false"]::before').transform)
      .toContain("rotate(-45deg)");
    // 9px was the whole affordance; a disclosure control needs a readable target.
    expect(ruleProps(".cr2-legend-toggle")["font-size"]).toBe("var(--cr-fs-caption)");
  });

  it("styles a toggle that carries aria-expanded and is named by its visible span alone", () => {
    const root = mount("CONNECTED");
    const toggle = root.querySelector(".cr2-legend-toggle") as HTMLElement;
    // Folded by default; the attribute is what a reader checks, not the glyph.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // The glyph this sheet hides is real text: without aria-hidden it would be
    // read out as part of the name, "- HOW TO ..." - so prove it is non-empty AND
    // that the name is exactly the other span. What that span SAYS belongs to
    // nav-rail.tsx; this sheet owns only the shape, so no copy is pinned here.
    const glyph = toggle.querySelector('span[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.textContent?.trim()).not.toBe("");
    const copy = toggle.querySelector("span:not([aria-hidden])")?.textContent?.trim() ?? "";
    expect(copy).not.toBe("");
    expect(within(root).getByRole("button", { name: copy })).toBe(toggle);
  });
});
