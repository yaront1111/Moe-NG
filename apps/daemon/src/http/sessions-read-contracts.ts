/**
 * THE SHAPE OF `/sessions/read`, declared apart from the fold that produces it (`sessions-read.ts`).
 * Type-only: nothing here runs. The browser (`apps/control-room/src/live/live-sessions.ts`) decodes
 * every interface below by EXACT ARITY and its tests read THIS file as source text, so a member added
 * anywhere here must land in the browser decoder in the same change or the Seats frame blanks.
 */
export type SessionLiveness = "CLOSED" | "EXPIRED" | "LIVE";
/**
 * How many agents may work at once, and how many are. The two halves are NOT the same
 * kind of fact and the names say so.
 *
 * `configuredAgentLimit` is CONFIGURED, never observed: the MOE_WRAPPER_MAX_AGENTS this
 * DAEMON PROCESS was launched with, parsed by the wrapper's own `readWrapperKnobs`. The
 * daemon and the wrapper are separate processes; `moe up` spawns both from one child
 * environment, so in the launched configuration they agree. A daemon started standalone,
 * or beside a wrapper launched separately with a different value, reports a limit no
 * wrapper is honouring. Nothing here measures the wrapper.
 *
 * `activeSeats` IS measured, from the same ledgers this read already folds: live seats
 * holding at least one active claim at `readAt`. It can lag the wrapper's own in-process
 * count by one pass — a seat is counted from the moment its claim commits, not from the
 * moment its child process starts.
 */
export interface SessionsConcurrency {
  /** Live seats holding at least one active claim, at this read's clock. Measured. */
  readonly activeSeats: number;
  /** The agent limit this daemon process was launched with. Configured, not observed. */
  readonly configuredAgentLimit: number;
}
/**
 * WHICH AGENT COMMAND THIS PROJECT IS CONFIGURED TO STAFF SEATS WITH, and whether the host
 * environment is what decided it. CONFIGURED, never observed — the name says `configured`,
 * not `effective`, for the reason `configuredAgentLimit` says it above.
 *
 * The two inputs are not the same kind of fact. The durable per-project setting IS read
 * from this daemon's own store and is authoritative: the same ledger
 * `project.set_agent_provider` writes and the wrapper reads per spawn. `MOE_AGENT_COMMAND`
 * is read from THIS DAEMON PROCESS'S environment, and the daemon and the wrapper are
 * separate processes; `moe up` spawns both from one child environment, so in the launched
 * configuration they agree. A daemon started standalone, or beside a wrapper launched
 * separately, reports an override no wrapper is applying — and a standalone daemon with no
 * override reports `envOverride: false` plus whatever its store says, which is what the
 * next `moe up` would resolve. Nothing here measures the wrapper.
 *
 * SECOND STATED LIMIT: this read is PROJECT-scoped (`createSessionsReadPort` takes a
 * projectId and no goal), so `configured` is the PROJECT default. A per-GOAL override
 * exists in the durable store and outranks the project setting at spawn for a
 * goal-targeted step; it is NOT disclosable here and this member never reflects one.
 *
 * Precedence is not re-derived: `resolveAgentProvider` — the orchestrator's own resolver,
 * the one the wrapper spawns through — answers, so no second copy can drift from it.
 */
export interface SessionsAgentProvider {
  /**
   * The command a seat would be staffed with, as a provider NAME where the command maps to
   * a known one (`C:\tools\codex.exe` reads `codex`, the same name the pause ledger and the
   * pause banner use) and VERBATIM where it does not. An off-roster `MOE_AGENT_COMMAND` is
   * published exactly as it stands — full path included — rather than collapsed to `claude`
   * the way `pauseProviderOf` deliberately collapses it for ledger keying: an operator must
   * never be shown a provider nobody configured, and reducing an unknown command to its
   * basename would manufacture a provider identity that does not exist.
   */
  readonly configured: string;
  /** True when `MOE_AGENT_COMMAND` in THIS daemon's environment is what decided it. */
  readonly envOverride: boolean;
}
/**
 * HOW ONE SEAT ENDED, quoted from the wrapper's own exit record (`orchestrator/seat-exit-ledger-read.ts`).
 * Second-hand in the same way the `AtStart` members are: the wrapper observed the child's exit and
 * wrote it down; nothing here observes a process. `exitCode` is null when the seat died on a signal
 * rather than an exit code — the record's documented meaning — and `lastLine` is the last non-empty
 * line the seat printed, clipped at the record's bound, or null. EXACT KEYS: the browser decodes this
 * object by exact arity, so a member added here must be added there in the same change.
 */
export interface SeatExitView {
  readonly at: string;
  readonly exitCode: number | null;
  readonly kind: string;
  readonly lastLine: string | null;
}
/**
 * WHAT THIS SEAT WAS STARTED WITH — a THIRD kind of fact, and neither of the two above.
 *
 * `activeSeats` IS measured, by this read, from ledgers it folds itself. `configuredAgentLimit`
 * is CONFIGURED and never observed. These two are MEASURED BUT SECOND-HAND: the WRAPPER measured
 * them, in the wrapper's own process, at the instant it spawned this seat's child, and wrote them
 * to a durable record (`orchestrator/seat-start-ledger.ts`). This read is quoting that note. It is
 * not observing a live process, and the daemon could not: the daemon and the wrapper are separate
 * processes and the daemon cannot see a child it did not spawn. That limit is why both names end
 * in `AtStart` — a `provider` or `agentVersion` here would claim a present-tense observation
 * nothing performs.
 *
 * WHAT A READER MAY THEREFORE CONCLUDE. These say what this seat WAS ACTUALLY STARTED WITH, which
 * is the useful answer and NOT a stale one: after `project.set_agent_provider` changes the setting,
 * a seat still running from before keeps reporting what it really runs, while the frame-level
 * `agentProvider` reports what the NEXT seat would get. The two disagreeing is the disclosure
 * working — it is exactly the window in which an operator needs to see both.
 *
 * WHAT THEY DO NOT SAY: nothing about now. A seat whose CLI was upgraded on disk mid-run still
 * reports the version measured at its start, because that is the version its running process
 * loaded. Nothing here re-probes.
 */
export interface SessionView {
  /**
   * The version this seat's agent CLI reported to `--version` when the wrapper started it, or
   * `SEAT_FACT_UNMEASURED` — never an empty string and never a plausible default. Four causes
   * collapse to that one token on purpose: no start record (every session opened before this
   * ledger existed, and every paired browser that never had a seat), an unreadable record, a
   * probe that failed or timed out, and output that was not shaped like a version.
   */
  readonly agentVersionAtStart: string;
  readonly capabilities: readonly string[];
  /**
   * How this seat ended, or null when no exit record speaks for it: a seat still running, a seat
   * whose wrapper had no pause gate to record with, and every seat that exited before that ledger
   * existed. Before this member the Health screen listed past seats as a count, so a seat killed
   * after hanging for seven minutes with no network read exactly like one that completed.
   */
  readonly exit: SeatExitView | null;
  readonly expiresAt: string;
  /** Work items this seat holds an OPEN, unexpired claim on, at the daemon's clock. */
  readonly holding: readonly string[];
  readonly liveness: SessionLiveness;
  readonly principalId: string;
  /**
   * The agent command the wrapper ACTUALLY spawned this seat with, as a roster name where the
   * command maps to a known provider and verbatim where it does not — the same rule
   * `agentProvider.configured` uses, so the two never disagree about what to call one command.
   * `SEAT_FACT_UNMEASURED` under the same one-unknown rule as the version beside it.
   */
  readonly providerAtStart: string;
  readonly sessionId: string;
  /**
   * The wrapper's clock when it spawned this seat, from the same start record as the two `AtStart`
   * members, or null for a seat with no readable record. The session ledger itself states no open
   * instant, so a paired browser and every seat older than the start ledger read null here — never
   * the read's own clock, which would date them to the wrong moment.
   */
  readonly startedAt: string | null;
  readonly status: "CLOSED" | "OPEN";
}
export interface SessionsView {
  readonly agentProvider: SessionsAgentProvider;
  readonly concurrency: SessionsConcurrency;
  readonly outcome: "SESSIONS";
  readonly readAt: string;
  readonly sessions: readonly SessionView[];
  readonly totals: { readonly closed: number; readonly expired: number; readonly live: number };
  readonly unreadable: boolean;
}
export interface SessionsRefused { readonly code: string; readonly layer: string; readonly outcome: "REFUSED" }
export type SessionsReadResult = SessionsRefused | SessionsView;
export interface SessionsReadPort {
  readonly boundProjectId: string;
  readSessions(): SessionsReadResult;
}
