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
  "v2/styles/cordum-shell.css",
  "v2/styles/cordum-tokens.css",
  "v2/styles/cordum-goals.css",
  "v2/styles/cordum-board.css",
  "v2/styles/product-home.css",
  "v2/projects/project-home.css",
]);

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

/**
 * The shell-wide gate: `cordum-shell.css` neutralises every animation and transition under
 * `.cr2-shell`, and every screen renders inside that frame. It is loaded by the shell
 * component itself, which is what the "rather than dead code" arm below pins.
 */
const SHELL_GATE = "v2/styles/cordum-shell.css";
const SHELL_COMPONENT = "v2/shell/cordum-shell.tsx";
const SHELL_GATE_IMPORT = 'import "../styles/cordum-shell.css"';

/**
 * Pinned to what each block ACTUALLY declares. v2 has no `@import` aggregator: every
 * motion-bearing sheet carries its own block, and each is pinned to the lines it has, not
 * to a common template — pinning a line a sheet does not declare would make this guard red
 * against correct production code.
 */
const SAME_FILE_BLOCKS = Object.freeze([
  Object.freeze({
    declarations: Object.freeze([
      "animation: none !important", "transition-duration: 1ms !important",
    ]),
    stylesheet: "v2/styles/cordum-shell.css",
  }),
  Object.freeze({
    declarations: Object.freeze(["transition: none"]),
    stylesheet: "v2/styles/cordum-board.css",
  }),
  Object.freeze({
    declarations: Object.freeze(["animation: none", "transition: none"]),
    stylesheet: "v2/styles/cordum-goals.css",
  }),
  Object.freeze({
    declarations: Object.freeze(["transition: none"]),
    stylesheet: "v2/styles/product-home.css",
  }),
  Object.freeze({
    declarations: Object.freeze(["transition: none"]),
    stylesheet: "v2/projects/project-home.css",
  }),
]);

const MOTION_DECLARATION = /(?:^|[;{\s])(?:transition|animation)\s*:\s*([^;}]+)/gu;
const KEYFRAMES = /@keyframes\s+[\w-]+/gu;

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

/** Well over a hundred production sources remain after the v1 removal; a floor well under that catches a broken scan root. */
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

  it("gates every motion-bearing stylesheet by its own block", () => {
    const bearing = motionBearing();
    // Self-guarding: without this the loop below passes by never meeting a stylesheet.
    expect(bearing.length).toBeGreaterThan(0);
    const violations: MotionViolation[] = [];
    for (const sheet of bearing) {
      if (!read(sheet).includes(REDUCED_MOTION)) violations.push(Object.freeze({
        code: "MOTION_WITHOUT_REDUCED_MOTION_GATE",
        stylesheet: sheet,
      }));
    }
    expect(violations).toEqual([]);
  });

  it("proves the shell-wide gate is loaded rather than dead code", () => {
    expect(reducedMotionBlock(read(SHELL_GATE))).toContain(".cr2-shell *");
    expect(read(SHELL_COMPONENT)).toContain(SHELL_GATE_IMPORT);
  });

  it("pins each same-file block so it cannot be hollowed out silently", () => {
    for (const pinned of SAME_FILE_BLOCKS) {
      const block = reducedMotionBlock(read(pinned.stylesheet));
      expect(block, pinned.stylesheet).not.toBe("");
      for (const declaration of pinned.declarations) {
        expect(block, `${pinned.stylesheet}: ${declaration}`).toContain(declaration);
      }
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
});

/*
 * NOT APPLICABLE, recorded with the measured reason. None of these is written as a
 * passing assertion over zero cases, and none is an `it.skip` — a skipped test reads as
 * green while proving nothing. The arms below exist so the record cannot rot.
 *
 * (a) WCAG AA CONTRAST — not "no colour exists to measure". It is ALREADY COVERED:
 *     v2/styles/cordum-contrast.test.ts resolves every token in cordum-tokens.css and
 *     asserts contrast >= AA_SMALL_TEXT (4.5) over the text pairs and every filled tone.
 *     Duplicating it here would be a second opinion with no second authority.
 *
 * (b) THE GRAPH HALF of section 11.1 bullet 1 (edges carry pattern + arrowheads, the
 *     critical path carries weight + pattern) — genuinely not applicable: no graph
 *     surface exists, and CR-J1-002 forbids mounting one.
 *
 * (c) cr.banner.revision and cr.graph.refusal DO NOT EXIST, and no placeholder may be
 *     created to give a sweep something to find.
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
    const contrast = read("v2/styles/cordum-contrast.test.ts");
    expect(contrast).toContain("AA_SMALL_TEXT = 4.5");
    expect(contrast).toContain("toBeGreaterThanOrEqual(AA_SMALL_TEXT)");
  });
});
