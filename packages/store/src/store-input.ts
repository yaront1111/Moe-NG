import { types } from "node:util";

import {
  DurableStoreError,
  MAX_BLOB_BYTES,
  MAX_COMMIT_BYTES,
  MAX_EVENTS_PER_COMMIT,
  MAX_OUTBOX_MESSAGES_PER_COMMIT,
  MAX_PAGE_SIZE,
} from "./store-contracts.js";
import type {
  CommandDecisionKey,
  CommitExpectedVersionDecisionInput,
  CommitInput,
} from "./store-contracts.js";
import { identifyCorrelation } from "./store-digests.js";
import {
  EMPTY_BYTES,
  INTERNAL_IDENTIFIER_PREFIX,
  MAX_IDENTIFIER_UTF8_BYTES,
  MAX_SQLITE_INTEGER,
  canonicalTimestampPattern,
  stringIsWellFormed,
  textEncoder,
} from "./store-internals.js";
import type {
  ByteBudget,
  DataRecord,
  SnapshotCommitInput,
  SnapshotCommittedProposal,
  SnapshotDecisionMetadata,
  SnapshotEventDraft,
  SnapshotExpectedVersionRequest,
  SnapshotOutboxDraft,
} from "./store-internals.js";

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;

function requireTypedArrayGetter(name: "buffer" | "byteLength" | "byteOffset"): () => unknown {
  const getter = Object.getOwnPropertyDescriptor(typedArrayPrototype, name)?.get;
  if (getter === undefined) {
    throw new Error(`Node runtime lacks intrinsic typed-array ${name} accessor`);
  }
  return getter;
}

const typedArrayBufferGetter = requireTypedArrayGetter("buffer");
const typedArrayByteLengthGetter = requireTypedArrayGetter("byteLength");
const typedArrayByteOffsetGetter = requireTypedArrayGetter("byteOffset");

export function invalidInput(message: string): never {
  throw new DurableStoreError("STORE_INPUT_INVALID", message);
}

export function limitExceeded(message: string): never {
  throw new DurableStoreError("STORE_LIMIT_EXCEEDED", message);
}

export function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_UTF8_BYTES ||
    !Reflect.apply(stringIsWellFormed, value, []) ||
    value.includes("\0") ||
    textEncoder.encode(value).byteLength > MAX_IDENTIFIER_UTF8_BYTES
  ) {
    return invalidInput(
      `${field} must be well-formed, non-empty, at most ${MAX_IDENTIFIER_UTF8_BYTES} UTF-8 bytes, and contain no NUL`,
    );
  }
  return value;
}

export function requireSafeNonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidInput(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function requireSafePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidInput(`${field} must be a positive safe integer`);
  }
  return value;
}

export function requireNonnegativeBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_SQLITE_INTEGER) {
    return invalidInput(`${field} must be a non-negative SQLite-range bigint`);
  }
  return value;
}

export function requirePageLimit(value: unknown): number {
  const limit = requireSafePositiveInteger(value, "limit");
  if (limit > MAX_PAGE_SIZE) {
    return limitExceeded(`limit cannot exceed ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

export function requireCanonicalTimestamp(value: unknown, field = "committedAt"): string {
  if (
    typeof value !== "string" ||
    !canonicalTimestampPattern.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return invalidInput(`${field} must be a canonical UTC timestamp with millisecond precision`);
  }
  return value;
}

export function requireDataRecord(value: unknown, field: string): DataRecord {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    return invalidInput(`${field} must be a non-proxy data object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidInput(`${field} must be a plain data object`);
  }
  return value as DataRecord;
}

export function readOwnDataProperty(
  record: DataRecord,
  key: string,
  field: string,
  required = true,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    if (required) {
      return invalidInput(`${field} is required`);
    }
    return undefined;
  }
  if (!("value" in descriptor)) {
    return invalidInput(`${field} must be an own data property`);
  }
  return descriptor.value;
}

export function snapshotDenseArray(
  value: unknown,
  field: string,
  maximumLength?: number,
): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value)) {
    return invalidInput(`${field} must be a non-proxy array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return invalidInput(`${field} must be a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    return invalidInput(`${field} has an invalid length`);
  }
  if (maximumLength !== undefined && length > maximumLength) {
    return limitExceeded(`${field} cannot exceed ${maximumLength} elements`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidInput(`${field} must be dense and contain only data elements`);
    }
    snapshot.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (
      key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)
    ) {
      return invalidInput(`${field} cannot contain non-index properties`);
    }
  }
  return snapshot;
}

export function snapshotBytes(
  value: unknown,
  field: string,
  budget?: ByteBudget,
): Uint8Array {
  if (types.isProxy(value) || !types.isUint8Array(value)) {
    return invalidInput(`${field} must be a non-proxy Uint8Array`);
  }

  let buffer: ArrayBufferLike;
  let byteLength: number;
  let byteOffset: number;
  try {
    buffer = Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBufferLike;
    byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
    byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as number;
  } catch {
    return invalidInput(`${field} must be a Uint8Array`);
  }
  if (types.isSharedArrayBuffer(buffer)) {
    return invalidInput(`${field} cannot use a shared backing buffer`);
  }
  if (byteLength > MAX_BLOB_BYTES) {
    return limitExceeded(`${field} exceeds ${MAX_BLOB_BYTES} bytes`);
  }
  if (budget !== undefined) {
    if (byteLength > budget.remaining) {
      return limitExceeded(`commit byte total cannot exceed ${MAX_COMMIT_BYTES}`);
    }
    budget.remaining -= byteLength;
  }

  try {
    const snapshot = new Uint8Array(byteLength);
    snapshot.set(new Uint8Array(buffer, byteOffset, byteLength));
    return snapshot;
  } catch {
    return invalidInput(`${field} must reference attached, stable bytes`);
  }
}

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

    return {
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

export function snapshotCommandDecisionKey(value: unknown): CommandDecisionKey {
  const key = requireDataRecord(value, "key");
  return Object.freeze({
    commandId: requireIdentifier(
      readOwnDataProperty(key, "commandId", "key.commandId"),
      "key.commandId",
    ),
    principalId: requireIdentifier(
      readOwnDataProperty(key, "principalId", "key.principalId"),
      "key.principalId",
    ),
    projectId: requireIdentifier(
      readOwnDataProperty(key, "projectId", "key.projectId"),
      "key.projectId",
    ),
  });
}

export function snapshotExpectedVersionRequest(
  rawInput: CommitExpectedVersionDecisionInput,
): SnapshotExpectedVersionRequest {
  const input = requireDataRecord(rawInput, "expected-version decision input");
  return {
    commandKind: requireIdentifier(
      readOwnDataProperty(input, "commandKind", "commandKind"),
      "commandKind",
    ),
    expectedVersion: requireSafeNonnegativeInteger(
      readOwnDataProperty(input, "expectedVersion", "expectedVersion"),
      "expectedVersion",
    ),
    inputRecord: input,
    key: snapshotCommandDecisionKey(readOwnDataProperty(input, "key", "key")),
    requestBytes: snapshotBytes(
      readOwnDataProperty(input, "requestBytes", "requestBytes"),
      "requestBytes",
    ),
    targetAggregateId: requireIdentifier(
      readOwnDataProperty(input, "targetAggregateId", "targetAggregateId"),
      "targetAggregateId",
    ),
  };
}

export function snapshotDecisionMetadata(input: DataRecord): SnapshotDecisionMetadata {
  const correlationId = requireIdentifier(
    readOwnDataProperty(input, "correlationId", "correlationId"),
    "correlationId",
  );
  return {
    correlationSha256: identifyCorrelation(correlationId),
    decidedAt: requireCanonicalTimestamp(
      readOwnDataProperty(input, "decidedAt", "decidedAt"),
      "decidedAt",
    ),
  };
}

export function snapshotCommittedProposal(
  request: SnapshotExpectedVersionRequest,
  receiptCommandId: string,
  decidedAt: string,
): SnapshotCommittedProposal {
  const byteBudget: ByteBudget = { remaining: MAX_COMMIT_BYTES };
  const resultBytes = snapshotBytes(
    readOwnDataProperty(
      request.inputRecord,
      "committedResultBytes",
      "committedResultBytes",
    ),
    "committedResultBytes",
    byteBudget,
  );
  const rawCommitInput = {
    aggregateId: request.targetAggregateId,
    commandBytes: request.requestBytes,
    commandId: receiptCommandId,
    committedAt: decidedAt,
    events: readOwnDataProperty(request.inputRecord, "events", "events"),
    expectedVersion: request.expectedVersion,
  } as unknown as CommitInput;
  const commitInput = snapshotCommitInput(rawCommitInput, byteBudget);
  assertExternalCommitIdentifiers(commitInput, receiptCommandId);
  return { commitInput, resultBytes };
}
