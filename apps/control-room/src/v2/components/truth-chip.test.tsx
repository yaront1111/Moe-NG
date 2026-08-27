import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TruthChip } from "./truth-chip.js";

/**
 * goalshome-09 / shell-11 / truth-07: the chip is the one place a non-engineer
 * meets a truth class, and it used to introduce itself as
 * "Ready. DAEMON_VERIFIED Daemon verified press Enter for provenance." - a raw
 * daemon token plus a keyboard instruction the screen reader already gives. The
 * class code belongs behind Inspect/Proof; the chip says what it means in words.
 * The legend variant is a plain span, so its label needs a role to be announced
 * at all, and a harness needs to tell a legend entry from a clickable claim.
 *
 * goalshome-10: on a goal card the chip is the only way to open a proof, and it
 * is a 37x15px target. The sheet grows the TARGET, not the chip: a transparent
 * pseudo-element at least 24px each way, so the layout the card settled does not
 * move. jsdom lays nothing out and computes no pseudo-element, so that rule is
 * read from the sheet and bound to the rendered chip with `matches()`; the
 * on-screen size is measured on the served bundle, not here.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  unloadSheets();
});

/**
 * jsdom evaluates no @media rule, but it does resolve the cascade - specificity
 * and order - of every top-level rule in a sheet installed as a <style> node. The
 * two sheets are installed in BOTH orders because the bundle's order is decided
 * by import statements in files this chip does not own.
 */
const SHELL_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-shell.css"), "utf8");
const CHIP_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-truth-chip.css"), "utf8");
const ORDERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["shell first", [SHELL_CSS, CHIP_CSS]],
  ["chip first", [CHIP_CSS, SHELL_CSS]],
];

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

/** The chip inside the shell it ships in, so the shell's own ring rule is in play. */
function renderInShell(chip: JSX.Element): void {
  render(<div className="cr2-shell">{chip}</div>);
}

interface Rule {
  readonly selector: string;
  readonly declarations: Readonly<Record<string, string>>;
}

/** Every rule of a sheet, one entry per comma-separated selector, comments stripped. */
function rulesOf(css: string): readonly Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: Rule[] = [];
  for (const [, selectors = "", body = ""] of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const declarations: Record<string, string> = {};
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0) declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    for (const selector of selectors.split(",")) rules.push({ selector: selector.trim(), declarations });
  }
  return rules;
}

/** The sheet's declarations that reach this element (or its `::before`), merged in sheet order. */
function declaredFor(element: Element, pseudo: "" | "::before"): Readonly<Record<string, string>> {
  const merged: Record<string, string> = {};
  for (const rule of rulesOf(CHIP_CSS)) {
    const own = rule.selector.endsWith("::before");
    if (own !== (pseudo === "::before")) continue;
    if (element.matches(rule.selector.replace(/::before$/u, ""))) Object.assign(merged, rule.declarations);
  }
  return merged;
}

/**
 * The floor of a `max(...)` length: the largest px term. `max(100%, 24px)` reads
 * "never narrower than the chip, never narrower than 24px"; a value without a
 * px floor is no floor at all.
 */
function pxFloor(value: string | undefined): number {
  const args = /max\(([^)]*)\)/u.exec(value ?? "")?.[1] ?? "";
  if (!args.includes("100%")) return Number.NaN;
  const px = [...args.matchAll(/(\d+(?:\.\d+)?)px/gu)].map((match) => Number(match[1]));
  return px.length === 0 ? Number.NaN : Math.max(...px);
}

describe("goalshome-09: a truth chip says what it means, not its code", () => {
  it("names the class in words and keeps the raw code as data", () => {
    render(<TruthChip contextLabel="Ready" truthClass="DAEMON_VERIFIED" />);
    const chip = screen.getByTestId("cr.chip.daemon_verified");
    expect(chip.getAttribute("aria-label")).toBe("Ready: Daemon verified");
    expect(chip.getAttribute("aria-label")).not.toContain("DAEMON_VERIFIED");
    expect(chip.getAttribute("aria-label")).not.toContain("press Enter");
    // Inspect/Proof still reads the code: it stays on the element as data.
    expect(chip.getAttribute("data-truth-class")).toBe("DAEMON_VERIFIED");
  });

  it("speaks the provenance of an absent class without the diagnostic code", () => {
    render(<TruthChip contextLabel="Budget" />);
    const chip = screen.getByTestId("cr.chip.unknown");
    expect(chip.getAttribute("aria-label")).toContain("Budget: Unknown");
    expect(chip.getAttribute("aria-label")).toContain("class missing from payload");
  });

  it("strips the CODE prefix a malformed class carries into the spoken name", () => {
    render(<TruthChip contextLabel="Budget" truthClass="daemon_verified" />);
    const chip = screen.getByTestId("cr.chip.unknown");
    const label = chip.getAttribute("aria-label") ?? "";
    expect(label).toContain("class present but not a daemon-supplied supported value");
    expect(label).not.toContain("TRUTH_CLASS_INVALID");
  });

  it("explains the click through the tooltip instead of the accessible name", () => {
    render(<TruthChip contextLabel="Ready" truthClass="OBSERVED" />);
    const chip = screen.getByTestId("cr.chip.observed");
    expect(chip.getAttribute("title")).toContain("Observed by the daemon");
    expect(chip.getAttribute("title")).toContain("proof");
  });
});

describe("shell-11 / truth-07: legend chips announce themselves and are distinguishable", () => {
  it("gives the non-interactive legend chip a role so its label is announced", () => {
    render(<TruthChip compact interactive={false} truthClass="OBSERVED" />);
    const chip = screen.getByTestId("cr.chip.observed");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("role")).toBe("img");
    expect(chip.getAttribute("aria-label")).toBe("Observed by the daemon");
  });

  it("marks which chips are clickable, so a selector cannot land on a legend entry", () => {
    const { unmount } = render(<TruthChip interactive={false} truthClass="OBSERVED" />);
    expect(screen.getByTestId("cr.chip.observed").getAttribute("data-interactive")).toBe("false");
    unmount();

    render(<TruthChip contextLabel="Ready" truthClass="OBSERVED" />);
    expect(screen.getByTestId("cr.chip.observed").getAttribute("data-interactive")).toBe("true");
  });

  it.each(ORDERS)("resolves a focused chip's ring to a colour that is not the fill it lands on - %s", (_, order) => {
    loadSheets(...order);
    renderInShell(<TruthChip contextLabel="Ready" truthClass="OBSERVED" />);
    const chip = screen.getByTestId("cr.chip.observed");
    chip.focus();
    const style = getComputedStyle(chip);
    expect(style.outline).not.toBe("");
    // The old ring was the same teal as the accent fills it lands on.
    expect(style.outline).not.toContain("--cr-accent");
    // A halo in the surface colour, so the ink ring reads on every chip tone.
    expect(style.boxShadow).not.toBe("");
  });

  it("is correcting a real ring: the shell alone paints the accent the ring vanished on", () => {
    loadSheets(SHELL_CSS);
    renderInShell(<TruthChip contextLabel="Ready" truthClass="OBSERVED" />);
    const chip = screen.getByTestId("cr.chip.observed");
    chip.focus();
    expect(getComputedStyle(chip).outline).toContain("--cr-accent");
  });
});

describe("goalshome-10: a clickable chip is a 24px target without growing on screen", () => {
  it("gives the interactive chip a transparent hit area at least 24px each way", () => {
    render(<TruthChip contextLabel="Ready" truthClass="DAEMON_VERIFIED" />);
    const chip = screen.getByTestId("cr.chip.daemon_verified");
    const area = declaredFor(chip, "::before");
    expect(area["content"]).toBeDefined();
    expect(area["position"]).toBe("absolute");
    expect(pxFloor(area["width"])).toBeGreaterThanOrEqual(24);
    expect(pxFloor(area["height"])).toBeGreaterThanOrEqual(24);
    // An absolute pseudo-element is anchored to the chip only if the chip is positioned.
    expect(declaredFor(chip, "")["position"]).toBe("relative");
  });

  it("sizes the target, never the chip: the chip's own box keeps the shell's dimensions", () => {
    render(<TruthChip contextLabel="Ready" truthClass="DAEMON_VERIFIED" />);
    const own = declaredFor(screen.getByTestId("cr.chip.daemon_verified"), "");
    for (const property of ["padding", "margin", "width", "height", "min-width", "min-height", "font-size"]) {
      expect(own[property], property).toBeUndefined();
    }
  });

  it("gives a legend entry no hit area: it names a class, it is not a target", () => {
    render(<TruthChip interactive={false} truthClass="OBSERVED" />);
    expect(declaredFor(screen.getByTestId("cr.chip.observed"), "::before")).toEqual({});
  });
});
