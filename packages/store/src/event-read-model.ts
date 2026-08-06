import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  COMMAND_REQUEST_IDENTITY_VERSION,
  DurableStoreError,
  EVENT_RECORD_VERSION,
  MAX_PAGE_SIZE,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  RECEIPT_RESULT_VERSION,
} from "./store-contracts.js";
import type {
  CommandReceipt,
  CursorPage,
  PendingOutboxMessage,
  StoredEvent,
} from "./store-contracts.js";
import { identifyCommandEffects } from "./store-digests.js";
import {
  limitExceeded,
  requireIdentifier,
  requireNonnegativeBigInt,
  requirePageLimit,
  requireSafeNonnegativeInteger,
} from "./store-input.js";
import type {
  EffectEventDraft,
  EffectOutboxDraft,
  StoredReceipt,
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

export const RECEIPT_OUTBOX_QUERY = `
  SELECT
    CAST(messages.outbox_position AS TEXT) AS outbox_position,
    messages.message_id,
    messages.event_id,
    messages.event_outbox_index,
    messages.topic,
    messages.payload,
    messages.headers,
    messages.created_at
  FROM outbox_messages AS messages
  INNER JOIN domain_events AS events ON events.event_id = messages.event_id
  WHERE events.command_id = ?
  ORDER BY events.command_event_index, messages.event_outbox_index
` as const;

export class EventReadModelStore extends StoreRuntime {
  public getAggregateVersion(aggregateId: string): number {
    return this.readOperation("read aggregate version", () => {
      this.assertCachedProjectBinding();
      return this.assertAggregateTail(requireIdentifier(aggregateId, "aggregateId"));
    });
  }

  public getCommandReceipt(commandId: string): CommandReceipt | null {
    return this.readOperation("read command receipt", () => {
      this.assertReceiptReadBinding();
      const safeCommandId = requireIdentifier(commandId, "commandId");
      const receipt = this.loadReceipt(safeCommandId);
      if (receipt === null) {
        return null;
      }
      return Object.freeze({
        ...receipt,
        eventIds: Object.freeze([...receipt.eventIds]),
        outboxMessageIds: Object.freeze([...receipt.outboxMessageIds]),
      });
    });
  }

  public readEvents(aggregateId: string): readonly StoredEvent[] {
    const page = this.readAggregateEvents(aggregateId, 0, MAX_PAGE_SIZE);
    if (page.hasMore) {
      return limitExceeded(
        `aggregate has more than ${MAX_PAGE_SIZE} events; use readAggregateEvents with its cursor`,
      );
    }
    return page.items;
  }

  public readAggregateEvents(
    aggregateId: string,
    afterAggregateSequence = 0,
    limit = 100,
  ): CursorPage<StoredEvent, number> {
    return this.readOperation("read aggregate events", () => {
      this.assertCachedProjectBinding();
      const safeAggregateId = requireIdentifier(aggregateId, "aggregateId");
      const safeAfter = requireSafeNonnegativeInteger(
        afterAggregateSequence,
        "afterAggregateSequence",
      );
      const safeLimit = requirePageLimit(limit);
      const rows = this.database
        .prepare(`
        SELECT
          CAST(events.global_position AS TEXT) AS global_position,
          events.aggregate_id,
          events.aggregate_sequence,
          events.command_id,
          decisions.project_id AS decision_project_id,
          decisions.principal_id AS decision_principal_id,
          decisions.command_id AS decision_command_id,
          decisions.command_kind AS decision_command_kind,
          decisions.request_identity_version AS decision_request_identity_version,
          decisions.request_sha256 AS decision_request_sha256,
          events.record_version,
          events.payload_codec_version,
          events.request_sha256,
          events.event_id,
          events.event_type,
          events.payload,
          events.metadata,
          events.committed_at
        FROM domain_events AS events
        LEFT JOIN command_decisions AS decisions
          ON decisions.receipt_command_id = events.command_id
        WHERE events.aggregate_id = ? AND events.aggregate_sequence > ?
        ORDER BY events.aggregate_sequence
        LIMIT ?
        `)
        .all(safeAggregateId, safeAfter, safeLimit + 1);
      const hasMore = rows.length > safeLimit;
      const items = rows.slice(0, safeLimit).map((row) => this.mapStoredEvent(row));
      return this.page(
        items,
        hasMore,
        items.length === 0 ? null : items.at(-1)!.aggregateSequence,
      );
    });
  }

  public readEventsAfter(
    afterGlobalPosition: bigint,
    limit = 100,
  ): CursorPage<StoredEvent, bigint> {
    return this.readOperation("read global events", () => {
      this.assertCachedProjectBinding();
      const safeAfter = requireNonnegativeBigInt(
        afterGlobalPosition,
        "afterGlobalPosition",
      );
      const safeLimit = requirePageLimit(limit);
      const rows = this.database
        .prepare(`
        SELECT
          CAST(events.global_position AS TEXT) AS global_position,
          events.aggregate_id,
          events.aggregate_sequence,
          events.command_id,
          decisions.project_id AS decision_project_id,
          decisions.principal_id AS decision_principal_id,
          decisions.command_id AS decision_command_id,
          decisions.command_kind AS decision_command_kind,
          decisions.request_identity_version AS decision_request_identity_version,
          decisions.request_sha256 AS decision_request_sha256,
          events.record_version,
          events.payload_codec_version,
          events.request_sha256,
          events.event_id,
          events.event_type,
          events.payload,
          events.metadata,
          events.committed_at
        FROM domain_events AS events
        LEFT JOIN command_decisions AS decisions
          ON decisions.receipt_command_id = events.command_id
        WHERE events.global_position > ?
        ORDER BY events.global_position
        LIMIT ?
        `)
        .all(safeAfter, safeLimit + 1);
      const hasMore = rows.length > safeLimit;
      const items = rows.slice(0, safeLimit).map((row) => this.mapStoredEvent(row));
      return this.page(
        items,
        hasMore,
        items.length === 0 ? null : items.at(-1)!.globalPosition,
      );
    });
  }

  public readPendingOutbox(limit = 100): readonly PendingOutboxMessage[] {
    const page = this.readPendingOutboxPage(0n, limit);
    if (page.hasMore) {
      return limitExceeded(
        `pending outbox has more than ${limit} messages; use readPendingOutboxPage with its cursor`,
      );
    }
    return page.items;
  }

  public readPendingOutboxPage(
    afterOutboxPosition: bigint,
    limit = 100,
  ): CursorPage<PendingOutboxMessage, bigint> {
    return this.readOperation("read pending outbox", () => {
      this.assertCachedProjectBinding();
      const safeAfter = requireNonnegativeBigInt(
        afterOutboxPosition,
        "afterOutboxPosition",
      );
      const safeLimit = requirePageLimit(limit);
      const rows = this.database
        .prepare(`
        SELECT
          CAST(outbox_position AS TEXT) AS outbox_position,
          message_id,
          event_id,
          topic,
          payload,
          headers,
          created_at,
          delivery_attempts
        FROM outbox_messages
        WHERE delivered_at IS NULL AND outbox_position > ?
        ORDER BY outbox_messages.outbox_position
        LIMIT ?
        `)
        .all(safeAfter, safeLimit + 1);
      const hasMore = rows.length > safeLimit;
      const items = rows.slice(0, safeLimit).map((row) => this.mapOutboxMessage(row));
      return this.page(
        items,
        hasMore,
        items.length === 0 ? null : items.at(-1)!.outboxPosition,
      );
    });
  }

  private mapStoredEvent(row: Record<string, unknown>): StoredEvent {
    const storedEvent: StoredEvent = {
      aggregateId: requireRowString(row, "aggregate_id"),
      aggregateSequence: requireStoredIntegerAtLeast(row, "aggregate_sequence", 1),
      commandId: requireRowString(row, "command_id"),
      committedAt: requireStoredTimestamp(row, "committed_at"),
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

  private mapOutboxMessage(row: Record<string, unknown>): PendingOutboxMessage {
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

  protected loadReceipt(commandId: string, validateAggregateTail = true): StoredReceipt | null {
    const row = this.database
      .prepare(`
        SELECT
          command_id,
          request_identity_version,
          request_sha256,
          result_version,
          effect_identity_version,
          effect_sha256,
          aggregate_id,
          expected_version,
          previous_version,
          current_version,
          event_count,
          outbox_count,
          committed_at
        FROM command_receipts
        WHERE command_id = ?
      `)
      .get(commandId);
    if (row === undefined) {
      return null;
    }

    const storedCommandId = requireRowString(row, "command_id");
    if (storedCommandId !== commandId) {
      throw new DurableStoreError("STORE_CORRUPT", "command receipt key does not match its row");
    }
    const scopeRow = this.database
      .prepare(`
        SELECT project_id
        FROM command_receipt_scopes
        WHERE receipt_command_id = ?
      `)
      .get(commandId);
    if (scopeRow === undefined) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command receipt ${JSON.stringify(commandId)} is missing its project scope`,
      );
    }
    const receiptProjectId = requireStoredIdentifier(scopeRow, "project_id");
    if (this.projectId === null) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_REQUIRED",
        "the inspection handle predates the database project binding; reopen it before reading scoped receipts",
      );
    }
    this.assertLiveProjectBinding();
    if (receiptProjectId !== this.projectId) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command receipt ${JSON.stringify(commandId)} is outside the database project binding`,
      );
    }
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
    const expectedEffectSha256 = requireStoredSha256(row, "effect_sha256");
    const requestSha256 = requireStoredSha256(row, "request_sha256");
    const aggregateId = requireRowString(row, "aggregate_id");
    const expectedVersion = requireStoredIntegerAtLeast(row, "expected_version", 0);
    const previousVersion = requireStoredIntegerAtLeast(row, "previous_version", 0);
    const currentVersion = requireStoredIntegerAtLeast(row, "current_version", 1);
    const eventCount = requireStoredIntegerAtLeast(row, "event_count", 1);
    const outboxCount = requireStoredIntegerAtLeast(row, "outbox_count", 0);
    const committedAt = requireStoredTimestamp(row, "committed_at");
    if (
      expectedVersion !== previousVersion ||
      currentVersion - previousVersion !== eventCount
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command receipt ${JSON.stringify(commandId)} has inconsistent versions`,
      );
    }

    const eventRows = this.database
      .prepare(`
        SELECT
          CAST(global_position AS TEXT) AS global_position,
          event_id,
          aggregate_id,
          aggregate_sequence,
          command_event_index,
          record_version,
          payload_codec_version,
          request_sha256,
          event_type,
          payload,
          metadata,
          committed_at
        FROM domain_events
        WHERE command_id = ?
        ORDER BY command_event_index
      `)
      .all(commandId);
    if (eventRows.length !== eventCount) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command receipt ${JSON.stringify(commandId)} expects ${eventCount} events, found ${eventRows.length}`,
      );
    }
    const eventIds: string[] = [];
    const eventIdSet = new Set<string>();
    const effectEvents: Array<
      Omit<EffectEventDraft, "outbox"> & { outbox: EffectOutboxDraft[] }
    > = [];
    const effectEventById = new Map<string, (typeof effectEvents)[number]>();
    for (const [eventIndex, eventRow] of eventRows.entries()) {
      const eventId = requireRowString(eventRow, "event_id");
      const aggregateSequence = requireStoredIntegerAtLeast(
        eventRow,
        "aggregate_sequence",
        1,
      );
      const commandEventIndex = requireStoredIntegerAtLeast(
        eventRow,
        "command_event_index",
        0,
      );
      if (
        requireRowString(eventRow, "aggregate_id") !== aggregateId ||
        aggregateSequence !== previousVersion + eventIndex + 1 ||
        commandEventIndex !== eventIndex ||
        requireStoredSha256(eventRow, "request_sha256") !== requestSha256 ||
        requireStoredTimestamp(eventRow, "committed_at") !== committedAt
      ) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `event ${JSON.stringify(eventId)} does not match receipt ${JSON.stringify(commandId)}`,
        );
      }
      this.requireStoredVersion(eventRow, "record_version", EVENT_RECORD_VERSION);
      this.requireStoredVersion(
        eventRow,
        "payload_codec_version",
        OPAQUE_PAYLOAD_CODEC_VERSION,
      );
      eventIds.push(eventId);
      eventIdSet.add(eventId);
      const effectEvent = {
        aggregateSequence,
        commandEventIndex,
        eventId,
        eventType: requireRowString(eventRow, "event_type"),
        globalPosition: requireStoredPositiveBigIntText(eventRow, "global_position"),
        metadata: requireRowBytes(eventRow, "metadata"),
        outbox: [],
        payload: requireRowBytes(eventRow, "payload"),
      };
      effectEvents.push(effectEvent);
      effectEventById.set(eventId, effectEvent);
    }

    const outboxRows = this.database.prepare(RECEIPT_OUTBOX_QUERY).all(commandId);
    if (outboxRows.length !== outboxCount) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command receipt ${JSON.stringify(commandId)} expects ${outboxCount} outbox rows, found ${outboxRows.length}`,
      );
    }
    const outboxMessageIds = outboxRows.map((outboxRow) => {
      const messageId = requireRowString(outboxRow, "message_id");
      const eventId = requireRowString(outboxRow, "event_id");
      const effectEvent = effectEventById.get(eventId);
      const eventOutboxIndex = requireStoredIntegerAtLeast(
        outboxRow,
        "event_outbox_index",
        0,
      );
      if (
        !eventIdSet.has(eventId) ||
        effectEvent === undefined ||
        eventOutboxIndex !== effectEvent.outbox.length ||
        requireStoredTimestamp(outboxRow, "created_at") !== committedAt
      ) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `outbox message ${JSON.stringify(messageId)} does not match receipt ${JSON.stringify(commandId)}`,
        );
      }
      effectEvent.outbox.push({
        eventOutboxIndex,
        headers: requireRowBytes(outboxRow, "headers"),
        messageId,
        outboxPosition: requireStoredPositiveBigIntText(
          outboxRow,
          "outbox_position",
        ),
        payload: requireRowBytes(outboxRow, "payload"),
        topic: requireRowString(outboxRow, "topic"),
      });
      return messageId;
    });

    const actualEffectSha256 = identifyCommandEffects({
      aggregateId,
      commandId,
      committedAt,
      currentVersion,
      events: effectEvents,
      previousVersion,
      requestSha256,
    });
    if (actualEffectSha256 !== expectedEffectSha256) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command receipt ${JSON.stringify(commandId)} effect digest does not match durable rows`,
      );
    }
    if (validateAggregateTail) {
      const aggregateVersion = this.assertAggregateTail(aggregateId);
      if (aggregateVersion < currentVersion) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `aggregate head is behind receipt ${JSON.stringify(commandId)}`,
        );
      }
    }
    return {
      aggregateId,
      commandId,
      committedAt,
      currentVersion,
      effectIdentityVersion,
      effectSha256: expectedEffectSha256,
      eventIds,
      outboxMessageIds,
      previousVersion,
      requestSha256,
    };
  }

  protected validateAllReceipts(): void {
    const rows = this.database
      .prepare("SELECT command_id FROM command_receipts ORDER BY command_id")
      .all();
    for (const row of rows) {
      const commandId = requireRowString(row, "command_id");
      if (this.loadReceipt(commandId, false) === null) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `command receipt ${JSON.stringify(commandId)} disappeared during startup validation`,
        );
      }
    }
  }
}
