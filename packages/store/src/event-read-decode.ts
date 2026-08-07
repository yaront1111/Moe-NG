import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  COMMAND_REQUEST_IDENTITY_VERSION,
  DurableStoreError,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  RECEIPT_RESULT_VERSION,
} from "./store-contracts.js";
import type {
  CursorPage,
  PendingOutboxMessage,
  StoredEvent,
} from "./store-contracts.js";
import type {
  EffectEventDraft,
  EffectOutboxDraft,
} from "./store-internals.js";
import {
  requireRowBytes,
  requireRowString,
  requireStoredIdentifier,
  requireStoredIntegerAtLeast,
  requireStoredPositiveBigIntText,
  requireStoredSha256,
  requireStoredTimestamp,
} from "./store-rows.js";
import { StoreRuntime } from "./store-runtime.js";

export interface DecodedReceiptRow {
  readonly aggregateId: string;
  readonly committedAt: string;
  readonly currentVersion: number;
  readonly effectIdentityVersion: typeof COMMAND_EFFECT_IDENTITY_VERSION;
  readonly effectSha256: string;
  readonly eventCount: number;
  readonly expectedVersion: number;
  readonly outboxCount: number;
  readonly previousVersion: number;
  readonly requestSha256: string;
}

export interface DecodedReceiptEventIdentity {
  readonly aggregateSequence: number;
  readonly commandEventIndex: number;
  readonly eventId: string;
}

export interface DecodedReceiptOutboxIdentity {
  readonly eventId: string;
  readonly eventOutboxIndex: number;
  readonly messageId: string;
}

export type DecodedReceiptEventBody = Omit<
  EffectEventDraft,
  "aggregateSequence" | "commandEventIndex" | "eventId" | "outbox"
>;

export type DecodedReceiptOutboxBody = Omit<
  EffectOutboxDraft,
  "eventOutboxIndex" | "messageId"
>;

/**
 * Internal decoding layer. It owns stored-row validation and detached snapshot
 * construction only; it issues no SQL and exposes no public read method.
 */
export class EventReadDecodeStore extends StoreRuntime {
  protected page<Item, Cursor>(
    items: readonly Item[],
    hasMore: boolean,
    nextCursor: Cursor | null,
  ): CursorPage<Item, Cursor> {
    return Object.freeze({
      hasMore,
      items: Object.freeze([...items]),
      nextCursor,
    });
  }

  protected mapStoredEvent(row: Record<string, unknown>): StoredEvent {
    const storedEvent: StoredEvent = {
      aggregateId: requireRowString(row, "aggregate_id"),
      aggregateSequence: requireStoredIntegerAtLeast(row, "aggregate_sequence", 1),
      commandId: requireRowString(row, "command_id"),
      committedAt: requireStoredTimestamp(row, "committed_at"),
      // Deliberately not requireStoredVersion: any recorded version is legal
      // here, because upcasters dispatch on whatever the producer stamped.
      domainSchemaVersion: requireRowString(row, "domain_schema_version"),
      eventId: requireRowString(row, "event_id"),
      eventType: requireRowString(row, "event_type"),
      globalPosition: requireStoredPositiveBigIntText(row, "global_position"),
      metadata: requireRowBytes(row, "metadata"),
      payloadCodecVersion: this.requireStoredVersion(
        row,
        "payload_codec_version",
        OPAQUE_PAYLOAD_CODEC_VERSION,
      ),
      payload: requireRowBytes(row, "payload"),
      recordVersion: this.requireStoredVersion(
        row,
        "record_version",
        EVENT_RECORD_VERSION,
      ),
      requestSha256: requireStoredSha256(row, "request_sha256"),
    };
    const projectId = row.decision_project_id;
    const principalId = row.decision_principal_id;
    const decisionCommandId = row.decision_command_id;
    const commandKind = row.decision_command_kind;
    const decisionRequestIdentityVersion = row.decision_request_identity_version;
    const decisionRequestSha256 = row.decision_request_sha256;
    if (
      projectId === null &&
      principalId === null &&
      decisionCommandId === null &&
      commandKind === null &&
      decisionRequestIdentityVersion === null &&
      decisionRequestSha256 === null
    ) {
      return storedEvent;
    }
    if (
      typeof projectId !== "string" ||
      typeof principalId !== "string" ||
      typeof decisionCommandId !== "string" ||
      typeof commandKind !== "string" ||
      typeof decisionRequestIdentityVersion !== "string" ||
      typeof decisionRequestSha256 !== "string"
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "an event has a partial scoped-command trace",
      );
    }
    return {
      ...storedEvent,
      decisionTrace: Object.freeze({
        commandId: requireStoredIdentifier(row, "decision_command_id"),
        commandKind: requireStoredIdentifier(row, "decision_command_kind"),
        principalId: requireStoredIdentifier(row, "decision_principal_id"),
        projectId: requireStoredIdentifier(row, "decision_project_id"),
        requestIdentityVersion: this.requireStoredVersion(
          row,
          "decision_request_identity_version",
          COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
        ),
        requestSha256: requireStoredSha256(row, "decision_request_sha256"),
      }),
    };
  }

  protected mapOutboxMessage(row: Record<string, unknown>): PendingOutboxMessage {
    return {
      createdAt: requireStoredTimestamp(row, "created_at"),
      deliveryAttempts: requireStoredIntegerAtLeast(row, "delivery_attempts", 0),
      eventId: requireRowString(row, "event_id"),
      headers: requireRowBytes(row, "headers"),
      messageId: requireRowString(row, "message_id"),
      outboxPosition: requireStoredPositiveBigIntText(row, "outbox_position"),
      payload: requireRowBytes(row, "payload"),
      topic: requireRowString(row, "topic"),
    };
  }

  protected decodeReceiptRow(row: Record<string, unknown>): DecodedReceiptRow {
    this.requireStoredVersion(
      row,
      "request_identity_version",
      COMMAND_REQUEST_IDENTITY_VERSION,
    );
    this.requireStoredVersion(row, "result_version", RECEIPT_RESULT_VERSION);
    const effectIdentityVersion = this.requireStoredVersion(
      row,
      "effect_identity_version",
      COMMAND_EFFECT_IDENTITY_VERSION,
    );
    const effectSha256 = requireStoredSha256(row, "effect_sha256");
    const requestSha256 = requireStoredSha256(row, "request_sha256");
    const aggregateId = requireRowString(row, "aggregate_id");
    const expectedVersion = requireStoredIntegerAtLeast(row, "expected_version", 0);
    const previousVersion = requireStoredIntegerAtLeast(row, "previous_version", 0);
    const currentVersion = requireStoredIntegerAtLeast(row, "current_version", 1);
    const eventCount = requireStoredIntegerAtLeast(row, "event_count", 1);
    const outboxCount = requireStoredIntegerAtLeast(row, "outbox_count", 0);
    const committedAt = requireStoredTimestamp(row, "committed_at");
    return {
      aggregateId,
      committedAt,
      currentVersion,
      effectIdentityVersion,
      effectSha256,
      eventCount,
      expectedVersion,
      outboxCount,
      previousVersion,
      requestSha256,
    };
  }

  protected decodeReceiptEventIdentity(
    row: Record<string, unknown>,
  ): DecodedReceiptEventIdentity {
    const eventId = requireRowString(row, "event_id");
    const aggregateSequence = requireStoredIntegerAtLeast(row, "aggregate_sequence", 1);
    const commandEventIndex = requireStoredIntegerAtLeast(row, "command_event_index", 0);
    return { aggregateSequence, commandEventIndex, eventId };
  }

  protected decodeReceiptEventBody(
    row: Record<string, unknown>,
  ): DecodedReceiptEventBody {
    return {
      eventType: requireRowString(row, "event_type"),
      globalPosition: requireStoredPositiveBigIntText(row, "global_position"),
      metadata: requireRowBytes(row, "metadata"),
      payload: requireRowBytes(row, "payload"),
    };
  }

  protected decodeReceiptOutboxIdentity(
    row: Record<string, unknown>,
  ): DecodedReceiptOutboxIdentity {
    const messageId = requireRowString(row, "message_id");
    const eventId = requireRowString(row, "event_id");
    const eventOutboxIndex = requireStoredIntegerAtLeast(row, "event_outbox_index", 0);
    return { eventId, eventOutboxIndex, messageId };
  }

  protected decodeReceiptOutboxBody(
    row: Record<string, unknown>,
  ): DecodedReceiptOutboxBody {
    return {
      headers: requireRowBytes(row, "headers"),
      outboxPosition: requireStoredPositiveBigIntText(row, "outbox_position"),
      payload: requireRowBytes(row, "payload"),
      topic: requireRowString(row, "topic"),
    };
  }
}
