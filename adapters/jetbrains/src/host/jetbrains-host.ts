/**
 * The JetBrains host: the launcher a plugin's tool window calls, and nothing
 * else.
 *
 * IT IS A COMPOSITION, NOT A LAYER. It binds the four real ports to the thin
 * adapter and returns whatever the adapter decides. There is no lifecycle
 * reducer here, no command authorization, no board and nothing rendered: every
 * product action and every pixel comes from the standalone control room reached
 * through the open port. Start-versus-reconnect is not decided here either — the
 * adapter derives that from discovery evidence, and duplicating the choice would
 * fork a decision that already has an owner.
 *
 * The adapter is imported through its BARE package root rather than by relative
 * path. Node's self-reference rule resolves `@moe/jetbrains-adapter` through
 * this package's own exports map, so the host consumes exactly the public
 * surface a plugin would, and a symbol that stops being published breaks here.
 */

import { createJetBrainsSession } from "@moe/jetbrains-adapter";
import type { JetBrainsResult, JetBrainsSession } from "@moe/jetbrains-adapter";
import type { DistributionApiRange } from "@moe/contracts";

import {
  openControlRoom,
  probeDaemon,
  readInstalledDistributions,
  startDaemon,
} from "./jetbrains-host-ports.js";
import type { BrowserOpener } from "./jetbrains-host-ports.js";

/**
 * Everything the host needs, stated by the plugin that builds it. Nothing is
 * read from the environment: an install path discovered from ambient state is a
 * different distribution from the one this build was compiled against.
 */
export interface JetBrainsHostConfig {
  /** The range THIS adapter build was compiled against, not the daemon's claim. */
  readonly apiCompatibilityRange: DistributionApiRange;
  readonly controlRoomAssetPath: string;
  readonly controlRoomOpenTimeoutMs: number;
  readonly daemonArgs: readonly string[];
  readonly daemonCommand: string;
  readonly endpoint: string;
  readonly installRoot: string;
  readonly opener: BrowserOpener;
  readonly probeTimeoutMs: number;
  readonly startConfirmIntervalMs: number;
  readonly startConfirmTimeoutMs: number;
}

export interface JetBrainsHost {
  readonly endpoint: () => string | null;
  readonly reconnect: () => Promise<JetBrainsResult>;
  readonly start: () => Promise<JetBrainsResult>;
  readonly uninstall: () => void;
}

/**
 * Binds the four real ports. Each closes over its own configuration, so the
 * adapter sees the port interface it declares and nothing about this host.
 */
const portsFor = (config: JetBrainsHostConfig): Parameters<typeof createJetBrainsSession>[0] => ({
  controlRoom: {
    openControlRoom: () =>
      openControlRoom(
        config.controlRoomAssetPath,
        config.opener,
        config.controlRoomOpenTimeoutMs,
      ),
  },
  discovery: {
    probeDaemon: () => probeDaemon(config.endpoint, config.probeTimeoutMs),
  },
  distribution: {
    discoverDistributions: () => readInstalledDistributions(config.installRoot),
  },
  start: {
    startDaemon: () =>
      startDaemon({
        args: config.daemonArgs,
        command: config.daemonCommand,
        confirmIntervalMs: config.startConfirmIntervalMs,
        confirmTimeoutMs: config.startConfirmTimeoutMs,
        endpoint: config.endpoint,
      }),
  },
});

export function createJetBrainsHost(config: JetBrainsHostConfig): JetBrainsHost {
  const ports = portsFor(config);
  const expectation = { apiCompatibilityRange: config.apiCompatibilityRange };

  // The only state in this file. An uninstalled session is dropped rather than
  // reused: the adapter proves teardown by absence, so a resurrected handle
  // would hand back a session that has already refused to act.
  let session: JetBrainsSession | null = null;

  const live = (): JetBrainsSession => {
    session ??= createJetBrainsSession(ports, expectation);
    return session;
  };

  // start and reconnect are the same admission-then-open sequence on purpose:
  // the adapter reconnects when discovery reports a daemon already listening and
  // starts one when it does not. Both names exist because the plugin's tool
  // window and its reconnect action are different user gestures, not different
  // policies.
  const open = (): Promise<JetBrainsResult> => live().openControlRoom();

  return Object.freeze({
    endpoint: () => session?.endpoint() ?? null,
    reconnect: open,
    start: open,
    uninstall: () => {
      session?.uninstall();
      session = null;
    },
  });
}
