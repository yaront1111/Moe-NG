#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isDependencyProvider, refuseEntry, startDaemon } from "./daemon-entry.js";
import type { DaemonDependencyProvider, DaemonEntryRefused } from "./daemon-entry.js";

/**
 * The process wrapper: argv in, exit code out. Kept apart from `daemon-entry`
 * so the lifecycle stays testable in process while this file owns the parts
 * that only make sense with a real argv and a real signal.
 */
export interface MainOptions {
  readonly log?: (line: string) => void;
  readonly onStarted?: (shutdown: () => Promise<unknown>) => void;
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
  const started = await startDaemon({
    dependencies: provider,
    log,
    ...(host === null ? {} : { host }),
    ...(port === undefined ? {} : { port }),
  });
  if (!started.ok) {
    // Copied verbatim, whichever layer refused.
    log(`${started.code} ${started.layer}`);
    return 1;
  }

  options.onStarted?.(started.shutdown);
  return 0;
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  process.exitCode = await runDaemonMain(process.argv.slice(2), {
    onStarted: (shutdown) => {
      // Closed on every exit path. A surviving handle keeps its port and
      // surfaces later on Windows as EBUSY rather than as the real error.
      const stop = (): void => {
        void shutdown().then(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    },
  });
}
