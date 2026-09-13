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
import type {
  SessionLiveness, SessionView, SessionsAgentProvider, SessionsReadPort, SessionsReadResult, SessionsRefused,
} from "./sessions-read-contracts.js";

export const SESSIONS_READ_PATH = "/sessions/read" as const;
const LAYER = "SESSIONS_READ" as const;

/** The published shape is declared beside the fold; every importer keeps reading it from here. */
export type {
  SeatExitView, SessionLiveness, SessionView, SessionsAgentProvider, SessionsConcurrency, SessionsReadPort,
  SessionsReadResult, SessionsRefused, SessionsView,
} from "./sessions-read-contracts.js";

export const SESSIONS_READ_CODES = Object.freeze([
  "SESSIONS_READ_CAPABILITY_DENIED", "SESSIONS_READ_PROJECT_MISMATCH", "SESSIONS_READ_UNREADABLE",
] as const);

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
