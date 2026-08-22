import { StrictMode } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { resolveLiveSetupFromBuild } from "./live/live-app.js";
import { ClockProvider } from "./performance/command-latency.js";
import type { Clock } from "./performance/command-latency.js";
import { resolveShellMode } from "./shell-mode.js";
import { ShellModeRoot } from "./shell-mode-view.js";
import { CordumApp } from "./v2/cordum-app.js";

/** The element id the served document supplies; nothing else is assumed to exist. */
export const CONTROL_ROOM_ROOT_ELEMENT_ID = "root";

/**
 * The application's one real time source. This is the composition root, and it is the
 * only production module that reads a host clock at all: everything under
 * `src/performance/**` takes time as an injected value so it stays deterministic in tests.
 *
 * A MONOTONIC clock, deliberately, not a wall clock. Every consumer measures an elapsed
 * span, and a wall clock can be stepped backwards by an NTP correction mid-command — that
 * would turn a normal wait into a negative interval and make the UI say it cannot measure
 * something it was measuring perfectly well. The monotonic reading cannot go backwards, so
 * the TIMING_NEGATIVE_INTERVAL refusal stays reserved for what it is meant to catch:
 * genuine skew between the daemon's clock and this client's.
 *
 * The origin is arbitrary (it counts from page load), which is exactly why nothing here
 * compares it against a daemon timestamp — the two are different scales.
 */
export const BROWSER_CLOCK: Clock = Object.freeze({
  now: (): number => performance.now(),
});

/**
 * The daemon is the DEFAULT: a credentialed build attaches to it with no flag at
 * all. Frozen fixtures are behind an explicit `?fixtures=1` and render under a
 * banner saying so, and a build with no credentials gets a notice naming what is
 * missing — never fixtures standing in silently for live data.
 *
 * No URL flag carries a secret; credentials arrive via Vite env into headers
 * only. See `shell-mode.ts` for the decision and `shell-mode-view.tsx` for what
 * each arm paints.
 */
function chooseRoot(): JSX.Element {
  const search = globalThis.location?.search ?? "";
  // The v2 Cordum rebuild lives alongside v1 behind an explicit ?v2=1, so the
  // existing LIVE / FIXTURES / CONFIG_NOTICE arms (and the e2e board-chain guard)
  // are untouched. This branch is orthogonal to the shell-mode tri-state.
  if (new URLSearchParams(search).get("v2") === "1") {
    return <CordumApp search={search} />;
  }
  const setup = resolveLiveSetupFromBuild();
  const mode = resolveShellMode(search, setup);
  return <ShellModeRoot mode={mode} setup={setup} />;
}

/** Mounts the application into a caller-supplied container and returns its root. */
export function mountControlRoom(container: Element, clock: Clock = BROWSER_CLOCK): Root {
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <ClockProvider clock={clock}>
        {chooseRoot()}
      </ClockProvider>
    </StrictMode>,
  );
  return root;
}

const container = document.getElementById(CONTROL_ROOM_ROOT_ELEMENT_ID);
if (container === null) {
  // Refuse loudly with a stable code. Skipping the mount would leave a blank page
  // and no reason, which is the one failure mode an operator cannot diagnose.
  throw new Error(
    `CONTROL_ROOM_ROOT_MISSING: the served document must supply #${CONTROL_ROOM_ROOT_ELEMENT_ID}`,
  );
}
mountControlRoom(container);
