/**
 * The thin JetBrains adapter: it sequences the IDE adapter contract's three
 * decisions and adds only what that contract deliberately left out — a startup
 * distribution compatibility gate, reconnect, and uninstall.
 *
 * THIN MEANS THIN. There is no canonical state here, no lifecycle transition, no
 * board, and nothing rendered. Every product action and every pixel comes from
 * the standalone control room reached through the open port; this file decides
 * only whether opening it is allowed and reports the contract's own verdict.
 *
 * The compatibility gate lives in ./jetbrains-distribution-gate.ts and is
 * re-exported here so the package root stays the whole public surface.
 */

import type { DistributionManifest, DistributionRefusal } from "@moe/contracts";
import {
  decideControlRoomOpen,
  decideDaemonDiscovery,
  decideDaemonStart,
} from "@moe/ide-adapter-contract";
import type {
  IdeAdapterFailure,
  IdeAdapterLayer,
  IdeAdapterPorts,
  IdeAdapterReasonCode,
  IdeAdapterResult,
} from "@moe/ide-adapter-contract";

import { admitDistribution } from "./jetbrains-distribution-gate.js";

export {
  JETBRAINS_REQUIRED_COMPONENT_KINDS,
  admitDistribution,
} from "./jetbrains-distribution-gate.js";
export type { JetBrainsDistributionExpectation } from "./jetbrains-distribution-gate.js";

import type { JetBrainsDistributionExpectation } from "./jetbrains-distribution-gate.js";

/** Reads the manifests of the installed distribution. Implemented by the plugin. */
export interface DistributionDiscoveryPort {
  readonly discoverDistributions: () => Promise<readonly DistributionManifest[]>;
}

export interface JetBrainsPorts extends IdeAdapterPorts {
  readonly distribution: DistributionDiscoveryPort;
}

/**
 * Two vocabularies, each passed through unchanged: a distribution refusal is
 * never re-coded into an IDE reason code, and an IDE verdict never acquires a
 * distribution reason. Callers discriminate on `"ok" in result`.
 */
export type JetBrainsResult = DistributionRefusal | IdeAdapterResult;

export interface JetBrainsSession {
  readonly discoveryOutcome: () => IdeAdapterResult | null;
  readonly endpoint: () => string | null;
  readonly openControlRoom: () => Promise<JetBrainsResult>;
  readonly startOutcome: () => IdeAdapterResult | null;
  readonly uninstall: () => void;
}

const UNINSTALLED_DETAIL = "the session was uninstalled; no live handle remains";

const failure = (
  code: IdeAdapterReasonCode,
  detail: string,
  layer: IdeAdapterLayer,
): IdeAdapterFailure =>
  Object.freeze({ code, detail, layer, outcome: "UNKNOWN" as const });

type Attempt<T> =
  | { readonly detail: string; readonly ok: false }
  | { readonly ok: true; readonly value: T };

/**
 * Evidence crosses a boundary from a foreign editor runtime. A port that throws
 * is a fact about that port, so it becomes a typed failure AT THAT PORT'S LAYER
 * rather than an exception escaping into the IDE's event loop.
 */
const attempt = async <T>(run: () => Promise<T>): Promise<Attempt<T>> => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error), ok: false };
  }
};

export function createJetBrainsSession(
  ports: JetBrainsPorts,
  expectation: JetBrainsDistributionExpectation,
): JetBrainsSession {
  let endpoint: string | null = null;
  let discovered: IdeAdapterResult | null = null;
  let started: IdeAdapterResult | null = null;
  let uninstalled = false;
  let era = 0;
  let inFlight: Promise<JetBrainsResult> | null = null;

  const torn = (): IdeAdapterFailure =>
    failure("DAEMON_STATE_UNKNOWN", UNINSTALLED_DETAIL, "IDE_ADAPTER");

  const run = async (): Promise<JetBrainsResult> => {
    // Uninstall is proven by absence: no port may fire after teardown, so this
    // returns before touching one rather than silently reopening.
    if (uninstalled) return torn();
    // An uninstall that lands mid-flight must not be undone by the rest of this
    // run: without the era check, a later `endpoint = ...` resurrects the very
    // handle teardown dropped, and every write below is after an await.
    const own = era;

    // The gate runs FIRST. An incompatible pair must never reach the daemon.
    const manifests = await attempt(() => ports.distribution.discoverDistributions());
    if (own !== era) return torn();
    const refusal = admitDistribution(manifests.ok ? manifests.value : [], expectation);
    if (refusal !== null) return refusal;

    const probed = await attempt(() => ports.discovery.probeDaemon());
    if (own !== era) return torn();
    const discovery = probed.ok
      ? decideDaemonDiscovery(probed.value)
      : failure("DAEMON_STATE_UNKNOWN", probed.detail, "DAEMON_DISCOVERY_PORT");
    discovered = discovery;
    if (discovery.outcome !== "OK") return discovery;

    if (discovery.code === "DAEMON_RUNNING") {
      // RECONNECT. The start port is deliberately not invoked.
      endpoint = discovery.detail;
    } else {
      const launched = await attempt(() => ports.start.startDaemon());
      if (own !== era) return torn();
      const start = launched.ok
        ? decideDaemonStart(launched.value)
        : failure("DAEMON_START_UNVERIFIED", launched.detail, "DAEMON_START_PORT");
      started = start;
      if (start.outcome !== "OK") return start;
      endpoint = start.detail;
    }

    const opened = await attempt(() => ports.controlRoom.openControlRoom());
    if (own !== era) return torn();
    return opened.ok
      ? decideControlRoomOpen(opened.value)
      : failure("CONTROL_ROOM_OPEN_UNKNOWN", opened.detail, "CONTROL_ROOM_OPEN_PORT");
  };

  /**
   * Single-flight. An IDE fires this twice routinely — a double click, or two
   * tool windows restored together — and two concurrent runs would both observe
   * DAEMON_ABSENT and both start a daemon, defeating the reconnect guarantee at
   * exactly the moment it matters.
   */
  const openControlRoom = (): Promise<JetBrainsResult> => {
    if (inFlight === null) {
      const flight = run().finally(() => {
        if (inFlight === flight) inFlight = null;
      });
      inFlight = flight;
    }
    return inFlight;
  };

  return Object.freeze({
    discoveryOutcome: () => discovered,
    endpoint: () => endpoint,
    openControlRoom,
    startOutcome: () => started,
    uninstall: () => {
      uninstalled = true;
      era += 1;
      endpoint = null;
      discovered = null;
      started = null;
    },
  });
}
