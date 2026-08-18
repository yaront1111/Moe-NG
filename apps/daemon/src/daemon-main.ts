#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isDependencyProvider, refuseEntry, startDaemon } from "./daemon-entry.js";
import type {
  DaemonDependencyProvider, DaemonEntryRefused, ShutdownResult,
} from "./daemon-entry.js";
import { createFoundationReceiptPublisher } from "./host/foundation-receipts.js";
import type { FoundationPublishResult } from "./host/foundation-receipts.js";

/**
 * The process wrapper: argv in, exit code out. Kept apart from `daemon-entry`
 * so the lifecycle stays testable in process while this file owns the parts
 * that only make sense with a real argv and a real signal.
 */
export interface MainOptions {
  /** The environment this host was started with; the store identity lives here. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The receipt clock, INJECTED: the receipts module itself holds none. */
  readonly instant?: () => string;
  readonly log?: (line: string) => void;
  readonly onStarted?: (shutdown: (trigger?: string) => Promise<ShutdownResult>) => void;
}

function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((entry) => entry.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

async function loadProvider(
  spec: string,
): Promise<DaemonDependencyProvider | DaemonEntryRefused> {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(resolve(spec)).href);
  } catch {
    return refuseEntry("DAEMON_ENTRY_PROVIDER_LOAD_FAILED");
  }
  const candidate = (loaded as { default?: unknown }).default;
  // A module that loaded but exports the wrong shape is a DIFFERENT fault from
  // one that failed to load, and the operator fixes each differently.
  if (!isDependencyProvider(candidate)) return refuseEntry("DAEMON_ENTRY_PROVIDER_INVALID");
  return candidate;
}

function parsePort(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  // Anything unparseable falls back to ephemeral rather than to a well-known
  // port: guessing a fixed port is how a transport collides with a live service.
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** This entry's identity in a receipt: the control-room HTTP host. */
const CONTROL_ROOM_ENTRY = "CONTROL_ROOM_HTTP" as const;

/**
 * Publishes the readiness receipt and returns the drain that publishes the
 * shutdown half.
 *
 * Called only after `startDaemon` answered ok, which is after the boot
 * reconciliation sweep it runs BEFORE binding: the ordering is inherited from
 * the entry rather than rebuilt here, so a daemon cannot announce READY while
 * the last crash is still unclassified. The identities come from the very
 * variables the shipped dependency provider opens its store with, so a receipt
 * names the store this process actually serves.
 */
function announceHost(
  shutdown: () => Promise<ShutdownResult>,
  options: MainOptions,
  log: (line: string) => void,
): (trigger?: string) => Promise<ShutdownResult> {
  const env = options.env ?? process.env;
  const instant = options.instant ?? ((): string => new Date().toISOString());
  const identity = {
    entry: CONTROL_ROOM_ENTRY,
    pid: process.pid,
    projectId: env["MOE_PROJECT_ID"] ?? "",
    storePath: env["MOE_STORE_PATH"] ?? "",
  };
  const receipts = createFoundationReceiptPublisher({ sink: log });
  // A receipt this host cannot honestly stamp is DISCLOSED by code and layer,
  // never invented and never fatal: the listener is already serving.
  const disclose = (result: FoundationPublishResult): void => {
    if (!result.ok) log(`${result.code} ${result.layer}`);
  };
  disclose(receipts.publishReadiness({ ...identity, instant: instant() }));
  return async (trigger = "PROGRAMMATIC_STOP"): Promise<ShutdownResult> => {
    const stopped = await shutdown();
    // The entry owns the lifecycle. A second drain is ITS refusal, copied
    // verbatim, and publishes no second receipt.
    if (!stopped.ok) {
      log(`${stopped.code} ${stopped.layer}`);
      return stopped;
    }
    disclose(receipts.publishShutdown({ ...identity, instant: instant(), trigger }));
    return stopped;
  };
}

export async function runDaemonMain(
  argv: readonly string[],
  options: MainOptions = {},
): Promise<number> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const spec = flag(argv, "dependencies");

  const provider =
    spec === null ? refuseEntry("DAEMON_ENTRY_NO_DEPENDENCY_PROVIDER") : await loadProvider(spec);
  if ("ok" in provider) {
    log(`${provider.code} ${provider.layer}`);
    return 1;
  }

  const host = flag(argv, "host");
  const port = parsePort(flag(argv, "port"));
  // Operator-supplied CSRF token for local development, so an external client
  // (e.g. the control room dev server) can present it. Design 19.2 still holds:
  // the value is never logged and never travels on a URL. Absent, the daemon
  // mints a random in-process token exactly as before.
  const csrfToken = flag(argv, "csrf-token");
  const started = await startDaemon({
    dependencies: provider,
    log,
    ...(csrfToken === null ? {} : { csrfToken }),
    ...(host === null ? {} : { host }),
    ...(port === undefined ? {} : { port }),
  });
  if (!started.ok) {
    // Copied verbatim, whichever layer refused.
    log(`${started.code} ${started.layer}`);
    return 1;
  }

  options.onStarted?.(announceHost(() => started.shutdown(), options, log));
  return 0;
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  process.exitCode = await runDaemonMain(process.argv.slice(2), {
    onStarted: (shutdown) => {
      // Closed on every exit path. A surviving handle keeps its port and
      // surfaces later on Windows as EBUSY rather than as the real error. The
      // signal NAME travels into the shutdown receipt, so a supervisor reading
      // stdout can tell an operator stop from a supervisor kill.
      const stop = (trigger: "SIGINT" | "SIGTERM") => (): void => {
        void shutdown(trigger).then(() => process.exit(0));
      };
      process.once("SIGINT", stop("SIGINT"));
      process.once("SIGTERM", stop("SIGTERM"));
    },
  });
}
