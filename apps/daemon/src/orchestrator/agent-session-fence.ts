import { createHash } from "node:crypto";

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { activeClaim, readWorkClaimLedger } from "../work/work-claim-services.js";

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
  | { readonly kind: "LIVE" }
  | { readonly kind: "IDLE" }
  | { readonly kind: "UNREADABLE" };

/**
 * Folds the staffing log for one item. Append-only and strictly ordered by
 * aggregate sequence, so the last transition wins: an ADMITTED with no later
 * RETIRED means a child is still live.
 *
 * An unknown event type on this aggregate is UNREADABLE, never ignored — a
 * skipped event is exactly how a fold silently starts admitting.
 */
function foldLiveChild(events: readonly StoredEvent[]): LiveFold {
  let live = false;
  const ordered = [...events].sort((a, b) => a.aggregateSequence - b.aggregateSequence);
  for (const event of ordered) {
    if (!STAFFING_EVENT_TYPES.has(event.eventType)) return { kind: "UNREADABLE" };
    live = event.eventType === ADMITTED;
  }
  return live ? { kind: "LIVE" } : { kind: "IDLE" };
}

export function createAgentSessionFence(config: AgentSessionFenceConfig): AgentSessionFence {
  const { projectId, store } = config;

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
    if (fold.kind === "LIVE") return refuse("AGENT_STAFFING_CHILD_LIVE");
    return ADMIT;
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
    recordLiveChild: (record: AgentLiveChildRecord): readonly Error[] => append(
      "RECORD", record.workItemId,
      {
        claimAggregateVersion: record.claimAggregateVersion,
        sessionId: record.sessionId,
        workItemId: record.workItemId,
      },
    ),
    retireLiveChild: (workItemId: string): readonly Error[] => append(
      "RETIRE", workItemId, { workItemId },
    ),
  });
}
