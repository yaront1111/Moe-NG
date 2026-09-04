/**
 * HEALTH, the read: the facts this daemon process can state about itself and its store,
 * for the operator's Health screen. Process identity (pid, when this composition started),
 * the wire it speaks (protocol version, command authority plane), what it is bound to
 * (project, store path, node-spec dir), the durable ledger's size and last decision, and
 * the verifier's standing authority. Nothing here is a guess: a fact the process does not
 * hold is null, and the ledger numbers are counted on every read.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { readProviderPause } from "../orchestrator/provider-pause-ledger.js";
import { readVerifierStandingAuthority } from "../review/verifier-authority-provider.js";
import type { VerifierStandingAuthority } from "../review/verifier-authority-provider.js";
import { catalogBoundGoals } from "./document-coverage-goals.js";
import { authenticateHttpRequest } from "./http-command-ingress.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { Authenticator, HttpPortRefused, HttpRefused } from "./http-contract.js";

export const HEALTH_READ_PATH = "/health/read" as const;
const LAYER = "HEALTH_READ" as const;
const DECISION_PAGE_SIZE = 512;

export const HEALTH_READ_CODES = Object.freeze([
  "HEALTH_READ_CAPABILITY_DENIED", "HEALTH_READ_PROJECT_MISMATCH", "HEALTH_READ_UNREADABLE",
] as const);

/**
 * The providers a seat can run under, in the order the operator hears about them. One banner is
 * rendered, so a tie is decided here rather than in the browser: claude is named first.
 */
export const KNOWN_PROVIDERS = Object.freeze(["claude", "codex"] as const);

/** A provider limit the fleet is waiting out, as the browser reads it. */
export interface ProviderPauseView {
  readonly lastLine: string;
  readonly provider: string;
  readonly resetAt: string;
  readonly since: string;
  readonly workItemId: string;
}

export interface HealthView {
  readonly agents: { readonly paused: ProviderPauseView | null };
  readonly daemon: {
    readonly commandAuthorityPlane: string;
    readonly nodeSpecsDir: string | null;
    readonly pid: number;
    readonly projectId: string;
    readonly protocolVersion: string;
    readonly startedAt: string;
    readonly storePath: string;
  };
  readonly ledger: {
    readonly aggregates: number;
    readonly commandKinds: number;
    readonly decisionCount: number;
    readonly goals: number | null;
    readonly lastDecidedAt: string | null;
  };
  readonly outcome: "HEALTH";
  readonly readAt: string;
  readonly verifier: VerifierStandingAuthority;
}
export interface HealthRefused { readonly code: string; readonly layer: string; readonly outcome: "REFUSED" }
export type HealthReadResult = HealthRefused | HealthView;
export interface HealthReadPort {
  readonly boundProjectId: string;
  readHealth(): HealthReadResult;
}

const refused = (code: string): HealthRefused => Object.freeze({ code, layer: LAYER, outcome: "REFUSED" as const });

export interface HealthReadOptions {
  readonly clock?: () => string;
  readonly nodeSpecsDir: string | null;
  readonly pid?: number;
  readonly projectId: string;
  readonly readPlane: () => string;
  readonly readVerifier?: (store: SqliteEventStore, projectId: string) => VerifierStandingAuthority;
  readonly startedAt: string;
  readonly store: SqliteEventStore;
  readonly storePath: string;
}

/**
 * The first provider whose limit is still running at `now`, or null.
 *
 * The pause is the wrapper's durable fact, not a guess: a record answers only while its reset is
 * ahead of `now`, and a cause that never named a line reports an empty line rather than reddening
 * the whole health read. Roster order breaks a tie because the operator sees one banner.
 */
function pausedAgent(
  store: SqliteEventStore, projectId: string, now: string,
): ProviderPauseView | null {
  for (const provider of KNOWN_PROVIDERS) {
    const record = readProviderPause(store, projectId, provider, now);
    if (record === null) continue;
    return Object.freeze({
      lastLine: record.cause?.lastLine ?? "",
      provider: record.provider,
      resetAt: record.resetAt,
      since: record.since,
      workItemId: record.cause?.workItemId ?? "",
    });
  }
  return null;
}

/** The latest committed decision instant for this project, one page walk. */
function lastDecidedAt(store: SqliteEventStore, projectId: string): string | null {
  let last: string | null = null;
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, DECISION_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId) continue;
      if (last === null || decision.decidedAt > last) last = decision.decidedAt;
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return last;
}

export function createHealthReadPort(options: HealthReadOptions): HealthReadPort {
  const { projectId, store } = options;
  const clock = options.clock ?? ((): string => new Date().toISOString());
  const readVerifier = options.readVerifier ?? readVerifierStandingAuthority;
  const readHealth = (): HealthReadResult => {
    try {
      const ledger = readDurableLedger(store, projectId);
      const goals = catalogBoundGoals(store, projectId);
      // ONE INSTANT PER READ: the pause window and the stated read time never disagree.
      const now = clock();
      return Object.freeze({
        agents: Object.freeze({ paused: pausedAgent(store, projectId, now) }),
        daemon: Object.freeze({
          commandAuthorityPlane: options.readPlane(),
          nodeSpecsDir: options.nodeSpecsDir,
          pid: options.pid ?? process.pid,
          projectId,
          protocolVersion: WIRE_PROTOCOL_VERSION,
          startedAt: options.startedAt,
          storePath: options.storePath,
        }),
        ledger: Object.freeze({
          aggregates: ledger.aggregates.size,
          commandKinds: ledger.kinds.size,
          decisionCount: ledger.decisionCount,
          goals: goals === null ? null : goals.length,
          lastDecidedAt: lastDecidedAt(store, projectId),
        }),
        outcome: "HEALTH" as const,
        readAt: now,
        verifier: readVerifier(store, projectId),
      });
    } catch {
      return refused("HEALTH_READ_UNREADABLE");
    }
  };
  return Object.freeze({ boundProjectId: projectId, readHealth });
}

export type HealthReadDispatch =
  | { readonly body: HealthReadResult | HttpPortRefused | HttpRefused; readonly httpStatus: number; readonly kind: "REPLY" }
  | { readonly code: "LISTENER_HEALTH_REQUEST_INVALID" | "LISTENER_HEALTH_UNAVAILABLE"; readonly kind: "LISTENER_REFUSAL" };

function emptyBody(body: unknown): boolean {
  if (body instanceof Uint8Array && body.length === 0) return true;
  const decoded = decodeBoundedJsonBytes(body);
  return decoded.ok && typeof decoded.value === "object" && decoded.value !== null
    && !Array.isArray(decoded.value) && Object.keys(decoded.value).length === 0;
}

export function handleHealthReadRequest(
  dependencies: { readonly authenticator: Authenticator; readonly health?: HealthReadPort | undefined },
  request: { readonly body: unknown; readonly credential: string | null; readonly protocolVersion: unknown },
): HealthReadDispatch {
  const access = authenticateHttpRequest(dependencies.authenticator, request.credential, request.protocolVersion);
  if (!access.ok) return Object.freeze({ body: access, httpStatus: access.httpStatus, kind: "REPLY" });
  if (!access.principal.capabilities.includes(CAPABILITIES.GOAL)) {
    return Object.freeze({ body: refused("HEALTH_READ_CAPABILITY_DENIED"), httpStatus: 200, kind: "REPLY" });
  }
  const port = dependencies.health;
  if (port === undefined) return Object.freeze({ code: "LISTENER_HEALTH_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
  if (access.principal.projectId !== port.boundProjectId) {
    return Object.freeze({ body: refused("HEALTH_READ_PROJECT_MISMATCH"), httpStatus: 200, kind: "REPLY" });
  }
  if (!emptyBody(request.body)) return Object.freeze({ code: "LISTENER_HEALTH_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
  return Object.freeze({ body: port.readHealth(), httpStatus: 200, kind: "REPLY" });
}
