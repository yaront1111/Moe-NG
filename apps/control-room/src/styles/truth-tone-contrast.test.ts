import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { auditTruthClassMonochrome } from "../a11y/surface-audit.js";
import { TRUTH_TONE_COLOUR_SCHEMES, TRUTH_TONE_TOKENS } from "./truth-tone-tokens.js";
import type { TruthToneColourScheme } from "./truth-tone-tokens.js";

/**
 * WCAG AA certification for the truth-chip colour layer (spec section 11.1 line 686).
 *
 * WHY THIS PARSES CSS AS TEXT. jsdom evaluates no CSS and `document.styleSheets.length`
 * is 0 here, so a rendered element's computed style would report nothing. The values are
 * therefore resolved from the real stylesheet bytes, and every parse asserts it produced
 * declarations BEFORE anything is measured — a sweep over an empty token set must fail,
 * not pass quietly.
 *
 * WHY IT DOES NOT RESTATE COLOURS. `design-system.test.ts:63-71` computes contrast over
 * hex written inside the test body, which proves only that the test agrees with itself.
 * Every ratio below is measured from the hex that `tokens.css` actually declares, reached
 * through `TRUTH_TONE_TOKENS`. The only hex literals in this file are a deliberately
 * broken fixture and two shape regexes; no expected production colour is written here.
 *
 * REDUCED MOTION, and why no @media block was added. DoD 6 asks for two things that
 * cannot both hold: "the only stylesheet edits are token declarations" AND "every
 * stylesheet carrying tokens also carries a @media (prefers-reduced-motion: reduce)
 * block". tokens.css carries tokens and has no such block, so adding one would be a
 * stylesheet edit that is not a token declaration. governor-42b952c9 already ratified the
 * resolution at 18:37Z on task-4b274fadc (governors channel msg-f91f6d76788e4ceb82fe19d7b35e3bf8):
 * this app gates motion with ONE global universal reset, and "do not require a
 * same-stylesheet @media block". Coverage holds by import — control-room.css:1 imports
 * tokens.css and control-room.css:11 imports responsive.css, whose universal reset at
 * responsive.css:152-160 neutralises animation and transition with !important, which
 * beats cascade order across every sheet in the bundle. tokens.css also declares zero
 * motion: --cr-ease (tokens.css:35) is a timing-function VALUE that no rule there applies.
 * The committed guard a11y/motion-inventory.test.ts already asserts the reset exists, is
 * universal, carries every neutralising declaration and is actually imported (:211-217),
 * so this file REFERENCES it rather than duplicating a second opinion with no second
 * authority. This task edits no stylesheet at all.
 */

const STYLES_DIRECTORY = resolve(process.cwd(), "src/styles");
const DARK_SCHEME_QUERY = "@media (prefers-color-scheme: dark)";
const CHIP_BASE_RULE = 'button[data-testid^="cr.chip."] {';
const CUSTOM_PROPERTY = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gu;
const TONE_RULE = /\[data-tone="([^"]+)"\]\s*\{\s*background:\s*var\((--[a-z0-9-]+)\)/gu;
/** Case-insensitive deliberately. The repo writes lowercase hex throughout, but a future
 *  `#FFFFFF` is a valid colour, and a checker that goes red on letter case would be a
 *  false alarm rather than a contrast finding. `luminance` parses either case already. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/iu;

/** AA for normal text. Chips are 0.58rem bold (surfaces.css:7-8) — not large text, so
 *  the 3:1 large-text/non-text allowance does not apply to any pair certified here. */
const AA_NORMAL_TEXT = 4.5;

function braceBlock(css: string, fromIndex: number): string {
  if (fromIndex < 0) return "";
  const open = css.indexOf("{", fromIndex);
  if (open < 0) return "";
  let depth = 0;
  for (let cursor = open; cursor < css.length; cursor += 1) {
    if (css[cursor] === "{") depth += 1;
    else if (css[cursor] === "}" && (depth -= 1) === 0) return css.slice(open + 1, cursor);
  }
  return "";
}

function customProperties(block: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const [, name, value] of block.matchAll(CUSTOM_PROPERTY)) {
    if (name !== undefined && value !== undefined) declarations.set(name, value.trim());
  }
  return declarations;
}

interface ParsedTokens {
  readonly light: ReadonlyMap<string, string>;
  /** `light` with the dark-scheme block applied on top. */
  readonly dark: ReadonlyMap<string, string>;
  /** Only the declarations the dark block actually overrides. */
  readonly darkOverrides: ReadonlyMap<string, string>;
}

export function parseTokenSheet(css: string): ParsedTokens {
  const light = customProperties(braceBlock(css, css.indexOf(":root")));
  const darkMedia = braceBlock(css, css.indexOf(DARK_SCHEME_QUERY));
  const darkOverrides = customProperties(braceBlock(darkMedia, darkMedia.indexOf(":root")));
  const dark = new Map(light);
  for (const [name, value] of darkOverrides) dark.set(name, value);
  return { light, dark, darkOverrides };
}

/** Maps each prose `TruthSemanticTone` to the custom property its chip fill reads. */
export function parseToneRules(css: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (const [, tone, property] of css.matchAll(TONE_RULE)) {
    if (tone !== undefined && property !== undefined) rules.set(tone, property);
  }
  return rules;
}

/** The `color:` on the chip base rule. The leading `[;{]` boundary is required: a bare
 *  `color:` match would otherwise bind to `border-color` (surfaces.css:2). */
export function parseChipForeground(css: string): string | undefined {
  const block = braceBlock(css, css.indexOf(CHIP_BASE_RULE));
  return /(?:^|[;{])\s*color:\s*([^;]+);/u.exec(block)?.[1]?.trim().toLowerCase();
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return 0.2126 * channel(channels[0] ?? 0)
    + 0.7152 * channel(channels[1] ?? 0)
    + 0.0722 * channel(channels[2] ?? 0);
}

function contrast(left: string, right: string): number {
  const [bright, dim] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return ((bright ?? 0) + 0.05) / ((dim ?? 0) + 0.05);
}

export type ContrastViolationCode =
  | "CR-CONTRAST-001"
  | "CR-CONTRAST-002"
  | "CR-CONTRAST-003";

export interface ContrastViolation {
  readonly code: ContrastViolationCode;
  readonly tone: string;
  /** Measured ratio for CR-CONTRAST-002. 0 where no pair could be measured at all. */
  readonly ratio: number;
}

export interface ContrastCertification {
  readonly scheme: TruthToneColourScheme;
  readonly checked: number;
  readonly violations: readonly ContrastViolation[];
}

function violation(code: ContrastViolationCode, tone: string, ratio: number): ContrastViolation {
  return Object.freeze({ code, tone, ratio });
}

/**
 * Certifies every tone declared in `TRUTH_TONE_TOKENS` against resolved production values.
 * `resolved` is the token map for one colour scheme; `declared` is what `surfaces.css`
 * actually wires each prose tone to.
 */
export function certifyTruthToneContrast(
  scheme: TruthToneColourScheme,
  resolved: ReadonlyMap<string, string>,
  declared: ReadonlyMap<string, string>,
): ContrastCertification {
  const violations: ContrastViolation[] = [];
  let checked = 0;
  for (const [tone, pair] of Object.entries(TRUTH_TONE_TOKENS)) {
    checked += 1;
    if (declared.get(tone) !== pair.background) {
      violations.push(violation("CR-CONTRAST-003", tone, 0));
      continue;
    }
    const background = resolved.get(pair.background);
    const foreground = resolved.get(pair.foreground);
    if (background === undefined || foreground === undefined) {
      violations.push(violation("CR-CONTRAST-001", tone, 0));
      continue;
    }
    const ratio = contrast(foreground, background);
    if (ratio < AA_NORMAL_TEXT) violations.push(violation("CR-CONTRAST-002", tone, ratio));
  }
  for (const tone of declared.keys()) {
    if (!(tone in TRUTH_TONE_TOKENS)) violations.push(violation("CR-CONTRAST-003", tone, 0));
  }
  return Object.freeze({ scheme, checked, violations: Object.freeze(violations) });
}

const TOKENS = parseTokenSheet(readFileSync(join(STYLES_DIRECTORY, "tokens.css"), "utf8"));
const SURFACES_CSS = readFileSync(join(STYLES_DIRECTORY, "surfaces.css"), "utf8");
const DECLARED_TONES = parseToneRules(SURFACES_CSS);
const CHIP_FOREGROUND = parseChipForeground(SURFACES_CSS);

function resolvedFor(scheme: TruthToneColourScheme): ReadonlyMap<string, string> {
  return scheme === "dark" ? TOKENS.dark : TOKENS.light;
}

describe("truth tone WCAG AA certification", () => {
  it("resolves live token values from tokens.css and keeps tones scheme-independent", () => {
    // Pins the it.each sweep below: an emptied scheme list would generate zero cases and
    // the suite would shrink silently rather than fail.
    expect([...TRUTH_TONE_COLOUR_SCHEMES]).toEqual(["light", "dark"]);
    expect(TOKENS.light.size).toBeGreaterThan(0);
    expect(TOKENS.darkOverrides.size).toBeGreaterThan(0);
    for (const pair of Object.values(TRUTH_TONE_TOKENS)) {
      expect(TOKENS.light.get(pair.background)).toMatch(HEX_COLOUR);
      expect(TOKENS.light.get(pair.foreground)).toMatch(HEX_COLOUR);
    }
    // Deliberate, not accidental: the dark block overrides no truth tone, so every chip
    // pair is byte-identical across schemes. An override added later must be certified.
    expect([...TOKENS.darkOverrides.keys()].filter((name) => name.startsWith("--cr-truth-")))
      .toEqual([]);
  });

  it("reads the chip tone rules and the chip foreground out of surfaces.css", () => {
    expect(DECLARED_TONES.size).toBe(5);
    expect(CHIP_FOREGROUND).toMatch(HEX_COLOUR);
    // Licenses naming --cr-white as the mapped foreground while surfaces.css:5 still
    // writes the literal. Asserted rather than assumed, and no stylesheet is edited.
    expect(CHIP_FOREGROUND).toBe(TOKENS.light.get("--cr-white")?.toLowerCase());
    expect(CHIP_FOREGROUND).toBe(TOKENS.dark.get("--cr-white")?.toLowerCase());
  });

  it("maps every TruthSemanticTone exactly once, with no tone and no rule left over", () => {
    expect(Object.keys(TRUTH_TONE_TOKENS).sort()).toEqual([
      "amber", "blue", "green", "high-contrast magenta", "neutral slate",
    ]);
    const fromStylesheet = Object.fromEntries(DECLARED_TONES);
    const fromTypedMap = Object.fromEntries(
      Object.entries(TRUTH_TONE_TOKENS).map(([tone, pair]) => [tone, pair.background]),
    );
    expect(fromStylesheet).toEqual(fromTypedMap);
  });

  it.each([...TRUTH_TONE_COLOUR_SCHEMES])(
    "certifies every declared truth tone at WCAG AA in %s mode",
    (scheme) => {
      const result = certifyTruthToneContrast(scheme, resolvedFor(scheme), DECLARED_TONES);
      expect(result).toEqual({ scheme, checked: 5, violations: [] });
      expect(result.checked).toBeGreaterThan(0);
      expect(result.checked).toBe(DECLARED_TONES.size);
    },
  );

  it("reports CR-CONTRAST-002 with the measured ratio when a tone falls below AA", () => {
    const washedOut = new Map(TOKENS.light);
    washedOut.set("--cr-truth-verified", "#d8f5ec");
    const result = certifyTruthToneContrast("light", washedOut, DECLARED_TONES);
    expect(result.checked).toBe(5);
    expect(result.violations).toHaveLength(1);
    const [only] = result.violations;
    expect(only?.code).toBe("CR-CONTRAST-002");
    expect(only?.tone).toBe("green");
    // A real measurement, not a sentinel: rules out a contrast() that returns a constant.
    expect(only?.ratio).toBeGreaterThan(1);
    expect(only?.ratio).toBeLessThan(AA_NORMAL_TEXT);
  });

  it("reports CR-CONTRAST-001 when a declared tone resolves to no token", () => {
    const missing = new Map(TOKENS.light);
    missing.delete("--cr-truth-human");
    expect(certifyTruthToneContrast("light", missing, DECLARED_TONES))
      .toEqual({
        scheme: "light",
        checked: 5,
        violations: [{ code: "CR-CONTRAST-001", tone: "blue", ratio: 0 }],
      });
  });

  it("reports CR-CONTRAST-003 in both drift directions", () => {
    const rewired = new Map(DECLARED_TONES);
    rewired.set("amber", "--cr-truth-verified");
    expect(certifyTruthToneContrast("light", TOKENS.light, rewired).violations)
      .toEqual([{ code: "CR-CONTRAST-003", tone: "amber", ratio: 0 }]);

    const unmapped = new Map(DECLARED_TONES);
    unmapped.set("teal", "--cr-truth-verified");
    expect(certifyTruthToneContrast("light", TOKENS.light, unmapped).violations)
      .toEqual([{ code: "CR-CONTRAST-003", tone: "teal", ratio: 0 }]);
  });

  it("fails closed when a stylesheet parse yields nothing", () => {
    expect(parseTokenSheet("").light.size).toBe(0);
    expect(parseToneRules("").size).toBe(0);
    expect(parseChipForeground("")).toBeUndefined();
    const empty = certifyTruthToneContrast("light", new Map(), new Map());
    expect(empty.checked).toBe(5);
    expect(empty.violations.map((entry) => entry.code))
      .toEqual(Array.from({ length: 5 }, () => "CR-CONTRAST-003"));
  });

  it("adds colour as a fourth channel without weakening the monochrome predicate", () => {
    // The DoD calls this "CR-A11Y-001"; that code does not exist in the repo. The real
    // committed predicate is auditTruthClassMonochrome (../a11y/surface-audit.ts:187),
    // which compares [glyph, shortLabel, borderStyle] and excludes semanticTone — which
    // is exactly why a colour layer cannot substitute for the other three channels.
    expect(auditTruthClassMonochrome()).toEqual({ checked: 5, violations: [] });
  });
});
