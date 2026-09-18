/**
 * The spawner's public contract: what a caller may configure, what a failed
 * agent process reports, and the admission-shaped spawn boundary.
 *
 * Split out of `agent-spawner.ts` so the contract stays readable next to the
 * lifecycle that implements it, and so that file stays under the per-file line
 * rail while it grows a start-admission surface. It also holds the wrapper's
 * frozen kind rosters, which are data the wrapper reads, never behaviour: this
 * file declares and freezes, it never executes a decision.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { AGENT_STAFFING_REFUSAL_CODES } from "./agent-session-fence.js";
import { REPOSITORY_DELIVERY_REFUSAL_CODES } from "./repository-delivery-contracts.js";
import type { RepositoryDeliveryRefusal } from "./repository-delivery-contracts.js";
import type { SPAWN_INVOCATION_LAYER, SpawnInvocationRefusalCode } from "./agent-spawn-invocation.js";
import type { SpawnRequest } from "./agent-wrapper.js";
import type { SeatActivityProbe } from "./seat-liveness-probe.js";

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
  /** INJECTED monotonic-ish instant source for the quiet notice; production uses `Date.now`. */
  readonly now?: () => number;
  /**
   * How often a LIVE seat that has printed nothing for a whole interval says so, and the cadence
   * of the liveness tick (probe + silence verdict) while it is on. 0 turns the NOTICE off only:
   * the tick then runs at the default cadence (60 s, never slower than `silenceMs`), so the
   * silence kill is unaffected. Only the notice is optional; hang detection is not.
   */
  readonly quietNoticeMs?: number;
  /**
   * What the wrapper can see of a seat that prints nothing: its descendants and the tree's CPU
   * time. Absent, silence is judged on output alone and every notice says so. A probe that
   * answers `{ ok: false, reason }` (or throws) grants no liveness for that tick; the reason
   * reaches the notice and the kill line, and `warn` is called once per seat on the first
   * failure. Production hands over `createSeatActivityProbe(process.platform)`; a test, a fake.
   */
  readonly probeActivity?: SeatActivityProbe | undefined;
  /**
   * Kill a seat that has shown NO ACTIVITY (no output, no tool child, flat CPU) for this long:
   * the hang detector. Distinct from `timeoutMs`, the absolute cap behind it.
   */
  readonly silenceMs?: number;
  /**
   * Warning-level lines (today: the first liveness-probe failure of a seat). The wrapper tees
   * these at "warn" so a broken probe is visible before it kills anything; absent, `log`.
   */
  readonly warn?: ((line: string) => void) | undefined;
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
  /**
   * The ABSOLUTE cap on one agent process: killed at this age whatever it is doing, and the kill
   * line names the last activity seen. This is the backstop for a provably ACTIVE seat that
   * still does not finish (a tool loop that never converges). A HUNG agent is not this timer's
   * job: `silenceMs` kills it, far sooner, on no output, no tool child and flat CPU.
   */
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
  readonly reason: AgentProcessFailureReason;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly tail: readonly string[];
  readonly outputSeen: boolean;
  /**
   * `outputSeen` is the spawner's own stream reading; a failure minted without one (a test
   * stub, a SPAWN_ERROR before any pipe existed) defaults to what its tail proves, so the flag
   * can never contradict the lines beside it.
   */
  constructor(reason: AgentProcessFailureReason, exitCode: number | null,
    signal: NodeJS.Signals | null, tail: readonly string[] = [],
    outputSeen: boolean = tail.length > 0) {
    super(`AGENT_PROCESS_FAILED:${reason}${exitCode !== null ? `:${String(exitCode)}`
      : signal !== null ? `:${signal}` : ""}`);
    this.name = "AgentProcessFailureError";
    this.reason = reason;
    this.exitCode = exitCode;
    this.signal = signal;
    this.tail = tail;
    this.outputSeen = outputSeen;
  }
}

/**
 * Startup admission is a different fact from process lifetime, so it is a
 * different promise. `exit` is the bounded lifetime/credential settlement this
 * spawner already owned — not independent proof the OS process is gone after a
 * timeout — and with `shell: true` Node's `spawn` event admits the SHELL that
 * was created, never the readiness of the `claude` command inside it.
 */
/**
 * The spawner's OWN refusal layer, distinct from the invocation's: a closed runtime admits no
 * new child. Answered BEFORE any process or credential exists, so every pre-spawn transition a
 * caller made (a checkout moved to EXECUTING, a provisional staffing record) can be reverted.
 * It used to be a thrown plain Error, which the delivery coordinator mapped to a BLOCKED
 * reservation nobody could recover when a stop landed during a git baseline (2026-09-13).
 */
export const AGENT_SPAWNER_LAYER = "agent-spawner" as const;
export type AgentSpawnerRefusalCode = "AGENT_SPAWNER_CLOSED";

export type AgentSpawnStartResult =
  | RepositoryDeliveryRefusal
  | {
    readonly ok: false;
    readonly code: SpawnInvocationRefusalCode;
    readonly layer: typeof SPAWN_INVOCATION_LAYER;
  }
  | {
    readonly ok: false;
    readonly code: AgentSpawnerRefusalCode;
    readonly layer: typeof AGENT_SPAWNER_LAYER;
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
  | Extract<AgentSpawnStartResult, {
    readonly ok: false;
    readonly layer: typeof SPAWN_INVOCATION_LAYER | typeof AGENT_SPAWNER_LAYER;
  }>
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
  /** Repository admission is rechecked automatically after the stated time, without minting seats while waiting. */
  readonly repositoryWaiting?: readonly import("./repository-admission-backoff.js").RepositoryAdmissionWait[];
  /**
   * The live provider pause, present ONLY on a pass that staffed nothing because of it.
   * Absent on every other pass, so an exact-shape assertion on an ordinary report is
   * unchanged by this key existing.
   */
  readonly paused?: ProviderPauseFacts;
  /**
   * The staffing latch, present ONLY once an authority cleanup has failed. From that pass on
   * the wrapper staffs nothing until it is restarted — a deliberate containment, because a
   * cleanup that failed may have left durable claims dangling and staffing more would compound
   * it. Carried on the report so the pass log can say so EVERY pass: before this the halt was
   * printed once, inside a line beginning "nothing to staff", and then deduped forever, so a
   * wedged fleet read as a quiet board. Absent on every other pass, like `paused`.
   */
  readonly halted?: string;
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
  /**
   * Whether ANY byte reached the tee from the seat's stdout or stderr. Null only where no
   * stream was observed (a legacy void lifetime, an uncoded failure). Seat pid 88288
   * (2026-09-12, real project) printed nothing for its whole 30-minute lifetime and its exit
   * record read like any other exit-1; this fact is what tells the two apart.
   */
  readonly outputSeen: boolean | null;
  readonly signal: NodeJS.Signals | null;
  readonly tail: readonly string[];
  /**
   * Whether the WRAPPER began the seat's termination (lifetime timeout, stdin failure, a child
   * `error` event after a pid was assigned, shutdown) rather than the seat closing on its own. On
   * Windows `taskkill /F` closes with exit 1 and no signal, indistinguishable from the seat's own
   * failure unless the wrapper writes this down. Null where no lifetime was observed.
   */
  readonly terminatedByWrapper: boolean | null;
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
  "criterion_check.approve", "criterion_check.verify", "repository.recover",
  // GOAL CREATION IS A PRODUCT INTENT, not a chain chore: since the affordance
  // surface began offering goal.create on EVERY read of an active project
  // (task-9d2d44aa), a wrapper that staffs it mints a fresh junk goal each pass
  // forever — each successful creation clears the attempts counter, so the loop
  // never exhausts. Measured live on the first real project: 8 junk goals in
  // minutes. Goals come from the operator's browser (or the PRD lane), never
  // from a self-staffed agent.
  "approval.decide", "approval.decide_intent",
  // `goal.cancel` is the browser's "Abandon the product" card and a HUMAN act, fenced here on
  // exactly the terms as its siblings. It landed operator-only on 2026-09-17 and was refused
  // over MCP by the DERIVED exclusion, but this roster is hand-kept and was not grown with it.
  "goal.cancel", "goal.close", "goal.create", "goal.create_with_source",
  // Pushing the operator's repository to a remote is the operator's decision; the wrapper
  // performs it as an effect of that decision, never as staffed work.
  "repository.publish",
  "release.decide",
  // Writing an environment variable is not staffable work: the value is a production secret
  // the deploy later hands to a running process, so a wrapper that staffed this could set
  // what production reads. Unlike the kinds above, which the offer surface can present to a
  // human, these two have no agent-facing step at all — the entry here is belt-and-braces
  // beside the MCP exclusion in `mcp-tool-allowlist.ts`, and both are wanted: that one stops
  // an agent reaching the kind over a transport, this one stops the wrapper minting a
  // session to take it.
  "environment.set_variable", "environment.unset_variable",
  // HOW OFTEN PRODUCTION IS PROBED IS THE OPERATOR'S JUDGEMENT, not an agent's. The interval is
  // a trade between monitoring cost and alert noise on the operator's own product, and an agent
  // able to widen it could quietly silence the surface that reports an outage -- the failure
  // would not look like a refusal, it would look like nothing happening. The damage is the
  // ABSENCE of a signal, which is the one kind of harm no later gate can notice.
  //
  // THIS IS THE ONLY FENCE THE KIND CAN CARRY AT THIS COMMIT, and that is deliberate rather
  // than an omission. `mcp-tool-allowlist.ts` holds the transport half for every other kind
  // here, but its `MCP_EXCLUDED_COMMAND_KINDS` is DERIVED from `OPERATOR_PRINCIPAL_KINDS`
  // (daemon-command-vocabulary.ts), which is typed by `WiredCommandKind` and therefore cannot
  // name a kind before `PAYLOAD_KEYS` does. Until task-eb37494e wires the dispatch, the kind is
  // MCP-unreachable for the stronger reason that the advertisement itself derives from
  // `PAYLOAD_KEYS` and does not contain it; `mcp-tool-allowlist.test.ts` asserts that
  // unreachability against the production allowlist AND reds if the dispatch lands without the
  // operator-roster entry. The entry HERE is what stops the wrapper staffing the kind in the
  // meantime, and it is a staffing decision rather than a capability fact, so it keeps applying
  // whatever `agentCapabilitiesFor` later returns.
  "monitoring.set_probe_interval",
  // Retiring an environment ends its monitoring rather than re-timing it, so an agent holding
  // the kind could silence the probe that would have paged a human. Unlike the kind above, this
  // one is wired for dispatch in the SAME row that adds it here, so its MCP exclusion is live
  // from the start (derived from `OPERATOR_PRINCIPAL_KINDS`) rather than resting on the
  // advertisement gap. The entry HERE is still wanted and is not redundant: it is the WRAPPER's
  // half, a staffing decision rather than a capability fact, and it keeps applying whatever
  // `agentCapabilitiesFor` later returns.
  "monitoring.retire_environment",
  // Provider selection chooses which vendor receives source and session credentials. MCP
  // exclusion blocks transport access; this fence also forbids staffing that human decision.
  "project.set_agent_provider",
  // Deciding a product preview is the operator LOOKING AT THE THING and saying yes or no. An
  // agent pressing APPROVE would be staffing the human gate itself, and the verdict the daemon
  // then records would be indistinguishable from a human's. This is the WRAPPER's half of the
  // fence; `mcp-tool-allowlist.ts` holds the other. Different actors, so both are wanted: that
  // one stops an agent REACHING the kind over a transport, this one stops the wrapper minting a
  // session to take it as staffed work. Belt-and-braces beside `agentCapabilitiesFor`, which
  // already returns null for this kind — that gate refuses one step later, after the work item
  // is reported as UNWIRED_KIND, and it is a capability fact rather than a staffing decision,
  // so it would stop applying the moment the kind gained any agent capability at all.
  "preview.decide",
  // ASKING for one is the same human act. `preview.start` spawns a dev server on the daemon
  // host and drives a browser against it, off the daemon's OWN bound workspace -- a seat that
  // could staff it would be running the product on the operator's machine on its own say-so.
  // `mcp-tool-allowlist.ts` holds the other half of the fence (that one stops an agent REACHING
  // the kind over a transport, this one stops the wrapper minting a session to take it), and
  // `agentCapabilitiesFor` already returns null for the kind -- which refuses one step later,
  // as a capability fact rather than a staffing decision, and would stop applying the moment
  // the kind gained any agent capability at all.
  "preview.start",
  // Creating a product repository at an operator-supplied path is the operator's decision; the
  // wrapper performs it as an effect of that decision, never as staffed work. The path is
  // operator input and the command writes a whole tree at it, so a self-staffed session would
  // be choosing where to write on the operator's disk. `mcp-tool-allowlist.ts` holds the other
  // half of the fence: that one stops an agent REACHING the kind over a transport, this one
  // stops the wrapper minting a session to take it.
  "repository.bootstrap",
  // DEPLOYING A PRODUCT IS NEVER AN AGENT'S DECISION, and neither is naming the host it deploys
  // to. Both carry a non-null `agentCapabilitiesFor` (GOAL, like `repository.publish`), so
  // absence here is exactly a staffed-deployer leak: the capability gate would not refuse, and
  // the wrapper would mint a session to take the step. `mcp-tool-allowlist.ts` holds the other
  // half of the fence — that one stops an agent REACHING the kind over a transport, this one
  // stops the wrapper staffing it — and `deploy-command.ts` fences the dispatch itself, since an
  // async entry never reaches the registry's synchronous operator check.
  "deployment.set_target", "deployment.deploy",
  // Replacing the running production image is an operator decision, never staffed work.
  "deployment.rollback",
  // REVERTING A PRODUCTION SCHEMA IS NEVER AN AGENT'S DECISION: it destroys the data the forward
  // migration created, and the wrapper performs it as an effect of the operator's decision, never
  // as staffed work. Belt-and-braces even so -- `agentCapabilitiesFor` already answers null for
  // this kind, so no seat is granted reach in the first place, and `migrate-down-command.ts`
  // fences the dispatch at handler entry because an async entry never reaches the registry's
  // synchronous operator check. Each of the three would have to fail for a schema to be reverted
  // by anything other than a human.
  "deployment.migrate_down",
]);

/** The compiler lane: staffed with `compilerMission`, never the demo payload hint. */
export const COMPILER_STEPS: ReadonlySet<string> = new Set([
  "planning.submit_decomposition", "product_contract.propose_revision",
]);

/**
 * THE PROJECT ACTIVATION CHAIN: the six bootstrap kinds the operator's browser commits to bring
 * a project to READY. The wrapper staffs none of them until `project.activate` is committed
 * (agent-staffing-surface.ts says what is staffable after). MEASURED 2026-09-13 on a real project:
 * each sat READY and unclaimed in turn as the browser drove the chain, and the wrapper spent a
 * claude seat on the READY ones (about 28 s per seat, three attempts per item per wrapper
 * process) before the project was activated; every seat was refused inside claude and exited.
 *
 * A SEPARATE ROSTER FROM `HUMAN_ONLY_STEPS`, CONSULTED ONE LAYER UP, and the reason is measured
 * rather than chosen. `agent-wrapper.test.ts` and its siblings (`agent-wrapper-retry`,
 * `-reclaim`, `agent-provider-pause`) exercise the wrapper's identity, claim and fence
 * mechanics against a FRESH project's real surface, whose only READY steps are
 * `project.register` and `policy.install`: adding these six kinds to `HUMAN_ONLY_STEPS` reds 34
 * of that file's 51 cases (measured 2026-09-13), and `preview-start-command.test.ts` pins the
 * served members of `HUMAN_ONLY_STEPS` by strict equality against a hand transcription. So this
 * roster is enforced by `agent-staffing-surface.ts`, the view of the surface the PRODUCTION
 * binary hands the wrapper (`agent-wrapper-main.ts`); `createAgentWrapper` over a raw port still
 * sees the chain, which is what those suites rely on.
 */
export const OPERATOR_ACTIVATION_STEPS: ReadonlySet<string> = new Set([
  "project.register", "project.bind_repository", "provider.probe",
  "policy.install", "policy.validate", "project.activate",
]);

/**
 * Outcomes the durable staffing gate answers BEFORE any identity is minted.
 * They are not attempts: nothing was spent, and the condition they report
 * (a live predecessor, a held claim, a record the fence cannot read) clears
 * on its own time, not the wrapper's.
 */
/** The wrapper's outcome for a brief whose durable read failed this pass. */
export const NODE_BRIEF_UNREADABLE = "NODE_BRIEF_UNREADABLE";

export const GATE_REFUSALS: ReadonlySet<string> = new Set([
  ...AGENT_STAFFING_REFUSAL_CODES, ...REPOSITORY_DELIVERY_REFUSAL_CODES,
  // The spawner closing under a pass is the process ending, not the item failing its turn.
  "AGENT_SPAWNER_CLOSED" satisfies AgentSpawnerRefusalCode,
  // A brief the store could not serve this pass. Not the item's fault and not a setup fault:
  // it is retried next pass, burns no attempt, and -- unlike a thrown mission -- never latches
  // the wrapper's failure outcome. See `NodeBriefUnreadableError`.
  NODE_BRIEF_UNREADABLE,
]);

/**
 * Thrown by a mission source when the DURABLE READ behind a brief failed -- the compiled graph
 * or the review ledger could not be consulted -- as opposed to a brief that genuinely does not
 * exist (which answers null, NODE_BRIEF_MISSING).
 *
 * A DISTINCT CLASS, not a message, because of what the wrapper does with an ordinary throw from
 * a mission: it records a setup failure, and recorded failures are never cleared, so every later
 * pass returns `spawned: []` until the process restarts. A transient SQLITE_BUSY during a graph
 * read must not take the fleet down that way. The wrapper matches this class BEFORE that path
 * and answers NODE_BRIEF_UNREADABLE, a gate refusal that is simply retried next pass.
 */
export class NodeBriefUnreadableError extends Error {
  public constructor(detail: string) {
    super(`${NODE_BRIEF_UNREADABLE}: ${detail}`);
    this.name = "NodeBriefUnreadableError";
  }
}
