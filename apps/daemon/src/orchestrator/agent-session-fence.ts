import { createHash } from "node:crypto";

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { activeClaim, readWorkClaimLedger } from "../work/work-claim-services.js";
import {
  hostBootPortsOf, hostRebootedSince, measureHostBoot, recordedHostBootOf,
} from "./agent-staffing-host-boot.js";
import type {
  HostBootIdPort, HostUptimePort, RecordedHostBoot,
} from "./agent-staffing-host-boot.js";

/**
 * The durable staffing fence: may this wrapper start an agent for this work item?
 *
 * WHY THIS EXISTS. The durable claim already fences contention — `work.claim`
 * refuses a held item with WORK_CLAIM_HELD. What it does not fence is its own
 * EXPIRY. `activeClaim` nulls a claim past `expiresAt`, the affordance surface
 * then projects `claim: null`, and the wrapper's remaining guard is a
 * process-local Map. A child that outlives its 30-minute claim — routine for a
 * coding session — leaves an item that reads UNCLAIMED while an agent is still
 * writing files in the shared worktree, and a second agent gets staffed on it.
 *
 * So this module records the CHILD, not the claim, and keeps that record in the
 * event store where a wrapper restart can still see it. It decides only; the
 * wrapper acts. No spawning happens here.
 *
 * FAIL CLOSED. Every unreadable, ambiguous or throwing durable read refuses
 * staffing. Admitting on a read this module could not understand is precisely
 * the failure it was built to prevent, and an over-eager refusal is recoverable
 * — the retire path frees the item and a dead predecessor stays replaceable.
 */

export const AGENT_STAFFING_LAYER = "WRAPPER_STAFFING" as const;

/**
 * Deliberately NOT added to WORK_CLAIM_PREREQUISITE_REFUSAL_CODES. That list
 * belongs to the work-claim command surface; this is a wrapper-side staffing
 * decision, and a new member there would misname which layer refused.
 *
 * CLAIM_HELD and CHILD_LIVE must stay distinct: the second is the reported
 * defect (expired claim, live child) and collapsing it into ordinary contention
 * would hide the class this module exists to close.
 */
export const AGENT_STAFFING_REFUSAL_CODES = Object.freeze([
  "AGENT_STAFFING_CLAIM_HELD",
  "AGENT_STAFFING_CHILD_LIVE",
  "AGENT_STAFFING_RECORD_UNREADABLE",
  "AGENT_STAFFING_LIVENESS_UNKNOWN",
] as const);

export type AgentStaffingRefusalCode = (typeof AGENT_STAFFING_REFUSAL_CODES)[number];

export interface AgentStaffingAdmission {
  readonly ok: true;
}

export interface AgentStaffingRefusal {
  readonly code: AgentStaffingRefusalCode;
  readonly layer: typeof AGENT_STAFFING_LAYER;
  readonly ok: false;
}

export type AgentStaffingDecision = AgentStaffingAdmission | AgentStaffingRefusal;

export interface AgentLiveChildRecord {
  /**
   * The SPAWNED CHILD's pid — never the recording wrapper's own. A SIGKILLed
   * wrapper leaves its detached child alive as an orphan (see the liveness note
   * on AgentSessionFenceConfig), so the wrapper's pid cannot speak for it.
   *
   * `undefined` when the runtime reported no pid. That is recorded as a pid-less
   * admission, which reads back UNREADABLE and therefore REFUSES: a child we
   * cannot probe must not be assumed dead. The retire path still clears it, so
   * this fails closed without wedging the item.
   */
  readonly childPid: number | undefined;
  /** The claim aggregate version the admission was granted against. */
  readonly claimAggregateVersion: number;
  readonly sessionId: string;
  readonly workItemId: string;
}

export interface AgentSessionFence {
  admit(workItemId: string, now: string): AgentStaffingDecision;
  recordLiveChild(record: AgentLiveChildRecord): readonly Error[];
  retireLiveChild(workItemId: string): readonly Error[];
}

export interface AgentSessionFenceConfig {
  /**
   * Liveness of a recorded CHILD pid, injected so this module never touches the
   * host's pid space and tests never depend on it.
   *
   * WHY THE CHILD AND NOT THE WRAPPER. Probing the recording wrapper's own pid
   * needs no contract change and looks equivalent. It is unsound: agent-spawner
   * starts the child `detached: true` as a group leader and kills it only by
   * explicitly running `killProcessGroup`. SIGKILL the wrapper and that line
   * never runs, so the child SURVIVES — the exact case this fence exists to
   * catch. "Wrapper dead" would then admit a second agent beside a live orphan.
   *
   * PID REUSE FAILS SAFE within one boot: a recycled pid reads as alive, so the
   * fence refuses where it could have admitted, for as long as the stranger
   * runs — whereas the opposite error re-opens the defect. Across a reboot no
   * retire path would ever free the item, which is what the host-boot facts
   * below close.
   */
  readonly isProcessAlive: (pid: number) => boolean;
  /**
   * The host's boot identity and uptime, injected like the probe. Written
   * beside the child's pid and read back at admission: a host that has rebooted
   * since the row was written cannot be running the child, so an alive-reading
   * pid is then a STRANGER's, not evidence — see agent-staffing-host-boot.ts.
   * Both default to the host's own reading. A row without the facts leaves the
   * probe to decide.
   */
  readonly hostBootId?: HostBootIdPort;
  readonly hostUptimeMs?: HostUptimePort;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

const ADMITTED = "AgentStaffingAdmitted";
const RETIRED = "AgentStaffingRetired";
const STAFFING_EVENT_TYPES: ReadonlySet<string> = new Set([ADMITTED, RETIRED]);

const encoder = new TextEncoder();

const ADMIT: AgentStaffingDecision = Object.freeze({ ok: true } as const);

function refuse(code: AgentStaffingRefusalCode): AgentStaffingDecision {
  return Object.freeze({ code, layer: AGENT_STAFFING_LAYER, ok: false } as const);
}

/** Bounded, collision-resistant aggregate id: a work item id is caller-shaped. */
function staffingAggregateId(workItemId: string): string {
  const digest = createHash("sha256").update(workItemId, "utf8").digest("hex");
  return `wrapper-staffing/${digest}`;
}

function commandIdFor(prefix: string, workItemId: string, version: number): string {
  const digest = createHash("sha256").update(workItemId, "utf8").digest("hex").slice(0, 32);
  return `${prefix}-${digest}-${String(version)}`;
}

function errorOf(action: string, cause: unknown): Error {
  return cause instanceof Error
    ? new Error(`AGENT_STAFFING_${action}_FAILED:${cause.message}`)
    : new Error(`AGENT_STAFFING_${action}_FAILED:UNKNOWN`);
}

type LiveFold =
  | {
    readonly childPid: number;
    readonly hostBoot: RecordedHostBoot | null;
    readonly kind: "LIVE";
  }
  | { readonly kind: "IDLE" }
  | { readonly kind: "UNREADABLE" };

/** One ADMITTED row as the fold keeps it: `childPid: null` is live but unprobeable. */
interface AdmittedRecord {
  readonly childPid: number | null;
  readonly hostBoot: RecordedHostBoot | null;
}

const UNPROBEABLE: AdmittedRecord = Object.freeze({ childPid: null, hostBoot: null });

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The recorded child's pid, with the host fact written beside it, or a pid-less
 * record when the payload cannot supply one.
 *
 * A pid this function cannot vouch for must NOT become "no pid, admit": that is
 * the fall-through that would quietly disable the probe. Every rejection here
 * surfaces as UNREADABLE, which refuses.
 */
function admittedRecordOf(event: StoredEvent): AdmittedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(event.payload));
  } catch {
    return UNPROBEABLE;
  }
  if (typeof parsed !== "object" || parsed === null) return UNPROBEABLE;
  const facts = parsed as Record<string, unknown>;
  const pid = facts["childPid"];
  // Integer and positive: 0 and negatives address process GROUPS, not processes,
  // and a fractional or NaN pid can never identify one.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return UNPROBEABLE;
  return { childPid: pid, hostBoot: recordedHostBootOf(facts) };
}

/**
 * Folds the staffing log for one item. Append-only and strictly ordered by
 * aggregate sequence, so the last transition wins: an ADMITTED with no later
 * RETIRED means a child is still live.
 *
 * An unknown event type on this aggregate is UNREADABLE, never ignored — a
 * skipped event is exactly how a fold silently starts admitting. The live
 * record's pid travels with the verdict so `admit` can probe the CHILD.
 */
function foldLiveChild(events: readonly StoredEvent[]): LiveFold {
  // `null` = idle; `{childPid: null}` = live but unprobeable. An unreadable pid
  // is deliberately NOT an early return: a later RETIRED must still be able to
  // clear it, or one pid-less admission wedges the item forever — the permanent
  // deadlock this fence must never trade the race for.
  let live: AdmittedRecord | null = null;
  const ordered = [...events].sort((a, b) => a.aggregateSequence - b.aggregateSequence);
  for (const event of ordered) {
    if (!STAFFING_EVENT_TYPES.has(event.eventType)) return { kind: "UNREADABLE" };
    live = event.eventType === ADMITTED ? admittedRecordOf(event) : null;
  }
  if (live === null) return { kind: "IDLE" };
  return live.childPid === null
    ? { kind: "UNREADABLE" }
    : { childPid: live.childPid, hostBoot: live.hostBoot, kind: "LIVE" };
}

export function createAgentSessionFence(config: AgentSessionFenceConfig): AgentSessionFence {
  const { isProcessAlive, projectId, store } = config;
  const host = hostBootPortsOf(config);

  const admit = (workItemId: string, now: string): AgentStaffingDecision => {
    // 1. The durable claim, which fences ordinary contention.
    let claimHeld: boolean;
    try {
      const ledger = readWorkClaimLedger(store, projectId);
      // A corrupt claim ledger must never read as "nobody holds it".
      if (ledger.unreadable) return refuse("AGENT_STAFFING_RECORD_UNREADABLE");
      claimHeld = activeClaim(ledger.claims.get(workItemId), now) !== null;
    } catch {
      return refuse("AGENT_STAFFING_RECORD_UNREADABLE");
    }
    if (claimHeld) return refuse("AGENT_STAFFING_CLAIM_HELD");

    // 2. The live child, which the claim CANNOT speak for once it has expired.
    let fold: LiveFold;
    try {
      fold = foldLiveChild(store.readEvents(staffingAggregateId(workItemId)));
    } catch {
      return refuse("AGENT_STAFFING_RECORD_UNREADABLE");
    }
    if (fold.kind === "UNREADABLE") return refuse("AGENT_STAFFING_RECORD_UNREADABLE");
    if (fold.kind === "IDLE") return ADMIT;

    // 3. The record says LIVE — but a SIGKILLed wrapper runs no exit handler, so
    // an unretired record is NOT proof the child still exists. Without this
    // probe the item would be unstaffable forever, which is strictly worse than
    // the expiry exposure the fence replaces. A record TTL is not a substitute:
    // a TTL equal to the claim TTL reintroduces that exact expiry defect.
    //
    // The probe itself speaks only for the boot that issued the pid. Once the
    // host has rebooted since the row was written the child is certainly gone,
    // and whatever the pid now addresses would read "alive" until the NEXT
    // reboot with no retire path left to free the item. The witness is clock
    // free — a boot identity, an uptime — because a stepped clock must never
    // admit beside a live orphan. A row without the facts, or a host that
    // cannot be read, proves nothing and the probe decides.
    if (hostRebootedSince(fold.hostBoot, host)) return ADMIT;
    let alive: boolean;
    try {
      alive = isProcessAlive(fold.childPid);
    } catch {
      // "Cannot tell" is not "dead". Distinct code so a probe outage is never
      // mistaken for ordinary contention or for an unreadable record.
      return refuse("AGENT_STAFFING_LIVENESS_UNKNOWN");
    }
    return alive ? refuse("AGENT_STAFFING_CHILD_LIVE") : ADMIT;
  };

  const append = (
    action: "RECORD" | "RETIRE", workItemId: string, payload: Record<string, unknown>,
  ): readonly Error[] => {
    const aggregateId = staffingAggregateId(workItemId);
    try {
      const version = store.getAggregateVersion(aggregateId);
      const eventType = action === "RECORD" ? ADMITTED : RETIRED;
      const commandId = commandIdFor(
        action === "RECORD" ? "stf-adm" : "stf-ret", workItemId, version,
      );
      store.commit({
        aggregateId,
        commandBytes: encoder.encode(JSON.stringify({ action, workItemId })),
        commandId,
        committedAt: new Date().toISOString(),
        events: [{
          eventId: `${commandId}-e1`,
          eventType,
          payload: encoder.encode(JSON.stringify(payload)),
        }],
        expectedVersion: version,
      });
      return [];
    } catch (cause) {
      return [errorOf(action, cause)];
    }
  };

  return Object.freeze({
    admit,
    recordLiveChild: (record: AgentLiveChildRecord): readonly Error[] => {
      // Measured HERE, in the process that spawned the child: one reading of
      // one boot, which is what lets a reader place this row inside it. What
      // cannot be measured is omitted, never guessed.
      return append("RECORD", record.workItemId, {
        // Written only when it is a real pid. Persisting `undefined`/0/-1 would
        // hand the probe a value it cannot use while LOOKING probeable; omitting
        // the key routes it to the UNREADABLE arm, which refuses.
        ...(typeof record.childPid === "number" ? { childPid: record.childPid } : {}),
        claimAggregateVersion: record.claimAggregateVersion,
        ...measureHostBoot(host),
        sessionId: record.sessionId,
        workItemId: record.workItemId,
      });
    },
    retireLiveChild: (workItemId: string): readonly Error[] => append(
      "RETIRE", workItemId, { workItemId },
    ),
  });
}
