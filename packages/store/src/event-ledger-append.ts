import type { StatementSync } from "node:sqlite";

import {
  COMMAND_EFFECT_IDENTITY_VERSION,
  COMMAND_REQUEST_IDENTITY_VERSION,
  DurableIdConflictError,
  DurableStoreError,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  RECEIPT_RESULT_VERSION,
} from "./store-contracts.js";
import { identifyCommandEffects } from "./store-digests.js";
import { PENDING_EFFECT_SHA256 } from "./store-internals.js";
import type {
  EffectEventDraft,
  SnapshotCommitInput,
  StoredCommitResult,
} from "./store-internals.js";
import { requireInsertedPosition } from "./store-rows.js";
import { EventOutboxStore } from "./event-ledger-outbox.js";

interface WrittenEvents {
  readonly effectEvents: readonly EffectEventDraft[];
  readonly outboxMessageIds: readonly string[];
}

/** Internal atomic append layer shared by command and decision transactions. */
export class EventAppendStore extends EventOutboxStore {
  protected writeCommitEffects(
    input: SnapshotCommitInput,
    requestSha256: string,
    previousVersion: number,
  ): StoredCommitResult {
    const currentVersion = previousVersion + input.events.length;
    if (!Number.isSafeInteger(currentVersion)) {
      throw new DurableStoreError(
        "STORE_LIMIT_EXCEEDED",
        "aggregate version would exceed the safe integer range",
      );
    }
    this.assertDurableIdsAvailable(input);
    const insertEvent = this.prepareEventInsert();
    const insertOutbox = this.prepareOutboxInsert();
    this.insertPendingReceipt(input, requestSha256, previousVersion, currentVersion);
    this.insertReceiptProjectScope(input.commandId);
    const written = this.writeEvents(
      input,
      requestSha256,
      previousVersion,
      insertEvent,
      insertOutbox,
    );
    const effectSha256 = identifyCommandEffects({
      aggregateId: input.aggregateId,
      commandId: input.commandId,
      committedAt: input.committedAt,
      currentVersion,
      events: written.effectEvents,
      previousVersion,
      requestSha256,
    });
    this.finalizeEffectReceipt(input.commandId, effectSha256);
    this.updateAggregateHead(input.aggregateId, currentVersion);
    return {
      aggregateId: input.aggregateId,
      commandId: input.commandId,
      currentVersion,
      effectIdentityVersion: COMMAND_EFFECT_IDENTITY_VERSION,
      effectSha256,
      eventIds: input.events.map((event) => event.eventId),
      outboxMessageIds: written.outboxMessageIds,
      previousVersion,
      requestSha256,
    };
  }

  private assertDurableIdsAvailable(input: SnapshotCommitInput): void {
    const findEvent = this.database.prepare(
      "SELECT 1 AS value FROM domain_events WHERE event_id = ?",
    );
    const findOutboxMessage = this.prepareOutboxIdLookup();
    for (const event of input.events) {
      if (findEvent.get(event.eventId) !== undefined) {
        throw new DurableIdConflictError("EVENT", event.eventId);
      }
      this.assertEventOutboxIdsAvailable(findOutboxMessage, event);
    }
  }

  private prepareEventInsert(): StatementSync {
    const insertEvent = this.database.prepare(`
      INSERT INTO domain_events (
        event_id,
        aggregate_id,
        aggregate_sequence,
        command_id,
        command_event_index,
        record_version,
        payload_codec_version,
        request_sha256,
        event_type,
        payload,
        metadata,
        committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEvent.setReadBigInts(true);
    return insertEvent;
  }

  private insertPendingReceipt(
    input: SnapshotCommitInput,
    requestSha256: string,
    previousVersion: number,
    currentVersion: number,
  ): void {
    const outboxCount = input.events.reduce(
      (count, event) => count + event.outbox.length,
      0,
    );
    this.database
      .prepare(`
        INSERT INTO command_receipts (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.commandId,
        COMMAND_REQUEST_IDENTITY_VERSION,
        requestSha256,
        RECEIPT_RESULT_VERSION,
        COMMAND_EFFECT_IDENTITY_VERSION,
        PENDING_EFFECT_SHA256,
        input.aggregateId,
        input.expectedVersion,
        previousVersion,
        currentVersion,
        input.events.length,
        outboxCount,
        input.committedAt,
      );
  }

  private writeEvents(
    input: SnapshotCommitInput,
    requestSha256: string,
    previousVersion: number,
    insertEvent: StatementSync,
    insertOutbox: StatementSync,
  ): WrittenEvents {
    const outboxMessageIds: string[] = [];
    const effectEvents: EffectEventDraft[] = [];
    for (const [eventIndex, event] of input.events.entries()) {
      const aggregateSequence = previousVersion + eventIndex + 1;
      const globalPosition = requireInsertedPosition(
        insertEvent.run(
          event.eventId,
          input.aggregateId,
          aggregateSequence,
          input.commandId,
          eventIndex,
          EVENT_RECORD_VERSION,
          OPAQUE_PAYLOAD_CODEC_VERSION,
          requestSha256,
          event.eventType,
          event.payload,
          event.metadata,
          input.committedAt,
        ),
        "global event position",
      );
      const outbox = this.writeEventOutbox(insertOutbox, event, input.committedAt);
      outboxMessageIds.push(...outbox.messageIds);
      effectEvents.push({
        ...event,
        aggregateSequence,
        commandEventIndex: eventIndex,
        globalPosition,
        outbox: outbox.effectOutbox,
      });
    }
    return { effectEvents, outboxMessageIds };
  }

  private finalizeEffectReceipt(commandId: string, effectSha256: string): void {
    const update = this.database
      .prepare("UPDATE command_receipts SET effect_sha256 = ? WHERE command_id = ?")
      .run(effectSha256, commandId);
    if (update.changes !== 1) {
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        "SQLite did not finalize the command effect receipt",
      );
    }
  }

  private updateAggregateHead(aggregateId: string, currentVersion: number): void {
    this.database
      .prepare(`
        INSERT INTO aggregate_heads (aggregate_id, version)
        VALUES (?, ?)
        ON CONFLICT (aggregate_id) DO UPDATE SET version = excluded.version
      `)
      .run(aggregateId, currentVersion);
  }

  protected insertReceiptProjectScope(receiptCommandId: string): void {
    if (this.projectId === null) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "a command receipt cannot be written without a project binding",
      );
    }
    const inserted = this.database
      .prepare(`
        INSERT INTO command_receipt_scopes (receipt_command_id, project_id)
        VALUES (?, ?)
      `)
      .run(receiptCommandId, this.projectId);
    if (inserted.changes !== 1) {
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        "SQLite did not bind the command receipt to its project",
      );
    }
  }
}
