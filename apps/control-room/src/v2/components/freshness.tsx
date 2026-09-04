import { useEffect, useState } from "react";
import type { JSX } from "react";

/**
 * FRESHNESS: when the daemon last answered this screen, said as time since, and whether it
 * has gone quiet. Every "3 min ago" on a screen is relative to a clock that only advances
 * when a poll succeeds, so without this line a stalled daemon reads as a frozen but healthy
 * page. The line ticks on its own clock; the last-answer instant is the screen's.
 */

/** A screen is quiet once this long has passed without an answer; two polls, roughly. */
export const QUIET_AFTER_MS = 20_000;

/** A clock that ticks every `intervalMs`, for relative times that must keep moving. */
export function useClock(intervalMs = 1_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNowMs(Date.now()); }, intervalMs);
    return (): void => { clearInterval(timer); };
  }, [intervalMs]);
  return nowMs;
}

export function freshnessWords(lastAnswerMs: number | null, nowMs: number): { readonly quiet: boolean; readonly words: string } {
  if (lastAnswerMs === null) return { quiet: false, words: "waiting for the daemon's first answer" };
  const seconds = Math.max(0, Math.round((nowMs - lastAnswerMs) / 1000));
  const since = seconds < 60 ? `${String(seconds)} s` : seconds < 3600 ? `${String(Math.round(seconds / 60))} min` : `${String(Math.round(seconds / 3600))} h`;
  if (nowMs - lastAnswerMs >= QUIET_AFTER_MS) return { quiet: true, words: `no answer from the daemon for ${since}` };
  return { quiet: false, words: `updated ${since} ago` };
}

export interface FreshnessProps {
  /** The instant the daemon last answered this screen; null before the first answer. */
  readonly lastAnswerMs: number | null;
  readonly nowMs: number;
  readonly testId?: string | undefined;
}

export function Freshness({ lastAnswerMs, nowMs, testId }: FreshnessProps): JSX.Element {
  const { quiet, words } = freshnessWords(lastAnswerMs, nowMs);
  return (
    <span
      aria-live={quiet ? "polite" : "off"}
      className="cr2-freshness"
      data-quiet={quiet ? "true" : undefined}
      data-testid={testId ?? "cr.freshness"}
      role="status"
    >
      {words}
    </span>
  );
}
