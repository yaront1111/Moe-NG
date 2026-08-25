import { StrictMode } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { resolveLiveSetupFromBuild } from "./live/live-app.js";
import { resolveLiveSetupFromHandshake } from "./live/live-handshake.js";
import type { LiveHandshakeResult } from "./live/live-handshake.js";
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
 * The Cordum v2 rebuild is the DEFAULT front door: it acquires its credential at
 * RUNTIME through the daemon handshake (no baked secret), and `?fixtures=1` renders
 * its frozen design view under a banner. The legacy v1 shell-mode board is demoted
 * behind an explicit `?v1=1`, kept so its build-time LIVE / FIXTURES / CONFIG_NOTICE
 * arms and the daemon e2e lane still have a home while the rebuild finishes.
 *
 * No URL flag carries a secret; v2 credentials arrive via the handshake and v1's
 * via Vite env into headers only. See `shell-mode.ts` for the v1 decision.
 */
function chooseRoot(
  search: string,
  liveSetup: Promise<LiveHandshakeResult> | undefined,
): JSX.Element {
  if (new URLSearchParams(search).get("v1") === "1") {
    const setup = resolveLiveSetupFromBuild();
    const mode = resolveShellMode(search, setup);
    return <ShellModeRoot mode={mode} setup={setup} />;
  }
  return <CordumApp liveSetup={liveSetup} search={search} />;
}

/**
 * Starts one browser-created pairing request before React can replay a lifecycle.
 * Both StrictMode effect passes observe this same promise, while fixtures and the
 * legacy v1 route retain their exact pre-pairing composition.
 */
function prepareV2LiveSetup(search: string): Promise<LiveHandshakeResult> | undefined {
  const params = new URLSearchParams(search);
  if (params.get("v1") === "1" || params.get("fixtures") === "1") return undefined;
  return resolveLiveSetupFromHandshake({
    fetchImpl: (input, init) => fetch(input, init),
  });
}

/** Mounts the application into a caller-supplied container and returns its root. */
export function mountControlRoom(container: Element, clock: Clock = BROWSER_CLOCK): Root {
  const search = globalThis.location?.search ?? "";
  // Fragments carry no authority. Remove any stale fragment before preparing
  // the request or constructing renderable state, without parsing or retaining it.
  if (window.location.hash !== "") {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  const liveSetup = prepareV2LiveSetup(search);
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <ClockProvider clock={clock}>
        {chooseRoot(search, liveSetup)}
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
/** Exported so integration tests can dispose the production root and its live polling. */
export const MOUNTED_CONTROL_ROOM_ROOT = mountControlRoom(container);
