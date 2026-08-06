import {
  COMMAND_EFFECT_IDENTITY_VERSION,
  COMMAND_REQUEST_IDENTITY_VERSION,
  CommandIdConflictError,
  DurableIdConflictError,
  DurableStoreError,
  EVENT_RECORD_VERSION,
  ExpectedVersionConflictError,
  OPAQUE_PAYLOAD_CODEC_VERSION,
  RECEIPT_RESULT_VERSION,
} from "./store-contracts.js";
import type { CommitInput, CommitResult } from "./store-contracts.js";
import {
  identifyCommandEffects,
  identifyCommandRequest,
} from "./store-digests.js";
import {
  assertExternalCommitIdentifiers,
  snapshotCommitInput,
} from "./store-input.js";
import { PENDING_EFFECT_SHA256 } from "./store-internals.js";
import type {
  EffectEventDraft,
  EffectOutboxDraft,
  SnapshotCommitInput,
  StoredCommitResult,
} from "./store-internals.js";
import {
  requireInsertedPosition,
  toCommitResult,
} from "./store-rows.js";
import {
  EventReadModelStore,
  RECEIPT_OUTBOX_QUERY,
} from "./event-read-model.js";

export { RECEIPT_OUTBOX_QUERY };

export class EventLedgerStore extends EventReadModelStore {
  public commit(rawInput: CommitInput): CommitResult {
    this.requireOpen();
    if (this.projectId === null || !this.writeProjectAsserted) {
      throw new DurableStoreError(
        "PROJECT_SCOPE_REQUIRED",
        "durable command effects require an explicitly project-asserted store handle",
      );
    }
    const input = snapshotCommitInput(rawInput);
    assertExternalCommitIdentifiers(input);
    const requestSha256 = identifyCommandRequest(input);

    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.normalizeOperationalError(error, "begin command transaction");
    }
    let commitAttempted = false;
    try {
      this.assertDurableProjectBinding();
      const receipt = this.loadReceipt(input.commandId);
      if (receipt !== null) {
        if (receipt.requestSha256 !== requestSha256) {
          throw new CommandIdConflictError(input.commandId);
        }
        if (receipt.aggregateId !== input.aggregateId) {
          throw new DurableStoreError(
            "STORE_CORRUPT",
            `command receipt ${JSON.stringify(input.commandId)} does not match its key`,
          );
        }
        commitAttempted = true;
        this.database.exec("COMMIT");
        return toCommitResult(receipt, "REPLAYED");
      }

      const previousVersion = this.assertAggregateTail(input.aggregateId);
      if (previousVersion !== input.expectedVersion) {
        throw new ExpectedVersionConflictError(
          input.aggregateId,
          input.expectedVersion,
          previousVersion,
        );
      }

      const currentVersion = previousVersion + input.events.length;
      if (!Number.isSafeInteger(currentVersion)) {
        throw new DurableStoreError(
          "STORE_LIMIT_EXCEEDED",
          "aggregate version would exceed the safe integer range",
        );
      }
      const findEvent = this.database.prepare(
        "SELECT 1 AS value FROM domain_events WHERE event_id = ?",
      );
      const findOutboxMessage = this.database.prepare(
        "SELECT 1 AS value FROM outbox_messages WHERE message_id = ?",
      );
      for (const event of input.events) {
        if (findEvent.get(event.eventId) !== undefined) {
          throw new DurableIdConflictError("EVENT", event.eventId);
        }
        for (const message of event.outbox) {
          if (findOutboxMessage.get(message.messageId) !== undefined) {
            throw new DurableIdConflictError("OUTBOX_MESSAGE", message.messageId);
          }
        }
      }

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
      const insertOutbox = this.database.prepare(`
        INSERT INTO outbox_messages (
          message_id,
          event_id,
          event_outbox_index,
          topic,
          payload,
          headers,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertOutbox.setReadBigInts(true);
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
      this.insertReceiptProjectScope(input.commandId);
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
        const effectOutbox: EffectOutboxDraft[] = [];
        for (const [messageIndex, message] of event.outbox.entries()) {
          const outboxPosition = requireInsertedPosition(
            insertOutbox.run(
              message.messageId,
              event.eventId,
              messageIndex,
              message.topic,
              message.payload,
              message.headers,
              input.committedAt,
            ),
            "outbox position",
          );
          outboxMessageIds.push(message.messageId);
          effectOutbox.push({
            ...message,
            eventOutboxIndex: messageIndex,
            outboxPosition,
          });
        }
        effectEvents.push({
          ...event,
          aggregateSequence,
          commandEventIndex: eventIndex,
          globalPosition,
          outbox: effectOutbox,
        });
      }

      const effectSha256 = identifyCommandEffects({
        aggregateId: input.aggregateId,
        commandId: input.commandId,
        committedAt: input.committedAt,
        currentVersion,
        events: effectEvents,
        previousVersion,
        requestSha256,
      });
      const effectUpdate = this.database
        .prepare("UPDATE command_receipts SET effect_sha256 = ? WHERE command_id = ?")
        .run(effectSha256, input.commandId);
      if (effectUpdate.changes !== 1) {
        throw new DurableStoreError(
          "STORE_UNAVAILABLE",
          "SQLite did not finalize the command effect receipt",
        );
      }

      this.database
        .prepare(`
          INSERT INTO aggregate_heads (aggregate_id, version)
          VALUES (?, ?)
          ON CONFLICT (aggregate_id) DO UPDATE SET version = excluded.version
        `)
        .run(input.aggregateId, currentVersion);

      const storedResult: StoredCommitResult = {
        aggregateId: input.aggregateId,
        commandId: input.commandId,
        currentVersion,
        effectIdentityVersion: COMMAND_EFFECT_IDENTITY_VERSION,
        effectSha256,
        eventIds: input.events.map((event) => event.eventId),
        outboxMessageIds,
        previousVersion,
        requestSha256,
      };

      commitAttempted = true;
      this.database.exec("COMMIT");
      return toCommitResult(storedResult, "COMMITTED");
    } catch (error) {
      const transactionEndedAfterCommitAttempt = commitAttempted && !this.database.isTransaction;
      let rollbackError: unknown;
      if (this.database.isTransaction) {
        try {
          this.database.exec("ROLLBACK");
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
        }
      }
      if (transactionEndedAfterCommitAttempt || rollbackError !== undefined) {
        const causes = rollbackError === undefined ? [error] : [error, rollbackError];
        this.poison();
        throw new DurableStoreError(
          "OUTCOME_UNKNOWN",
          "the command outcome could not be proven; reopen and reconcile its receipt",
          { cause: new AggregateError(causes) },
        );
      }
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw this.normalizeOperationalError(error, "commit command effects");
    }
  }

  /**
   * Internal storage foundation. This proves only scoped idempotency and the target's
   * expected version; it is not an authorization or domain-transition decision.
   */
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
    const findEvent = this.database.prepare(
      "SELECT 1 AS value FROM domain_events WHERE event_id = ?",
    );
    const findOutboxMessage = this.database.prepare(
      "SELECT 1 AS value FROM outbox_messages WHERE message_id = ?",
    );
    for (const event of input.events) {
      if (findEvent.get(event.eventId) !== undefined) {
        throw new DurableIdConflictError("EVENT", event.eventId);
      }
      for (const message of event.outbox) {
        if (findOutboxMessage.get(message.messageId) !== undefined) {
          throw new DurableIdConflictError("OUTBOX_MESSAGE", message.messageId);
        }
      }
    }

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
    const insertOutbox = this.database.prepare(`
      INSERT INTO outbox_messages (
        message_id,
        event_id,
        event_outbox_index,
        topic,
        payload,
        headers,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertOutbox.setReadBigInts(true);
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
    this.insertReceiptProjectScope(input.commandId);
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
      const effectOutbox: EffectOutboxDraft[] = [];
      for (const [messageIndex, message] of event.outbox.entries()) {
        const outboxPosition = requireInsertedPosition(
          insertOutbox.run(
            message.messageId,
            event.eventId,
            messageIndex,
            message.topic,
            message.payload,
            message.headers,
            input.committedAt,
          ),
          "outbox position",
        );
        outboxMessageIds.push(message.messageId);
        effectOutbox.push({
          ...message,
          eventOutboxIndex: messageIndex,
          outboxPosition,
        });
      }
      effectEvents.push({
        ...event,
        aggregateSequence,
        commandEventIndex: eventIndex,
        globalPosition,
        outbox: effectOutbox,
      });
    }

    const effectSha256 = identifyCommandEffects({
      aggregateId: input.aggregateId,
      commandId: input.commandId,
      committedAt: input.committedAt,
      currentVersion,
      events: effectEvents,
      previousVersion,
      requestSha256,
    });
    const effectUpdate = this.database
      .prepare("UPDATE command_receipts SET effect_sha256 = ? WHERE command_id = ?")
      .run(effectSha256, input.commandId);
    if (effectUpdate.changes !== 1) {
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        "SQLite did not finalize the command effect receipt",
      );
    }

    this.database
      .prepare(`
        INSERT INTO aggregate_heads (aggregate_id, version)
        VALUES (?, ?)
        ON CONFLICT (aggregate_id) DO UPDATE SET version = excluded.version
      `)
      .run(input.aggregateId, currentVersion);

    return {
      aggregateId: input.aggregateId,
      commandId: input.commandId,
      currentVersion,
      effectIdentityVersion: COMMAND_EFFECT_IDENTITY_VERSION,
      effectSha256,
      eventIds: input.events.map((event) => event.eventId),
      outboxMessageIds,
      previousVersion,
      requestSha256,
    };
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
