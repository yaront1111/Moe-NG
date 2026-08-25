/// <reference types="vite/client" />

import { lazy, StrictMode, Suspense } from "react";
import type { ComponentType, JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { gateDevelopmentQuery } from "./entry-route.js";
import { resolveLiveSetupFromHandshake } from "./live/live-handshake.js";
import type { LiveHandshakeResult } from "./live/live-handshake.js";
import { ClockProvider } from "./performance/command-latency.js";
import type { Clock } from "./performance/command-latency.js";
import { CordumApp } from "./v2/cordum-app.js";
import { ProjectManagerApp } from "./v2/projects/project-manager-app.js";
import { connectProjectManager } from "./v2/projects/project-manager-client.js";
import type { ProjectManagerConnection } from "./v2/projects/project-manager-client.js";

/** The element id the served document supplies; nothing else is assumed to exist. */
export const CONTROL_ROOM_ROOT_ELEMENT_ID = "root";

const DEVELOPMENT_LEGACY_MODULE_PATH = "./development-legacy-root.js";
const DevelopmentLegacyRoot = import.meta.env.DEV
  ? lazy(async () => await import(
    /* @vite-ignore */ DEVELOPMENT_LEGACY_MODULE_PATH
  ) as { default: ComponentType<{ readonly search: string }> })
  : null;

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
 * RUNTIME through the daemon handshake (no baked secret). Development-only query
 * switches retain the frozen design view and legacy v1 board for local evidence;
 * production always mounts this v2 front door.
 *
 * No query or fragment carries authority. Legacy authority-bearing locations are
 * scrubbed before React, v2 credentials arrive only in the approved claim response,
 * and v1 credentials travel in headers only.
 * See `shell-mode.ts` for the v1 decision.
 */
function chooseRoot(search: string, managerMode: boolean,
  liveSetup: Promise<LiveHandshakeResult> | undefined,
  managerSetup: Promise<ProjectManagerConnection> | undefined): JSX.Element {
  if (managerMode && managerSetup !== undefined)
    return <ProjectManagerApp prepared={managerSetup} />;
  if (import.meta.env.DEV && DevelopmentLegacyRoot !== null
    && new URLSearchParams(search).get("v1") === "1") {
    return (
      <Suspense fallback={<p>Loading development shell…</p>}>
        <DevelopmentLegacyRoot search={search} />
      </Suspense>
    );
  }
  return <CordumApp liveSetup={liveSetup} search={search} />;
}

/**
 * Starts one browser-created pairing request before React can replay a lifecycle.
 * The resulting promise is safe for both StrictMode effect passes to observe;
 * its request id remains closure-private until the operator-approved claim.
 */
function prepareV2LiveSetup(
  search: string,
  managerMode: boolean,
): Promise<LiveHandshakeResult> | undefined {
  const params = new URLSearchParams(search);
  if (managerMode || (import.meta.env.DEV
    && (params.get("v1") === "1" || params.get("fixtures") === "1"))) return undefined;
  return resolveLiveSetupFromHandshake({
    fetchImpl: (input, init) => fetch(input, init),
  });
}

/** Prepares the manager cookie session once; no manager secret enters React state. */
function prepareProjectManager(managerMode: boolean): Promise<ProjectManagerConnection> | undefined {
  if (!managerMode) return undefined;
  return connectProjectManager({
    fetchImpl: (input, init) => fetch(input, init),
  });
}

/** The fixed manager host makes the plain origin itself the route selector. */
export function isProjectManagerLocation(
  hostname: string,
  search: string,
  development: boolean,
): boolean {
  return hostname === "127.0.0.2"
    || (development && new URLSearchParams(search).get("projects") === "1");
}

/** Mounts the application into a caller-supplied container and returns its root. */
export function mountControlRoom(container: Element, clock: Clock = BROWSER_CLOCK): Root {
  const rawSearch = globalThis.location?.search ?? "";
  const search = gateDevelopmentQuery(rawSearch, import.meta.env.DEV);
  // Fragments carry no authority in this release. Scrub any stale fragment
  // without parsing or retaining it before creating renderable state.
  if (window.location.hash !== "") {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  const managerMode = isProjectManagerLocation(window.location.hostname, search, import.meta.env.DEV);
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
/** The production mount, exported so integration tests can dispose live polling. */
export const MOUNTED_CONTROL_ROOM_ROOT = mountControlRoom(container);
