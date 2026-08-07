export const MINIMUM_SQLITE_VERSION = "3.51.3" as const;
export const COMMAND_REQUEST_IDENTITY_VERSION = "moe-command-request/1" as const;
export const COMMAND_DECISION_REQUEST_IDENTITY_VERSION =
  "moe-scoped-command-request/1" as const;
export const COMMAND_DECISION_IDENTITY_VERSION = "moe-command-decision-identity/1" as const;
export const COMMAND_DECISION_RECORD_VERSION = "moe-command-decision/1" as const;
export const COMMAND_DECISION_RESULT_VERSION = "moe-command-result-bytes/1" as const;
export const COMMAND_REJECTION_AUDIT_VERSION = "moe-command-rejection-audit/1" as const;
export const EXPECTED_VERSION_DECISION_COVERAGE = "EXPECTED_VERSION_ONLY" as const;
export const SQLITE_APPLICATION_ID = 0x4d4f4531 as const;
export const EVENT_RECORD_VERSION = "moe-event-record/1" as const;
export const OPAQUE_PAYLOAD_CODEC_VERSION = "moe-opaque-bytes/1" as const;
export const RECEIPT_RESULT_VERSION = "moe-commit-result/1" as const;
export const COMMAND_EFFECT_IDENTITY_VERSION = "moe-command-effect/1" as const;
export const SQLITE_SCHEMA_MANIFEST_VERSION = "moe-sqlite-schema/3" as const;
export const MAX_EVENTS_PER_COMMIT = 256 as const;
export const MAX_OUTBOX_MESSAGES_PER_COMMIT = 1_024 as const;
export const MAX_BLOB_BYTES = 8 * 1_024 * 1_024;
export const MAX_COMMIT_BYTES = 32 * 1_024 * 1_024;
export const MAX_PAGE_SIZE = 1_000 as const;
export const MAX_PAGE_DECODED_BYTES = 2 * MAX_COMMIT_BYTES;

export interface OutboxDraft {
  readonly headers?: Uint8Array;
  readonly messageId: string;
  readonly payload: Uint8Array;
  readonly topic: string;
}

export interface EventDraft {
  readonly eventId: string;
  readonly eventType: string;
  readonly metadata?: Uint8Array;
  readonly outbox?: readonly OutboxDraft[];
  readonly payload: Uint8Array;
}

export interface CommitInput {
  readonly aggregateId: string;
  readonly commandBytes: Uint8Array;
  readonly commandId: string;
  readonly committedAt: string;
  readonly events: readonly EventDraft[];
  readonly expectedVersion: number;
}

export interface CommitResult {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly currentVersion: number;
  readonly disposition: "COMMITTED" | "REPLAYED";
  readonly effectIdentityVersion: typeof COMMAND_EFFECT_IDENTITY_VERSION;
  readonly effectSha256: string;
  readonly eventIds: readonly string[];
  readonly outboxMessageIds: readonly string[];
  readonly previousVersion: number;
  readonly requestSha256: string;
}

export interface CommandDecisionKey {
  readonly commandId: string;
  readonly principalId: string;
  readonly projectId: string;
}

export interface CommitExpectedVersionDecisionInput {
  readonly commandKind: string;
  readonly committedResultBytes: Uint8Array;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly events: readonly EventDraft[];
  readonly expectedVersion: number;
  readonly key: CommandDecisionKey;
  readonly requestBytes: Uint8Array;
  readonly targetAggregateId: string;
}

interface CommandDecisionRecordBase {
  readonly businessEventIds: readonly string[];
  readonly commandKind: string;
  readonly correlationSha256: string;
  readonly coverage: typeof EXPECTED_VERSION_DECISION_COVERAGE;
  readonly decidedAt: string;
  readonly decisionId: string;
  readonly decisionIdentityVersion: typeof COMMAND_DECISION_IDENTITY_VERSION;
  readonly decisionPosition: bigint;
  readonly decisionSha256: string;
  readonly effectIdentityVersion: typeof COMMAND_EFFECT_IDENTITY_VERSION;
  readonly effectSha256: string;
  readonly expectedVersion: number;
  readonly key: CommandDecisionKey;
  readonly observedVersion: number;
  readonly outboxMessageIds: readonly string[];
  readonly recordVersion: typeof COMMAND_DECISION_RECORD_VERSION;
  readonly requestIdentityVersion: typeof COMMAND_DECISION_REQUEST_IDENTITY_VERSION;
  readonly requestSha256: string;
  readonly resultBytes: Uint8Array;
  readonly resultSha256: string;
  readonly resultVersion: typeof COMMAND_DECISION_RESULT_VERSION;
  readonly targetAggregateId: string;
}

export interface EffectsCommittedDecision extends CommandDecisionRecordBase {
  readonly auditEventId: null;
  readonly currentVersion: number;
  readonly effectDisposition: "EFFECTS_COMMITTED";
  readonly previousVersion: number;
  readonly resultCode: "EFFECTS_COMMITTED";
}

export interface NoBusinessEffectDecision extends CommandDecisionRecordBase {
  readonly auditEventId: string;
  readonly businessEventIds: readonly [];
  readonly currentVersion: null;
  readonly effectDisposition: "NO_BUSINESS_EFFECT";
  readonly outboxMessageIds: readonly [];
  readonly previousVersion: null;
  readonly resultCode: "EXPECTED_VERSION_CONFLICT";
}

export type CommandDecisionRecord = EffectsCommittedDecision | NoBusinessEffectDecision;

export interface CommandDecisionResponse {
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly historical: boolean;
  readonly requiresAffordanceRefresh: boolean;
}

export interface CommandReceipt {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly committedAt: string;
  readonly currentVersion: number;
  readonly effectIdentityVersion: typeof COMMAND_EFFECT_IDENTITY_VERSION;
  readonly effectSha256: string;
  readonly eventIds: readonly string[];
  readonly outboxMessageIds: readonly string[];
  readonly previousVersion: number;
  readonly requestSha256: string;
}

export interface StoredEvent {
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly commandId: string;
  readonly committedAt: string;
  readonly decisionTrace?: Readonly<{
    readonly commandId: string;
    readonly commandKind: string;
    readonly principalId: string;
    readonly projectId: string;
    readonly requestIdentityVersion: typeof COMMAND_DECISION_REQUEST_IDENTITY_VERSION;
    readonly requestSha256: string;
  }>;
  readonly eventId: string;
  readonly eventType: string;
  readonly globalPosition: bigint;
  readonly metadata: Uint8Array;
  readonly payloadCodecVersion: typeof OPAQUE_PAYLOAD_CODEC_VERSION;
  readonly payload: Uint8Array;
  readonly recordVersion: typeof EVENT_RECORD_VERSION;
  readonly requestSha256: string;
}

export interface PendingOutboxMessage {
  readonly createdAt: string;
  readonly deliveryAttempts: number;
  readonly eventId: string;
  readonly headers: Uint8Array;
  readonly messageId: string;
  readonly outboxPosition: bigint;
  readonly payload: Uint8Array;
  readonly topic: string;
}

export interface CursorPage<Item, Cursor> {
  readonly hasMore: boolean;
  readonly items: readonly Item[];
  readonly nextCursor: Cursor | null;
}

export type DurableStoreErrorCode =
  | "COMMAND_ID_CONFLICT"
  | "DATABASE_IDENTITY_MISMATCH"
  | "DURABLE_ID_CONFLICT"
  | "EXPECTED_VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "OUTCOME_UNKNOWN"
  | "PROJECT_SCOPE_MISMATCH"
  | "PROJECT_SCOPE_REQUIRED"
  | "STORE_BUSY"
  | "STORE_CLOSED"
  | "STORE_CORRUPT"
  | "STORE_INPUT_INVALID"
  | "STORE_LIMIT_EXCEEDED"
  | "STORE_MIGRATION_REQUIRED"
  | "STORE_SCHEMA_INVALID"
  | "STORE_UNAVAILABLE";

export class DurableStoreError extends Error {
  public readonly code: DurableStoreErrorCode;

  public constructor(code: DurableStoreErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "DurableStoreError";
    this.code = code;
  }
}

export class CommandIdConflictError extends DurableStoreError {
  public readonly commandId: string;

  public constructor(commandId: string) {
    super(
      "COMMAND_ID_CONFLICT",
      `command ${JSON.stringify(commandId)} was reused for a different request`,
    );
    this.name = "CommandIdConflictError";
    this.commandId = commandId;
  }
}

export class ExpectedVersionConflictError extends DurableStoreError {
  public readonly actualVersion: number;
  public readonly aggregateId: string;
  public readonly expectedVersion: number;

  public constructor(aggregateId: string, expectedVersion: number, actualVersion: number) {
    super(
      "EXPECTED_VERSION_CONFLICT",
      `aggregate ${JSON.stringify(aggregateId)} is at version ${actualVersion}, expected ${expectedVersion}`,
    );
    this.name = "ExpectedVersionConflictError";
    this.actualVersion = actualVersion;
    this.aggregateId = aggregateId;
    this.expectedVersion = expectedVersion;
  }
}

export class IdempotencyConflictError extends DurableStoreError {
  public readonly key: CommandDecisionKey;

  public constructor(key: CommandDecisionKey) {
    super(
      "IDEMPOTENCY_CONFLICT",
      "the scoped command ID was reused for a different request",
    );
    this.name = "IdempotencyConflictError";
    this.key = Object.freeze({ ...key });
  }
}

export class DurableIdConflictError extends DurableStoreError {
  public readonly durableId: string;
  public readonly kind: "EVENT" | "OUTBOX_MESSAGE";

  public constructor(kind: DurableIdConflictError["kind"], durableId: string) {
    super(
      "DURABLE_ID_CONFLICT",
      `${kind.toLowerCase()} ID ${JSON.stringify(durableId)} already exists`,
    );
    this.name = "DurableIdConflictError";
    this.durableId = durableId;
    this.kind = kind;
  }
}

export interface StoreHealth {
  readonly accessMode: "PROJECT_ASSERTED_WRITE" | "READ_ONLY_INSPECTION";
  readonly applicationId: number;
  readonly busyTimeoutMilliseconds: number;
  readonly databasePath: string | null;
  readonly durability: "EPHEMERAL_TEST" | "WAL_FILE";
  readonly foreignKeys: boolean;
  readonly foreignKeyViolations: number;
  readonly journalMode: string;
  readonly projectId: string | null;
  readonly quickCheck: string;
  readonly recursiveTriggers: boolean;
  readonly sqliteVersion: string;
  readonly synchronous: "extra" | "full" | "normal" | "off";
  readonly trustedSchema: boolean;
  readonly userVersion: number;
  readonly walAutocheckpointPages: number;
  readonly writeProjectAsserted: boolean;
}
