import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * WCAG AA for the Cordum palette, measured from the stylesheet bytes.
 *
 * WHAT WAS WRONG. The chip fills and connection tones were lifted from the design
 * export and never measured: the white "AGT" glyph rode an amber at 2.99:1 and
 * "HUM" a blue at 3.68:1; the LAGGING relay - the one state that says something is
 * going wrong - printed at 2.61:1 on the page and 2.31:1 on its own chip wash;
 * `--cr-faint` (every use of it in v2 is 9-10px text) sat at 2.14:1; and the
 * disabled primary button was the enabled one at `opacity: .5`, which is a white
 * label on a washed teal at 2.10:1 - it read as "loading", not "not allowed".
 *
 * THE RULE. Every colour this palette paints as SMALL text clears 4.5:1 on every
 * ground it is painted on. Chips are 9-10px (`--cr-fs-mono` / `--cr-fs-micro`), so
 * the 3:1 large-text allowance never applies here.
 *
 * NO EXPECTED COLOURS LIVE IN THIS FILE. Every ratio is computed from the hex
 * `cordum-tokens.css` actually declares, reached by token NAME, and the status
 * chip's wash percentage is read out of `cordum-shell.css` rather than restated -
 * so raising the wash to 30% re-measures instead of quietly passing. The only hex
 * literals below are in the self-check that proves the maths agrees with the
 * published WCAG examples.
 */

const TOKENS_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-tokens.css"), "utf8");
const SHELL_CSS = readFileSync(resolve(process.cwd(), "src/v2/styles/cordum-shell.css"), "utf8");

const AA_SMALL_TEXT = 4.5;
const CHIP_FILLS = ["--cr-truth-observed", "--cr-truth-agent", "--cr-truth-verified",
  "--cr-truth-human", "--cr-truth-unknown"] as const;
/** Tokens a `.cr2-statuschip` paints as text on a tint of itself. */
const STATUS_TONES = ["--cr-conn-connected", "--cr-conn-lagging", "--cr-conn-disconnected",
  "--cr-conn-historical", "--cr-conn-offline", "--cr-truth-human-deep", "--cr-danger"] as const;
/** Opaque grounds the shell paints text on; the worst of them has to hold. */
const GROUNDS = ["--cr-bg-base", "--cr-surface", "--cr-wash"] as const;

type Scheme = "light" | "dark";

function block(css: string, fromIndex: number): string {
  const open = css.indexOf("{", fromIndex);
  if (open < 0) return "";
  let depth = 0;
  for (let cursor = open; cursor < css.length; cursor += 1) {
    if (css[cursor] === "{") depth += 1;
    else if (css[cursor] === "}" && (depth -= 1) === 0) return css.slice(open + 1, cursor);
  }
  return "";
}

function declarations(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name = "", value = ""] of source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
    found.set(name, value.trim());
  }
  return found;
}

function palette(scheme: Scheme): ReadonlyMap<string, string> {
  const light = declarations(block(TOKENS_CSS, TOKENS_CSS.indexOf(":root")));
  if (scheme === "light") return light;
  const darkMedia = block(TOKENS_CSS, TOKENS_CSS.indexOf("@media (prefers-color-scheme: dark)"));
  const resolved = new Map(light);
  for (const [name, value] of declarations(block(darkMedia, darkMedia.indexOf(":root")))) {
    resolved.set(name, value);
  }
  return resolved;
}

const PALETTE: Readonly<Record<Scheme, ReadonlyMap<string, string>>> = {
  light: palette("light"),
  dark: palette("dark"),
};

function hex(scheme: Scheme, token: string): string {
  const value = PALETTE[scheme].get(token);
  if (value === undefined || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new Error(`${token} is not a plain hex in the ${scheme} palette: ${String(value)}`);
  }
  return value;
}

function channel(byte: number): number {
  const unit = byte / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function bytes(colour: string): readonly number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(colour.slice(offset, offset + 2), 16));
}

function luminance(colour: string): number {
  const [red = 0, green = 0, blue = 0] = bytes(colour);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

export function contrast(left: string, right: string): number {
  const [bright, dim] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return ((bright ?? 0) + 0.05) / ((dim ?? 0) + 0.05);
}

/** `color-mix(in srgb, <fill> <share>%, transparent)` composited over `ground`. */
function mix(fill: string, ground: string, share: number): string {
  const [f, g] = [bytes(fill), bytes(ground)];
  return `#${[0, 1, 2]
    .map((index) => Math.round((f[index] ?? 0) * share + (g[index] ?? 0) * (1 - share)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The declarations of one top-level rule of cordum-shell.css. */
function ruleProps(selector: string): Readonly<Record<string, string>> {
  const source = SHELL_CSS.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: Record<string, string> = {};
  for (const [, selectors = "", body = ""] of source.matchAll(/([^{}@]+)\{([^{}]*)\}/gu)) {
    if (!selectors.split(",").map((one) => one.trim()).includes(selector)) continue;
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0) found[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return found;
}

/** The tint the status chip actually paints behind its own label. */
function statusChipWash(): number {
  const share = /color-mix\([^;]*?(\d+(?:\.\d+)?)%/u.exec(ruleProps(".cr2-statuschip").background ?? "")?.[1];
  if (share === undefined) throw new Error("no color-mix wash found on .cr2-statuschip");
  return Number.parseFloat(share) / 100;
}

const SCHEMES: readonly Scheme[] = ["light", "dark"];

describe("the Cordum palette is measured, not eyeballed", () => {
  it("agrees with the published WCAG reference ratios", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("reads both palettes off the sheet, so an empty parse cannot pass quietly", () => {
    expect(PALETTE.light.size).toBeGreaterThan(30);
    expect(PALETTE.dark.get("--cr-ink")).not.toBe(PALETTE.light.get("--cr-ink"));
    expect(statusChipWash()).toBeGreaterThan(0);
    expect(statusChipWash()).toBeLessThan(1);
  });

  it.each(SCHEMES)("carries a readable glyph on every truth chip fill (%s)", (scheme) => {
    for (const fill of CHIP_FILLS) {
      const ratio = contrast(hex(scheme, "--cr-chip-ink"), hex(scheme, fill));
      expect(ratio, `${fill} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it.each(SCHEMES)("keeps every status tone readable on the page and on its own wash (%s)", (scheme) => {
    const share = statusChipWash();
    for (const tone of STATUS_TONES) {
      const ink = hex(scheme, tone);
      for (const ground of GROUNDS) {
        const behind = hex(scheme, ground);
        const plain = contrast(ink, behind);
        const washed = contrast(ink, mix(ink, behind, share));
        expect(plain, `${tone} on ${ground} ${plain.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
        expect(washed, `${tone} on its wash over ${ground} ${washed.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      }
    }
  });

  it.each(SCHEMES)("keeps the quietest ink an ink you can still read (%s)", (scheme) => {
    // Every v2 use of --cr-faint is small text (project instance ids, board
    // meta), so it is a text colour with a text colour's floor - not a hairline.
    for (const ground of GROUNDS) {
      const ratio = contrast(hex(scheme, "--cr-faint"), hex(scheme, ground));
      expect(ratio, `--cr-faint on ${ground} ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it.each(SCHEMES)("states the disabled button's own colours instead of fading it (%s)", (scheme) => {
    const disabled = ruleProps(".cr2-btn:disabled");
    // A half-transparent primary button reads as "loading". A refused control
    // must look refused - and still be legible while it is refused.
    expect(disabled.opacity).toBe("1");
    expect(disabled.cursor).toBe("not-allowed");
    const token = (value: string | undefined): string =>
      /var\((--[a-z0-9-]+)\)/u.exec(value ?? "")?.[1] ?? "";
    const ratio = contrast(hex(scheme, token(disabled.color)), hex(scheme, token(disabled.background)));
    expect(ratio, `disabled label ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });
});
