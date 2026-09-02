import { StrictMode, Suspense, lazy } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { resolveProjectManagerMode } from "./entry-project-manager.js";
import { gateDevelopmentQuery } from "./entry-route.js";
import { resolveLiveSetupFromHandshake } from "./live/live-handshake.js";
import type { LiveHandshakeResult } from "./live/live-handshake.js";
import { ClockProvider } from "./performance/command-latency.js";
import type { Clock } from "./performance/command-latency.js";
import { CordumApp } from "./v2/cordum-app.js";
import type { LiveAttempts } from "./v2/cordum-app.js";
import { ProjectManagerApp } from "./v2/projects/project-manager-app.js";
import { connectProjectManager } from "./v2/projects/project-manager-client.js";
import type { ProjectManagerConnection } from "./v2/projects/project-manager-client.js";

/** The element id the served document supplies; nothing else is assumed to exist. */
export const CONTROL_ROOM_ROOT_ELEMENT_ID = "root";

/**
 * THE ONE BUILD FACT THIS MODULE READS, and it is deliberately a single constant rather
 * than a repeated `import.meta.env.DEV`. The bundler substitutes a literal `false` here for
 * a production build, which is what makes both uses below statically decidable: the query
 * gate and the legacy mount are then the SAME fact, so no build can strip the selectors at
 * runtime while still shipping the shell they select, or the reverse.
 */
const DEVELOPMENT_BUILD: boolean = import.meta.env.DEV;

/**
 * The retired v1 shell, reachable ONLY from a development build.
 *
 * DELIBERATELY A CONDITIONAL LAZY IMPORT, NOT A STATIC ONE. A static import keeps
 * `shell/frame.tsx` — and with it the `cr.shell.root` selector, the fixture banner and the
 * frozen demo corpus — inside the production bundle even when no route can reach them, so
 * the artifact is a lie about what the build can render. With `DEVELOPMENT_BUILD` folded to
 * `false`, this whole branch is dead and the module is dropped from the graph. If a future
 * bundler emits it as a separate chunk instead of eliminating it, the smoke lane's artifact
 * fence still catches it: that fence enumerates EVERY `dist/assets/*.js`, not just the entry.
 *
 * AWAITED AT MODULE EVALUATION, not at first render, and the await lives inside the dead
 * branch so a production build never emits it. A development entry therefore has the module
 * in hand before `mountControlRoom` runs, and the Suspense boundary resolves on the first
 * attempt rather than painting its fallback for a turn — which is what keeps the entry-point
 * mount observable to a caller that awaits the import and then reads the DOM.
 */
const developmentLegacyModule = DEVELOPMENT_BUILD
  ? await import("./development-legacy-root.js")
  : null;

const DevelopmentLegacyRoot = developmentLegacyModule === null
  ? null
  : lazy(async () => developmentLegacyModule);

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
 * The project manager takes precedence over every query route: it is selected by
 * the plain origin (see `entry-project-manager.ts`), so no flag can move a project
 * document onto it and no flag can move the manager document off it.
 *
 * No URL flag carries a secret; v2 credentials arrive via the handshake, the
 * manager's via its own same-origin cookie session, and v1's via Vite env into
 * headers only. See `shell-mode.ts` for the v1 decision.
 */
function chooseRoot(
  search: string,
  managerMode: boolean,
  liveSetup: LiveAttempts | undefined,
  managerSetup: Promise<ProjectManagerConnection> | undefined,
): JSX.Element {
  if (managerMode && managerSetup !== undefined) {
    return <ProjectManagerApp prepared={managerSetup} />;
  }
  // BOTH conditions, in this order. The component being absent is the compile-time fact and
  // the only one a production build can rely on; the exact `v1=1` is the route request, which
  // a production build has already had stripped from `search` by the same constant.
  if (DevelopmentLegacyRoot !== null && new URLSearchParams(search).get("v1") === "1") {
    // A null fallback, and it is development-only by construction: production never reaches
    // this branch, so no operator ever sees a blank frame while a chunk loads.
    return (
      <Suspense fallback={null}>
        <DevelopmentLegacyRoot search={search} />
      </Suspense>
    );
  }
  return <CordumApp liveSetup={liveSetup} search={search} />;
}

/**
 * Starts one browser-created pairing request before React can replay a lifecycle,
 * and closes retry over this same route decision. Both StrictMode effect passes
 * observe the initial promise; later retries never re-read location after its
 * fragment was scrubbed. Fixtures, v1 and the project manager retain their exact
 * pre-pairing composition. Manager mode short-circuits deliberately: it holds its
 * own same-origin session, so an unused one-use project credential is never issued.
 */
function prepareV2LiveSetup(
  search: string,
  managerMode: boolean,
): LiveAttempts | undefined {
  const params = new URLSearchParams(search);
  if (managerMode || params.get("v1") === "1" || params.get("fixtures") === "1") return undefined;
  const start = (signal?: AbortSignal): Promise<LiveHandshakeResult> =>
    resolveLiveSetupFromHandshake({
      fetchImpl: (input, init) => fetch(input, init),
      ...(signal === undefined ? {} : { signal }),
    });
  return Object.freeze({ initial: start(), retry: (signal: AbortSignal) => start(signal) });
}

/**
 * Starts the manager's one bootstrap before React can replay a lifecycle, exactly
 * as the v2 handshake is prepared. No manager secret enters React state: the CSRF
 * token stays closed over inside the client this promise resolves to, and the
 * session itself is a same-origin cookie the document never reads.
 */
function prepareProjectManager(managerMode: boolean): Promise<ProjectManagerConnection> | undefined {
  if (!managerMode) return undefined;
  return connectProjectManager({
    fetchImpl: (input, init) => fetch(input, init),
  });
}

/**
 * Mounts the application into a caller-supplied container and returns its root.
 *
 * `hostname` is injected for the same reason `clock` is: this is the composition
 * root, and it is the only production module that reads the host location at all,
 * so a caller can compose a route decision without a real browser origin.
 */
export function mountControlRoom(
  container: Element,
  clock: Clock = BROWSER_CLOCK,
  hostname: string = globalThis.location?.hostname ?? "",
): Root {
  const search = gateDevelopmentQuery(
    globalThis.location?.search ?? "",
    DEVELOPMENT_BUILD,
  );
  // Fragments carry no authority. Remove any stale fragment before preparing
  // the request or constructing renderable state, without parsing or retaining it.
  if (window.location.hash !== "") {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  const managerMode = resolveProjectManagerMode(hostname, search);
  const liveSetup = prepareV2LiveSetup(search, managerMode);
  const managerSetup = prepareProjectManager(managerMode);
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <ClockProvider clock={clock}>
        {chooseRoot(search, managerMode, liveSetup, managerSetup)}
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
