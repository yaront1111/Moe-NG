import { randomUUID } from "node:crypto";

import {
  optionalPortFactoriesAreValid,
  resolveOptionalDaemonPorts,
} from "./daemon-entry-port-resolution.js";
import type {
  OptionalDaemonPortProvider,
  ResolvedOptionalDaemonPorts,
} from "./daemon-entry-port-resolution.js";
import type {
  BootReconciliationPort, BootReconciliationRefused,
} from "./recovery/boot-reconciliation.js";
import type { CommandAdapterDeps } from "./http/http-contract.js";
import { startControlRoomListener } from "./http/http-listener.js";
import type {
  ListenerRefused,
  PairingOperatorApprovalResult,
} from "./http/http-listener.js";

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
  PairingOperatorApprovalResult,
  StartListenerOptions,
  StartListenerResult,
} from "./http/http-listener.js";
// An arm of `DaemonStartResult` and the port a provider supplies, re-exported so
// a consumer can switch on a refused start without a deep import.
export type {
  BootReconciliationPort, BootReconciliationRefused,
} from "./recovery/boot-reconciliation.js";

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
  "DAEMON_ENTRY_DEPENDENCIES_INVALID",
  "DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER",
  "DAEMON_ENTRY_PROVIDER_INVALID",
  "DAEMON_ENTRY_PROVIDER_LOAD_FAILED",
  "DAEMON_ENTRY_PROVIDER_THREW",
] as const);

export type DaemonEntryRefusalCode = (typeof DAEMON_ENTRY_REFUSAL_CODES)[number];

/** The one seam through which real authority reaches the transport. */
export interface DaemonDependencyProvider extends OptionalDaemonPortProvider {
  provide(): CommandAdapterDeps;
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

export type DaemonPairingApprovalResult = PairingOperatorApprovalResult | Extract<
  ShutdownResult,
  { readonly ok: false }
>;

export interface StartedDaemon {
  approvePairing(confirmationLabel: unknown): DaemonPairingApprovalResult;
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
 *
 * A boot reconciliation refusal travels out the same way and for the same reason:
 * re-stamping `EXPECTED_VERSION_CONFLICT` at `DURABLE_STORE` or the sweep's
 * refusal at `DAEMON_FOUNDATION_ATTEMPT` with `DAEMON_ENTRY` would make an
 * unreadable attempt set indistinguishable from a lost write.
 */
export type DaemonStartResult =
  | BootReconciliationRefused | DaemonEntryRefused | ListenerRefused | StartedDaemon;

export interface DaemonStartOptions {
  /**
   * An ABSOLUTE directory of built control-room assets to host on the daemon's
   * own origin. Absent, nothing is hosted and the transport is exactly what it
   * was: the listener owns the resolution and the refusal, so this entry adds no
   * second opinion about what a servable root is.
   */
  readonly assetRoot?: string;
  /**
   * In-process secrets no hosted asset may contain - the daemon credential the
   * process was started with. Forwarded to the listener, which adds its own
   * CSRF token and refuses to START hosting a root whose servable files carry
   * any of them (`LISTENER_ASSET_ROOT_LEAKS_SECRET`). Meaningless without
   * `assetRoot`, and never logged or echoed by any layer below.
   */
  readonly assetSecrets?: readonly string[];
  readonly csrfToken?: string;
  readonly dependencies?: DaemonDependencyProvider | null;
  readonly host?: string;
  readonly log?: (line: string) => void;
  /** Header-only process fact; absence stays absent until the listener fails it closed. */
  readonly pairingOperatorChannelAvailable?: boolean;
  readonly port?: number;
}

export function refuseEntry(code: DaemonEntryRefusalCode): DaemonEntryRefused {
  return Object.freeze({ code, layer: DAEMON_ENTRY_LAYER, ok: false } as const);
}

/** Structural, because a provider loaded from a module path is untyped at the boundary. */
export function isDependencyProvider(value: unknown): value is DaemonDependencyProvider {
  if (typeof value !== "object" || value === null) return false;
  try {
    const provide = Reflect.get(value, "provide") as unknown;
    return typeof provide === "function" && optionalPortFactoriesAreValid(value);
  } catch {
    return false;
  }
}

function hasCallable(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return typeof Reflect.get(value, key) === "function";
  } catch {
    return false;
  }
}

function isCommandAdapterDeps(value: unknown): value is CommandAdapterDeps {
  if (typeof value !== "object" || value === null) return false;
  try {
    return hasCallable(Reflect.get(value, "authenticator"), "authenticate") &&
      hasCallable(Reflect.get(value, "decisions"), "decide") &&
      hasCallable(Reflect.get(value, "registry"), "get");
  } catch {
    return false;
  }
}

type ResolvedDependencies = DaemonEntryRefused | (ResolvedOptionalDaemonPorts & {
  readonly deps: CommandAdapterDeps;
  readonly ok: true;
});

function resolveDependencies(provider: DaemonDependencyProvider): ResolvedDependencies {
  let provided: unknown;
  try {
    provided = provider.provide();
  } catch {
    return refuseEntry("DAEMON_ENTRY_PROVIDER_THREW");
  }
  if (!isCommandAdapterDeps(provided)) {
    return refuseEntry("DAEMON_ENTRY_DEPENDENCIES_INVALID");
  }

  const ports = resolveOptionalDaemonPorts(provider);
  if (!ports.ok) {
    return refuseEntry(ports.failure === "THREW"
      ? "DAEMON_ENTRY_PROVIDER_THREW" : "DAEMON_ENTRY_DEPENDENCIES_INVALID");
  }
  return Object.freeze({ deps: provided, ok: true, ...ports.ports } as const);
}

/**
 * Reconciliation of what was in flight when the process last died, run ONCE per
 * start and BEFORE anything binds. `null` means carry on — the provider wires no
 * sweep, or the sweep succeeded; every other answer stops the boot. A port that
 * THROWS is the one condition named here, under the EXISTING provider code: a
 * dead port is a broken provider with no durable code or layer to preserve.
 */
function runBootReconciliation(
  port: BootReconciliationPort | undefined,
): BootReconciliationRefused | DaemonEntryRefused | null {
  if (port === undefined) return null;
  try {
    const outcome = port.sweep();
    return outcome.ok ? null : outcome;
  } catch {
    return refuseEntry("DAEMON_ENTRY_PROVIDER_THREW");
  }
}

const ALREADY_STOPPED = Object.freeze({
  code: "DAEMON_ENTRY_ALREADY_STOPPED",
  layer: DAEMON_ENTRY_LAYER,
  ok: false,
} as const);

export async function startDaemon(options: DaemonStartOptions): Promise<DaemonStartResult> {
  const dependencies = options.dependencies ?? null;
  if (dependencies === null) return refuseEntry("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER");

  const resolved = resolveDependencies(dependencies);
  if (!resolved.ok) return resolved;

  // BEFORE the listener, never after: a daemon that becomes ready while the last
  // crash is still unclassified is the exact failure this sweep exists to stop.
  const swept = runBootReconciliation(resolved.reconciliation);
  if (swept !== null) return swept;

  // Minted here when unsupplied and returned IN PROCESS only. Design 19.2 keeps
  // credentials out of URLs and logs, so this value is never written to the log
  // sink and never placed on a query string.
  // Empty is treated as unsupplied: `--csrf-token=` reaches here as "", and an
  // empty token is a secret no header can safely match, so mint a real one.
  const suppliedCsrfToken = options.csrfToken ?? "";
  const csrfToken = suppliedCsrfToken === "" ? randomUUID() : suppliedCsrfToken;
  const started = await startControlRoomListener({
    csrfToken,
    deps: resolved.deps,
    ...(options.assetRoot === undefined ? {} : { assetRoot: options.assetRoot }),
    ...(options.assetSecrets === undefined ? {} : { assetSecrets: options.assetSecrets }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.pairingOperatorChannelAvailable === undefined
      ? {} : { pairingOperatorChannelAvailable: options.pairingOperatorChannelAvailable }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(resolved.affordances === undefined ? {} : { affordances: resolved.affordances }),
    ...(resolved.documentDossiers === undefined
      ? {} : { documentDossiers: resolved.documentDossiers }),
    ...(resolved.documentIngest === undefined
      ? {} : { documentIngest: resolved.documentIngest }),
    ...(resolved.graph === undefined ? {} : { graph: resolved.graph }),
    ...(resolved.goalCatalog === undefined ? {} : { goalCatalog: resolved.goalCatalog }),
    ...(resolved.planningRuns === undefined
      ? {} : { planningRuns: resolved.planningRuns }),
    ...(resolved.budgetCommitment === undefined
      ? {} : { budgetCommitment: resolved.budgetCommitment }),
    ...(resolved.productContractGate1 === undefined
      ? {} : { productContractGate1: resolved.productContractGate1 }),
    ...(resolved.sessionChallengeOperands === undefined
      ? {} : { sessionChallengeOperands: resolved.sessionChallengeOperands }),
    ...(resolved.sessionHandshake === undefined
      ? {} : { pairing: resolved.sessionHandshake }),
    ...(resolved.subscriptions === undefined ? {} : { subscriptions: resolved.subscriptions }),
  });
  if (!started.ok) return started;

  options.log?.(`listening on ${started.origin}`);

  let stopped = false;
  return Object.freeze({
    approvePairing: (confirmationLabel: unknown): DaemonPairingApprovalResult =>
      stopped ? ALREADY_STOPPED : started.approvePairing(confirmationLabel),
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
