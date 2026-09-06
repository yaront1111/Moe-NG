#!/usr/bin/env node
import {
  connectStdioTransport,
  createStdioMcpServer,
  readBootstrapCredential,
} from "@moe/mcp";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "./daemon-store-dependencies.js";
import { createFoundationReceiptPublisher } from "./host/foundation-receipts.js";
import type { FoundationPublishResult } from "./host/foundation-receipts.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { wiredMcpToolKinds } from "./mcp-tool-allowlist.js";

/**
 * The agent-facing entry: one MCP stdio server per agent session, exactly the
 * old-Moe shape — a wrapper starts `node src/mcp-main.ts` with the agent's
 * credential in MOE_SESSION_CREDENTIAL, and that agent's Claude session gets
 * one tool per runtime kind, every dispatch answered by the same durable
 * pipeline the HTTP listener serves.
 *
 * Environment (all refusals name the variable, never a value):
 * - MOE_STORE_PATH / MOE_PROJECT_ID / MOE_DAEMON_CREDENTIAL — store wiring,
 *   same as the daemon bin.
 * - MOE_SESSION_CREDENTIAL — THIS agent's credential: the operator secret, or
 *   a session credential minted via session.open with scoped capabilities.
 *
 * Reads go through the provider's own subscription seam, so an agent's
 * events_read folds and encodes exactly as the daemon's /events/read does.
 */
/** This entry's identity in a receipt: one agent session over official MCP stdio. */
const STDIO_ENTRY = "MCP_STDIO" as const;

/** Named so a supervisor can tell a fault during drain from a clean stop. It is a
 *  host fact, not a receipt refusal, so it never borrows the receipts layer. */
const STOP_FAILED_CODE = "FOUNDATION_HOST_STOP_FAILED" as const;

/**
 * Everything the lifecycle needs from the PROCESS, and nothing else: no
 * authority, no dispatch, no store. Injectable so the drain is testable without
 * killing the test runner's own process.
 */
export interface StdioHostSeam {
  readonly exit: (code: number) => void;
  /** The receipt clock, read HERE: the receipts module holds none. */
  readonly instant: () => string;
  readonly onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
  /** stdin EOF. The SDK transport never watches for it, so this host must. */
  readonly onTransportClosed: (handler: () => void) => void;
  readonly pid: number;
  readonly projectId: string;
  /** Stops accepting requests: closes the server, then the store handles. */
  readonly stop: () => Promise<void>;
  readonly storePath: string;
  /** STDERR, never stdout — stdout is the JSON-RPC wire. */
  readonly write: (line: string) => void;
}

export interface StdioHost {
  drain(trigger: string): Promise<void>;
  publishReady(): void;
}

/**
 * The drain this entry never had. On Windows an externally sent SIGTERM does not
 * run a Node handler at all, so the transport-close path is the PRIMARY trigger
 * and the signals are the POSIX bonus; both converge on ONE drain, because two
 * shutdown receipts would tell a supervisor a process stopped twice.
 */
export function createStdioHost(seam: StdioHostSeam): StdioHost {
  const receipts = createFoundationReceiptPublisher({ sink: seam.write });
  const identity = {
    entry: STDIO_ENTRY, pid: seam.pid, projectId: seam.projectId, storePath: seam.storePath,
  };
  const disclose = (result: FoundationPublishResult): void => {
    if (!result.ok) seam.write(`${result.code} ${result.layer}`);
  };
  let draining: Promise<void> | null = null;
  const drain = async (trigger: string): Promise<void> => {
    // One drain per process, whichever trigger arrives first — and the process
    // is released even when the receipt refuses: a wedged agent session is worse
    // than a missing line.
    draining ??= (async (): Promise<void> => {
      // A stop that THROWS still releases the process. Without this the drain
      // promise rejects,  never runs, and an agent session whose stdin is
      // already closed wedges forever - the exact failure the receipt exists to
      // rule out. The fault is DISCLOSED beside the receipt, never swallowed and
      // never allowed to masquerade as a clean stop.
      try {
        await seam.stop();
      } catch (error) {
        seam.write(`${STOP_FAILED_CODE} ${error instanceof Error ? error.message : "unknown"}`);
      }
      disclose(receipts.publishShutdown({ ...identity, instant: seam.instant(), trigger }));
      seam.exit(0);
    })();
    return draining;
  };
  seam.onTransportClosed(() => { void drain("TRANSPORT_CLOSED"); });
  seam.onSignal("SIGINT", () => { void drain("SIGINT"); });
  seam.onSignal("SIGTERM", () => { void drain("SIGTERM"); });
  return Object.freeze({
    drain,
    publishReady: (): void => {
      disclose(receipts.publishReadiness({ ...identity, instant: seam.instant() }));
    },
  });
}

async function main(): Promise<void> {
  const credential = readBootstrapCredential();
  const config = readStoreDependencyEnv(process.env);
  const provider = createStoreDependencies(config);
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription seam");

  const server = createStdioMcpServer({
    credential,
    port: createMcpDispatchPort({
      affordances: provider.affordances?.(),
      // Both planes and the plane READER are composed once here; which plane a
      // dispatch runs on is the reader's answer at that dispatch, not at start.
      commandAuthorityPlane: provider.commandAuthorityPlane?.(),
      deps: provider.provide(),
      // The seat's design read. Composed here rather than left undefined because ADVERTISING
      // `design.read` while the port is absent refuses every real caller -- the tool shows up on
      // the roster and can only ever answer INPUT_INVALID.
      design: provider.designReads?.(),
      documents: provider.goalSource?.(),
      fallbackCredential: credential,
      graph: provider.graph?.(),
      subscriptions,
      v2Deps: provider.provideV2?.(),
    }),
    serverName: "moe-next",
    // Advertise only what this daemon wires: an agent never sees a tool that
    // could only ever refuse.
    toolAllowlist: wiredMcpToolKinds(),
  });

  const host = createStdioHost({
    exit: (code) => process.exit(code),
    instant: () => new Date().toISOString(),
    onSignal: (signal, handler) => { process.once(signal, handler); },
    onTransportClosed: (handler) => {
      // BOTH, because the SDK's stdio transport watches only `data` and `error`:
      // a client that closes its end reaches this process as stdin EOF and
      // nothing else. `drain` is idempotent, so the pair costs nothing.
      process.stdin.once("end", handler);
      process.stdin.once("close", handler);
    },
    pid: process.pid,
    projectId: config.projectId,
    stop: async () => {
      await server.close();
      provider.close();
    },
    storePath: config.storePath,
    write: (line) => { process.stderr.write(`${line}\n`); },
  });

  await connectStdioTransport(server);
  // AFTER the transport is connected and the dispatch port is composed: a
  // readiness line published earlier would name a session nobody can reach yet.
  host.publishReady();
}

const meta = import.meta as ImportMeta & { readonly main?: boolean };
if (meta.main === true) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "startup failed"}\n`);
    process.exitCode = 1;
  });
}

export { main as runMcpMain };
