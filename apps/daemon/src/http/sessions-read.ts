/**
 * SESSIONS: who holds a seat on this daemon. Every session the identity ledger folds
 * (operator or minted agent seat), with its principal, capabilities, expiry and whether it
 * is live at the daemon's clock, joined to the work items its claims hold. Nothing here
 * mints or reads a credential: the credential digest stays out of the view on purpose.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import type { SessionLedger } from "../identity/session-read-model.js";
import { agentProviderFact, resolveAgentProvider } from "../orchestrator/agent-provider-resolve.js";
import { providerFor } from "../orchestrator/moe-up-credentials.js";
import { readSeatExitLedger } from "../orchestrator/seat-exit-ledger-read.js";
import type { SeatExitLedger } from "../orchestrator/seat-exit-ledger-read.js";
import { SEAT_START_UNKNOWN, readSeatStartLedger } from "../orchestrator/seat-start-ledger.js";
import type { SeatStartLedger } from "../orchestrator/seat-start-ledger.js";
import { readWorkClaimLedger } from "../work/work-claim-read-model.js";
import type { WorkClaimLedger } from "../work/work-claim-read-model.js";
import { activeClaim } from "../work/work-claim-services.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const SESSIONS_READ_PATH = "/sessions/read" as const;
const LAYER = "SESSIONS_READ" as const;

export const SESSIONS_READ_CODES = Object.freeze([
  "SESSIONS_READ_CAPABILITY_DENIED", "SESSIONS_READ_PROJECT_MISMATCH", "SESSIONS_READ_UNREADABLE",
] as const);

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

const refused = (code: string): SessionsRefused => Object.freeze({ code, layer: LAYER, outcome: "REFUSED" as const });

export interface SessionsReadOptions {
  readonly clock?: () => string;
  /**
   * REQUIRED, and not defaulted on purpose: a member that quietly falls back to the
   * wrapper's default would publish "2" from a daemon that was never told the limit,
   * and no test could tell that apart from the real knob. Production supplies
   * `readWrapperKnobs(process.env).maxAgents` at the composition site.
   */
  readonly configuredAgentLimit: number;
  /**
   * `MOE_AGENT_COMMAND` as THIS daemon process was launched with. Optional and defaulted
   * to the live `process.env` rather than required, because unlike the agent limit there
   * is no silent-fallback hazard here: absent means absent, and absent is precisely the
   * fact `envOverride: false` publishes. Injectable so an arm can set and unset it
   * without mutating the test runner's own environment.
   */
  readonly envAgentCommand?: string | null | undefined;
  readonly projectId: string;
  readonly readClaims?: (store: SqliteEventStore, projectId: string) => WorkClaimLedger;
  /**
   * The wrapper's seat-start notes, defaulted to the production fold exactly as `readSessions`
   * and `readClaims` are, so the port stays drivable without sqlite. A default cannot publish an
   * untold value here: absent notes ARE the fact `SEAT_FACT_UNMEASURED` states.
   */
  readonly readSeatStarts?: (store: SqliteEventStore, projectId: string) => SeatStartLedger;
  /**
   * The durable agent-provider setting for one scope, defaulted to the production store
   * read exactly as `readSessions`/`readClaims` are. A default here cannot publish an
   * untold value the way a defaulted `configuredAgentLimit` would: the default IS the
   * production reader, so the fallback and the real thing are the same code path.
   */
  readonly readProvider?: (store: SqliteEventStore, projectId: string) => (goalId: string) => string | null;
  /** The wrapper's seat-exit notes, defaulted to the production fold under the same rule as `readSeatStarts`. */
  readonly readSeatExits?: (store: SqliteEventStore, projectId: string) => SeatExitLedger;
  readonly readSessions?: (store: SqliteEventStore, projectId: string) => SessionLedger;
  readonly store: SqliteEventStore;
}

/**
 * A WRAPPER NOTE MAY NEVER WEDGE THIS READ. The session and claim folds are load bearing — a Seats
 * screen without them says nothing true — but a note about how a seat started or ended is
 * decoration on top of them. A reader that throws yields NO notes, which degrades every seat to the
 * same stated unknown a seat opened before the ledger existed already carries.
 */
function decoration<T>(read: () => ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  try {
    return read();
  } catch {
    return new Map();
  }
}

/**
 * The provider disclosure for THIS read's project scope. `resolveAgentProvider` is called
 * with no goalRef on purpose — see SessionsAgentProvider — and `envOverride` is decided by
 * the same `present()` rule the resolver uses for rung 1, so the flag can never say "the
 * env decided this" about a blank or whitespace variable the resolver ignored.
 */
function agentProviderOf(
  envCommand: string | null | undefined, settingFor: (goalId: string) => string | null,
): SessionsAgentProvider {
  const command = resolveAgentProvider({ envCommand, settingFor });
  return Object.freeze({
    configured: providerFor(command)?.leaf ?? command,
    envOverride: typeof envCommand === "string" && envCommand.trim().length > 0,
  });
}

export function createSessionsReadPort(options: SessionsReadOptions): SessionsReadPort {
  const { projectId, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const readSessions = options.readSessions ?? readSessionLedger;
  const readClaims = options.readClaims ?? readWorkClaimLedger;
  const readSeatStarts = options.readSeatStarts ?? readSeatStartLedger;
  const readSeatExits = options.readSeatExits ?? readSeatExitLedger;
  const readProvider = options.readProvider ?? agentProviderFact;
  const envAgentCommand = "envAgentCommand" in options
    ? options.envAgentCommand : process.env["MOE_AGENT_COMMAND"];
  const read = (): SessionsReadResult => {
    try {
      const now = clock();
      const ledger = readSessions(store, projectId);
      const claims = readClaims(store, projectId);
      const seatStarts: SeatStartLedger = decoration(() => readSeatStarts(store, projectId));
      const seatExits: SeatExitLedger = decoration(() => readSeatExits(store, projectId));
      const holdings = new Map<string, string[]>();
      for (const record of claims.claims.values()) {
        if (activeClaim(record, now) === null) continue;
        const list = holdings.get(record.claimedBy) ?? [];
        list.push(record.workItemId);
        holdings.set(record.claimedBy, list);
      }
      const sessions: SessionView[] = [];
      const totals = { closed: 0, expired: 0, live: 0 };
      let activeSeats = 0;
      for (const record of ledger.sessions.values()) {
        const liveness: SessionLiveness = record.status === "CLOSED" ? "CLOSED"
          : record.expiresAt > now ? "LIVE" : "EXPIRED";
        totals[liveness === "CLOSED" ? "closed" : liveness === "LIVE" ? "live" : "expired"] += 1;
        const holding = Object.freeze([...(holdings.get(record.principalId) ?? []), ...(record.principalId === record.sessionId ? [] : holdings.get(record.sessionId) ?? [])].sort());
        // A seat counts against the limit when it is LIVE and holding work. A paired
        // browser holds nothing and an expired seat is not working, so neither is a seat
        // the wrapper could have staffed instead.
        if (liveness === "LIVE" && holding.length > 0) activeSeats += 1;
        // No note for this seat is the NORMAL case, not an error, so it takes the same stated
        // unknown a failed probe takes rather than a second vocabulary.
        const started = seatStarts.get(record.sessionId) ?? SEAT_START_UNKNOWN;
        const exit = seatExits.get(record.sessionId);
        sessions.push(Object.freeze({
          agentVersionAtStart: started.agentVersion,
          capabilities: record.capabilities,
          exit: exit === undefined ? null
            : Object.freeze({ at: exit.at, exitCode: exit.exitCode, kind: exit.kind, lastLine: exit.lastLine }),
          expiresAt: record.expiresAt,
          holding,
          liveness,
          principalId: record.principalId,
          providerAtStart: started.provider,
          sessionId: record.sessionId,
          startedAt: started.startedAt,
          status: record.status,
        }));
      }
      sessions.sort((left, right) => (left.liveness === right.liveness
        ? right.expiresAt.localeCompare(left.expiresAt)
        : (left.liveness === "LIVE" ? -1 : right.liveness === "LIVE" ? 1 : left.liveness === "EXPIRED" ? -1 : 1)));
      return Object.freeze({
        agentProvider: agentProviderOf(envAgentCommand, readProvider(store, projectId)),
        concurrency: Object.freeze({ activeSeats, configuredAgentLimit: options.configuredAgentLimit }),
        outcome: "SESSIONS" as const, readAt: now, sessions: Object.freeze(sessions),
        totals: Object.freeze(totals), unreadable: ledger.unreadable || claims.unreadable,
      });
    } catch {
      return refused("SESSIONS_READ_UNREADABLE");
    }
  };
  return Object.freeze({ boundProjectId: projectId, readSessions: read });
}

export type SessionsReadDispatch =
  | { readonly body: SessionsReadResult | HttpPortRefused | HttpRefused; readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: "LISTENER_SESSIONS_REQUEST_INVALID" | "LISTENER_SESSIONS_UNAVAILABLE"; readonly kind: "LISTENER_REFUSAL" };

function emptyBody(body: unknown): boolean {
  if (body instanceof Uint8Array && body.length === 0) return true;
  const decoded = decodeBoundedJsonBytes(body);
  return decoded.ok && typeof decoded.value === "object" && decoded.value !== null
    && !Array.isArray(decoded.value) && Object.keys(decoded.value).length === 0;
}

export function handleSessionsReadRequest(
  dependencies: { readonly authenticator: Authenticator; readonly sessions?: SessionsReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): SessionsReadDispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("SESSIONS_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY" });
  }
  const port = dependencies.sessions;
  if (port === undefined) return Object.freeze({ code: "LISTENER_SESSIONS_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({ body: refused("SESSIONS_READ_PROJECT_MISMATCH"), httpStatus: 200, kind: "REPLY" });
  }
  if (!emptyBody(request.body)) return Object.freeze({ code: "LISTENER_SESSIONS_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  return Object.freeze({ body: port.readSessions(), httpStatus: 200, kind: "REPLY" });
}
