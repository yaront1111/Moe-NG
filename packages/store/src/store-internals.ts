import type {
  COMMAND_EFFECT_IDENTITY_VERSION,
  CommandDecisionKey,
  CommandDecisionRecord,
  CommitExpectedVersionDecisionInput,
} from "./store-contracts.js";

export const SCHEMA_VERSION = 6;
export const LEGACY_SCHEMA_MANIFEST_VERSION = "moe-sqlite-schema/1" as const;
export const SCHEMA_V2_MANIFEST_VERSION = "moe-sqlite-schema/2" as const;
export const SCHEMA_V3_MANIFEST_VERSION = "moe-sqlite-schema/3" as const;
export const SCHEMA_V4_MANIFEST_VERSION = "moe-sqlite-schema/4" as const;
export const SCHEMA_V5_MANIFEST_VERSION = "moe-sqlite-schema/5" as const;
export const EMPTY_BYTES = new Uint8Array();
export const PENDING_EFFECT_SHA256 = "0".repeat(64);
export const INTERNAL_IDENTIFIER_PREFIX = "moe-internal:" as const;
/**
 * Separates a multi-leg decision's canonical receipt ID from the leg index. A
 * leg receipt is `<canonical>:leg:<index>`, so SQL recovers the canonical ID by
 * truncating at this separator and stays an equality probe on a unique column.
 */
export const LEG_RECEIPT_SEPARATOR = ":leg:" as const;
export const MAX_IDENTIFIER_UTF8_BYTES = 512;
export const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
export const textEncoder = new TextEncoder();
export const canonicalTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const stringIsWellFormed = String.prototype.isWellFormed;

export interface SnapshotOutboxDraft {
  readonly headers: Uint8Array;
  readonly messageId: string;
  readonly payload: Uint8Array;
  readonly topic: string;
}

export interface EffectOutboxDraft extends SnapshotOutboxDraft {
  readonly eventOutboxIndex: number;
  readonly outboxPosition: bigint;
}

export interface SnapshotEventDraft {
  readonly domainSchemaVersion: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly metadata: Uint8Array;
  readonly outbox: readonly SnapshotOutboxDraft[];
  readonly payload: Uint8Array;
}

// domainSchemaVersion is omitted deliberately: the command effect digest hashes
// an explicit field list that excludes it, and the replay side rebuilds effect
// events from receipt rows that never select it. Including it here would break
// that rebuild at the type level and invite it into the digest.
export interface EffectEventDraft
  extends Omit<SnapshotEventDraft, "domainSchemaVersion" | "outbox"> {
  readonly aggregateSequence: number;
  readonly commandEventIndex: number;
  readonly globalPosition: bigint;
  readonly outbox: readonly EffectOutboxDraft[];
}

export interface SnapshotCommitInput {
  readonly aggregateId: string;
  readonly commandBytes: Uint8Array;
  readonly commandId: string;
  readonly committedAt: string;
  readonly events: readonly SnapshotEventDraft[];
  readonly expectedVersion: number;
}

export interface StoredCommitResult {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly currentVersion: number;
  readonly effectIdentityVersion: typeof COMMAND_EFFECT_IDENTITY_VERSION;
  readonly effectSha256: string;
  readonly eventIds: readonly string[];
  readonly outboxMessageIds: readonly string[];
  readonly previousVersion: number;
  readonly requestSha256: string;
}

export interface StoredReceipt extends StoredCommitResult {
  readonly committedAt: string;
}

export type StoredCommandDecision = CommandDecisionRecord & {
  readonly receiptCommandId: string;
};

export type DataRecord = Record<PropertyKey, unknown>;

export interface SnapshotExpectedVersionRequest {
  readonly commandKind: string;
  readonly expectedVersion: number;
  readonly inputRecord: DataRecord;
  readonly key: CommandDecisionKey;
  readonly requestBytes: Uint8Array;
  readonly targetAggregateId: string;
}

export interface SnapshotDecisionMetadata {
  readonly correlationSha256: string;
  readonly decidedAt: string;
}

export interface SnapshotCommittedProposal {
  readonly commitInput: SnapshotCommitInput;
  readonly resultBytes: Uint8Array;
}

export interface ByteBudget {
  remaining: number;
}

export interface CommandEffectInput {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly committedAt: string;
  readonly currentVersion: number;
  readonly events: readonly EffectEventDraft[];
  readonly previousVersion: number;
  readonly requestSha256: string;
}

export interface RejectionAuditPayloadInput {
  readonly commandId: string;
  readonly commandKind: string;
  readonly decisionId: string;
  readonly expectedVersion: number;
  readonly observedVersion: number;
  readonly principalId: string;
  readonly projectId: string;
  readonly requestSha256: string;
  readonly targetAggregateId: string;
}

export type ExpectedVersionDecisionInputRecord = CommitExpectedVersionDecisionInput & DataRecord;
