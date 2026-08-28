/**
 * WHETHER A DURABLE APPROVAL ALREADY BINDS THIS RUN (task-f053d212).
 *
 * `approval.decide` is not a planning-run command at all: it commits `GoalExecutionEnabled` on
 * the GOAL aggregate (`approval-activation.ts:160-167`) and never writes the run, so the run's
 * lifecycle stays `PLAN_REVIEW` after the human has decided. A read that derives reviewability
 * from the lifecycle alone therefore keeps offering an approval that has already been made. This
 * module answers the one question that lifecycle cannot: is there a decision bound to THIS run.
 *
 * IT COMPOSES THE EXISTING DURABLE FACT AND INVENTS NO AUTHORITY. `approval-run-binding.ts:10`
 * names `GoalExecutionEnabled` the daemon's only durable approval fact, and two production
 * readers already consume it this exact way — `human-approval-authority-reader.ts:87-94` and
 * `goal-close-prerequisite.ts:85-96`. The per-run identity is read from the same event's
 * daemon-owned witness (`approval-activation.ts:79-92`, whose `runId` came from
 * `verifyApprovedRunBinding` and never from the request).
 *
 * PER-RUN, NOT PER-GOAL. One goal can hold several sealed runs, so "this goal has an approval"
 * would silence every one of them the moment any one is approved. Only an event whose witness
 * names this `runId` is BOUND.
 *
 * UNREADABLE IS NEVER ABSENT. An event that will not decode, or two events where there can only
 * be one answer, means this reader cannot say whether the human has already decided — and
 * "cannot say" reported as "not approved" is precisely the direction that re-invites a second
 * approval. Both are UNREADABLE and the caller fails closed on them.
 *
 * A PURE READ: no write, no clock, no caller-supplied value, and a store that cannot answer is
 * an outcome rather than a throw across the transport.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

/** The durable approval fact, matched as a STRING because no site exports it. RENAME HAZARD,
 *  reported not fixed: the writer spells it at `approval-activation.ts:167` and two other
 *  readers repeat the literal. A rename there presents here as ABSENT on an approved goal. */
const APPROVAL_EVENT_TYPE = "GoalExecutionEnabled";

export const PLANNING_RUN_APPROVAL_BINDINGS = Object.freeze([
  "ABSENT",
  "BOUND",
  "UNREADABLE",
] as const);

export type PlanningRunApprovalBinding = (typeof PLANNING_RUN_APPROVAL_BINDINGS)[number];

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value === null || typeof value !== "object" || Array.isArray(value)
    ? null : (value as Readonly<Record<string, unknown>>);

/** The goal's approval events, or null when the store cannot answer for the aggregate — an
 *  unreadable world, never an empty one. */
function approvalEvents(
  store: SqliteEventStore, goalRef: string,
): readonly StoredEvent[] | null {
  try {
    return store.readEvents(goalRef)
      .filter((event) => event.aggregateId === goalRef
        && event.eventType === APPROVAL_EVENT_TYPE);
  } catch {
    return null;
  }
}

/** The run this decision names, read out of the daemon's own durable witness, or null when the
 *  payload will not decode or carries no run identity. */
function boundRunId(event: StoredEvent): string | null {
  const decoded = decodeBoundedJsonBytes(event.payload);
  if (!decoded.ok) return null;
  const activation = objectOf(objectOf(decoded.value)?.["activation"]);
  const runId = activation?.["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

/**
 * Whether a durable approval decision binds `runId` on `goalRef`.
 *
 * ABSENT is reserved for the one world this reader can positively vouch for: the goal has no
 * approval event at all. Anything it cannot read — an unreachable store, an undecodable payload,
 * a witness with no run identity, or more than one decision on the goal — is UNREADABLE.
 */
export function readPlanningRunApprovalBinding(input: {
  readonly goalRef: string;
  readonly runId: string;
  readonly store: SqliteEventStore;
}): PlanningRunApprovalBinding {
  const events = approvalEvents(input.store, input.goalRef);
  if (events === null) return "UNREADABLE";
  if (events.length === 0) return "ABSENT";
  if (events.length > 1) return "UNREADABLE";
  const bound = boundRunId(events[0] as StoredEvent);
  if (bound === null) return "UNREADABLE";
  return bound === input.runId ? "BOUND" : "ABSENT";
}
