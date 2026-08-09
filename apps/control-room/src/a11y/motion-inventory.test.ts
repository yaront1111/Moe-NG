import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * SOURCE-TEXT PIN, deliberately. jsdom 30.0.1 implements neither `window.matchMedia`
 * nor media-query evaluation, and `document.styleSheets.length` is 0 because Vitest
 * stubs the CSS import, so no assertion here may be driven by an actual
 * `prefers-reduced-motion` match. Every arm reads stylesheet source from disk.
 *
 * The property is that motion is GATED, never that motion is ABSENT. A guard banning
 * motion outright would forbid legitimate accessible UI and would have to be weakened
 * the moment anyone added a transition — the guard-rot this file exists to prevent.
 *
 * `import.meta.url` is converted directly, with no relative `new URL(".", base)` step:
 * under jsdom the global `URL` resolves a relative specifier against the document base
 * and yields `http://localhost:3000/...`, which `fileURLToPath` then rejects.
 */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A hop-counted scan root narrows silently when a file moves: every assertion over the
 * smaller set still passes. The root basename, the named-stylesheet set and the floor
 * below are three independent ways for that narrowing to fail loudly instead.
 */
const MINIMUM_STYLESHEETS = 13;
const REQUIRED_STYLESHEETS = Object.freeze([
  "shell/shell-layout.css",
  "styles/chrome.css",
  "styles/control-room.css",
  "styles/responsive.css",
  "styles/shell.css",
  "styles/surfaces.css",
]);

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";
const IMPORT_ROOT = "styles/control-room.css";
const GLOBAL_RESET = "styles/responsive.css";

/** The universal reset wins on `!important`, so an imported sheet needs no block of its own. */
const GLOBAL_RESET_DECLARATIONS = Object.freeze([
  "animation-duration: 0.01ms !important",
  "animation-iteration-count: 1 !important",
  "scroll-behavior: auto !important",
  "transition-duration: 0.01ms !important",
]);

/**
 * Pinned to what each block ACTUALLY declares. `approval-layout.css` carries no
 * `scroll-behavior` and says why in its own comment ("Motion only: animation and
 * transition. Deliberately NOT scroll-snap"); pinning a line it does not have would
 * make this guard red against correct production code.
 */
const SAME_FILE_BLOCKS = Object.freeze([
  Object.freeze({
    declarations: Object.freeze(["animation: none", "transition: none"]),
    stylesheet: "approvals/approval-layout.css",
  }),
  Object.freeze({
    declarations: Object.freeze(["scroll-behavior: auto", "animation: none", "transition: none"]),
    stylesheet: "board/board-layout.css",
  }),
  Object.freeze({
    declarations: Object.freeze(["animation: none", "scroll-behavior: auto", "transition: none"]),
    stylesheet: "shell/shell-layout.css",
  }),
]);

const MOTION_DECLARATION = /(?:^|[;{\s])(?:transition|animation)\s*:\s*([^;}]+)/gu;
const KEYFRAMES = /@keyframes\s+[\w-]+/gu;
const UNIVERSAL_SELECTOR = /\*,\s*\*::before,\s*\*::after/u;

/**
 * The half the CSS reset provably CANNOT reach: overriding `animation-duration` and
 * `transition-duration` does nothing to a requestAnimationFrame loop or a Web Animations
 * `element.animate()` call, so these must be ABSENT where CSS motion is merely gated.
 *
 * `setTimeout`/`setInterval` are deliberately NOT banned: live/live-board-feed.ts and
 * live/live-event-feed.ts use `setTimeout` for feed reconnect BACKOFF, not animation, so
 * a blanket timer ban would go red on correct code and then have to be weakened.
 */
const JS_MOTION_TOKENS = Object.freeze([
  ".animate(",
  "framer-motion",
  "react-spring",
  "requestAnimationFrame",
]);

/** 63 production sources measured; a floor well under that catches a broken scan root. */
const MINIMUM_SOURCES = 40;

interface MotionViolation {
  readonly code: "MOTION_WITHOUT_REDUCED_MOTION_GATE";
  readonly stylesheet: string;
}

interface ScriptMotionViolation {
  readonly code: "JS_DRIVEN_MOTION";
  readonly source: string;
  readonly token: string;
}

function stylesheets(): readonly string[] {
  return readdirSync(SRC_ROOT, { encoding: "utf8", recursive: true })
    .filter((entry) => entry.endsWith(".css"))
    .map((entry) => entry.split(sep).join("/"))
    .sort();
}

function read(relativePath: string): string {
  return readFileSync(join(SRC_ROOT, ...relativePath.split("/")), "utf8");
}

/** Comments name `transition` and `animation` in prose; stripping them keeps the count honest. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/**
 * Motion only when it MOVES something: `transition: none` is a suppression, and
 * `transition-duration` / `animation-iteration-count` never match at all because the
 * hyphen defeats the `\s*:` that must follow the keyword.
 */
function motionDeclarations(css: string): readonly string[] {
  const source = withoutComments(css);
  const found = [...source.matchAll(KEYFRAMES)].map((match) => match[0]);
  for (const match of source.matchAll(MOTION_DECLARATION)) {
    const value = (match[1] ?? "").trim();
    if (value !== "none") found.push(match[0].trim());
  }
  return found;
}

function reducedMotionBlock(css: string): string {
  const start = css.indexOf(REDUCED_MOTION);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start; index < css.length; index += 1) {
    const character = css[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return "";
}

/**
 * An imported sheet inherits the universal reset; a component-side sheet does not. Both
 * halves are checked: being imported into `control-room.css` only reaches the reset while
 * `control-room.css` itself still imports it. Checking only the first half would leave
 * this arm green after the reset import was deleted — measured, not assumed.
 */
function reachesGlobalReset(relativePath: string): boolean {
  const prefix = "styles/";
  if (!relativePath.startsWith(prefix)) return false;
  const root = read(IMPORT_ROOT);
  if (!root.includes(`@import "./${GLOBAL_RESET.slice(prefix.length)}"`)) return false;
  return root.includes(`@import "./${relativePath.slice(prefix.length)}"`);
}

function motionBearing(): readonly string[] {
  return stylesheets().filter((sheet) => motionDeclarations(read(sheet)).length > 0);
}

/** Tests and fixtures are excluded: they name the banned tokens in order to ban them. */
function productionSources(): readonly string[] {
  return readdirSync(SRC_ROOT, { encoding: "utf8", recursive: true })
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .map((entry) => entry.split(sep).join("/"))
    .filter((entry) => !entry.includes(".test.") && !entry.includes("fixtures"))
    .sort();
}

describe("motion inventory is gated rather than banned", () => {
  it("discovers every control-room stylesheet without a narrowed scan root", () => {
    expect(basename(SRC_ROOT)).toBe("src");
    const sheets = stylesheets();
    expect(sheets.length).toBeGreaterThanOrEqual(MINIMUM_STYLESHEETS);
    for (const required of REQUIRED_STYLESHEETS) expect(sheets).toContain(required);
  });

  it("counts a non-zero motion inventory before asserting anything about it", () => {
    const counted = stylesheets().flatMap((sheet) => motionDeclarations(read(sheet)));
    // A sweep that silently matches nothing must not pass: everything below is vacuous
    // unless real motion exists to be gated.
    expect(counted.length).toBeGreaterThanOrEqual(5);
    expect(motionBearing().length).toBeGreaterThan(0);
  });

  it("gates every motion-bearing stylesheet by its own block or the global reset", () => {
    const bearing = motionBearing();
    // Self-guarding: without this the loop below passes by never meeting a stylesheet.
    expect(bearing.length).toBeGreaterThan(0);
    const violations: MotionViolation[] = [];
    for (const sheet of bearing) {
      const gated = read(sheet).includes(REDUCED_MOTION) || reachesGlobalReset(sheet);
      if (!gated) violations.push(Object.freeze({
        code: "MOTION_WITHOUT_REDUCED_MOTION_GATE",
        stylesheet: sheet,
      }));
    }
    expect(violations).toEqual([]);
  });

  it("pins the global reset that neutralises every imported stylesheet", () => {
    const reset = reducedMotionBlock(read(GLOBAL_RESET));
    expect(reset).not.toBe("");
    expect(reset).toMatch(UNIVERSAL_SELECTOR);
    for (const declaration of GLOBAL_RESET_DECLARATIONS) expect(reset).toContain(declaration);
  });

  it("proves the global reset is loaded rather than dead code", () => {
    expect(read(IMPORT_ROOT)).toContain('@import "./responsive.css"');
  });

  it("pins each same-file block so it cannot be hollowed out silently", () => {
    for (const pinned of SAME_FILE_BLOCKS) {
      const block = reducedMotionBlock(read(pinned.stylesheet));
      expect(block).not.toBe("");
      for (const declaration of pinned.declarations) expect(block).toContain(declaration);
    }
  });

  it("bans smooth scrolling in every stylesheet", () => {
    const smooth = stylesheets().filter((sheet) => read(sheet).includes("scroll-behavior: smooth"));
    expect(smooth).toEqual([]);
  });

  it("bans JS-driven motion, which no stylesheet reset can neutralise", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThanOrEqual(MINIMUM_SOURCES);
    const violations: ScriptMotionViolation[] = [];
    for (const source of sources) {
      const text = read(source);
      for (const token of JS_MOTION_TOKENS) {
        if (text.includes(token)) {
          violations.push(Object.freeze({ code: "JS_DRIVEN_MOTION", source, token }));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps backoff timers legal so the JS ban cannot rot into a weakened guard", () => {
    // Positive assertion: these two setTimeout call sites are feed backoff, not animation.
    // If a future guard banned timers wholesale it would fail here rather than ship.
    expect(read("live/live-board-feed.ts")).toContain("setTimeout(");
    expect(read("live/live-event-feed.ts")).toContain("setTimeout(");
    expect(JS_MOTION_TOKENS).not.toContain("setTimeout");
    expect(JS_MOTION_TOKENS).not.toContain("setInterval");
  });

  it("leaves scroll-snap alone, which section 4.16 column behaviour depends on", () => {
    // Asserted positively: a future guard that banned scroll-snap as "motion" would
    // fight the narrow-mode board and fails here instead of shipping.
    const board = read("board/board-layout.css");
    expect(board).toContain("scroll-snap-type");
    expect(board).toContain("scroll-snap-align");
  });
});

/*
 * NOT APPLICABLE, recorded with the measured reason. None of these is written as a
 * passing assertion over zero cases, and none is an `it.skip` — a skipped test reads as
 * green while proving nothing. The one arm below exists so the record cannot rot.
 *
 * (a) WCAG AA CONTRAST — not "no colour exists to measure". 65 colour literals were
 *     measured across exactly six stylesheets (tokens.css 39, chrome.css 8, shell.css 6,
 *     surfaces.css 5, inspector.css 4, responsive.css 1). It is ALREADY COVERED: styles/
 *     design-system.test.ts asserts contrast(...) >= 4.5 over the primary text pairs and
 *     over every filled tone. Duplicating it here would be a second opinion with no
 *     second authority, and styles/ is not an owned path so it is not edited either.
 *
 * (b) THE GRAPH HALF of section 11.1 bullet 1 (edges carry pattern + arrowheads, the
 *     critical path carries weight + pattern) — genuinely not applicable: no graph
 *     surface exists, and CR-J1-002 forbids mounting one. criticalPath is not colour-only
 *     today regardless: board/board-card.tsx renders it as the text-labelled CARD_FACTS
 *     entry ["criticalpath", "Critical path", ...] through FactRow.
 *
 * (c) cr.banner.revision and cr.graph.refusal DO NOT EXIST, and no placeholder may be
 *     created to give a sweep something to find. cr.banner.circuitbreaker, which the task
 *     description also called absent, DOES exist and is covered by banner-politeness.test.tsx.
 */
describe("the not-applicable record cannot quietly become false", () => {
  it("still finds zero cr.banner.revision and zero cr.graph.refusal in production", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThanOrEqual(MINIMUM_SOURCES);
    const shipped = sources.filter((source) => {
      const text = read(source);
      return text.includes("cr.banner.revision") || text.includes("cr.graph.refusal");
    });
    // If either ships, this goes red and the (c) record above must be rewritten rather
    // than staying true-by-absence forever.
    expect(shipped).toEqual([]);
  });

  it("still finds the contrast coverage that (a) defers to", () => {
    const designSystem = read("styles/design-system.test.ts");
    expect(designSystem).toContain("toBeGreaterThanOrEqual(4.5)");
    expect(designSystem).toContain('contrast("#ffffff"');
  });
});
