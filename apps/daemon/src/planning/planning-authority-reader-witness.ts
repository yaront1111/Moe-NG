/**
 * The GOAL side of the planning-authority read (task-47b2dbc6): from a goalId to the verified run
 * identity its durable approval bound, or the refusal that says why there is none.
 *
 * Split from `planning-authority-reader-seal.ts`, which owns the authority-aggregate side. The
 * two halves fail for different reasons and are read for different reasons.
 *
 * `GoalExecutionEnabled` is the daemon's ONLY durable approval fact. Selection follows the
 * discipline `readApprovedNodeScope` sets at goal-close-prerequisite.ts:85-97 — exactly one event,
 * approval APPROVE/DECIDED/CURRENT — but each reason gets its OWN code here, because "absent",
 * "ambiguous" and "broken" are different operator problems and a single null would erase which.
 */
import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readerRefusal } from "./planning-authority-reader-contract.js";
import type { PlanningAuthorityReaderRefusal } from "./planning-authority-reader-contract.js";

const ACTIVATION_EVENT_TYPE = "GoalExecutionEnabled";

/** The four keys the durable witness binds. Legacy history carries them ABSENT, never null. */
const BINDING_KEYS = Object.freeze([
  "authorityRef", "bodiesDigest", "envelopeDigest", "runId",
] as const);

export type JsonRecord = Readonly<Record<string, unknown>>;

/** The four durable facts `verifyApprovedRunBinding` bound at approval-run-binding.ts:143-190. */
export interface ApprovedRunBinding {
  readonly authorityRef: string;
  readonly bodiesDigest: string;
  readonly envelopeDigest: string;
  readonly runId: string;
}

export const recordOf = (value: unknown): JsonRecord | null =>
  value === null || typeof value !== "object" || Array.isArray(value)
    ? null : (value as JsonRecord);

export const refOf = (record: JsonRecord, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

export function payloadRecord(payload: Uint8Array): JsonRecord | null {
  const decoded = decodeBoundedJsonBytes(payload);
  return decoded.ok ? recordOf(decoded.value) : null;
}

export const eventsOfType = (
  events: readonly StoredEvent[], eventType: string,
): readonly StoredEvent[] => events.filter((event) => event.eventType === eventType);

/**
 * `store.readEvents` and nothing else. `readDurableLedger` CANNOT see the authority aggregate: it
 * folds only `decision.targetAggregateId`, and the authority leg is a SECONDARY leg, so a ledger
 * read reports it empty forever.
 */
export function readAggregate(
  store: SqliteEventStore, aggregateId: string,
): readonly StoredEvent[] {
  try {
    return store.readEvents(aggregateId);
  } catch {
    return [];
  }
}

/** The durable approval this read answers for. Anything short of a CURRENT approve confers nothing. */
function isCurrentApproval(payload: JsonRecord): boolean {
  const approval = recordOf(payload["approval"]);
  return approval !== null && approval["decision"] === "APPROVE"
    && approval["lifecycle"] === "DECIDED" && approval["validity"] === "CURRENT";
}

/**
 * The witness binding, or the refusal that says why there is none.
 *
 * ALL FOUR OR NONE. All absent is pre-binding HISTORY and answers UNKNOWN; a partial set is a
 * BROKEN witness, and reporting that as legacy would retire a live corruption as "an old run".
 * A null or empty value counts as present-and-broken, never as absent.
 */
function bindingOf(activation: JsonRecord): ApprovedRunBinding | PlanningAuthorityReaderRefusal {
  const present = BINDING_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(activation, key));
  if (present.length === 0) return readerRefusal("PLANNING_AUTHORITY_READER_LEGACY_UNBOUND");
  const bound = BINDING_KEYS.map((key) => refOf(activation, key));
  if (present.length !== BINDING_KEYS.length || bound.some((value) => value === null)) {
    return readerRefusal("PLANNING_AUTHORITY_READER_APPROVAL_MALFORMED", "partial-binding");
  }
  return Object.freeze({
    authorityRef: bound[0] as string,
    bodiesDigest: bound[1] as string,
    envelopeDigest: bound[2] as string,
    runId: bound[3] as string,
  });
}

/** The witness on the goal, or the refusal naming which of absent/ambiguous/broken it is. */
export function readApprovedRunWitness(
  store: SqliteEventStore, goalId: string,
): ApprovedRunBinding | PlanningAuthorityReaderRefusal {
  const events = eventsOfType(
    readAggregate(store, goalId).filter((event) => event.aggregateId === goalId),
    ACTIVATION_EVENT_TYPE,
  );
  if (events.length === 0) {
    return readerRefusal("PLANNING_AUTHORITY_READER_APPROVAL_ABSENT", "absent");
  }
  if (events.length > 1) return readerRefusal("PLANNING_AUTHORITY_READER_APPROVAL_AMBIGUOUS");
  const payload = payloadRecord((events[0] as StoredEvent).payload);
  if (payload === null) {
    return readerRefusal("PLANNING_AUTHORITY_READER_APPROVAL_MALFORMED", "payload");
  }
  if (!isCurrentApproval(payload)) {
    return readerRefusal("PLANNING_AUTHORITY_READER_APPROVAL_ABSENT", "not-current");
  }
  const activation = recordOf(payload["activation"]);
  return activation === null
    ? readerRefusal("PLANNING_AUTHORITY_READER_APPROVAL_MALFORMED", "payload")
    : bindingOf(activation);
}
