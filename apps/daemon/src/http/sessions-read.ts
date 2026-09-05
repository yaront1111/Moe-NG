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
export interface SessionView {
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  /** Work items this seat holds an OPEN, unexpired claim on, at the daemon's clock. */
  readonly holding: readonly string[];
  readonly liveness: SessionLiveness;
  readonly principalId: string;
  readonly sessionId: string;
  readonly status: "CLOSED" | "OPEN";
}
export interface SessionsView {
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
  readonly projectId: string;
  readonly readClaims?: (store: SqliteEventStore, projectId: string) => WorkClaimLedger;
  readonly readSessions?: (store: SqliteEventStore, projectId: string) => SessionLedger;
  readonly store: SqliteEventStore;
}

export function createSessionsReadPort(options: SessionsReadOptions): SessionsReadPort {
  const { projectId, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const readSessions = options.readSessions ?? readSessionLedger;
  const readClaims = options.readClaims ?? readWorkClaimLedger;
  const read = (): SessionsReadResult => {
    try {
      const now = clock();
      const ledger = readSessions(store, projectId);
      const claims = readClaims(store, projectId);
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
        sessions.push(Object.freeze({
          capabilities: record.capabilities,
          expiresAt: record.expiresAt,
          holding,
          liveness,
          principalId: record.principalId,
          sessionId: record.sessionId,
          status: record.status,
        }));
      }
      sessions.sort((left, right) => (left.liveness === right.liveness
        ? right.expiresAt.localeCompare(left.expiresAt)
        : (left.liveness === "LIVE" ? -1 : right.liveness === "LIVE" ? 1 : left.liveness === "EXPIRED" ? -1 : 1)));
      return Object.freeze({
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
