/**
 * The spawner's public contract: what a caller may configure, what a failed
 * agent process reports, and the two shapes a spawn boundary can hand back.
 *
 * Split out of `agent-spawner.ts` so the contract stays readable next to the
 * lifecycle that implements it, and so that file stays under the per-file line
 * rail while it grows a start-admission surface. Nothing here executes.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";

import type { SPAWN_INVOCATION_LAYER, SpawnInvocationRefusalCode } from "./agent-spawn-invocation.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/** Everything the spawner touches outside its own arguments, injectable for tests. */
export interface AgentSpawnerOptions {
  readonly command?: string;
  /** Injectable parent environment; every MOE_* authority variable is stripped from the child. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Injectable POSIX negative-pid signal boundary. */
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Maximum wait for process close after requesting tree termination. */
  readonly killGraceMs?: number;
  readonly log?: (line: string) => void;
  /** Fatal containment failures halt the owning runtime; they are never ordinary agent exits. */
  readonly onFatalContainment?: ((error: AgentProcessContainmentError) => void) | undefined;
  readonly spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Hard lifetime for one agent process; a hung agent is killed and its slot freed. */
  readonly timeoutMs?: number;
  /** Platform override for the kill strategy (win32 needs a tree kill). */
  readonly platform?: NodeJS.Platform;
}

export type AgentProcessContainmentReason =
  | "CLOSE_NOT_OBSERVED"
  | "PID_UNAVAILABLE"
  | "TREE_KILL_FAILED";

export class AgentProcessContainmentError extends Error {
  readonly code = "AGENT_PROCESS_CONTAINMENT_FAILED";
  readonly reason: AgentProcessContainmentReason;

  constructor(reason: AgentProcessContainmentReason) {
    super(`AGENT_PROCESS_CONTAINMENT_FAILED:${reason}`);
    this.name = "AgentProcessContainmentError";
    this.reason = reason;
  }
}

export type AgentProcessFailureReason = "EXIT_NONZERO" | "EXIT_SIGNAL" | "SPAWN_ERROR";

export class AgentProcessFailureError extends Error {
  readonly code = "AGENT_PROCESS_FAILED";
  constructor(readonly reason: AgentProcessFailureReason, readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null) {
    super(`AGENT_PROCESS_FAILED:${reason}${exitCode !== null ? `:${String(exitCode)}`
      : signal !== null ? `:${signal}` : ""}`);
    this.name = "AgentProcessFailureError";
  }
}

/** Callable spawn boundary plus explicit ownership of every process it starts. */
export interface AgentSpawner {
  (request: SpawnRequest): Promise<void>;
  readonly activeCount: () => number;
  readonly close: () => Promise<void>;
}

/**
 * Startup admission is a different fact from process lifetime, so it is a
 * different promise. `exit` is the bounded lifetime/credential settlement this
 * spawner already owned — not independent proof the OS process is gone after a
 * timeout — and with `shell: true` Node's `spawn` event admits the SHELL that
 * was created, never the readiness of the `claude` command inside it.
 */
export type AgentSpawnStartResult =
  | {
    readonly ok: false;
    readonly code: SpawnInvocationRefusalCode;
    readonly layer: typeof SPAWN_INVOCATION_LAYER;
  }
  | { readonly ok: true; readonly exit: Promise<void> };

export type AgentSpawnStart = (request: SpawnRequest) => Promise<AgentSpawnStartResult>;

export interface AgentSpawnStarter {
  (request: SpawnRequest): Promise<AgentSpawnStartResult>;
  readonly activeCount: () => number;
  readonly close: () => Promise<void>;
}

/** Either the coded refusal, or a live attempt whose two facts stay separate. */
export type SpawnAttempt =
  | Extract<AgentSpawnStartResult, { readonly ok: false }>
  | { readonly admitted: Promise<void>; readonly done: Promise<void> };
