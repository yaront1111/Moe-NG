import { randomUUID } from "node:crypto";

import type { SubscriptionPort } from "./http/event-stream-contract.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import { startControlRoomListener } from "./http/http-listener.js";
import type { ListenerRefused } from "./http/http-listener.js";

// The daemon root's transport surface, re-exported here rather than added as a
// second line to `index.ts`: that file is at its size target and
// task-5e43a9e2 owns restructuring it.
export {
  CONTROL_ROOM_LISTENER_LAYER,
  LISTENER_REFUSAL_CODES,
  startControlRoomListener,
} from "./http/http-listener.js";
export type {
  ControlRoomListener,
  ListenerRefusalCode,
  ListenerRefused,
  StartListenerOptions,
  StartListenerResult,
} from "./http/http-listener.js";

/**
 * What makes the daemon a startable PROCESS rather than a library.
 *
 * It owns the lifecycle and nothing else: resolve injected dependencies, bind
 * the loopback listener, report the port actually bound, and shut down exactly
 * once. It constructs no authority of its own — a daemon that minted its own
 * registry or authenticator here would be a second authority beside the
 * committed one, so a caller that supplies none is REFUSED rather than served
 * from an invented default.
 */
export const DAEMON_ENTRY_LAYER = "DAEMON_ENTRY" as const;

/** Every refusal this layer can emit. Closed, so a consumer can switch exhaustively. */
export const DAEMON_ENTRY_REFUSAL_CODES = Object.freeze([
  "DAEMON_ENTRY_ALREADY_STOPPED",
  "DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER",
  "DAEMON_ENTRY_PROVIDER_INVALID",
  "DAEMON_ENTRY_PROVIDER_LOAD_FAILED",
  "DAEMON_ENTRY_PROVIDER_THREW",
] as const);

export type DaemonEntryRefusalCode = (typeof DAEMON_ENTRY_REFUSAL_CODES)[number];

/** The one seam through which real authority reaches the transport. */
export interface DaemonDependencyProvider {
  provide(): CommandAdapterDeps;
  /**
   * Optional. Absent means the stream route REFUSES rather than serving an
   * invented empty page, so a half-wired daemon is visible instead of silent.
   */
  subscriptions?(): SubscriptionPort;
}

export interface DaemonEntryRefused {
  readonly code: DaemonEntryRefusalCode;
  readonly layer: typeof DAEMON_ENTRY_LAYER;
  readonly ok: false;
}

export type ShutdownResult =
  | { readonly ok: true }
  | {
      readonly code: "DAEMON_ENTRY_ALREADY_STOPPED";
      readonly layer: typeof DAEMON_ENTRY_LAYER;
      readonly ok: false;
    };

export interface StartedDaemon {
  readonly csrfToken: string;
  readonly ok: true;
  readonly origin: string;
  readonly port: number;
  shutdown(): Promise<ShutdownResult>;
}

/**
 * A listener refusal travels out UNCHANGED. `PortRefusal`'s contract is that the
 * seam holds no translation table, so the layer that made the security decision
 * stays visible instead of being flattened into a generic entry code.
 */
export type DaemonStartResult = DaemonEntryRefused | ListenerRefused | StartedDaemon;

export interface DaemonStartOptions {
  readonly credential?: string;
  readonly csrfToken?: string;
  readonly dependencies?: DaemonDependencyProvider | null;
  readonly host?: string;
  readonly log?: (line: string) => void;
  readonly port?: number;
}

export function refuseEntry(code: DaemonEntryRefusalCode): DaemonEntryRefused {
  return Object.freeze({ code, layer: DAEMON_ENTRY_LAYER, ok: false } as const);
}

/** Structural, because a provider loaded from a module path is untyped at the boundary. */
export function isDependencyProvider(value: unknown): value is DaemonDependencyProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { provide?: unknown }).provide === "function"
  );
}

const ALREADY_STOPPED = Object.freeze({
  code: "DAEMON_ENTRY_ALREADY_STOPPED",
  layer: DAEMON_ENTRY_LAYER,
  ok: false,
} as const);

export async function startDaemon(options: DaemonStartOptions): Promise<DaemonStartResult> {
  const dependencies = options.dependencies ?? null;
  if (dependencies === null) return refuseEntry("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER");

  let deps: CommandAdapterDeps;
  let subscriptions: SubscriptionPort | undefined;
  try {
    deps = dependencies.provide();
    subscriptions = dependencies.subscriptions?.();
  } catch {
    // Distinct from an absent provider: a provider that failed is a wiring
    // fault, not a caller that supplied nothing.
    return refuseEntry("DAEMON_ENTRY_PROVIDER_THREW");
  }

  // Minted here when unsupplied and returned IN PROCESS only. Design 19.2 keeps
  // credentials out of URLs and logs, so this value is never written to the log
  // sink and never placed on a query string.
  const csrfToken = options.csrfToken ?? randomUUID();
  const started = await startControlRoomListener({
    csrfToken,
    deps,
    ...(options.credential === undefined ? {} : { credential: options.credential }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(subscriptions === undefined ? {} : { subscriptions }),
  });
  if (!started.ok) return started;

  options.log?.(`listening on ${started.origin}`);

  let stopped = false;
  return Object.freeze({
    csrfToken,
    ok: true,
    origin: started.origin,
    port: started.port,
    shutdown: async (): Promise<ShutdownResult> => {
      // Idempotent BY REFUSAL rather than silently: a second shutdown usually
      // means two owners believe they hold the lifecycle, which is worth a code.
      if (stopped) return ALREADY_STOPPED;
      stopped = true;
      await started.close();
      return Object.freeze({ ok: true } as const);
    },
  } as const);
}
