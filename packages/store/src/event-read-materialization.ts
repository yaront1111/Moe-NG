import {
  DurableStoreError,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
} from "./store-contracts.js";
import { identifyCommandEffects } from "./store-digests.js";
import type {
  EffectEventDraft,
  EffectOutboxDraft,
  StoredReceipt,
} from "./store-internals.js";
import {
  requireRowString,
  requireStoredIdentifier,
  requireStoredSha256,
  requireStoredTimestamp,
} from "./store-rows.js";
import { EventReadDecodeStore } from "./event-read-decode.js";

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

const RECEIPT_ROW_QUERY = `
  SELECT command_id, request_identity_version, request_sha256, result_version,
    effect_identity_version, effect_sha256, aggregate_id, expected_version,
    previous_version, current_version, event_count, outbox_count, committed_at
  FROM command_receipts
  WHERE command_id = ?
` as const;

const RECEIPT_SCOPE_QUERY =
  "SELECT project_id FROM command_receipt_scopes WHERE receipt_command_id = ?" as const;

const RECEIPT_EVENT_QUERY = `
  SELECT CAST(global_position AS TEXT) AS global_position, event_id, aggregate_id,
    aggregate_sequence, command_event_index, record_version, payload_codec_version,
    request_sha256, event_type, payload, metadata, committed_at
  FROM domain_events
  WHERE command_id = ?
  ORDER BY command_event_index
` as const;

/**
 * Internal receipt reconstruction layer. It rebuilds a durable command receipt from
 * its rows and proves the stored effect digest; it exposes no public read method.
 */
export class EventReadMaterializationStore extends EventReadDecodeStore {
  /**
   * Receipts already proven by {@link validateAllReceipts}, keyed by command id.
   * Non-null only inside {@link withStartupReceiptMemo}: the startup decision
   * sweep replays `loadReceipt` for every decision-linked receipt, and
   * re-reading and re-hashing rows just proven against the same snapshot adds
   * no evidence. Outside that window the field stays null, so every later read
   * re-proves its receipt durably and tampering after open is still caught.
   */
  private startupReceiptMemo: Map<string, StoredReceipt> | null = null;

  /**
   * Runs `run` with the startup receipt memo alive and drops the memo on the
   * way out — success or throw — so no verified receipt outlives the single
   * open-time validation pass that proved it.
   */
  protected withStartupReceiptMemo<Result>(run: () => Result): Result {
    this.startupReceiptMemo = new Map();
    try {
      return run();
    } finally {
      this.startupReceiptMemo = null;
    }
  }

  protected loadReceipt(
    commandId: string,
    validateAggregateTail = true,
    liveBindingAlreadyValidated = false,
  ): StoredReceipt | null {
    // A memoized receipt was fully re-proven moments ago in this same startup
    // pass; only the checks that read outside its own rows — the live project
    // binding and the aggregate tail — are repeated per the caller's flags.
    const memoized = this.startupReceiptMemo?.get(commandId);
    if (memoized !== undefined) {
      if (!liveBindingAlreadyValidated) {
        this.assertLiveProjectBinding();
      }
      if (validateAggregateTail) {
        this.assertReceiptTail(commandId, memoized.aggregateId, memoized.currentVersion);
      }
      return memoized;
    }
    const row = this.database.prepare(RECEIPT_ROW_QUERY).get(commandId);
    if (row === undefined) {
      return null;
    }

    const storedCommandId = requireRowString(row, "command_id");
    if (storedCommandId !== commandId) {
      throw new DurableStoreError("STORE_CORRUPT", "command receipt key does not match its row");
    }
    const scopeRow = this.database.prepare(RECEIPT_SCOPE_QUERY).get(commandId);
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
    if (!liveBindingAlreadyValidated) {
      this.assertLiveProjectBinding();
    }
    if (receiptProjectId !== this.projectId) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command receipt ${JSON.stringify(commandId)} is outside the database project binding`,
      );
    }
    const {
      aggregateId,
      committedAt,
      currentVersion,
      effectIdentityVersion,
      effectSha256: expectedEffectSha256,
      eventCount,
      expectedVersion,
      outboxCount,
      previousVersion,
      requestSha256,
    } = this.decodeReceiptRow(row);
    if (
      expectedVersion !== previousVersion ||
      currentVersion - previousVersion !== eventCount
    ) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `command receipt ${JSON.stringify(commandId)} has inconsistent versions`,
      );
    }

    const eventRows = this.database.prepare(RECEIPT_EVENT_QUERY).all(commandId);
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
      const { aggregateSequence, commandEventIndex, eventId } =
        this.decodeReceiptEventIdentity(eventRow);
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
        ...this.decodeReceiptEventBody(eventRow),
        outbox: [],
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
      const { eventId, eventOutboxIndex, messageId } =
        this.decodeReceiptOutboxIdentity(outboxRow);
      const effectEvent = effectEventById.get(eventId);
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
        messageId,
        ...this.decodeReceiptOutboxBody(outboxRow),
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
      this.assertReceiptTail(commandId, aggregateId, currentVersion);
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

  /** Proves the receipt's aggregate head has not fallen behind its commit. */
  private assertReceiptTail(
    commandId: string,
    aggregateId: string,
    currentVersion: number,
  ): void {
    const aggregateVersion = this.assertAggregateTail(aggregateId);
    if (aggregateVersion < currentVersion) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `aggregate head is behind receipt ${JSON.stringify(commandId)}`,
      );
    }
  }

  protected validateAllReceipts(): void {
    const rows = this.database
      .prepare("SELECT command_id FROM command_receipts ORDER BY command_id")
      .all();
    for (const row of rows) {
      const commandId = requireRowString(row, "command_id");
      const receipt = this.loadReceipt(commandId, false);
      if (receipt === null) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `command receipt ${JSON.stringify(commandId)} disappeared during startup validation`,
        );
      }
      this.startupReceiptMemo?.set(commandId, receipt);
    }
  }
}
