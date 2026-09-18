/**
 * The wrapper's configuration contract: what one spawn carries, what a coding brief is, and
 * every knob and injected port `createAgentWrapper` reads.
 *
 * Split out of agent-wrapper.ts, which stood at 399 lines against the split-before-400 rail
 * when the pass containment and the closed-spawner stop landed: types only, moved verbatim,
 * re-exported from the wrapper so every existing `from "./agent-wrapper.js"` import still holds.
 */
import type { JsonObject } from "@moe/contracts";
import type { ReviewContinuationApproval } from "@moe/review";

import type { AffordancePort } from "../http/affordance-contract.js";
import type { CommandAdapterDeps } from "../http/http-contract.js";
import type { DesignBrief } from "./agent-mission-text.js";
import type { ProviderPauseGate } from "./agent-provider-pause.js";
import type { AgentSessionFence } from "./agent-session-fence.js";
import type { AgentSpawnStart, SpawnStartRefusal } from "./agent-spawn-contract.js";

export interface SpawnRequest {
  /** The agent's bearer credential. Hand it to the process environment only. */
  readonly credential: string;
  /** The CLAIM's expiry, the horizon the mission names; the bearer's is longer. */
  readonly expiresAt: string;
  readonly kind: string;
  readonly mission: string;
  /** The agent command THIS seat is spawned with; absent keeps the spawner's own chain. */
  readonly provider?: string;
  readonly sessionId: string;
  readonly workItemId: string;
  /** For code nodes: the directory the agent works in; null for chain steps. */
  readonly workspace: string | null;
}

/** Operator-authored coding brief for one node (full spec file). */
export interface NodeMission {
  readonly instructions: string;
  readonly test: string;
  readonly title: string;
  readonly workspace: string;
}

export interface AgentWrapperConfig {
  readonly affordances: AffordancePort;
  /** The durable agent-provider setting for one scope ("" is the project default), or
   *  null when it has none. A fact, not a store handle. */
  readonly agentProvider?: ((goalId: string) => string | null) | undefined;
  /**
   * Claim lifetime per spawn: the reap horizon when a child dies without releasing. While
   * the child LIVES the wrapper renews the claim under the seat's own bearer every third of
   * this (agent-claim-renewal.ts), so a seat that outruns one TTL never loses its claim; the
   * seat may still renew itself. The bearer (`sessionTtlMs`) is derived from the agent
   * lifetime and so outlives every renewal's release: a renewal only ever moves the CLAIM's
   * horizon, and the exit-path release happens while the child's own cap still bounds it.
   */
  readonly claimTtlMs: number;
  readonly clock: () => number;
  readonly deps: CommandAdapterDeps;
  /**
   * One line of wrapper diagnostics: a refused or skipped claim renewal is said here, once per
   * code per seat (`[wrapper] <item> claim renew refused <code>: <detail>`). Absent = stderr.
   * The wrapper bin passes its wrapper.log sink (stdout) so these lines sit beside the seat
   * quiet and kill lines; nothing tees stderr into that log.
   */
  readonly log?: ((line: string) => void) | undefined;
  readonly maxAgents: number;
  /** Stops restaffing one unmoved item; leaving READY or a new proved review grant re-arms it. */
  readonly maxItemAttempts?: number | undefined;
  readonly mintSecret: () => string;
  /** Coding brief per node ref; a node step without one is not staffed. */
  readonly nodeMission?: ((nodeRef: string) => NodeMission | null) | undefined;
  /** Host read of an exact unconsumed human review grant. Never supplied by mission text or an agent. */
  readonly reviewContinuation?: ((nodeRef: string) => ReviewContinuationApproval | null) | undefined;
  readonly operatorCredential: string;
  /**
   * Provider-limit pause: reads every seat exit, refunds a limit exit's attempt and
   * parks staffing until the reset; absent = today's behaviour.
   */
  readonly providerPause?: ProviderPauseGate | undefined;
  /**
   * Optional development payload suggestion embedded in the mission, so a real
   * model does not have to guess witness hashes. Advisory text only — the
   * daemon's decoder remains the sole payload authority.
   */
  readonly payloadHint?: ((kind: string, target: string | null) => JsonObject | null) | undefined;
  /**
   * The Gate 1 approval triple for a source-bound goal, resolved from durable
   * state for the DISPATCHER mission only. Convenience, not authority: the
   * compile dispatcher re-verifies the gate and digest on every submit, so a
   * wrong answer here buys a refusal, never a compile.
   */
  readonly compilerGateRef?: ((goalId: string | null) => JsonObject | null) | undefined;
  /** The goal's own instructions for design and compiler seats; always keyed by the bare goal id. */
  readonly compilerInstructions?: ((goalId: string | null) => string | null) | undefined;
  /** The goal's design outcome for briefs that plan from it. A null answer is STATED as ABSENT
   *  in the brief, never omitted: a seat that cannot tell a skip from a failed read guesses. */
  readonly designBrief?: ((kind: string, target: string | null) => DesignBrief | null) | undefined;
  /** The project the seat's MCP host serves, named in every brief so graph_get is callable. */
  readonly projectId?: string | undefined;
  /**
   * Bearer lifetime per spawn, independent of the claim's. The exit-path
   * release runs under the agent's own secret, so the bearer must outlive the
   * child process: a session bound to the claim TTL dies while a long task is
   * still renewing its claim, and every later release is refused as
   * unauthenticated. Production derives it from the agent lifetime knob
   * (wrapper-knobs.ts); absent, it falls back to `claimTtlMs`.
   */
  readonly sessionTtlMs?: number | undefined;
  /**
   * Starts the agent process and resolves on STARTUP ADMISSION — a coded
   * refusal, or an accepted start whose `exit` is the child's separate lifetime.
   * Injectable for tests.
   */
  /**
   * Read-only repository admission for `node.deliver`, asked before any session, claim or staffing
   * record is written. A refusal names who holds the repository; absent = the spawner alone decides.
   */
  readonly repositoryAdmission?: ((nodeRef: string, workspace: string) => SpawnStartRefusal | null) | undefined;
  readonly spawnAgent: AgentSpawnStart;
  /** Durable pre-identity gate. The lifecycle retains its in-process active map;
   * this injected port survives restarts and expired claims over live children. */
  readonly staffingFence?: AgentSessionFence | undefined;
}
