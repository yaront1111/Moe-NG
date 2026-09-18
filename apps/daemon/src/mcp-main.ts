#!/usr/bin/env node
import {
  connectStdioTransport,
  createStdioMcpServer,
  readBootstrapCredential,
} from "@moe/mcp";
import type { McpDispatchFaultObserver } from "@moe/mcp";

import {
  createStoreDependencies,
  readStoreDependencyEnv,
} from "./daemon-store-dependencies.js";
import type { StoreDependencyProvider } from "./daemon-store-foundation-composition.js";
import { createFoundationReceiptPublisher } from "./host/foundation-receipts.js";
import type { FoundationPublishResult } from "./host/foundation-receipts.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import {
  MCP_DELEGABLE_OPERATOR_KINDS, operatorDelegateMcpPayloadProperties, operatorDelegateMcpToolKinds,
  wiredMcpPayloadProperties, wiredMcpToolKinds,
} from "./mcp-tool-allowlist.js";
import { createDiagnosticRuntime } from "./diagnostics/diagnostic-runtime.js";
import { diagnosticProjectRoot } from "./diagnostics/diagnostic-project-root.js";
import { readDiagnosticSettings } from "./diagnostics/diagnostic-settings.js";
import { mcpDispatchFaultReporter, mcpFaultFrameReporter } from "./mcp-dispatch-fault-report.js";
import type { McpFaultFrame } from "./mcp-fault-frame.js";
import { credentialValues } from "./orchestrator/credential-scrub.js";

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

/** What the stdio composition needs from the process: the seat's credential, the provider the
 *  store env resolved to, and where a tool call that threw is reported. */
export interface StdioServerComposition {
  /**
   * `moe mcp --as-operator` (owner decision 2026-09-18): the owner hands THIS session their own
   * seat, so it is served `operatorDelegateMcpToolKinds()`. A PARAMETER, never an environment
   * variable: a variable is inherited by every child this process spawns, and this must reach
   * nobody else.
   */
  readonly asOperator?: boolean | undefined;
  readonly credential: string;
  /** Told of every delegated operator act BEFORE it is dispatched; see `disclosingDelegatedActs`. */
  readonly onDelegatedAct?: ((act: DelegatedOperatorAct) => void) | undefined;
  readonly onDispatchFault: McpDispatchFaultObserver;
  /** Where a fault frame ANSWERED to the seat is reported; absent means the seat alone sees it. */
  readonly onFaultFrame?: (frame: McpFaultFrame) => void;
  readonly provider: StoreDependencyProvider;
}

/**
 * THE stdio server this entry ships, composed in one place so a test can build exactly what
 * `main` builds and read `tools/list` off it: the wired roster, the typed-payload overlay and
 * the dispatch port over both planes. `main` adds only what the process owns (env, diagnostics,
 * the transport and the drain).
 */
export function composeStdioServer(
  composition: StdioServerComposition,
): ReturnType<typeof createStdioMcpServer> {
  const { credential, onDispatchFault, provider } = composition;
  const asOperator = composition.asOperator === true;
  // Fail closed: the delegate roster is never served without the record of its use.
  if (asOperator && composition.onDelegatedAct === undefined) {
    throw new Error("asOperator composes no delegated-act observer");
  }
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription seam");

  return createStdioMcpServer({
    credential,
    onDispatchFault,
    port: disclosingDelegatedActs(asOperator ? composition.onDelegatedAct : undefined, createMcpDispatchPort({
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
      ...(composition.onFaultFrame === undefined ? {} : { onFaultFrame: composition.onFaultFrame }),
      subscriptions,
      v2Deps: provider.provideV2?.(),
    })),
    // The JSON type of every integer payload key, so a seat reads it off the schema instead
    // of off a refusal (review.submit round, 2026-09-18).
    payloadProperties: asOperator ? operatorDelegateMcpPayloadProperties() : wiredMcpPayloadProperties(),
    serverName: "moe-next",
    // Advertise only what this daemon wires: an agent never sees a tool that
    // could only ever refuse.
    toolAllowlist: asOperator ? operatorDelegateMcpToolKinds() : wiredMcpToolKinds(),
  });
}

/** One operator-only act an outside session performed on the owner's behalf. */
export interface DelegatedOperatorAct {
  readonly commandId: string | null;
  readonly kind: string;
  readonly targetAggregateId: string | null;
}

/** The diagnostics event every delegated operator act lands under, on the project's log plane. */
export const MCP_OPERATOR_ACT_DELEGATED = "MCP_OPERATOR_ACT_DELEGATED";

type DispatchPort = ReturnType<typeof createMcpDispatchPort>;

/**
 * The durable record that an operator act arrived over `moe mcp --as-operator` rather than from
 * the owner's own browser. The command ledger records WHO (the operator principal, which this
 * entry authenticates as) and cannot say HOW; this says how, server-side, before the dispatch,
 * from the bytes this process itself built -- never from anything the client can assert. A
 * malformed body is left to the daemon's decoder, which refuses it by name.
 *
 * It records an ATTEMPT, not an outcome: it is written before the daemon answers, so a refused
 * or replayed command has a line too. Join it to the command ledger by `commandId` to learn
 * what the daemon decided.
 */
export function disclosingDelegatedActs(
  observe: ((act: DelegatedOperatorAct) => void) | undefined,
  port: DispatchPort,
): DispatchPort {
  if (observe === undefined) return port;
  const text = (value: unknown): string | null => typeof value === "string" ? value : null;
  return Object.freeze({
    ...port,
    // Stdio has one identity per process, so this port's dispatch takes the bytes and nothing else.
    dispatchCommandBytes: (bytes: Uint8Array): ReturnType<DispatchPort["dispatchCommandBytes"]> => {
      let envelope: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof parsed === "object" && parsed !== null) envelope = parsed as Record<string, unknown>;
      } catch { /* the daemon's decoder owns the refusal */ }
      const kind = text(envelope["commandKind"]);
      if (kind !== null && MCP_DELEGABLE_OPERATOR_KINDS.includes(kind)) {
        observe({
          commandId: text(envelope["commandId"]),
          kind,
          targetAggregateId: text(envelope["targetAggregateId"]),
        });
      }
      return port.dispatchCommandBytes(bytes);
    },
  });
}

/** What the CLI verb hands this entry in-process; the bin's own self-invocation passes nothing. */
export interface McpMainOptions {
  readonly asOperator?: boolean | undefined;
  /**
   * The project the CLI verb resolved. Without it the log root is inferred from the store path
   * and then the cwd, and a client starts this process from a cwd of its OWN: the delegated-act
   * record would land in the client's folder instead of the project's `.moe/logs`.
   */
  readonly projectRoot?: string | undefined;
}

/** `--as-operator` was asked for while the log plane that records its use is off or too quiet. */
export const MCP_OPERATOR_AUDIT_UNAVAILABLE = "MCP_OPERATOR_AUDIT_UNAVAILABLE";

async function main(options: McpMainOptions = {}): Promise<void> {
  const credential = readBootstrapCredential();
  const config = readStoreDependencyEnv(process.env);
  const projectRoot = options.projectRoot ?? diagnosticProjectRoot(config.storePath, process.cwd());
  // BEFORE the store or the log plane is opened, so a refusal leaves nothing behind: the record is
  // a `warn` on the FILE sink, and MOE_LOG=off or MOE_LOG_LEVEL=error would drop every one of them
  // while the session went on deciding as the operator.
  if (options.asOperator === true) {
    const settings = readDiagnosticSettings(process.env, projectRoot);
    if (!settings.enabled || settings.level === "error") {
      throw new Error(`${MCP_OPERATOR_AUDIT_UNAVAILABLE}: --as-operator needs the log file on at `
        + "warn or lower (MOE_LOG, MOE_LOG_LEVEL), because that is where each delegated act is recorded");
    }
  }
  // This process is spawned by the agent's own CLI, so its stderr is the client's MCP log and
  // nothing else; the file sink under the project's .moe/logs is where a tool call that threw
  // becomes visible to the operator. The session credential is scrubbed with the rest.
  const diagnostics = createDiagnosticRuntime({
    env: process.env,
    projectRoot,
    secrets: [...credentialValues(process.env), credential],
  });
  const provider = createStoreDependencies({ ...config, diagnostics: diagnostics.emitterFor("command") });
  const delegated = diagnostics.emitterFor("mcp-stdio");
  const server = composeStdioServer({
    asOperator: options.asOperator,
    credential,
    // `warn`: the console sink prints it at its default threshold, and the guard above proved the
    // file sink keeps it.
    onDelegatedAct: (act) => { delegated.warn(MCP_OPERATOR_ACT_DELEGATED, { fields: { ...act } }); },
    onDispatchFault: mcpDispatchFaultReporter(diagnostics.emitterFor("mcp-stdio")),
    onFaultFrame: mcpFaultFrameReporter(diagnostics.emitterFor("mcp-stdio")),
    provider,
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
      diagnostics.close();
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
