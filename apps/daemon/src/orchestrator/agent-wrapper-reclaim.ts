import { createHash } from "node:crypto";

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import type { CommandAdapterDeps } from "../http/http-contract.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { activeClaim, readWorkClaimLedger } from "../work/work-claim-services.js";
import { createAgentSessionFence } from "./agent-session-fence.js";
import {
  actualVersionOf,
  createReclaimDispatch,
} from "./agent-wrapper-reclaim-dispatch.js";
import type { ReclaimDispatch } from "./agent-wrapper-reclaim-dispatch.js";
import { liveChildOf } from "./agent-wrapper-reclaim-records.js";
import type { LiveChildRecord } from "./agent-wrapper-reclaim-records.js";

/**
 * THE BOOT-TIME RECLAIM: hand back the items a wrapper's dead children still hold.
 *
 * A seat claims under its OWN bearer, so the only principal that could release
 * the claim is a secret that died with the wrapper process. Restart the wrapper
 * and every item its previous children held stays fenced until the claim's
 * 30-minute expiry — the board reads staffed while nothing is running.
 *
 * This pass runs ONCE at boot, before the first staffing pass, over the durable
 * staffing records the fence already keeps. For a record whose child pid is known
 * AND dead it closes the seat's session — which is what makes the daemon's
 * holder-liveness rule admit a foreign release — then releases the claim, then
 * retires the record. That ORDER is load-bearing: release before close and the
 * daemon still sees a live holder and refuses.
 *
 * FAIL CLOSED, exactly like the fence: an alive pid, an unknown pid, a probe
 * outage, an unreadable record or any refusal leaves every aggregate untouched
 * and says so on the log. Nothing here invents a verdict; every effect is a
 * normal dispatch through the committed command adapter.
 */

export const RECLAIM_OUTCOMES = Object.freeze([
  "RECLAIMED",
  "KEPT_ALIVE",
  "KEPT_PID_UNKNOWN",
  "KEPT_LIVENESS_UNKNOWN",
  "CLOSE_REFUSED",
  "RELEASE_REFUSED",
  "RETIRE_FAILED",
] as const);

export type ReclaimOutcome = (typeof RECLAIM_OUTCOMES)[number];

export interface ReclaimReport {
  /** The code that refused or failed, when the outcome names one; null otherwise. */
  readonly code: string | null;
  readonly outcome: ReclaimOutcome;
  readonly sessionId: string;
  readonly workItemId: string;
}

export interface ReclaimPassConfig {
  readonly clock: () => number;
  readonly deps: CommandAdapterDeps;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly log: (line: string) => void;
  /** Correlates one boot's commands in the audit log; command ids stay derived. */
  readonly mintSecret: () => string;
  readonly operatorCredential: string;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export type { LiveChildRecord } from "./agent-wrapper-reclaim-records.js";

const STAFFING_PREFIX = "wrapper-staffing/";
/** Session refusals that mean the seat is ALREADY gone — not a reason to stop. */
const SESSION_SETTLED: ReadonlySet<string> = new Set([
  "SESSION_ALREADY_CLOSED", "SESSION_NOT_FOUND",
]);
/** A claim another pass already released is settled, not a refusal to report. */
const CLAIM_SETTLED: ReadonlySet<string> = new Set(["WORK_CLAIM_NOT_FOUND"]);
const CONFLICT = "EXPECTED_VERSION_CONFLICT";

/**
 * Every staffing record that is ADMITTED and not yet RETIRED.
 *
 * The fence writes RAW events, so no decision reader lists them; this walks the
 * aggregate ids by prefix and folds each log's last transition. A record it
 * cannot read is SKIPPED with a log line and never throws — one corrupt
 * aggregate must not stop the boot pass from reclaiming the rest.
 */
export function enumerateLiveChildren(
  store: SqliteEventStore, log?: (line: string) => void,
): readonly LiveChildRecord[] {
  let aggregateIds: readonly string[];
  try {
    aggregateIds = store.enumerateAggregateIdsByPrefix(STAFFING_PREFIX);
  } catch {
    log?.("[wrapper] skipped the staffing log: it could not be enumerated");
    return [];
  }
  const live: LiveChildRecord[] = [];
  for (const aggregateId of aggregateIds) {
    let events: readonly StoredEvent[];
    try {
      events = store.readEvents(aggregateId);
    } catch {
      log?.(`[wrapper] skipped ${aggregateId}: staffing record unreadable`);
      continue;
    }
    const folded = liveChildOf(events);
    if (folded === "UNREADABLE") {
      log?.(`[wrapper] skipped ${aggregateId}: staffing record unreadable`);
      continue;
    }
    if (folded !== null) live.push(folded);
  }
  return Object.freeze(live);
}

function commandIdFor(action: string, key: string, attempt: number): string {
  return `wrap-reclaim-${createHash("sha256")
    .update(JSON.stringify([key, action, attempt]), "utf8")
    .digest("hex").slice(0, 24)}`;
}

/** Closes the dead seat FIRST: the daemon never admits a live holder's release. */
function closeSeat(
  config: ReclaimPassConfig, dispatch: ReclaimDispatch, sessionId: string,
): string | null {
  let record: { readonly status: string; readonly version: number } | undefined;
  try {
    const ledger = readSessionLedger(config.store, config.projectId);
    if (ledger.unreadable) return "SESSION_LEDGER_UNREADABLE";
    record = ledger.sessions.get(sessionId);
  } catch {
    return "SESSION_LEDGER_UNREADABLE";
  }
  if (record === undefined || record.status === "CLOSED") return null;
  const closed = dispatch(
    "session.close", { sessionId }, `session/${sessionId}`, record.version,
    commandIdFor("session.close", sessionId, record.version),
  );
  return closed.ok || SESSION_SETTLED.has(closed.code) ? null : closed.code;
}

/** Releases the claim, retrying ONCE at the version a conflict named. */
function releaseClaim(
  config: ReclaimPassConfig, dispatch: ReclaimDispatch, workItemId: string, now: string,
): string | null {
  let version: number | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let held: { readonly version: number } | null;
    try {
      const ledger = readWorkClaimLedger(config.store, config.projectId);
      if (ledger.unreadable) return "WORK_CLAIM_LEDGER_UNREADABLE";
      held = activeClaim(ledger.claims.get(workItemId), now);
    } catch {
      return "WORK_CLAIM_LEDGER_UNREADABLE";
    }
    // No active claim: an expired or already-released hold needs no release, and
    // the staffing record still deserves its retire.
    if (held === null) return null;
    const at: number = version ?? held.version;
    const released = dispatch(
      "work.release", { workItemId }, `work/${workItemId}`, at,
      commandIdFor("work.release", workItemId, at),
    );
    if (released.ok || CLAIM_SETTLED.has(released.code)) return null;
    // Only a conflict earns the retry, and only at a version it actually named
    // that differs from the one just refused — otherwise this would spin.
    version = released.code === CONFLICT ? actualVersionOf(released.detail) : null;
    if (version === null || version === at) return released.code;
  }
  return CONFLICT;
}

export function runReclaimPass(config: ReclaimPassConfig): readonly ReclaimReport[] {
  const { isProcessAlive, log, store } = config;
  const dispatch = createReclaimDispatch(
    config.deps, config.operatorCredential,
    `wrap-reclaim-${config.mintSecret().slice(0, 18)}`,
  );
  const now = new Date(config.clock()).toISOString();
  const fence = createAgentSessionFence({
    isProcessAlive, projectId: config.projectId, store,
  });
  const reports: ReclaimReport[] = [];
  const keep = (
    child: LiveChildRecord, outcome: ReclaimOutcome, code: string | null, why: string,
  ): void => {
    log(`[wrapper] kept ${child.workItemId}: ${why}`);
    reports.push(Object.freeze({
      code, outcome, sessionId: child.sessionId, workItemId: child.workItemId,
    }));
  };

  for (const child of enumerateLiveChildren(store, log)) {
    const { sessionId, workItemId } = child;
    if (child.childPid === null) {
      keep(child, "KEPT_PID_UNKNOWN", null, "pid unknown");
      continue;
    }
    let alive: boolean;
    try {
      alive = isProcessAlive(child.childPid);
    } catch {
      // "Cannot tell" is not "dead" — the same posture the fence takes.
      keep(child, "KEPT_LIVENESS_UNKNOWN", null, "liveness unknown");
      continue;
    }
    if (alive) {
      keep(child, "KEPT_ALIVE", null, "child alive");
      continue;
    }
    const closeRefusal = closeSeat(config, dispatch, sessionId);
    if (closeRefusal !== null) {
      keep(child, "CLOSE_REFUSED", closeRefusal, `session close refused ${closeRefusal}`);
      continue;
    }
    const releaseRefusal = releaseClaim(config, dispatch, workItemId, now);
    if (releaseRefusal !== null) {
      keep(child, "RELEASE_REFUSED", releaseRefusal, `release refused ${releaseRefusal}`);
      continue;
    }
    const failures = fence.retireLiveChild(workItemId);
    if (failures.length > 0) {
      const code = failures[0]?.message ?? "AGENT_STAFFING_RETIRE_FAILED:UNKNOWN";
      keep(child, "RETIRE_FAILED", code, `retire failed ${code}`);
      continue;
    }
    log(`[wrapper] reclaimed ${workItemId} from ${sessionId}`);
    reports.push(Object.freeze({
      code: null, outcome: "RECLAIMED" as const, sessionId, workItemId,
    }));
  }
  return Object.freeze(reports);
}
