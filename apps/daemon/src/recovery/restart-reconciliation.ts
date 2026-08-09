import { classifyCrash, PREDECESSOR_RELEASES, RECOVERY_OUTCOME_KINDS } from "@moe/runner";
import type {
  CrashClassification,
  PredecessorRelease,
  RecoveryLayer,
  RecoveryOutcomeKind,
} from "@moe/runner";
import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

/**
 * `/2` adds the runner-derived continuation evidence. The bump is not cosmetic:
 * a `/1` row carries no derived release, so decoding one as `/2` would leave the
 * boundary facts absent and a reader free to supply them. Legacy rows fail the
 * version check and stay non-authoritative rather than being upgraded.
 */
export const RESTART_RECONCILIATION_SCHEMA_VERSION = "moe-restart-reconciliation/2" as const;

/**
 * The one command kind reconciliation rows are written under. Exported so a
 * caller — or a suite proving history was not edited — can find those rows
 * without restating the literal and drifting from it.
 */
export const RESTART_RECONCILIATION_COMMAND_KIND = "reconciliation.decide" as const;
export const RESTART_RECORD_CLASSIFICATIONS = Object.freeze([
  ...RECOVERY_OUTCOME_KINDS,
  "REFUSED",
] as const);

export type RestartRecordClassification = RecoveryOutcomeKind | "REFUSED";
export type RestartTruthClass = "VERIFIED" | "UNKNOWN";

export interface InFlightAttempt {
  readonly attemptRef: string;
  readonly situation: unknown;
}

export interface ReconciliationRecord {
  readonly attemptRef: string;
  readonly classification: RestartRecordClassification;
  readonly code: string | null;
  readonly command: string | null;
  readonly detail: string | null;
  readonly effectRef: string | null;
  readonly held: readonly string[];
  readonly layer: string | null;
  readonly message: string | null;
  readonly postState: string | null;
  /**
   * The predecessor's release boundary and committed handoff, DERIVED by the
   * runner from the durable record set and persisted here. Continuation reads
   * these; it never accepts them from a request. See `@moe/runner`'s
   * `ContinuationEvidence` for why the direction matters.
   */
  readonly predecessorRelease: PredecessorRelease;
  readonly safeHandoff: string | null;
  readonly schemaVersion: typeof RESTART_RECONCILIATION_SCHEMA_VERSION;
  readonly truthClass: RestartTruthClass;
}

export interface RestartReconciliationRequest {
  readonly attempts: readonly InFlightAttempt[];
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly principalId: string;
  readonly projectId: string;
}

export type RestartReconciliationResult =
  | { readonly ok: true; readonly records: readonly ReconciliationRecord[] }
  | { readonly ok: false; readonly code: string; readonly layer: RecoveryLayer | "DURABLE_STORE" };

interface StoredRecord {
  readonly bytes: Uint8Array;
  readonly record: ReconciliationRecord;
  readonly version: number;
}

const PAGE_SIZE = 200;
const COMMAND_KIND = RESTART_RECONCILIATION_COMMAND_KIND;
const AGGREGATE_PREFIX = "restart-reconciliation:";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function recordBase(classification: RestartRecordClassification, attemptRef: string) {
  return {
    attemptRef,
    classification,
    code: null,
    command: null,
    detail: null,
    effectRef: null,
    held: Object.freeze([]) as readonly string[],
    layer: null,
    message: null,
    postState: null,
    schemaVersion: RESTART_RECONCILIATION_SCHEMA_VERSION,
  };
}

function recordOf(attemptRef: string, result: CrashClassification): ReconciliationRecord {
  const base = recordBase(result.kind, attemptRef);
  if (result.kind === "REFUSED") {
    // A refusal produced no classification, so it produced no evidence either.
    // UNKNOWN/null is the honest pair: epic rail 4 leaves an unverifiable fact
    // without authority rather than defaulting it toward release.
    return Object.freeze({
      ...base,
      code: result.failure.code,
      layer: result.failure.layer,
      message: result.failure.message,
      predecessorRelease: "UNKNOWN" as const,
      safeHandoff: null,
      truthClass: "UNKNOWN" as const,
    });
  }
  const truthClass: RestartTruthClass =
    result.kind === "SUSPECT" || result.kind === "RECONCILIATION_COMMAND" ? "UNKNOWN" : "VERIFIED";
  return Object.freeze({
    ...base,
    command: result.kind === "RECONCILIATION_COMMAND" ? result.command : null,
    detail: result.kind === "RECONCILIATION_COMMAND" ? result.detail : null,
    effectRef: result.effectRef,
    held: result.kind === "QUARANTINED" ? Object.freeze([...result.held]) : base.held,
    postState: result.kind === "ADOPTED" || result.kind === "SUSPECT" ? result.postState : null,
    // Copied off the classification, never recomputed here: a second derivation
    // in the daemon would be a second authority that could disagree with the one
    // the runner actually classified against.
    predecessorRelease: result.continuationEvidence.predecessorRelease,
    safeHandoff: result.continuationEvidence.safeHandoff,
    truthClass,
  });
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function decodeRecord(bytes: Uint8Array): ReconciliationRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Readonly<Record<string, unknown>>;
  if (item["schemaVersion"] !== RESTART_RECONCILIATION_SCHEMA_VERSION) return null;
  if (typeof item["attemptRef"] !== "string" || typeof item["truthClass"] !== "string") return null;
  if (!RESTART_RECORD_CLASSIFICATIONS.includes(item["classification"] as RestartRecordClassification)) return null;
  if (!Array.isArray(item["held"]) || !item["held"].every((entry) => typeof entry === "string")) return null;
  // The derived evidence is validated as strictly as the classification. A row
  // missing it, or carrying a release outside the runner's lattice, decodes to
  // null and is simply not there — it never reaches continuation as a default.
  if (!(PREDECESSOR_RELEASES as readonly unknown[]).includes(item["predecessorRelease"])) return null;
  if (!isStringOrNull(item["safeHandoff"])) return null;
  for (const key of ["code", "command", "detail", "effectRef", "layer", "message", "postState"] as const) {
    if (!isStringOrNull(item[key])) return null;
  }
  return Object.freeze({ ...item, held: Object.freeze([...item["held"]]) }) as unknown as ReconciliationRecord;
}

/**
 * The one aggregate an attempt's reconciliation history lives on.
 *
 * Exported so a caller — or a suite proving history was not edited — can name
 * that history by TARGET rather than by command kind. Those are not the same
 * question: a write that lands on this aggregate under some other kind is still
 * a write into the attempt's history.
 */
export function reconciliationAggregateId(attemptRef: string): string {
  return `${AGGREGATE_PREFIX}${attemptRef}`;
}

const aggregateId = reconciliationAggregateId;

function readStored(store: SqliteEventStore, projectId: string): Map<string, StoredRecord> {
  const records = new Map<string, StoredRecord>();
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, PAGE_SIZE);
    for (const decision of page.items) addStored(records, decision, projectId);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return records;
}

function addStored(
  records: Map<string, StoredRecord>,
  decision: CommandDecisionRecord,
  projectId: string,
): void {
  if (decision.key.projectId !== projectId || decision.commandKind !== COMMAND_KIND) return;
  if (decision.effectDisposition !== "EFFECTS_COMMITTED") return;
  const record = decodeRecord(decision.resultBytes);
  if (record === null || decision.targetAggregateId !== aggregateId(record.attemptRef)) return;
  records.set(record.attemptRef, { bytes: decision.resultBytes, record, version: decision.currentVersion });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function commitRecord(
  store: SqliteEventStore,
  request: RestartReconciliationRequest,
  record: ReconciliationRecord,
  current: StoredRecord | undefined,
): ReconciliationRecord | null {
  const bytes = encoder.encode(JSON.stringify(record));
  if (current !== undefined && sameBytes(current.bytes, bytes)) return current.record;
  const expectedVersion = current?.version ?? 0;
  const commandId = `restart-reconcile:${record.attemptRef}:v${expectedVersion + 1}`;
  const response = store.commitExpectedVersionDecision({
    commandKind: COMMAND_KIND,
    committedResultBytes: bytes,
    correlationId: request.correlationId,
    decidedAt: request.decidedAt,
    events: [{ eventId: `${commandId}:recorded`, eventType: "RestartReconciliationRecorded", payload: bytes }],
    expectedVersion,
    key: { commandId, principalId: request.principalId, projectId: request.projectId },
    requestBytes: encoder.encode(JSON.stringify({ attemptRef: record.attemptRef, situation: "CLASSIFIED" })),
    targetAggregateId: aggregateId(record.attemptRef),
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED" ? record : null;
}

export function readReconciliationRecords(
  store: SqliteEventStore,
  projectId: string,
): ReadonlyMap<string, ReconciliationRecord> {
  return new Map([...readStored(store, projectId)].map(([key, value]) => [key, value.record]));
}

export function reconcileOnRestart(
  store: SqliteEventStore,
  request: RestartReconciliationRequest,
): RestartReconciliationResult {
  const current = readStored(store, request.projectId);
  const records: ReconciliationRecord[] = [];
  for (const attempt of request.attempts) {
    const record = recordOf(attempt.attemptRef, classifyCrash(attempt.situation));
    const committed = commitRecord(store, request, record, current.get(attempt.attemptRef));
    if (committed === null) {
      return Object.freeze({ ok: false as const, code: "EXPECTED_VERSION_CONFLICT", layer: "DURABLE_STORE" });
    }
    records.push(committed);
  }
  return Object.freeze({ ok: true as const, records: Object.freeze(records) });
}
