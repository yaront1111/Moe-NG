import { resolveResetInstant } from "./seat-reset-instant.js";

/**
 * WHY A SEAT EXITED, read off the provider's own words.
 *
 * A seat that exits nonzero because the account hit a provider limit is NOT a failed work item:
 * retrying it burns the item's attempts against a wall that will not move until the provider's
 * reset. This module is the one place that tells those two apart, and it does it from a FROZEN
 * roster of patterns, each written from a real captured provider line (`sample` + `capturedFrom`).
 *
 * FAIL CLOSED: anything the roster does not recognise is FAILED. A limit is never guessed, because
 * a false PROVIDER_LIMIT parks the whole provider for a wall-clock window on the strength of one
 * sentence a seat happened to print.
 *
 * Pure: no I/O, no clock. The exit instant arrives as `exitAt` so reset arithmetic is testable.
 */

export { resolveResetInstant } from "./seat-reset-instant.js";

export const SEAT_EXIT_KINDS = ["COMPLETED", "FAILED", "PROVIDER_LIMIT"] as const;

export type SeatExitKind = (typeof SEAT_EXIT_KINDS)[number];

export type SeatExitProvider = "claude" | "codex";

export type SeatExitRosterEntry = Readonly<{
  /** Where the sample line was captured — a live run, or the shipped CLI's own composer. */
  capturedFrom: string;
  id: string;
  pattern: RegExp;
  provider: SeatExitProvider;
  /** Null when the provider's line carries a DURATION rather than an instant. */
  resetOf: ((line: string, exitAt: string) => string | null) | null;
  sample: string;
}>;

export type SeatExitClassification = Readonly<{
  kind: SeatExitKind;
  /** The last non-empty tail line, or the matched line for a limit. Null when the tail was empty. */
  lastLine: string | null;
  matched: string | null;
  resetAt: string | null;
}>;

export interface SeatExitInput {
  readonly exitAt: string;
  readonly exitCode: number | null;
  readonly provider: string;
  readonly signal: string | null;
  readonly tail: readonly string[];
}

/** The provider prints at most a handful of lines after the refusal; 40 covers the epilogue. */
const TAIL_SCAN_LINES = 40;

/**
 * The frozen roster. Each pattern is anchored on a whole provider SENTENCE, never on the word
 * "limit" — a seat that prints `rate limit` inside its own JSON output must not park the provider.
 *
 * The claude entries carry `(?![.\w])` because codex's refusal contains the same clause
 * ("You've hit your usage limit. Visit ...") while claude's composer never puts a period there:
 * its suffix is "", " · resets X", " · progress saved" or " · contact your admin to increase it".
 */
export const SEAT_EXIT_ROSTER: readonly SeatExitRosterEntry[] = Object.freeze([
  Object.freeze({
    capturedFrom:
      "LIVE seat #4 exit 1, UnAI drive, 2026-09-03 21:04 Asia/Jerusalem (memory"
      + " productize-loop-2026-09-03); composer confirmed in claude.exe 2.1.260"
      + " H0() with IL.five_hour = \"session limit\".",
    id: "claude/session-limit",
    pattern: /You've hit your session limit(?![.\w])/iu,
    provider: "claude" as const,
    resetOf: resolveResetInstant,
    sample: "You've hit your session limit · resets 12:10am Asia/Jerusalem",
  }),
  Object.freeze({
    capturedFrom:
      "claude.exe 2.1.260 call site H0(\"usage limit\", v, n, {progressSavedSuffix: ...}); reset"
      + " rendered by bu() which appends \" (${Intl.DateTimeFormat().resolvedOptions().timeZone})\".",
    id: "claude/usage-limit",
    pattern: /You've hit your usage limit(?![.\w])/iu,
    provider: "claude" as const,
    resetOf: resolveResetInstant,
    sample: "You've hit your usage limit · resets 12:10am (Asia/Jerusalem)",
  }),
  Object.freeze({
    capturedFrom:
      "claude.exe 2.1.260 IL.seven_day = \"weekly limit\" through the same H0 composer; reset"
      + " rendered by bu()'s >24h branch (month/day, hour12, AM/PM lowercased).",
    id: "claude/weekly-limit",
    pattern: /You've hit your weekly limit(?![.\w])/iu,
    provider: "claude" as const,
    resetOf: resolveResetInstant,
    sample: "You've hit your weekly limit · resets Sep 8, 10:46am (Asia/Jerusalem)",
  }),
  Object.freeze({
    capturedFrom:
      "claude.exe 2.1.260 SDo(): case \"rate_limit\" returns"
      + " `Fast limit reached and temporarily disabled \\xB7 resets in ${x}`.",
    id: "claude/rate-limit",
    // A DURATION, not an instant: the pause ledger gets resetAt null and the wrapper waits a beat.
    pattern: /Fast limit reached and temporarily disabled/iu,
    provider: "claude" as const,
    resetOf: null,
    sample: "Fast limit reached and temporarily disabled · resets in 5m",
  }),
  Object.freeze({
    capturedFrom:
      "LIVE: two UnAI seats (node.deliver@kernel-redaction, node.deliver@boot-spares-a-live-held-claim)"
      + " exited 1 with this as their last line at 2026-09-05 ~17:35 Asia/Jerusalem, up.local.log"
      + " lines 1147-1148, while the account's five-hour window was exhausted. The wrapper read"
      + " both as FAILED, charged the attempts and recorded a verifier round on one of them.",
    id: "claude/rate-limit-429",
    // Anchored at the line start with the status code: a seat that merely QUOTES an API error
    // inside its own prose does not start a line with it.
    pattern: /^\s*API Error: Request rejected \(429\)/iu,
    provider: "claude" as const,
    // No instant in the line: the pause ledger falls back to its bounded default.
    resetOf: null,
    sample: "API Error: Request rejected (429) · This request would exceed your account's rate limit."
      + " Please try again later.",
  }),
  Object.freeze({
    capturedFrom:
      "LIVE `codex exec --skip-git-repo-check \"say hi\"` at 2026-09-04T17:36:55Z, codex-cli"
      + " 0.152.0, exit 1, stderr. Sentence confirmed in the shipped codex.exe.",
    id: "codex/usage-limit",
    pattern: /hit your usage limit\.\s+Visit https:\/\/chatgpt\.com\/codex/iu,
    provider: "codex" as const,
    resetOf: resolveResetInstant,
    sample:
      "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to"
      + " purchase more credits or try again at Sep 8th, 2026 10:46 AM.",
  }),
]);

function lastNonEmpty(tail: readonly string[]): string | null {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = tail[index];
    if (line !== undefined && line.trim() !== "") return line;
  }
  return null;
}

/** Exit 0 is a completed seat, whatever it printed on the way out. Otherwise: roster, then FAILED. */
export function classifySeatExit(input: SeatExitInput): SeatExitClassification {
  const lastLine = lastNonEmpty(input.tail);
  if (input.exitCode === 0) {
    return Object.freeze({ kind: "COMPLETED" as const, lastLine, matched: null, resetAt: null });
  }
  const entries = SEAT_EXIT_ROSTER.filter((entry) => entry.provider === input.provider);
  const scanned = input.tail.slice(Math.max(0, input.tail.length - TAIL_SCAN_LINES));
  for (let index = scanned.length - 1; index >= 0; index -= 1) {
    const line = scanned[index];
    if (line === undefined) continue;
    for (const entry of entries) {
      if (!entry.pattern.test(line)) continue;
      return Object.freeze({
        kind: "PROVIDER_LIMIT" as const,
        lastLine: line,
        matched: entry.id,
        resetAt: entry.resetOf === null ? null : entry.resetOf(line, input.exitAt),
      });
    }
  }
  return Object.freeze({ kind: "FAILED" as const, lastLine, matched: null, resetAt: null });
}
