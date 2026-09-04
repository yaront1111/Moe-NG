import { createContext, useContext } from "react";
import type { JSX, ReactNode } from "react";

import type { ProviderPauseView } from "../../live/live-ops.js";

/**
 * The one shell-wide provider-pause fact. The app polls /health/read once and
 * publishes the answer here; the status strip reads it today, and the Seats panel
 * and the board next-step read the same value later. No consumer polls its own
 * copy - two pollers would disagree for up to a poll interval and the shell would
 * contradict itself between screens.
 *
 * Fail-safe: `null` means NO PAUSE IS KNOWN. It is not a claim that the fleet is
 * running - an unwrapped screen (a unit test, a stray mount) and a refused health
 * answer both read `null`, and a consumer must render nothing rather than assert
 * either way. A screen rendered with no provider above it never crashes.
 */

/** The pause exactly as /health/read stated it; the decoder's shape, unaltered. */
export type ProviderPause = ProviderPauseView;

const PauseContext = createContext<ProviderPause | null>(null);

export function ProviderPauseProvider(props: {
  readonly children: ReactNode;
  readonly value: ProviderPause | null;
}): JSX.Element {
  return (
    <PauseContext.Provider value={props.value}>
      {props.children}
    </PauseContext.Provider>
  );
}

/** The pause the app last read, or `null` when none is known. */
export function useProviderPause(): ProviderPause | null {
  return useContext(PauseContext);
}

/**
 * The one sentence the shell says about a pause, so the strip, the Seats panel and
 * the board next-step cannot word it three different ways. The instant is the
 * daemon's, rendered in the viewer's own locale; one this box cannot parse is shown
 * RAW, never as "Invalid Date" and never dropped - hiding a live pause behind a
 * formatting miss is the one thing this line must not do. Same idiom as
 * `agentsWords` on the Health screen.
 */
export function pauseWords(paused: ProviderPause): string {
  const at = Date.parse(paused.resetAt);
  const when = Number.isNaN(at) ? paused.resetAt : new Date(at).toLocaleString();
  return `Agents paused: ${paused.provider} limit, resumes ${when}`;
}
