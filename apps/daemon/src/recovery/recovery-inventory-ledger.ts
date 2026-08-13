import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readCurrentRecoveryAuthenticationBinding } from "../identity/recovery-authentication-binding.js";
import { readAnchoredIncarnation } from "./recovery-incarnation-anchor.js";
import {
  RECOVERY_RECONCILIATION_COMMAND_KIND,
  RECOVERY_RECONCILIATION_EVENT_TYPE,
  RECOVERY_RECONCILIATION_SCHEMA_VERSION,
  exactDataRecord,
  recoveryInventoryRefusal,
  recoveryReconciliationAggregateId,
} from "./recovery-inventory-contract.js";
import type {
  RecoveryInventoryRefusal,
  RecoveryInventoryUpstream,
  RecoveryReconciliationRecord,
} from "./recovery-inventory-contract.js";
import {
  decodeRecoveryReconciliationRecord,
  encodeRecoveryReconciliationRecord,
} from "./recovery-inventory-codec.js";
import { buildRecoveryReconciliationRecord } from "./recovery-inventory-record.js";
import type {
  RecoveryConfiguredProof,
  RecoveryReconciliationSubject,
} from "./recovery-inventory-subject.js";

/**
 * Content-addressed durable persistence for one reconciliation record, built on
 * the existing public `SqliteEventStore` decision surface — no schema change and
 * no raw SQLite.
 *
 * The record is addressed by its OWN digest, never by a mutable "latest": a
 * later `R3` decision binds one immutable digest, and a pointer that could be
 * repointed would be exactly the unspecified authority this area must not
 * create. Nothing here grants `recovery.complete`.
 *
 * The current incarnation and key epoch are READ from the fixed ACTIVE slot and
 * from the anchor, never accepted from the caller. A restored credential must
 * not be able to nominate which recovery identity is "current" by putting it in
 * a request.
 */
export interface RecoveryReconciliationExternalFacts {
  readonly backupCursor: string;
  readonly backupGenerationDigest: string;
  readonly configuredClasses: readonly string[];
  readonly projectTag: string;
  readonly proofs: readonly RecoveryConfiguredProof[];
  readonly subjects: readonly RecoveryReconciliationSubject[];
}

export interface RecoveryDurableReconcileRequest {
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
}

export interface RecoveryReconciliationRecorded {
  readonly authority: "NONE";
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly ok: true;
  readonly outcome: "RECORDED";
  readonly record: RecoveryReconciliationRecord;
  readonly recordDigest: string;
}

export interface RecoveryReconciliationFound {
  readonly ok: true;
  readonly outcome: "FOUND";
  readonly authority: "NONE";
  readonly record: RecoveryReconciliationRecord;
}

export type RecoveryReconciliationWriteResult =
  | RecoveryReconciliationRecorded
  | RecoveryInventoryRefusal;
export type RecoveryReconciliationReadResult =
  | RecoveryReconciliationFound
  | RecoveryInventoryRefusal;

const ledger = (code: RecoveryInventoryUpstream["code"]): RecoveryInventoryUpstream =>
  Object.freeze({ code, layer: "RECOVERY_INVENTORY_LEDGER" as const });

const REFUSALS = Object.freeze({
  ANCHOR_UNAVAILABLE: recoveryInventoryRefusal(
    ledger("RECOVERY_ANCHOR_UNAVAILABLE"),
    "The selected recovery incarnation has no durable anchor in this project.",
  ),
  BINDING_MISMATCH: recoveryInventoryRefusal(
    ledger("RECOVERY_BINDING_MISMATCH"),
    "The selected recovery authority does not agree with the anchored incarnation.",
  ),
  BINDING_UNAVAILABLE: recoveryInventoryRefusal(
    ledger("RECOVERY_BINDING_UNAVAILABLE"),
    "No installer-selected recovery binding is readable from this project store.",
  ),
  CONFLICT: recoveryInventoryRefusal(
    ledger("RECORD_CONFLICT"),
    "The durable evidence for this record digest is not a single consistent record.",
  ),
  INPUT_INVALID: recoveryInventoryRefusal(
    ledger("RECOVERY_INVENTORY_INPUT_INVALID"),
    "The reconciliation request did not present the exact expected external facts.",
  ),
  NOT_FOUND: recoveryInventoryRefusal(
    ledger("RECORD_NOT_FOUND"),
    "No reconciliation record is stored under the addressed digest.",
  ),
  UNREADABLE: recoveryInventoryRefusal(
    ledger("RECORD_UNREADABLE"),
    "The durable bytes stored under the addressed digest do not verify as a record.",
  ),
});

const FACT_KEYS = Object.freeze([
  "backupCursor",
  "backupGenerationDigest",
  "configuredClasses",
  "projectTag",
  "proofs",
  "subjects",
]);
const REQUEST_KEYS = Object.freeze([
  "correlationId",
  "decidedAt",
  "principalId",
  "projectId",
]);

const commandIdFor = (recordDigest: string): string => `recovery-reconcile:${recordDigest}`;

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/**
 * Builds and commits ONE record. The selected recovery refs come from the store
 * and the anchor; the caller supplies only what it observed outside the system.
 *
 * There is deliberately no catch-all around the commit: a genuine store fault
 * must keep throwing, because reporting a real database failure as a benign
 * refusal is precisely how a recovery ledger would gain false authority.
 */
export function recordRecoveryReconciliation(
  store: SqliteEventStore,
  request: unknown,
  facts: unknown,
): RecoveryReconciliationWriteResult {
  const scope = exactDataRecord(request, REQUEST_KEYS);
  const external = exactDataRecord(facts, FACT_KEYS);
  if (scope === null || external === null) return REFUSALS.INPUT_INVALID;
  for (const key of REQUEST_KEYS) {
    if (typeof scope[key] !== "string" || (scope[key] as string).length === 0) {
      return REFUSALS.INPUT_INVALID;
    }
  }
  const projectId = scope["projectId"] as string;

  const selected = readCurrentRecoveryAuthenticationBinding(store);
  if (selected === null) return REFUSALS.BINDING_UNAVAILABLE;
  const anchored = readAnchoredIncarnation(store, projectId, selected.recoveryIncarnationRef);
  if (anchored === null) return REFUSALS.ANCHOR_UNAVAILABLE;
  if (anchored.keyEpochRef !== selected.keyEpochRef) return REFUSALS.BINDING_MISMATCH;
  if (anchored.incarnationRef !== selected.recoveryIncarnationRef) return REFUSALS.BINDING_MISMATCH;
  if (anchored.backupGenerationDigest !== external["backupGenerationDigest"]) {
    return REFUSALS.BINDING_MISMATCH;
  }

  const built = buildRecoveryReconciliationRecord({
    backupCursor: external["backupCursor"],
    backupGenerationDigest: external["backupGenerationDigest"],
    configuredClasses: external["configuredClasses"],
    projectId,
    projectTag: external["projectTag"],
    proofs: external["proofs"],
    selected: {
      anchorBindingDigest: anchored.bindingDigest,
      incarnationRef: anchored.incarnationRef,
      keyEpochRef: anchored.keyEpochRef,
    },
    subjects: external["subjects"],
  });
  if (!built.ok) return built;

  const record = built.record;
  const bytes = encodeRecoveryReconciliationRecord(record);
  const commandId = commandIdFor(record.recordDigest);
  const response = store.commitExpectedVersionDecision({
    commandKind: RECOVERY_RECONCILIATION_COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: scope["correlationId"] as string,
    decidedAt: scope["decidedAt"] as string,
    events: [
      {
        domainSchemaVersion: RECOVERY_RECONCILIATION_SCHEMA_VERSION,
        eventId: `${commandId}:recorded`,
        eventType: RECOVERY_RECONCILIATION_EVENT_TYPE,
        payload: bytes,
      },
    ],
    expectedVersion: 0,
    key: { commandId, principalId: scope["principalId"] as string, projectId },
    requestBytes: bytes,
    targetAggregateId: recoveryReconciliationAggregateId(record.recordDigest),
  });
  if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") return REFUSALS.CONFLICT;

  return Object.freeze({
    authority: "NONE" as const,
    disposition: response.disposition,
    ok: true as const,
    outcome: "RECORDED" as const,
    record,
    recordDigest: record.recordDigest,
  });
}

/** The sole event must be sequence 1 and must carry this command's own trace. */
function isSoleRecordEvent(event: StoredEvent, projectId: string): boolean {
  return (
    event.aggregateSequence === 1 &&
    event.eventType === RECOVERY_RECONCILIATION_EVENT_TYPE &&
    event.decisionTrace !== undefined &&
    event.decisionTrace.commandKind === RECOVERY_RECONCILIATION_COMMAND_KIND &&
    event.decisionTrace.projectId === projectId
  );
}

/**
 * Reads the record stored under ONE explicit digest. Absent, conflicting,
 * malformed and unverifiable evidence all answer coordinator `UNKNOWN_TRUTH` at
 * `RECOVERY_INVENTORY`, each retaining its own ledger code so provenance is not
 * flattened into a single "not available".
 */
export function readRecoveryReconciliation(
  store: SqliteEventStore,
  projectId: string,
  recordDigest: string,
): RecoveryReconciliationReadResult {
  const aggregateId = recoveryReconciliationAggregateId(recordDigest);
  let events: readonly StoredEvent[];
  try {
    events = store.readAggregateEvents(aggregateId, 0, 2).items;
  } catch {
    return REFUSALS.UNREADABLE;
  }
  if (events.length === 0) return REFUSALS.NOT_FOUND;
  if (events.length !== 1) return REFUSALS.CONFLICT;
  const event = events[0];
  if (event === undefined || !isSoleRecordEvent(event, projectId)) return REFUSALS.CONFLICT;

  const trace = event.decisionTrace;
  if (trace === undefined) return REFUSALS.CONFLICT;
  const decision = store.getCommandDecision({
    commandId: trace.commandId,
    principalId: trace.principalId,
    projectId: trace.projectId,
  });
  if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return REFUSALS.CONFLICT;
  }
  if (decision.targetAggregateId !== aggregateId) return REFUSALS.CONFLICT;
  if (decision.commandKind !== RECOVERY_RECONCILIATION_COMMAND_KIND) return REFUSALS.CONFLICT;
  // Decision bytes and event bytes must be the SAME record, not merely both
  // present: a row whose result disagrees with the event it committed is not
  // evidence of anything, and picking one of the two would be inventing a fact.
  if (!sameBytes(decision.resultBytes, event.payload)) return REFUSALS.CONFLICT;

  const decoded = decodeRecoveryReconciliationRecord(decision.resultBytes);
  if (!decoded.ok) return REFUSALS.UNREADABLE;
  // Content addressing is only real if the address is CHECKED: bytes filed under
  // a digest they do not hash to are a misfiling, never an alternate record.
  if (decoded.record.recordDigest !== recordDigest) return REFUSALS.CONFLICT;
  if (decoded.record.projectId !== projectId) return REFUSALS.CONFLICT;

  return Object.freeze({
    authority: "NONE" as const,
    ok: true as const,
    outcome: "FOUND" as const,
    record: decoded.record,
  });
}
