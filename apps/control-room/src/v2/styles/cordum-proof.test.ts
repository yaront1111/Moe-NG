import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * SOURCE-TEXT PIN, deliberately. jsdom 30 evaluates no media queries and Vitest
 * stubs the CSS import outright (`document.styleSheets.length` is 0), so no
 * assertion here can be driven by a computed style. Every arm reads the sheet from
 * disk, the way `shell/shell-narrow.test.tsx` and `a11y/motion-inventory.test.ts`
 * already do for the rules jsdom cannot reach.
 *
 * The property under test is that the open proof drawer REFLOWS the stage instead
 * of floating over it. As first shipped, `.cr2-proof` was
 * `position: absolute; inset: 0 0 0 auto; width: 330px` inside a `.cr2-stage` that
 * stayed `display: block`, so `.cr2-main` never narrowed: the goal card kept its
 * full width and its "Open board" button, budget chip and committed count were
 * covered by the drawer and unreachable by pointer.
 *
 * cordum-shell.css is owned by another lane, so these rules live in a sheet of
 * their own and win on specificity (0,3,0 against 0,1,0) rather than load order.
 */

const CSS_PATH = resolve(process.cwd(), "src/v2/styles/cordum-proof.css");
const TSX_PATH = resolve(process.cwd(), "src/v2/shell/proof-inspector.tsx");
const CSS = readFileSync(CSS_PATH, "utf8");
const TSX = readFileSync(TSX_PATH, "utf8");

const STAGE_RULE = '.cr2-shell[data-inspector="open"] .cr2-stage';
const DRAWER_RULE = '.cr2-shell[data-inspector="open"] .cr2-stage > .cr2-proof';
const MAIN_RULE = '.cr2-shell[data-inspector="open"] .cr2-stage > .cr2-main';
const OVERLAY_BREAKPOINT = "@media (max-width: 980px)";

interface Rule {
  readonly selectors: readonly string[];
  readonly props: Readonly<Record<string, string>>;
}

/** Strip comments, then split every `selector { prop: value; }` block. */
function rules(css: string): readonly Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: Rule[] = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const props: Record<string, string> = {};
    for (const declaration of (match[2] ?? "").split(";")) {
      const at = declaration.indexOf(":");
      if (at < 0) continue;
      props[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim();
    }
    found.push({
      props,
      selectors: (match[1] ?? "").split(",").map((one) => one.trim()).filter((one) => one !== ""),
    });
  }
  return found;
}

/**
 * The body of the first `@media` block opened by `query`, and the sheet with that
 * block cut out. The parser above cannot see nesting, so a rule inside the media
 * block would otherwise shadow the wide rule it overrides (or the other way
 * round, depending on which comes first); each half is read on its own.
 */
function splitAtMedia(css: string, query: string): { readonly inside: string; readonly outside: string } {
  const at = css.indexOf(query);
  const open = at < 0 ? -1 : css.indexOf("{", at);
  if (open < 0) return { inside: "", outside: css };
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) {
      return { inside: css.slice(open + 1, index), outside: css.slice(0, at) + css.slice(index + 1) };
    }
  }
  return { inside: css.slice(open + 1), outside: css.slice(0, at) };
}

const BREAK_AT = CSS.indexOf(OVERLAY_BREAKPOINT);
const { inside: NARROW, outside: WIDE } = splitAtMedia(CSS, OVERLAY_BREAKPOINT);

/** Every block in `source` whose selector list names `selector` exactly. */
function blocksFor(selector: string, source: string): readonly Rule[] {
  return rules(source).filter((rule) => rule.selectors.includes(selector));
}

function propOf(selector: string, property: string, source: string = WIDE): string | undefined {
  for (const block of blocksFor(selector, source)) {
    const value = block.props[property];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Split a `grid-template-columns` value into tracks; a `minmax(...)` is one track. */
function tracks(value: string | undefined): readonly string[] {
  return value?.match(/[^\s(]+(?:\([^)]*\))?/gu) ?? [];
}

describe("the proof drawer stylesheet is real and loaded", () => {
  it("parses a non-trivial sheet rather than passing over an empty file", () => {
    expect(CSS.length).toBeGreaterThan(400);
    // Self-guard: every assertion below is vacuous if the parser matches nothing.
    expect(rules(CSS).length).toBeGreaterThanOrEqual(4);
  });

  it("is imported by the component it styles, so it is not dead bytes on disk", () => {
    expect(TSX).toContain('import "../styles/cordum-proof.css";');
  });
});

describe("an open proof drawer reflows the stage instead of covering the card", () => {
  it("turns the stage into a main column plus a drawer column", () => {
    expect(propOf(STAGE_RULE, "display")).toBe("grid");
    // Two tracks, not a substring of one: a single-track grid would drop the
    // drawer into an implicit second ROW under main, which is worse than the
    // overlay this sheet exists to replace.
    const columns = tracks(propOf(STAGE_RULE, "grid-template-columns"));
    expect(columns).toHaveLength(2);
    // Main takes what is left and may shrink below its content; the drawer is fixed.
    expect(columns[0]).toMatch(/^minmax\(0,\s*1fr\)$/u);
    expect(columns[1]).toMatch(/^\d+px$/u);
  });

  it("puts the drawer in normal flow, so nothing sits underneath it", () => {
    expect(propOf(DRAWER_RULE, "position")).toBe("static");
    expect(propOf(DRAWER_RULE, "max-width")).toBe("none");
  });

  it("lets the narrowed main column keep scrolling its own content", () => {
    expect(propOf(MAIN_RULE, "min-width")).toBe("0");
    expect(propOf(MAIN_RULE, "overflow")).toBe("auto");
  });
});

describe("below the reflow breakpoint the drawer is an overlay with a way out", () => {
  it("returns the drawer to an overlay where two columns will not fit", () => {
    expect(BREAK_AT).toBeGreaterThan(-1);
    // The overlay rules must come after the reflow rules, inside the breakpoint.
    expect(CSS.indexOf(STAGE_RULE)).toBeLessThan(BREAK_AT);
    expect(NARROW).not.toBe("");
    // The stage gives up its drawer column and the drawer itself floats again -
    // this drawer, not whichever rule happens to be absolute after the breakpoint.
    expect(tracks(propOf(STAGE_RULE, "grid-template-columns", NARROW))).toHaveLength(1);
    expect(propOf(DRAWER_RULE, "position", NARROW)).toBe("absolute");
    // Same width beside main as over it, so the drawer never changes size on resize.
    expect(propOf(DRAWER_RULE, "width", NARROW))
      .toBe(tracks(propOf(STAGE_RULE, "grid-template-columns"))[1]);
  });

  it("paints a scrim behind the overlay so the covered column reads as blocked", () => {
    expect(propOf(".cr2-proof-scrim", "position")).toBe("absolute");
    expect(propOf(".cr2-proof-scrim", "background")).toContain("--cr-scrim");
  });
});

describe("the drawer's own controls are large enough to hit", () => {
  it("gives the close control a 28px target without redrawing the glyph", () => {
    expect(propOf(".cr2-proof .cr2-proof-close", "min-width")).toBe("28px");
    expect(propOf(".cr2-proof .cr2-proof-close", "min-height")).toBe("28px");
  });
});
