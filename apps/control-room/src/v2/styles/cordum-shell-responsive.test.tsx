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
 * chips vanished while the cards below kept showing twelve of them. And it hid
 * the nav badge the same way, as "decoration" - but that badge is the SOON chip,
 * the one thing that explains an item that will not press, or a daemon-authored
 * count; `display: none` would drop a wired count out of the name without trace.
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

/** The badge selector exactly as the sheet writes it: a chip INSIDE a nav item. */
const NAV_BADGE = ".cr2-navitem .cr2-statuschip";

describe("the narrow rail keeps every name it stops drawing", () => {
  const narrow = mediaBlock("(max-width: 980px)");

  it("parses a real breakpoint, so an empty block cannot pass quietly", () => {
    expect(narrow.get(".cr2-shell")?.["grid-template-columns"]).toBe("64px minmax(0, 1fr)");
    expect(narrow.size).toBeGreaterThan(3);
  });

  it("never removes a nav label, a nav badge or the chip legend from the page", () => {
    const gone = hiddenBy(narrow, "display", "none");
    expect(gone).not.toContain(".cr2-navlabel");
    expect(gone).not.toContain(NAV_BADGE);
    expect(gone).not.toContain(".cr2-legend");
    expect(gone).not.toContain(".cr2-brand-name");
  });

  it.each([".cr2-navlabel", NAV_BADGE])("hides %s the way assistive technology can still read it", (selector) => {
    const rule = narrow.get(selector) ?? {};
    expect(rule.position).toBe("absolute");
    expect(rule["clip-path"]).toBe("inset(50%)");
    expect(rule.width).toBe("1px");
    expect(rule.height).toBe("1px");
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
    const goals = screen.getByRole("button", { name: "Goals" });
    expect(goals).toBe(screen.getByTestId("cr.nav.goals"));
    const label = goals.querySelector(".cr2-navlabel");
    expect(label?.textContent).toBe("Goals");
    expect(goals.getAttribute("aria-label")).toBeNull();
    expect(goals.textContent).toContain("Goals");
  });

  it("targets the badge of an item that will not press, which keeps a visible title", () => {
    // No onNavigate: every non-active item is disabled and wears the product's
    // SOON chip. The chip must be what NAV_BADGE selects, and at 64px the item
    // still has to explain itself by some visible route - its title.
    render(<CordumShell title="Goals" />);
    const approvals = screen.getByTestId("cr.nav.resources");
    expect(approvals.hasAttribute("disabled")).toBe(true);
    const badge = approvals.querySelector(".cr2-statuschip");
    expect(badge).not.toBeNull();
    expect(badge?.textContent?.trim()).not.toBe("");
    expect([...document.querySelectorAll(NAV_BADGE)]).toContain(badge);
    // `?? ""` first: an ABSENT title is null, and `null?.trim()` is undefined, which
    // `not.toBe("")` accepted - the very mutant this arm exists to catch.
    expect(approvals.getAttribute("title") ?? "").toMatch(/\S/u);
  });

  it("keeps a daemon-supplied count inside the button's own text, which is its name", () => {
    render(
      <CordumShell navBadges={{ resources: { count: "7", tone: "info" } }} onNavigate={() => undefined}
        title="Goals" />,
    );
    const approvals = screen.getByTestId("cr.nav.resources");
    const badge = approvals.querySelector(".cr2-statuschip");
    expect([...document.querySelectorAll(NAV_BADGE)]).toContain(badge);
    expect(badge?.textContent).toBe("7");
    // No aria-label: the name is the content, so a hidden-not-removed badge is in it.
    expect(approvals.getAttribute("aria-label")).toBeNull();
    expect(approvals.textContent).toContain("not available yet");
    expect(approvals.textContent).toContain("7");
    expect(screen.getByRole("button", { name: /Resources.*not available yet.*7/iu }))
      .toBe(approvals);
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
