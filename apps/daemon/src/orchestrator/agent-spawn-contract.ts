/**
 * The spawner's public contract: what a caller may configure, what a failed
 * agent process reports, and the two shapes a spawn boundary can hand back.
 *
 * Split out of `agent-spawner.ts` so the contract stays readable next to the
 * lifecycle that implements it, and so that file stays under the per-file line
 * rail while it grows a start-admission surface. It also holds the wrapper's
 * frozen kind rosters, which are data the wrapper reads, never behaviour: this
 * file declares and freezes, it never executes a decision.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { AGENT_STAFFING_REFUSAL_CODES } from "./agent-session-fence.js";
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
  /**
   * Where the seat's own stdout/stderr are TEED. Production writes the child's raw bytes
   * straight to the wrapper's console, so the operator sees byte-identical output; a test
   * substitutes collecting sinks to prove that identity.
   */
  readonly output?: {
    readonly stderr: NodeJS.WritableStream;
    readonly stdout: NodeJS.WritableStream;
  };
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
    readonly signal: NodeJS.Signals | null, readonly tail: readonly string[] = []) {
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
  | {
    readonly ok: true;
    readonly exit: Promise<SeatExitReport | void>;
    /**
     * The started CHILD's pid, or undefined when the runtime never reported one.
     *
     * Surfaced so the durable staffing fence can probe whether that child is
     * still alive. It must be the child's, never the spawning wrapper's: the
     * child is detached and outlives a SIGKILLed parent, so the parent's pid
     * cannot answer for it. `undefined` is a real possibility (an injected or
     * already-gone child) and callers must fail closed on it rather than
     * substitute their own.
     */
    readonly pid: number | undefined;
  };

export type AgentSpawnStart = (request: SpawnRequest) => Promise<AgentSpawnStartResult>;

export interface AgentSpawnStarter {
  (request: SpawnRequest): Promise<AgentSpawnStartResult>;
  readonly activeCount: () => number;
  readonly close: () => Promise<void>;
}

/** Either the coded refusal, or a live attempt whose two facts stay separate. */
export type SpawnAttempt =
  | Extract<AgentSpawnStartResult, { readonly ok: false }>
  | {
    readonly admitted: Promise<void>;
    readonly done: Promise<SeatExitReport | void>;
    /** Read AFTER `admitted` settles; the pid does not exist before the spawn. */
    readonly pid: () => number | undefined;
  };

/**
 * The refusal arm on its own, so a consumer can report it without restating the
 * vocabulary. Derived from `AgentSpawnStartResult` rather than rewritten: a code
 * this layer never declared is then a compile error at every reporting site,
 * which is the only thing that makes a refusal assertion capable of failing.
 */
export type SpawnStartRefusal = Extract<AgentSpawnStartResult, { readonly ok: false }>;

/**
 * What the wrapper reports for one staffed item.
 *
 * `outcome` is the OPEN board label: besides `"SPAWNED"` it carries command
 * result codes straight off the adapter (`AUTHENTICATION_FAILED`,
 * `EXPECTED_VERSION_CONFLICT`, …) and the `AGENT_SETUP_FAILED:*` family, none of
 * which this file owns a closed vocabulary for. Startup admission is the fact
 * that IS closed, so it lives in `refusal` — non-null exactly when the spawner
 * refused the start, and typed to the producer's own union.
 */
export interface SpawnReport {
  readonly kind: string;
  readonly outcome: string;
  readonly refusal: SpawnStartRefusal | null;
  readonly sessionId: string | null;
  readonly workItemId: string;
}

export interface RunOnceReport {
  readonly active: number;
  /**
   * The live provider pause, present ONLY on a pass that staffed nothing because of it.
   * Absent on every other pass, so an exact-shape assertion on an ordinary report is
   * unchanged by this key existing.
   */
  readonly paused?: ProviderPauseFacts;
  readonly spawned: readonly SpawnReport[];
  readonly surfaceOutcome: string;
}

/**
 * What one finished seat left behind: the exit facts plus the bounded tail of
 * everything it printed. The tail is what a limit reading is decided from — the
 * provider announces a limit in its output, never in its exit code.
 */
export interface SeatExitReport {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly tail: readonly string[];
}

/**
 * How the wrapper READ one seat exit. A `PROVIDER_LIMIT` is the PROVIDER's state,
 * never the work item's failure: the item keeps its attempt and the provider is
 * parked until its reset.
 */
export type SeatExitReading = "COMPLETED" | "FAILED" | "PROVIDER_LIMIT";

/** The live pause a paused pass reports: which provider, since when, until when. */
export interface ProviderPauseFacts {
  readonly provider: string;
  readonly resetAt: string;
  readonly since: string;
}

/**
 * Kinds the wrapper must NEVER staff, exported so the offer surface's test can
 * hold every offered `approval.*` kind against it — an approval kind offered but
 * absent here would let the wrapper mint an agent session to take a human act.
 */
export const HUMAN_ONLY_STEPS: ReadonlySet<string> = new Set([
  // GOAL CREATION IS A PRODUCT INTENT, not a chain chore: since the affordance
  // surface began offering goal.create on EVERY read of an active project
  // (task-9d2d44aa), a wrapper that staffs it mints a fresh junk goal each pass
  // forever — each successful creation clears the attempts counter, so the loop
  // never exhausts. Measured live on the first real project: 8 junk goals in
  // minutes. Goals come from the operator's browser (or the PRD lane), never
  // from a self-staffed agent.
  "approval.decide", "approval.decide_intent",
  "goal.close", "goal.create", "goal.create_with_source",
  // Pushing the operator's repository to a remote is the operator's decision; the wrapper
  // performs it as an effect of that decision, never as staffed work.
  "repository.publish",
  // Writing an environment variable is not staffable work: the value is a production secret
  // the deploy later hands to a running process, so a wrapper that staffed this could set
  // what production reads. Unlike the kinds above, which the offer surface can present to a
  // human, these two have no agent-facing step at all — the entry here is belt-and-braces
  // beside the MCP exclusion in `mcp-tool-allowlist.ts`, and both are wanted: that one stops
  // an agent reaching the kind over a transport, this one stops the wrapper minting a
  // session to take it.
  "environment.set_variable", "environment.unset_variable",
]);

/** The compiler lane: staffed with `compilerMission`, never the demo payload hint. */
export const COMPILER_STEPS: ReadonlySet<string> = new Set([
  "planning.submit_decomposition", "product_contract.propose_revision",
]);

/**
 * Outcomes the durable staffing gate answers BEFORE any identity is minted.
 * They are not attempts: nothing was spent, and the condition they report
 * (a live predecessor, a held claim, a record the fence cannot read) clears
 * on its own time, not the wrapper's.
 */
export const GATE_REFUSALS: ReadonlySet<string> = new Set(AGENT_STAFFING_REFUSAL_CODES);
