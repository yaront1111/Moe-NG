import type { NodeMission } from "./agent-wrapper.js";
import type { VerifierRunCapture } from "./node-verifier.js";

export type VerifierProcessContainmentReason =
  | "CLOSE_NOT_OBSERVED"
  | "PID_UNAVAILABLE"
  | "TREE_KILL_FAILED";

export class VerifierProcessContainmentError extends Error {
  readonly code = "VERIFIER_PROCESS_CONTAINMENT_FAILED";
  readonly reason: VerifierProcessContainmentReason;

  constructor(reason: VerifierProcessContainmentReason) {
    super(`VERIFIER_PROCESS_CONTAINMENT_FAILED:${reason}`);
    this.name = "VerifierProcessContainmentError";
    this.reason = reason;
  }
}

export class VerifierProcessCancelledError extends Error {
  readonly code = "VERIFIER_PROCESS_CANCELLED";

  constructor() {
    super("VERIFIER_PROCESS_CANCELLED");
    this.name = "VerifierProcessCancelledError";
  }
}

export interface VerifierProcessRunner {
  (brief: NodeMission): Promise<VerifierRunCapture>;
  readonly activeCount: () => number;
  readonly close: () => Promise<void>;
}

/** The signal-0 probe backing the wrapper's durable staffing fence. */
export type ProcessSignalProbe = (pid: number, signal: 0) => void;

/**
 * Is this pid still addressable? `kill(pid, 0)` delivers no signal; it only asks.
 *
 * ESRCH means no such process — the staffing record is stale and the item may be
 * re-staffed. EPERM means the process EXISTS but is owned by someone else, which
 * is ALIVE and must refuse; reading it as "gone" would admit a second agent
 * beside a live child, the exact defect the fence closes. Anything else is
 * propagated so the fence answers LIVENESS_UNKNOWN rather than guessing "dead" —
 * an unknown probe failure is never evidence of death.
 */
export function probeProcessAlive(
  pid: number,
  kill: ProcessSignalProbe = (target, signal) => { process.kill(target, signal); },
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/** The line a supervisor writes on the wrapper's stdin to ask for the same stop as Ctrl-C. */
export const WRAPPER_STDIN_STOP_TOKEN = "stop" as const;

/** The piped-stdin shape the stop signal reads; a TTY is never read. */
export interface WrapperStopInput {
  readonly isTTY?: boolean | undefined;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  unref?(): unknown;
}

interface WrapperSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  readonly stdin?: WrapperStopInput | null | undefined;
}

export interface WrapperStopSignal {
  readonly close: () => void;
  readonly request: () => void;
  readonly requested: () => boolean;
  readonly wait: () => Promise<void>;
}

/**
 * One idempotent stop latch shared by the operator signals, fatal child ownership, and — when
 * the wrapper is supervised over a pipe — its stdin. A console Ctrl-C cannot reach a child
 * spawned without a window, and `child.kill()` on Windows is TerminateProcess, which skips the
 * exit path that retires the seats. So a supervisor asks first: a `stop` line on the pipe
 * requests the same stop Ctrl-C does. Only the explicit line counts — a closed or absent stdin
 * (a service manager, a redirect from nothing) is not a request. A TTY stdin is left alone, and
 * the pipe is unref'd so a single-pass wrapper can still exit on its own.
 */
export function createWrapperStopSignal(
  source: WrapperSignalSource,
  onRequest: () => void,
): WrapperStopSignal {
  let stopping = false;
  let wake!: () => void;
  const stopped = new Promise<void>((resolve) => { wake = resolve; });
  const request = (): void => {
    if (stopping) return;
    stopping = true;
    wake();
    onRequest();
  };
  // Persistent handlers are load-bearing: a second same signal during async
  // teardown must not fall through to Node's default hard-exit behavior.
  source.on("SIGINT", request);
  source.on("SIGTERM", request);
  const input = source.stdin;
  const piped = input !== null && input !== undefined && input.isTTY !== true;
  let pending = "";
  const onData = (chunk: Buffer | string): void => {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/u, "").trim();
      pending = pending.slice(newline + 1);
      if (line === WRAPPER_STDIN_STOP_TOKEN) request();
      newline = pending.indexOf("\n");
    }
  };
  if (piped) {
    input.on("data", onData);
    input.unref?.();
  }
  return Object.freeze({
    close: (): void => {
      source.removeListener("SIGINT", request);
      source.removeListener("SIGTERM", request);
      if (piped) input.removeListener("data", onData);
    },
    request,
    requested: (): boolean => stopping,
    wait: (): Promise<void> => stopped,
  });
}

export interface WrapperRuntimeShutdownResources {
  readonly closeRepositoryDelivery?: (() => Promise<void>) | undefined;
  readonly closeAgentSpawner?: (() => Promise<void>) | undefined;
  readonly closeProvider?: (() => void) | undefined;
  readonly closeVerifierRunner?: (() => Promise<void>) | undefined;
  readonly closeVerifierStore?: (() => void) | undefined;
  readonly settleAgents?: (() => Promise<void>) | undefined;
  readonly stopAuthorityHost?: (() => Promise<void>) | undefined;
}

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error("WRAPPER_RUNTIME_SHUTDOWN_FAILED");

/** Child ownership is attempted first, then network/store authority is revoked
 * on every path. An escaped child must never retain a live bearer endpoint. */
export async function shutdownWrapperRuntime(
  resources: WrapperRuntimeShutdownResources,
): Promise<void> {
  const childStops = [resources.closeVerifierRunner, resources.closeAgentSpawner, resources.closeRepositoryDelivery]
    .filter((stop): stop is () => Promise<void> => stop !== undefined)
    .map(async (stop) => stop());
  const childResults = await Promise.allSettled(childStops);
  const settleResult = resources.settleAgents === undefined
    ? undefined
    : await Promise.resolve().then(resources.settleAgents).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ reason, status: "rejected" as const }),
    );
  const failures = childResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => asError(result.reason));
  if (settleResult?.status === "rejected") failures.push(asError(settleResult.reason));

  if (resources.stopAuthorityHost !== undefined) {
    try {
      await resources.stopAuthorityHost();
    } catch (error) {
      failures.push(asError(error));
    }
  }
  failures.push(...[resources.closeVerifierStore, resources.closeProvider]
    .filter((close): close is () => void => close !== undefined)
    .map((close) => {
      try {
        close();
        return null;
      } catch (error) {
        return asError(error);
      }
    }).filter((error): error is Error => error !== null));

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "WRAPPER_RUNTIME_SHUTDOWN_FAILED");
  }
}
