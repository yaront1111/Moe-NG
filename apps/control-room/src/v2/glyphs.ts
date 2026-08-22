/**
 * Every non-ASCII character the v2 UI renders, spelled as a `\uXXXX` escape so the
 * source stays pure ASCII (the Windows shell tooling mangles raw non-ASCII bytes,
 * and the design export itself uses escapes for the same reason). The escape is
 * ASCII in the file; the runtime string carries the real character.
 *
 * Punctuation and shell affordances live here; the truth-class glyphs live with
 * their mapping in `truth-class.ts`.
 */

/** RIGHTWARDS ARROW - "Open board ->", "Open receipt ->". */
export const ARROW_RIGHT = "\u2192";
/** MIDDLE DOT - inline separator, e.g. "PROJECT . MOE-NG". */
export const MIDDOT = "\u00b7";
/** EM DASH. */
export const EMDASH = "\u2014";
/** HORIZONTAL ELLIPSIS. */
export const ELLIPSIS = "\u2026";
/** MULTIPLICATION SIGN - the inspector close affordance. */
export const TIMES = "\u00d7";
/** EN DASH - the "collapse" caret on the legend toggle. */
export const ENDASH = "\u2013";
/** LEFTWARDS ARROW - the "<- GOALS" breadcrumb back link. */
export const ARROW_LEFT = "\u2190";
