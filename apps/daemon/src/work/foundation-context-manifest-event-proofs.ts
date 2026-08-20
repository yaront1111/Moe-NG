/**
 * The event-side proofs: that the durable row IS the row this slot's identity
 * derives, and that it was written by the command it claims.
 *
 * WHY THESE ARE SEPARATE FROM THE DECISION AND RECEIPT PROOFS. Those two ask
 * whether a command committed exactly once; these ask something the store can
 * never answer for itself — whether the row a port handed back is the row that
 * was ASKED FOR. `readEvents(aggregateId)` is trusted by every caller to filter
 * by aggregate, and a port that does not (a stale index, a projection replaying
 * the wrong stream, a test double) returns a perfectly well-formed foreign
 * event that passes every command proof there is. One equality closes it, and
 * the equality has to be against the DERIVED id, not against the event's own.
 *
 * THE DERIVATIONS ARE IMPORTED, NEVER RESTATED. The aggregate id, the event id
 * and the decision key all come from the identity module the LEDGER writes
 * under. Two derivations that agree today drift tomorrow, and a drifted reader
 * answers ABSENT forever against records that are perfectly good.
 *
 * This module diagnoses; it never mutates and never decides what happens next.
 */

import type { CommandDecisionKey, StoredEvent } from "@moe/store";

import { FOUNDATION_CONTEXT_RECORD_VERSION } from "./foundation-context-manifest-codec.js";
import {
  FOUNDATION_CONTEXT_COMMAND_KIND, deriveFoundationContextAggregateId,
  deriveFoundationContextDecisionKey, deriveFoundationContextEventId,
} from "./foundation-context-manifest-identity.js";
import type { FoundationContextSelectionIdentity } from "./foundation-context-manifest-identity.js";
import type { FoundationContextProofCode } from "./foundation-context-manifest-proofs.js";

/** The version an aggregate reaches on its one and only context event. */
const EXPECTED_AGGREGATE_SEQUENCE = 1;
const INVALID = "FOUNDATION_CONTEXT_READER_EVENT_INVALID" as const;

/**
 * The trace the store stamps onto every event it commits through a decision.
 *
 * It is OPTIONAL on `StoredEvent` because rows written by the plain commit path
 * carry none — which is exactly the state this proof refuses. An event with no
 * trace was not appended by a decided command, whatever else is true of it.
 */
type DecisionTrace = NonNullable<StoredEvent["decisionTrace"]>;

function proveTrace(trace: DecisionTrace | undefined, key: CommandDecisionKey): boolean {
  if (trace === undefined) return false;
  return trace.commandKind === FOUNDATION_CONTEXT_COMMAND_KIND
    && trace.commandId === key.commandId
    && trace.principalId === key.principalId
    && trace.projectId === key.projectId;
}

/**
 * The stored event matches the identity the SERVER derived, or a refusal code.
 *
 * `selection` is the DURABLE record's own selection, so every identity below is
 * derived from the bytes that were sealed — a caller cannot supply an id, and a
 * record whose fields were edited after sealing derives a different event id
 * than the one the store actually wrote.
 *
 * The trace's `projectId` and `principalId` are compared against the DERIVED
 * decision key rather than against the record: the key's principal is hashed
 * from project + session, so this single comparison is what ties the durable row
 * to the project/session pair the slot names.
 */
export function proveEventIdentity(
  event: StoredEvent,
  selection: FoundationContextSelectionIdentity,
): FoundationContextProofCode | null {
  if (event.aggregateId !== deriveFoundationContextAggregateId(selection)) return INVALID;
  if (event.aggregateSequence !== EXPECTED_AGGREGATE_SEQUENCE) return INVALID;
  if (event.eventId !== deriveFoundationContextEventId(selection)) return INVALID;
  // An omitted version persists the store's generic default, a schema these
  // bytes do not speak; the ledger stamps this one explicitly for that reason.
  if (event.domainSchemaVersion !== FOUNDATION_CONTEXT_RECORD_VERSION) return INVALID;
  if (!proveTrace(event.decisionTrace, deriveFoundationContextDecisionKey(selection))) {
    return INVALID;
  }
  return null;
}
