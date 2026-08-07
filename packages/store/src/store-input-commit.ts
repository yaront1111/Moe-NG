import {
  DOMAIN_EVENT_SCHEMA_VERSION,
  MAX_COMMIT_BYTES,
  MAX_EVENTS_PER_COMMIT,
  MAX_OUTBOX_MESSAGES_PER_COMMIT,
} from "./store-contracts.js";
import type { CommitInput } from "./store-contracts.js";
import {
  EMPTY_BYTES,
  INTERNAL_IDENTIFIER_PREFIX,
} from "./store-internals.js";
import type {
  ByteBudget,
  SnapshotCommitInput,
  SnapshotEventDraft,
  SnapshotOutboxDraft,
} from "./store-internals.js";
import {
  snapshotBytes,
  snapshotDenseArray,
} from "./store-input-containers.js";
import {
  invalidInput,
  limitExceeded,
  readOwnDataProperty,
  requireCanonicalTimestamp,
  requireDataRecord,
  requireIdentifier,
  requireSafeNonnegativeInteger,
} from "./store-input-primitives.js";

export function snapshotCommitInput(
  rawInput: CommitInput,
  byteBudget: ByteBudget = { remaining: MAX_COMMIT_BYTES },
): SnapshotCommitInput {
  const input = requireDataRecord(rawInput, "commit input");
  const rawEvents = snapshotDenseArray(
    readOwnDataProperty(input, "events", "events"),
    "events",
    MAX_EVENTS_PER_COMMIT,
  );
  if (rawEvents.length === 0) {
    return invalidInput("events must contain at least one event");
  }
  if (rawEvents.length > MAX_EVENTS_PER_COMMIT) {
    return limitExceeded(`events cannot exceed ${MAX_EVENTS_PER_COMMIT} per commit`);
  }
  const commandBytes = snapshotBytes(
    readOwnDataProperty(input, "commandBytes", "commandBytes"),
    "commandBytes",
    byteBudget,
  );

  const eventIds = new Set<string>();
  const messageIds = new Set<string>();
  const events = rawEvents.map((rawEvent, eventIndex): SnapshotEventDraft => {
    const event = requireDataRecord(rawEvent, `events[${eventIndex}]`);
    const eventId = requireIdentifier(
      readOwnDataProperty(event, "eventId", `events[${eventIndex}].eventId`),
      `events[${eventIndex}].eventId`,
    );
    if (eventIds.has(eventId)) {
      return invalidInput(`duplicate eventId ${JSON.stringify(eventId)}`);
    }
    eventIds.add(eventId);

    const rawOutboxValue = readOwnDataProperty(
      event,
      "outbox",
      `events[${eventIndex}].outbox`,
      false,
    );
    const rawOutbox =
      rawOutboxValue === undefined
        ? []
        : snapshotDenseArray(
            rawOutboxValue,
            `events[${eventIndex}].outbox`,
            MAX_OUTBOX_MESSAGES_PER_COMMIT - messageIds.size,
          );
    if (messageIds.size + rawOutbox.length > MAX_OUTBOX_MESSAGES_PER_COMMIT) {
      return limitExceeded(
        `outbox messages cannot exceed ${MAX_OUTBOX_MESSAGES_PER_COMMIT} per commit`,
      );
    }
    const outbox = rawOutbox.map((rawMessage, messageIndex): SnapshotOutboxDraft => {
      const message = requireDataRecord(
        rawMessage,
        `events[${eventIndex}].outbox[${messageIndex}]`,
      );
      const messageId = requireIdentifier(
        readOwnDataProperty(
          message,
          "messageId",
          `events[${eventIndex}].outbox[${messageIndex}].messageId`,
        ),
        `events[${eventIndex}].outbox[${messageIndex}].messageId`,
      );
      if (messageIds.has(messageId)) {
        return invalidInput(`duplicate messageId ${JSON.stringify(messageId)}`);
      }
      messageIds.add(messageId);
      return {
        headers: snapshotBytes(
          readOwnDataProperty(
            message,
            "headers",
            `events[${eventIndex}].outbox[${messageIndex}].headers`,
            false,
          ) ?? EMPTY_BYTES,
          `events[${eventIndex}].outbox[${messageIndex}].headers`,
          byteBudget,
        ),
        messageId,
        payload: snapshotBytes(
          readOwnDataProperty(
            message,
            "payload",
            `events[${eventIndex}].outbox[${messageIndex}].payload`,
          ),
          `events[${eventIndex}].outbox[${messageIndex}].payload`,
          byteBudget,
        ),
        topic: requireIdentifier(
          readOwnDataProperty(
            message,
            "topic",
            `events[${eventIndex}].outbox[${messageIndex}].topic`,
          ),
          `events[${eventIndex}].outbox[${messageIndex}].topic`,
        ),
      };
    });

    const rawDomainSchemaVersion = readOwnDataProperty(
      event,
      "domainSchemaVersion",
      `events[${eventIndex}].domainSchemaVersion`,
      false,
    );

    return {
      domainSchemaVersion:
        rawDomainSchemaVersion === undefined
          ? DOMAIN_EVENT_SCHEMA_VERSION
          : requireIdentifier(
              rawDomainSchemaVersion,
              `events[${eventIndex}].domainSchemaVersion`,
            ),
      eventId,
      eventType: requireIdentifier(
        readOwnDataProperty(event, "eventType", `events[${eventIndex}].eventType`),
        `events[${eventIndex}].eventType`,
      ),
      metadata: snapshotBytes(
        readOwnDataProperty(
          event,
          "metadata",
          `events[${eventIndex}].metadata`,
          false,
        ) ?? EMPTY_BYTES,
        `events[${eventIndex}].metadata`,
        byteBudget,
      ),
      outbox,
      payload: snapshotBytes(
        readOwnDataProperty(event, "payload", `events[${eventIndex}].payload`),
        `events[${eventIndex}].payload`,
        byteBudget,
      ),
    };
  });

  return {
    aggregateId: requireIdentifier(
      readOwnDataProperty(input, "aggregateId", "aggregateId"),
      "aggregateId",
    ),
    commandBytes,
    commandId: requireIdentifier(
      readOwnDataProperty(input, "commandId", "commandId"),
      "commandId",
    ),
    committedAt: requireCanonicalTimestamp(
      readOwnDataProperty(input, "committedAt", "committedAt"),
    ),
    events,
    expectedVersion: requireSafeNonnegativeInteger(
      readOwnDataProperty(input, "expectedVersion", "expectedVersion"),
      "expectedVersion",
    ),
  };
}

export function assertExternalCommitIdentifiers(
  input: SnapshotCommitInput,
  allowedInternalReceiptCommandId: string | null = null,
): void {
  const rejectInternal = (value: string, field: string): void => {
    if (value.startsWith(INTERNAL_IDENTIFIER_PREFIX)) {
      invalidInput(`${field} uses Moe's reserved internal identifier namespace`);
    }
  };
  rejectInternal(input.aggregateId, "aggregateId");
  if (input.commandId !== allowedInternalReceiptCommandId) {
    rejectInternal(input.commandId, "commandId");
  }
  for (const [eventIndex, event] of input.events.entries()) {
    rejectInternal(event.eventId, `events[${eventIndex}].eventId`);
    if (event.eventType === "command.expected-version-rejected") {
      invalidInput(`events[${eventIndex}].eventType uses Moe's reserved audit event type`);
    }
    for (const [messageIndex, message] of event.outbox.entries()) {
      rejectInternal(
        message.messageId,
        `events[${eventIndex}].outbox[${messageIndex}].messageId`,
      );
    }
  }
}
