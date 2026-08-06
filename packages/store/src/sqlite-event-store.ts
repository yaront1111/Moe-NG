import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";

export const MINIMUM_SQLITE_VERSION = "3.51.3" as const;
export const COMMAND_REQUEST_IDENTITY_VERSION = "moe-command-request/1" as const;
export const SQLITE_APPLICATION_ID = 0x4d4f4531 as const;
export const EVENT_RECORD_VERSION = "moe-event-record/1" as const;
export const OPAQUE_PAYLOAD_CODEC_VERSION = "moe-opaque-bytes/1" as const;
export const RECEIPT_RESULT_VERSION = "moe-commit-result/1" as const;
export const COMMAND_EFFECT_IDENTITY_VERSION = "moe-command-effect/1" as const;
export const SQLITE_SCHEMA_MANIFEST_VERSION = "moe-sqlite-schema/1" as const;
export const MAX_EVENTS_PER_COMMIT = 256 as const;
export const MAX_OUTBOX_MESSAGES_PER_COMMIT = 1_024 as const;
export const MAX_BLOB_BYTES = 8 * 1_024 * 1_024;
export const MAX_COMMIT_BYTES = 32 * 1_024 * 1_024;
export const MAX_PAGE_SIZE = 1_000 as const;

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
  | "OUTCOME_UNKNOWN"
  | "STORE_BUSY"
  | "STORE_CLOSED"
  | "STORE_CORRUPT"
  | "STORE_INPUT_INVALID"
  | "STORE_LIMIT_EXCEEDED"
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
    super("COMMAND_ID_CONFLICT", `command ${JSON.stringify(commandId)} was reused for a different request`);
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
  readonly applicationId: number;
  readonly busyTimeoutMilliseconds: number;
  readonly databasePath: string | null;
  readonly durability: "EPHEMERAL_TEST" | "WAL_FILE";
  readonly foreignKeys: boolean;
  readonly foreignKeyViolations: number;
  readonly journalMode: string;
  readonly quickCheck: string;
  readonly recursiveTriggers: boolean;
  readonly sqliteVersion: string;
  readonly synchronous: "extra" | "full" | "normal" | "off";
  readonly trustedSchema: boolean;
  readonly userVersion: number;
  readonly walAutocheckpointPages: number;
}

const SCHEMA_VERSION = 1;
const EMPTY_BYTES = new Uint8Array();
const PENDING_EFFECT_SHA256 = "0".repeat(64);
const MAX_IDENTIFIER_UTF8_BYTES = 512;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;
const textEncoder = new TextEncoder();
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const stringIsWellFormed = String.prototype.isWellFormed;

const SCHEMA_OBJECT_SQL = Object.freeze({
  aggregate_heads: `
    CREATE TABLE aggregate_heads (
      aggregate_id TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 0 AND version <= 9007199254740991)
    ) STRICT
  `,
  command_receipts: `
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY NOT NULL,
      request_identity_version TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      result_version TEXT NOT NULL,
      effect_identity_version TEXT NOT NULL,
      effect_sha256 TEXT NOT NULL CHECK (
        length(effect_sha256) = 64 AND effect_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      aggregate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
      previous_version INTEGER NOT NULL CHECK (previous_version >= 0),
      current_version INTEGER NOT NULL CHECK (current_version > previous_version),
      event_count INTEGER NOT NULL CHECK (event_count > 0),
      outbox_count INTEGER NOT NULL CHECK (outbox_count >= 0),
      committed_at TEXT NOT NULL,
      CHECK (expected_version = previous_version),
      CHECK (current_version = previous_version + event_count)
    ) STRICT
  `,
  domain_events: `
    CREATE TABLE domain_events (
      global_position INTEGER PRIMARY KEY AUTOINCREMENT CHECK (global_position > 0),
      event_id TEXT NOT NULL UNIQUE,
      aggregate_id TEXT NOT NULL,
      aggregate_sequence INTEGER NOT NULL CHECK (aggregate_sequence > 0),
      command_id TEXT NOT NULL,
      command_event_index INTEGER NOT NULL CHECK (command_event_index >= 0),
      record_version TEXT NOT NULL,
      payload_codec_version TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (
        length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      event_type TEXT NOT NULL,
      payload BLOB NOT NULL,
      metadata BLOB NOT NULL,
      committed_at TEXT NOT NULL,
      UNIQUE (aggregate_id, aggregate_sequence),
      UNIQUE (command_id, command_event_index),
      FOREIGN KEY (command_id) REFERENCES command_receipts(command_id) ON DELETE RESTRICT
    ) STRICT
  `,
  outbox_messages: `
    CREATE TABLE outbox_messages (
      outbox_position INTEGER PRIMARY KEY AUTOINCREMENT CHECK (outbox_position > 0),
      message_id TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL,
      event_outbox_index INTEGER NOT NULL CHECK (event_outbox_index >= 0),
      topic TEXT NOT NULL,
      payload BLOB NOT NULL,
      headers BLOB NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
      UNIQUE (event_id, event_outbox_index),
      FOREIGN KEY (event_id) REFERENCES domain_events(event_id) ON DELETE RESTRICT
    ) STRICT
  `,
  store_metadata: `
    CREATE TABLE store_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT
  `,
  outbox_pending_order: `
    CREATE INDEX outbox_pending_order
      ON outbox_messages(delivered_at, outbox_position)
  `,
  outbox_event_order: `
    CREATE INDEX outbox_event_order
      ON outbox_messages(event_id, event_outbox_index)
  `,
});

/** Package-internal query exported only so its production access plan can be regression-tested. */
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

interface SnapshotOutboxDraft {
  readonly headers: Uint8Array;
  readonly messageId: string;
  readonly payload: Uint8Array;
  readonly topic: string;
}

interface EffectOutboxDraft extends SnapshotOutboxDraft {
  readonly eventOutboxIndex: number;
  readonly outboxPosition: bigint;
}

interface SnapshotEventDraft {
  readonly eventId: string;
  readonly eventType: string;
  readonly metadata: Uint8Array;
  readonly outbox: readonly SnapshotOutboxDraft[];
  readonly payload: Uint8Array;
}

interface EffectEventDraft extends Omit<SnapshotEventDraft, "outbox"> {
  readonly aggregateSequence: number;
  readonly commandEventIndex: number;
  readonly globalPosition: bigint;
  readonly outbox: readonly EffectOutboxDraft[];
}

interface SnapshotCommitInput {
  readonly aggregateId: string;
  readonly commandBytes: Uint8Array;
  readonly commandId: string;
  readonly committedAt: string;
  readonly events: readonly SnapshotEventDraft[];
  readonly expectedVersion: number;
}

interface StoredCommitResult {
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

interface StoredReceipt extends StoredCommitResult {
  readonly committedAt: string;
}

function invalidInput(message: string): never {
  throw new DurableStoreError("STORE_INPUT_INVALID", message);
}

function limitExceeded(message: string): never {
  throw new DurableStoreError("STORE_LIMIT_EXCEEDED", message);
}

function canonicalDatabasePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !Reflect.apply(stringIsWellFormed, value, []) ||
    value.startsWith("file:") ||
    !isAbsolute(value)
  ) {
    return invalidInput("database path must be a well-formed absolute filesystem path");
  }
  try {
    if (existsSync(value)) {
      return realpathSync.native(value);
    }
    return join(realpathSync.native(dirname(value)), basename(value));
  } catch (error) {
    throw new DurableStoreError(
      "STORE_INPUT_INVALID",
      "database path parent must exist and be canonically resolvable",
      { cause: error },
    );
  }
}

function isFreshDatabaseFileCandidate(databasePath: string | null): boolean {
  if (databasePath === null) {
    return true;
  }
  try {
    return !existsSync(databasePath) || statSync(databasePath).size === 0;
  } catch (error) {
    throw new DurableStoreError(
      "STORE_UNAVAILABLE",
      "unable to inspect the SQLite database file",
      { cause: error },
    );
  }
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_UTF8_BYTES ||
    !Reflect.apply(stringIsWellFormed, value, []) ||
    value.includes("\0") ||
    textEncoder.encode(value).byteLength > MAX_IDENTIFIER_UTF8_BYTES
  ) {
    return invalidInput(`${field} must be well-formed, non-empty, at most ${MAX_IDENTIFIER_UTF8_BYTES} UTF-8 bytes, and contain no NUL`);
  }
  return value;
}

function requireSafeNonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidInput(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireSafePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidInput(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireNonnegativeBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_SQLITE_INTEGER) {
    return invalidInput(`${field} must be a non-negative SQLite-range bigint`);
  }
  return value;
}

function requirePageLimit(value: unknown): number {
  const limit = requireSafePositiveInteger(value, "limit");
  if (limit > MAX_PAGE_SIZE) {
    return limitExceeded(`limit cannot exceed ${MAX_PAGE_SIZE}`);
  }
  return limit;
}

function requireCanonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !canonicalTimestampPattern.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    return invalidInput("committedAt must be a canonical UTC timestamp with millisecond precision");
  }
  return value;
}

type DataRecord = Record<PropertyKey, unknown>;

function requireDataRecord(value: unknown, field: string): DataRecord {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    return invalidInput(`${field} must be a non-proxy data object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidInput(`${field} must be a plain data object`);
  }
  return value as DataRecord;
}

function readOwnDataProperty(
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

function snapshotDenseArray(
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

interface ByteBudget {
  remaining: number;
}

function snapshotBytes(value: unknown, field: string, budget?: ByteBudget): Uint8Array {
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

function snapshotCommitInput(rawInput: CommitInput): SnapshotCommitInput {
  const input = requireDataRecord(rawInput, "commit input");
  const byteBudget: ByteBudget = { remaining: MAX_COMMIT_BYTES };
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

function updateLengthFramed(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length);
  hash.update(value);
}

function identifyCommandRequest(input: SnapshotCommitInput): string {
  const hash = createHash("sha256");
  updateLengthFramed(hash, textEncoder.encode(COMMAND_REQUEST_IDENTITY_VERSION));
  updateLengthFramed(hash, textEncoder.encode(input.aggregateId));
  const expectedVersion = Buffer.allocUnsafe(8);
  expectedVersion.writeBigUInt64BE(BigInt(input.expectedVersion));
  updateLengthFramed(hash, expectedVersion);
  updateLengthFramed(hash, input.commandBytes);
  return hash.digest("hex");
}

interface CommandEffectInput {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly committedAt: string;
  readonly currentVersion: number;
  readonly events: readonly EffectEventDraft[];
  readonly previousVersion: number;
  readonly requestSha256: string;
}

function updateUnsignedInteger(
  hash: ReturnType<typeof createHash>,
  value: number,
): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  updateLengthFramed(hash, encoded);
}

function updateUnsignedBigInteger(
  hash: ReturnType<typeof createHash>,
  value: bigint,
): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(value);
  updateLengthFramed(hash, encoded);
}

function updateString(hash: ReturnType<typeof createHash>, value: string): void {
  updateLengthFramed(hash, textEncoder.encode(value));
}

function identifyCommandEffects(input: CommandEffectInput): string {
  const hash = createHash("sha256");
  updateString(hash, COMMAND_EFFECT_IDENTITY_VERSION);
  updateString(hash, input.aggregateId);
  updateString(hash, input.commandId);
  updateString(hash, input.committedAt);
  updateString(hash, input.requestSha256);
  updateUnsignedInteger(hash, input.previousVersion);
  updateUnsignedInteger(hash, input.currentVersion);
  updateUnsignedInteger(hash, input.events.length);
  for (const event of input.events) {
    updateUnsignedInteger(hash, event.aggregateSequence);
    updateUnsignedInteger(hash, event.commandEventIndex);
    updateUnsignedBigInteger(hash, event.globalPosition);
    updateString(hash, event.eventId);
    updateString(hash, event.eventType);
    updateString(hash, EVENT_RECORD_VERSION);
    updateString(hash, OPAQUE_PAYLOAD_CODEC_VERSION);
    updateLengthFramed(hash, event.payload);
    updateLengthFramed(hash, event.metadata);
    updateUnsignedInteger(hash, event.outbox.length);
    for (const message of event.outbox) {
      updateUnsignedInteger(hash, message.eventOutboxIndex);
      updateUnsignedBigInteger(hash, message.outboxPosition);
      updateString(hash, message.messageId);
      updateString(hash, message.topic);
      updateLengthFramed(hash, message.payload);
      updateLengthFramed(hash, message.headers);
    }
  }
  return hash.digest("hex");
}

function requireRowString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new DurableStoreError("STORE_CORRUPT", `${column} is not text`);
  }
  return value;
}

function requireRowInteger(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DurableStoreError("STORE_CORRUPT", `${column} is not a safe integer`);
  }
  return value;
}

function requireStoredIntegerAtLeast(
  row: Record<string, unknown>,
  column: string,
  minimum: number,
): number {
  const value = requireRowInteger(row, column);
  if (value < minimum) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      `${column} is below its durable minimum ${minimum}`,
    );
  }
  return value;
}

function requireStoredTimestamp(row: Record<string, unknown>, column: string): string {
  const value = requireRowString(row, column);
  if (
    !canonicalTimestampPattern.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new DurableStoreError("STORE_CORRUPT", `${column} is not a canonical UTC timestamp`);
  }
  return value;
}

function requireStoredSha256(row: Record<string, unknown>, column: string): string {
  const value = requireRowString(row, column);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new DurableStoreError("STORE_CORRUPT", `${column} is not a lowercase SHA-256 digest`);
  }
  return value;
}

function requireStoredPositiveBigIntText(
  row: Record<string, unknown>,
  column: string,
): bigint {
  const value = requireRowString(row, column);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new DurableStoreError("STORE_CORRUPT", `${column} is not a positive integer cursor`);
  }
  return BigInt(value);
}

function requireInsertedPosition(
  result: { readonly lastInsertRowid: bigint | number },
  field: string,
): bigint {
  const value = result.lastInsertRowid;
  if (typeof value !== "bigint" || value <= 0n || value > MAX_SQLITE_INTEGER) {
    throw new DurableStoreError(
      "STORE_UNAVAILABLE",
      `SQLite did not return an exact positive ${field}`,
    );
  }
  return value;
}

function requireRowBytes(row: Record<string, unknown>, column: string): Uint8Array {
  try {
    return snapshotBytes(row[column], column);
  } catch (error) {
    if (error instanceof DurableStoreError) {
      throw new DurableStoreError("STORE_CORRUPT", `${column} is not a byte string`);
    }
    throw error;
  }
}

function toCommitResult(
  stored: StoredCommitResult,
  disposition: CommitResult["disposition"],
): CommitResult {
  return Object.freeze({
    aggregateId: stored.aggregateId,
    commandId: stored.commandId,
    currentVersion: stored.currentVersion,
    disposition,
    effectIdentityVersion: stored.effectIdentityVersion,
    effectSha256: stored.effectSha256,
    eventIds: Object.freeze([...stored.eventIds]),
    outboxMessageIds: Object.freeze([...stored.outboxMessageIds]),
    previousVersion: stored.previousVersion,
    requestSha256: stored.requestSha256,
  });
}

function readScalar(
  database: DatabaseSync,
  sql: string,
  column: string,
): string | number | bigint {
  const row = database.prepare(sql).get();
  const value = row?.[column];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`STORE_SCALAR_INVALID: ${column}`);
  }
  return value;
}

function synchronousMode(value: number): StoreHealth["synchronous"] {
  switch (value) {
    case 0:
      return "off";
    case 1:
      return "normal";
    case 2:
      return "full";
    case 3:
      return "extra";
    default:
      throw new DurableStoreError("STORE_CORRUPT", `unknown SQLite synchronous mode ${value}`);
  }
}

function isFreshDatabase(
  database: DatabaseSync,
  allowTransactionHeaderPage = false,
): boolean {
  const applicationId = Number(
    readScalar(database, "PRAGMA application_id", "application_id"),
  );
  const userVersion = Number(readScalar(database, "PRAGMA user_version", "user_version"));
  if (applicationId === SQLITE_APPLICATION_ID) {
    if (userVersion === 0) {
      throw new DurableStoreError(
        "DATABASE_IDENTITY_MISMATCH",
        "recognized Moe application ID has no committed schema version",
      );
    }
    return false;
  }
  if (applicationId !== 0 || userVersion !== 0) {
    throw new DurableStoreError(
      "DATABASE_IDENTITY_MISMATCH",
      `expected Moe application ID ${SQLITE_APPLICATION_ID}, found ${applicationId} with schema version ${userVersion}`,
    );
  }

  const schemaObjectCount = Number(
    readScalar(
      database,
      "SELECT count(*) AS value FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      "value",
    ),
  );
  const pageCount = Number(readScalar(database, "PRAGMA page_count", "page_count"));
  const maximumFreshPageCount = allowTransactionHeaderPage ? 1 : 0;
  if (schemaObjectCount !== 0 || pageCount > maximumFreshPageCount) {
    throw new DurableStoreError(
      "DATABASE_IDENTITY_MISMATCH",
      `refusing to adopt an unidentified non-empty database (${schemaObjectCount} schema objects, ${pageCount} pages)`,
    );
  }
  return true;
}

function normalizeSchemaSql(sql: string): string {
  return sql.trim().replace(/;\s*$/u, "");
}

function validateSchema(database: DatabaseSync): void {
  try {
    const expectedObjects = new Map<string, { readonly sql: string; readonly type: string }>();
    for (const [name, sql] of Object.entries(SCHEMA_OBJECT_SQL)) {
      expectedObjects.set(name, {
        sql: normalizeSchemaSql(sql),
        type:
          name === "outbox_pending_order" || name === "outbox_event_order"
            ? "index"
            : "table",
      });
    }

    const actualRows = database
      .prepare(`
        SELECT name, type, sql
        FROM sqlite_schema
        WHERE substr(name, 1, 7) <> 'sqlite_'
        ORDER BY name
      `)
      .all();
    if (actualRows.length !== expectedObjects.size) {
      throw new DurableStoreError(
        "STORE_SCHEMA_INVALID",
        `expected ${expectedObjects.size} application schema objects, found ${actualRows.length}`,
      );
    }
    for (const row of actualRows) {
      const name = requireRowString(row, "name");
      const expected = expectedObjects.get(name);
      const actualType = requireRowString(row, "type");
      const actualSql = requireRowString(row, "sql");
      if (
        expected === undefined ||
        actualType !== expected.type ||
        normalizeSchemaSql(actualSql) !== expected.sql
      ) {
        throw new DurableStoreError(
          "STORE_SCHEMA_INVALID",
          `schema object ${JSON.stringify(name)} does not match the version ${SCHEMA_VERSION} manifest`,
        );
      }
    }

    const metadataRows = database
      .prepare("SELECT key, value FROM store_metadata ORDER BY key")
      .all();
    if (
      metadataRows.length !== 1 ||
      requireRowString(metadataRows[0]!, "key") !== "schema_manifest_version" ||
      requireRowString(metadataRows[0]!, "value") !== SQLITE_SCHEMA_MANIFEST_VERSION
    ) {
      throw new DurableStoreError(
        "STORE_SCHEMA_INVALID",
        "schema manifest metadata is missing or unsupported",
      );
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new DurableStoreError(
        "STORE_SCHEMA_INVALID",
        "foreign-key verification found durable relationship violations",
      );
    }
    if (String(readScalar(database, "PRAGMA quick_check", "quick_check")) !== "ok") {
      throw new DurableStoreError("STORE_SCHEMA_INVALID", "SQLite quick_check did not pass");
    }

    const semanticRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM command_receipts AS receipts
        WHERE
          receipts.request_identity_version <> ?
          OR receipts.result_version <> ?
          OR receipts.effect_identity_version <> ?
          OR receipts.current_version - receipts.previous_version <> receipts.event_count
          OR NOT EXISTS (
            SELECT 1
            FROM aggregate_heads AS heads
            WHERE heads.aggregate_id = receipts.aggregate_id
              AND heads.version >= receipts.current_version
          )
          OR (
            SELECT count(*)
            FROM domain_events AS events
            WHERE events.command_id = receipts.command_id
          ) <> receipts.event_count
          OR EXISTS (
            SELECT 1
            FROM domain_events AS events
            WHERE events.command_id = receipts.command_id
              AND (
                events.aggregate_id <> receipts.aggregate_id
                OR events.aggregate_sequence <>
                  receipts.previous_version + events.command_event_index + 1
                OR events.command_event_index >= receipts.event_count
                OR events.record_version <> ?
                OR events.payload_codec_version <> ?
                OR events.request_sha256 <> receipts.request_sha256
                OR events.committed_at <> receipts.committed_at
              )
          )
          OR (
            SELECT count(*)
            FROM outbox_messages AS messages
            INNER JOIN domain_events AS events ON events.event_id = messages.event_id
            WHERE events.command_id = receipts.command_id
          ) <> receipts.outbox_count
      `)
      .get(
        COMMAND_REQUEST_IDENTITY_VERSION,
        RECEIPT_RESULT_VERSION,
        COMMAND_EFFECT_IDENTITY_VERSION,
        EVENT_RECORD_VERSION,
        OPAQUE_PAYLOAD_CODEC_VERSION,
      );
    if (requireRowInteger(semanticRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "durable command receipts do not match the authoritative event ledger",
      );
    }
    const aggregateRow = database
      .prepare(`
        SELECT count(*) AS violations
        FROM (
          SELECT heads.aggregate_id
          FROM aggregate_heads AS heads
          LEFT JOIN (
            SELECT
              aggregate_id,
              count(*) AS event_count,
              max(aggregate_sequence) AS maximum_sequence
            FROM domain_events
            GROUP BY aggregate_id
          ) AS ledger ON ledger.aggregate_id = heads.aggregate_id
          WHERE
            ledger.maximum_sequence IS NULL
            OR heads.version <> ledger.maximum_sequence
            OR ledger.event_count <> ledger.maximum_sequence

          UNION ALL

          SELECT ledger.aggregate_id
          FROM (
            SELECT
              aggregate_id,
              count(*) AS event_count,
              max(aggregate_sequence) AS maximum_sequence
            FROM domain_events
            GROUP BY aggregate_id
          ) AS ledger
          LEFT JOIN aggregate_heads AS heads ON heads.aggregate_id = ledger.aggregate_id
          WHERE heads.aggregate_id IS NULL
        )
      `)
      .get();
    if (requireRowInteger(aggregateRow ?? {}, "violations") !== 0) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        "aggregate heads do not exactly match the event ledger",
      );
    }
  } catch (error) {
    if (error instanceof DurableStoreError) {
      throw error;
    }
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      "unable to verify the application schema",
      { cause: error },
    );
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new Error(`SQLITE_VERSION_INVALID: ${value}`);
    }
    return value.split(".").map((part) => Number.parseInt(part, 10));
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function migrateLocked(database: DatabaseSync, freshDatabase: boolean): void {
  const currentVersion = Number(readScalar(database, "PRAGMA user_version", "user_version"));
  if (currentVersion > SCHEMA_VERSION) {
    throw new DurableStoreError(
      "STORE_SCHEMA_INVALID",
      `schema version ${currentVersion} is newer than supported version ${SCHEMA_VERSION}`,
    );
  }
  if (currentVersion === SCHEMA_VERSION) {
    return;
  }
  if (!freshDatabase) {
    throw new DurableStoreError(
      "DATABASE_IDENTITY_MISMATCH",
      `schema version ${currentVersion} is not a recognized migration source`,
    );
  }

  database.exec(`${Object.values(SCHEMA_OBJECT_SQL).join(";\n")};`);
  database
    .prepare("INSERT INTO store_metadata (key, value) VALUES (?, ?)")
    .run("schema_manifest_version", SQLITE_SCHEMA_MANIFEST_VERSION);
  database.exec(`
    PRAGMA application_id = ${SQLITE_APPLICATION_ID};
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  return (
    record.errcode === 5 ||
    record.errstr === "database is locked" ||
    (typeof record.message === "string" && record.message.includes("database is locked"))
  );
}

function bootstrapAndValidateSchema(
  database: DatabaseSync,
  freshDatabaseCandidate: boolean,
): void {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (isSqliteBusy(error)) {
      throw new DurableStoreError("STORE_BUSY", "database startup lock timed out", {
        cause: error,
      });
    }
    throw new DurableStoreError("STORE_UNAVAILABLE", "unable to acquire database startup lock", {
      cause: error,
    });
  }

  try {
    const freshDatabase = isFreshDatabase(database, freshDatabaseCandidate);
    migrateLocked(database, freshDatabase);
    validateSchema(database);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new DurableStoreError(
          "OUTCOME_UNKNOWN",
          "database bootstrap failed and rollback could not be confirmed",
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
    }
    throw error;
  }
}

export class SqliteEventStore {
  readonly #database: DatabaseSync;
  readonly #databasePath: string | null;
  readonly #durability: StoreHealth["durability"];
  #state: "CLOSED" | "OPEN" | "POISONED" = "OPEN";

  private constructor(
    database: DatabaseSync,
    databasePath: string | null,
    durability: StoreHealth["durability"],
  ) {
    this.#database = database;
    this.#databasePath = databasePath;
    this.#durability = durability;
  }

  public static open(path: string): SqliteEventStore {
    const databasePath = canonicalDatabasePath(path);
    return SqliteEventStore.#open(databasePath, databasePath, "WAL_FILE");
  }

  /** Test-only escape hatch. Production code must use {@link open}. */
  public static openEphemeralForTest(): SqliteEventStore {
    return SqliteEventStore.#open(":memory:", null, "EPHEMERAL_TEST");
  }

  static #open(
    sqlitePath: string,
    databasePath: string | null,
    durability: StoreHealth["durability"],
  ): SqliteEventStore {
    const freshDatabaseCandidate = isFreshDatabaseFileCandidate(databasePath);
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(sqlitePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      });
    } catch (error) {
      throw new DurableStoreError("STORE_UNAVAILABLE", "unable to open SQLite database", {
        cause: error,
      });
    }
    try {
      const sqliteVersion = String(
        readScalar(database, "SELECT sqlite_version() AS value", "value"),
      );
      if (compareVersions(sqliteVersion, MINIMUM_SQLITE_VERSION) < 0) {
        throw new Error(
          `SQLITE_VERSION_UNSUPPORTED: ${sqliteVersion} < ${MINIMUM_SQLITE_VERSION}`,
        );
      }
      database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA trusted_schema = OFF;
        PRAGMA recursive_triggers = OFF;
        PRAGMA wal_autocheckpoint = 1000;
      `);
      bootstrapAndValidateSchema(database, freshDatabaseCandidate);
      const requestedJournalMode = database.prepare("PRAGMA journal_mode = WAL").get();
      const journalMode = requireRowString(requestedJournalMode ?? {}, "journal_mode");
      const expectedJournalMode = durability === "WAL_FILE" ? "wal" : "memory";
      if (journalMode !== expectedJournalMode) {
        throw new DurableStoreError(
          "STORE_UNAVAILABLE",
          `SQLite returned journal mode ${JSON.stringify(journalMode)}, expected ${JSON.stringify(expectedJournalMode)}`,
        );
      }
      database.exec("PRAGMA synchronous = FULL;");
      if (
        Number(readScalar(database, "PRAGMA foreign_keys", "foreign_keys")) !== 1 ||
        Number(readScalar(database, "PRAGMA synchronous", "synchronous")) !== 2 ||
        Number(readScalar(database, "PRAGMA trusted_schema", "trusted_schema")) !== 0 ||
        Number(readScalar(database, "PRAGMA recursive_triggers", "recursive_triggers")) !== 0 ||
        Number(readScalar(database, "PRAGMA wal_autocheckpoint", "wal_autocheckpoint")) !== 1_000 ||
        Number(readScalar(database, "PRAGMA busy_timeout", "timeout")) !== 5_000
      ) {
        throw new DurableStoreError(
          "STORE_UNAVAILABLE",
          "SQLite connection safety settings could not be established",
        );
      }
      if (databasePath !== null) {
        const mainDatabase = database
          .prepare("PRAGMA database_list")
          .all()
          .find((row) => row.name === "main");
        const reportedPath =
          mainDatabase === undefined ? "" : requireRowString(mainDatabase, "file");
        if (reportedPath.length === 0 || realpathSync.native(reportedPath) !== databasePath) {
          throw new DurableStoreError(
            "STORE_UNAVAILABLE",
            "SQLite opened a different database path than requested",
          );
        }
      }
      database.enableDefensive(true);
      const store = new SqliteEventStore(database, databasePath, durability);
      store.#validateAllReceipts();
      return store;
    } catch (error) {
      database.close();
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw new DurableStoreError("STORE_UNAVAILABLE", "SQLite initialization failed", {
        cause: error,
      });
    }
  }

  public close(): void {
    if (this.#state === "CLOSED") {
      return;
    }
    if (this.#state === "OPEN") {
      this.#database.close();
    }
    this.#state = "CLOSED";
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  public commit(rawInput: CommitInput): CommitResult {
    this.#requireOpen();
    const input = snapshotCommitInput(rawInput);
    const requestSha256 = identifyCommandRequest(input);

    try {
      this.#database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw this.#normalizeOperationalError(error, "begin command transaction");
    }
    let commitAttempted = false;
    try {
      const receipt = this.#loadReceipt(input.commandId);
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
        this.#database.exec("COMMIT");
        return toCommitResult(receipt, "REPLAYED");
      }

      const previousVersion = this.#assertAggregateTail(input.aggregateId);
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
      const findEvent = this.#database.prepare(
        "SELECT 1 AS value FROM domain_events WHERE event_id = ?",
      );
      const findOutboxMessage = this.#database.prepare(
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

      const insertEvent = this.#database.prepare(`
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
      const insertOutbox = this.#database.prepare(`
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
      this.#database
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
      const effectUpdate = this.#database
        .prepare("UPDATE command_receipts SET effect_sha256 = ? WHERE command_id = ?")
        .run(effectSha256, input.commandId);
      if (effectUpdate.changes !== 1) {
        throw new DurableStoreError(
          "STORE_UNAVAILABLE",
          "SQLite did not finalize the command effect receipt",
        );
      }

      this.#database
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
      this.#database.exec("COMMIT");
      return toCommitResult(storedResult, "COMMITTED");
    } catch (error) {
      let rollbackError: unknown;
      if (this.#database.isTransaction) {
        try {
          this.#database.exec("ROLLBACK");
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
        }
      }
      if (commitAttempted || rollbackError !== undefined) {
        const causes = rollbackError === undefined ? [error] : [error, rollbackError];
        this.#poison();
        throw new DurableStoreError(
          "OUTCOME_UNKNOWN",
          "the command outcome could not be proven; reopen and reconcile its receipt",
          { cause: new AggregateError(causes) },
        );
      }
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw this.#normalizeOperationalError(error, "commit command effects");
    }
  }

  public getAggregateVersion(aggregateId: string): number {
    return this.#readOperation("read aggregate version", () =>
      this.#assertAggregateTail(requireIdentifier(aggregateId, "aggregateId")),
    );
  }

  public getCommandReceipt(commandId: string): CommandReceipt | null {
    return this.#readOperation("read command receipt", () => {
      const safeCommandId = requireIdentifier(commandId, "commandId");
      const receipt = this.#loadReceipt(safeCommandId);
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
    return this.#readOperation("read aggregate events", () => {
      const safeAggregateId = requireIdentifier(aggregateId, "aggregateId");
      const safeAfter = requireSafeNonnegativeInteger(
        afterAggregateSequence,
        "afterAggregateSequence",
      );
      const safeLimit = requirePageLimit(limit);
      const rows = this.#database
        .prepare(`
        SELECT
          CAST(global_position AS TEXT) AS global_position,
          aggregate_id,
          aggregate_sequence,
          command_id,
          record_version,
          payload_codec_version,
          request_sha256,
          event_id,
          event_type,
          payload,
          metadata,
          committed_at
        FROM domain_events
        WHERE aggregate_id = ? AND aggregate_sequence > ?
        ORDER BY aggregate_sequence
        LIMIT ?
        `)
        .all(safeAggregateId, safeAfter, safeLimit + 1);
      const hasMore = rows.length > safeLimit;
      const items = rows.slice(0, safeLimit).map((row) => this.#mapStoredEvent(row));
      return this.#page(
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
    return this.#readOperation("read global events", () => {
      const safeAfter = requireNonnegativeBigInt(
        afterGlobalPosition,
        "afterGlobalPosition",
      );
      const safeLimit = requirePageLimit(limit);
      const rows = this.#database
        .prepare(`
        SELECT
          CAST(global_position AS TEXT) AS global_position,
          aggregate_id,
          aggregate_sequence,
          command_id,
          record_version,
          payload_codec_version,
          request_sha256,
          event_id,
          event_type,
          payload,
          metadata,
          committed_at
        FROM domain_events
        WHERE global_position > ?
        ORDER BY domain_events.global_position
        LIMIT ?
        `)
        .all(safeAfter, safeLimit + 1);
      const hasMore = rows.length > safeLimit;
      const items = rows.slice(0, safeLimit).map((row) => this.#mapStoredEvent(row));
      return this.#page(
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
    return this.#readOperation("read pending outbox", () => {
      const safeAfter = requireNonnegativeBigInt(
        afterOutboxPosition,
        "afterOutboxPosition",
      );
      const safeLimit = requirePageLimit(limit);
      const rows = this.#database
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
      const items = rows.slice(0, safeLimit).map((row) => this.#mapOutboxMessage(row));
      return this.#page(
        items,
        hasMore,
        items.length === 0 ? null : items.at(-1)!.outboxPosition,
      );
    });
  }

  public getHealth(): StoreHealth {
    return this.#readOperation("read store health", () => Object.freeze({
      applicationId: Number(
        readScalar(this.#database, "PRAGMA application_id", "application_id"),
      ),
      busyTimeoutMilliseconds: Number(
        readScalar(this.#database, "PRAGMA busy_timeout", "timeout"),
      ),
      databasePath: this.#databasePath,
      durability: this.#durability,
      foreignKeys:
        Number(readScalar(this.#database, "PRAGMA foreign_keys", "foreign_keys")) === 1,
      foreignKeyViolations: this.#database.prepare("PRAGMA foreign_key_check").all().length,
      journalMode: String(
        readScalar(this.#database, "PRAGMA journal_mode", "journal_mode"),
      ),
      quickCheck: String(
        readScalar(this.#database, "PRAGMA quick_check", "quick_check"),
      ),
      recursiveTriggers:
        Number(
          readScalar(this.#database, "PRAGMA recursive_triggers", "recursive_triggers"),
        ) === 1,
      sqliteVersion: String(
        readScalar(this.#database, "SELECT sqlite_version() AS value", "value"),
      ),
      synchronous: synchronousMode(
        Number(readScalar(this.#database, "PRAGMA synchronous", "synchronous")),
      ),
      trustedSchema:
        Number(readScalar(this.#database, "PRAGMA trusted_schema", "trusted_schema")) === 1,
      userVersion: Number(
        readScalar(this.#database, "PRAGMA user_version", "user_version"),
      ),
      walAutocheckpointPages: Number(
        readScalar(this.#database, "PRAGMA wal_autocheckpoint", "wal_autocheckpoint"),
      ),
    }));
  }

  #mapStoredEvent(row: Record<string, unknown>): StoredEvent {
    return {
      aggregateId: requireRowString(row, "aggregate_id"),
      aggregateSequence: requireStoredIntegerAtLeast(row, "aggregate_sequence", 1),
      commandId: requireRowString(row, "command_id"),
      committedAt: requireStoredTimestamp(row, "committed_at"),
      eventId: requireRowString(row, "event_id"),
      eventType: requireRowString(row, "event_type"),
      globalPosition: requireStoredPositiveBigIntText(row, "global_position"),
      metadata: requireRowBytes(row, "metadata"),
      payloadCodecVersion: this.#requireStoredVersion(
        row,
        "payload_codec_version",
        OPAQUE_PAYLOAD_CODEC_VERSION,
      ),
      payload: requireRowBytes(row, "payload"),
      recordVersion: this.#requireStoredVersion(
        row,
        "record_version",
        EVENT_RECORD_VERSION,
      ),
      requestSha256: requireStoredSha256(row, "request_sha256"),
    };
  }

  #mapOutboxMessage(row: Record<string, unknown>): PendingOutboxMessage {
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

  #page<Item, Cursor>(
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

  #loadReceipt(commandId: string, validateAggregateTail = true): StoredReceipt | null {
    const row = this.#database
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
    this.#requireStoredVersion(
      row,
      "request_identity_version",
      COMMAND_REQUEST_IDENTITY_VERSION,
    );
    this.#requireStoredVersion(row, "result_version", RECEIPT_RESULT_VERSION);
    const effectIdentityVersion = this.#requireStoredVersion(
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

    const eventRows = this.#database
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
      this.#requireStoredVersion(eventRow, "record_version", EVENT_RECORD_VERSION);
      this.#requireStoredVersion(
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

    const outboxRows = this.#database.prepare(RECEIPT_OUTBOX_QUERY).all(commandId);
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
      const aggregateVersion = this.#assertAggregateTail(aggregateId);
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

  #validateAllReceipts(): void {
    const rows = this.#database
      .prepare("SELECT command_id FROM command_receipts ORDER BY command_id")
      .all();
    for (const row of rows) {
      const commandId = requireRowString(row, "command_id");
      if (this.#loadReceipt(commandId, false) === null) {
        throw new DurableStoreError(
          "STORE_CORRUPT",
          `command receipt ${JSON.stringify(commandId)} disappeared during startup validation`,
        );
      }
    }
  }

  #requireStoredVersion<const Version extends string>(
    row: Record<string, unknown>,
    column: string,
    expected: Version,
  ): Version {
    const actual = requireRowString(row, column);
    if (actual !== expected) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `${column} version ${JSON.stringify(actual)} is unsupported`,
      );
    }
    return expected;
  }

  #assertAggregateTail(aggregateId: string): number {
    const headRow = this.#database
      .prepare("SELECT version FROM aggregate_heads WHERE aggregate_id = ?")
      .get(aggregateId);
    const tailRow = this.#database
      .prepare(`
        SELECT aggregate_sequence
        FROM domain_events
        WHERE aggregate_id = ?
        ORDER BY aggregate_sequence DESC
        LIMIT 1
      `)
      .get(aggregateId);
    if (headRow === undefined) {
      if (tailRow === undefined) {
        return 0;
      }
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `aggregate ${JSON.stringify(aggregateId)} has events without a head`,
      );
    }
    const headVersion = requireStoredIntegerAtLeast(headRow, "version", 0);
    if (tailRow === undefined) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `aggregate ${JSON.stringify(aggregateId)} has a head without events`,
      );
    }
    const tailSequence = requireStoredIntegerAtLeast(tailRow, "aggregate_sequence", 1);
    if (headVersion !== tailSequence) {
      throw new DurableStoreError(
        "STORE_CORRUPT",
        `aggregate ${JSON.stringify(aggregateId)} head does not match its event tail`,
      );
    }
    return headVersion;
  }

  #requireOpen(): void {
    if (this.#state === "POISONED") {
      throw new DurableStoreError(
        "STORE_UNAVAILABLE",
        "the SQLite event store is quarantined after an uncertain transaction outcome",
      );
    }
    if (this.#state === "CLOSED") {
      throw new DurableStoreError("STORE_CLOSED", "the SQLite event store is closed");
    }
  }

  #readOperation<Result>(operation: string, read: () => Result): Result {
    this.#requireOpen();
    try {
      return read();
    } catch (error) {
      if (error instanceof DurableStoreError) {
        throw error;
      }
      throw this.#normalizeOperationalError(error, operation);
    }
  }

  #normalizeOperationalError(error: unknown, operation: string): DurableStoreError {
    if (isSqliteBusy(error)) {
      return new DurableStoreError("STORE_BUSY", `${operation} timed out waiting for SQLite`, {
        cause: error,
      });
    }
    return new DurableStoreError("STORE_UNAVAILABLE", `${operation} failed`, {
      cause: error,
    });
  }

  #poison(): void {
    try {
      this.#database.close();
    } catch {
      // The state remains poisoned even when SQLite cannot confirm close.
    }
    this.#state = "POISONED";
  }
}
