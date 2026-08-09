import type { TruthSemanticTone } from "@moe/control-room-model";

/**
 * The semanticTone-to-token mapping the WCAG certification derives from.
 *
 * Spec section 11.1 line 686 requires "Contrast >= WCAG AA". A contrast ratio needs two
 * RESOLVED colours, and `TruthSemanticTone` is a prose union ("amber", "green", ...) that
 * NAMES a colour without being one. This module is the missing link: it says which CSS
 * custom property each prose tone resolves through, so `truth-tone-contrast.test.ts` can
 * follow the chain into `tokens.css` and measure a real ratio.
 *
 * Values are CUSTOM PROPERTY NAMES, never hex. Hex lives in `tokens.css` and nowhere else.
 * Restating it here would rebuild the very defect this layer exists to remove: a table
 * inside the checker proves only that the checker agrees with itself.
 *
 * Colour is the THIRD encoding channel, never a replacement for the other two. Spec
 * section 3.1 requires glyph + short label + colour, all surviving monochrome. The
 * committed `auditTruthClassMonochrome` (../a11y/surface-audit.ts) compares only
 * [glyph, shortLabel, borderStyle] and deliberately excludes semanticTone, which is why
 * adding this layer cannot weaken it. The contrast test asserts that predicate still
 * returns { checked: 5, violations: [] }.
 */
export interface TruthToneTokenPair {
  /** Custom property carrying the chip fill, e.g. `--cr-truth-observed`. */
  readonly background: string;
  /** Custom property carrying the text drawn on that fill. */
  readonly foreground: string;
}

/**
 * `Record<TruthSemanticTone, ...>` is load-bearing, not decoration: it is the build-time
 * arm of the exhaustiveness requirement. Adding a sixth member to the union makes `tsc`
 * fail here on the missing key, so a tone can never default silently to an uncoloured or
 * uncertified chip. Step 7 of this task proves that by adding a temporary sixth member
 * and confirming `pnpm --filter @moe/control-room typecheck` goes red.
 *
 * FOREGROUND NOTE: `surfaces.css:5` writes the literal `color: #ffffff` on the chip base
 * rule rather than `var(--cr-white)`. Naming `--cr-white` here is therefore a claim, and
 * the contrast test discharges it by asserting the parsed chip colour resolves EQUAL to
 * the parsed `--cr-white`. That keeps this mapping honest without editing `surfaces.css`,
 * which this task must not do.
 */
export const TRUTH_TONE_TOKENS: Record<TruthSemanticTone, TruthToneTokenPair> = Object.freeze({
  "neutral slate": Object.freeze({
    background: "--cr-truth-observed",
    foreground: "--cr-white",
  }),
  amber: Object.freeze({
    background: "--cr-truth-agent",
    foreground: "--cr-white",
  }),
  green: Object.freeze({
    background: "--cr-truth-verified",
    foreground: "--cr-white",
  }),
  blue: Object.freeze({
    background: "--cr-truth-human",
    foreground: "--cr-white",
  }),
  "high-contrast magenta": Object.freeze({
    background: "--cr-truth-unknown",
    foreground: "--cr-white",
  }),
});

/**
 * Colour schemes the certification runs over. `tokens.css` carries one
 * `@media (prefers-color-scheme: dark)` block, so a token resolves to at most two values
 * and every declared tone must clear AA in BOTH. Running the sweep per mode keeps the
 * checked count equal to the number of declared tones, which is what the count assertion
 * compares against.
 */
export const TRUTH_TONE_COLOUR_SCHEMES = Object.freeze(["light", "dark"] as const);

export type TruthToneColourScheme = (typeof TRUTH_TONE_COLOUR_SCHEMES)[number];
