import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CordumShell } from "../shell/cordum-shell.js";

/**
 * What the shell does to itself below 980px, and why it may not use display:none
 * on a name.
 *
 * THE DEFECT. `@media (max-width: 980px)` collapsed the rail to 64px and hid
 * `.cr2-navlabel` with `display: none`. That does not just hide the word - it
 * removes it from the accessibility tree, and the icon is aria-hidden, so the one
 * live destination shipped as a button with NO accessible name at all (measured
 * on the served bundle at 820px and 390px: `cr.nav.goals` -> name ""). The same
 * list hid `.cr2-legend` outright, so the key that explains the OBS/AGT/VER/HUM/UNK
 * chips vanished while the cards below kept showing twelve of them.
 *
 * HOW IT IS MEASURED. jsdom applies no @media rule at all, so the breakpoint is
 * read from the stylesheet bytes: the block is parsed into selectors and
 * declarations, and the assertions are about PROPERTIES, not substrings. The
 * companion render proves the selectors are not dead - that a real nav button
 * contains a real `.cr2-navlabel`, and that its text is the button's accessible
 * name, which is the thing `display: none` was destroying.
 */

const CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-shell.css"), "utf8");

type Block = ReadonlyMap<string, Readonly<Record<string, string>>>;

/** The declarations of one @media block, keyed by single selector. */
function mediaBlock(query: string): Block {
  const source = CSS.replace(/\/\*[\s\S]*?\*\//gu, "");
  const start = source.indexOf(`@media ${query}`);
  if (start < 0) throw new Error(`no @media ${query} block in cordum-shell.css`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let close = open;
  for (; close < source.length; close += 1) {
    if (source[close] === "{") depth += 1;
    else if (source[close] === "}" && (depth -= 1) === 0) break;
  }
  const body = source.slice(open + 1, close);
  const rules = new Map<string, Record<string, string>>();
  for (const [, selectors = "", declarations = ""] of body.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const props: Record<string, string> = {};
    for (const declaration of declarations.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0) props[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    for (const selector of selectors.split(",")) {
      rules.set(selector.trim(), { ...rules.get(selector.trim()), ...props });
    }
  }
  return rules;
}

function hiddenBy(block: Block, property: string, value: string): readonly string[] {
  return [...block].filter(([, props]) => props[property] === value).map(([selector]) => selector);
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(cleanup);

describe("the narrow rail keeps every name it stops drawing", () => {
  const narrow = mediaBlock("(max-width: 980px)");

  it("parses a real breakpoint, so an empty block cannot pass quietly", () => {
    expect(narrow.get(".cr2-shell")?.["grid-template-columns"]).toBe("64px minmax(0, 1fr)");
    expect(narrow.size).toBeGreaterThan(3);
  });

  it("never removes a nav label or the chip legend from the page", () => {
    const gone = hiddenBy(narrow, "display", "none");
    expect(gone).not.toContain(".cr2-navlabel");
    expect(gone).not.toContain(".cr2-legend");
    expect(gone).not.toContain(".cr2-brand-name");
  });

  it("hides the label the way assistive technology can still read it", () => {
    const label = narrow.get(".cr2-navlabel") ?? {};
    expect(label.position).toBe("absolute");
    expect(label["clip-path"]).toBe("inset(50%)");
    expect(label.width).toBe("1px");
    expect(label.height).toBe("1px");
    // The absolute label needs a containing block, or it escapes the 64px rail.
    expect(narrow.get(".cr2-navitem")?.position).toBe("relative");
  });

  it("keeps the chip key on screen as a column of chips without their prose", () => {
    expect(narrow.get(".cr2-legend")?.display).toBe("flex");
    for (const selector of [".cr2-legend-lede", ".cr2-legend-name"]) {
      expect(hiddenBy(narrow, "display", "none"), selector).toContain(selector);
    }
  });

  it("targets a label that actually exists, and it is the button's whole name", () => {
    render(<CordumShell onNavigate={() => undefined} title="Goals" />);
    const goals = screen.getByTestId("cr.nav.goals");
    const label = goals.querySelector(".cr2-navlabel");
    expect(label?.textContent).toBe("Goals");
    expect(goals.getAttribute("aria-label")).toBeNull();
    expect(goals.textContent).toContain("Goals");
  });
});

describe("the phone breakpoint gives the page back to the goals", () => {
  const phone = mediaBlock("(max-width: 560px)");

  it("trims the chrome that framed the board instead of the content", () => {
    expect(phone.get(".cr2-shell .cr2-contextbar")?.padding).toBe("10px 16px");
    expect(phone.get(".cr2-shell .cr2-main")?.padding).toBe("12px 14px 20px");
    // A 220px minimum on the title column forced the Proof control onto its own
    // row at 390px, on top of the two rows the treatment group already took.
    expect(phone.get(".cr2-context-lead")?.["min-width"]).toBe("0");
  });
});
