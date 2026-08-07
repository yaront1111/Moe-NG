import type { StatementSync } from "node:sqlite";

import { DurableIdConflictError } from "./store-contracts.js";
import type {
  EffectOutboxDraft,
  SnapshotEventDraft,
} from "./store-internals.js";
import { requireInsertedPosition } from "./store-rows.js";
import { EventReadModelStore } from "./event-read-model.js";

interface InsertedEventOutbox {
  readonly effectOutbox: readonly EffectOutboxDraft[];
  readonly messageIds: readonly string[];
}

/** Internal outbox-write layer for the event ledger. */
export class EventOutboxStore extends EventReadModelStore {
  protected prepareOutboxIdLookup(): StatementSync {
    return this.database.prepare(
      "SELECT 1 AS value FROM outbox_messages WHERE message_id = ?",
    );
  }

  protected assertEventOutboxIdsAvailable(
    findOutboxMessage: StatementSync,
    event: SnapshotEventDraft,
  ): void {
    for (const message of event.outbox) {
      if (findOutboxMessage.get(message.messageId) !== undefined) {
        throw new DurableIdConflictError("OUTBOX_MESSAGE", message.messageId);
      }
    }
  }

  protected prepareOutboxInsert(): StatementSync {
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
    return insertOutbox;
  }

  protected writeEventOutbox(
    insertOutbox: StatementSync,
    event: SnapshotEventDraft,
    committedAt: string,
  ): InsertedEventOutbox {
    const effectOutbox: EffectOutboxDraft[] = [];
    const messageIds: string[] = [];
    for (const [messageIndex, message] of event.outbox.entries()) {
      const outboxPosition = requireInsertedPosition(
        insertOutbox.run(
          message.messageId,
          event.eventId,
          messageIndex,
          message.topic,
          message.payload,
          message.headers,
          committedAt,
        ),
        "outbox position",
      );
      messageIds.push(message.messageId);
      effectOutbox.push({
        ...message,
        eventOutboxIndex: messageIndex,
        outboxPosition,
      });
    }
    return { effectOutbox, messageIds };
  }
}
