/**
 * DIAGNOSTIC SEVERITY, and the only ordering over it.
 *
 * Four levels, no more: an operator filtering a live daemon chooses between "everything",
 * "what happened", "what looks wrong", and "what failed". A fifth level invites call sites to
 * argue about placement instead of emitting.
 *
 * The rank is private and the comparison is a function, so a caller can never order two levels
 * by comparing the strings themselves — "error" < "warn" lexically, which is backwards.
 */

export const DIAGNOSTIC_LEVELS = Object.freeze(["debug", "info", "warn", "error"] as const);

export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

/** Ascending severity. Compared only through `admitsDiagnosticLevel`. */
const RANK: Readonly<Record<DiagnosticLevel, number>> = Object.freeze({
  debug: 0,
  error: 3,
  info: 1,
  warn: 2,
});

export function isDiagnosticLevel(value: unknown): value is DiagnosticLevel {
  return typeof value === "string" && Object.hasOwn(RANK, value);
}

/**
 * Does a sink whose threshold is `threshold` accept a record at `level`?
 *
 * Fail-open on severity, never on silence: an unrecognised threshold admits everything rather
 * than dropping the record, because a typo in a knob must not be the reason a fatal fault went
 * unrecorded. The knob reader refuses malformed values by name before this is ever reached; this
 * is the second fence behind it.
 */
export function admitsDiagnosticLevel(threshold: string, level: DiagnosticLevel): boolean {
  if (!isDiagnosticLevel(threshold)) return true;
  return RANK[level] >= RANK[threshold];
}
