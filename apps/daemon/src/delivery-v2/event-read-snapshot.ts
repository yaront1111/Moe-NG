import { types } from "node:util";

import { MAX_BLOB_BYTES, type StoredEvent } from "@moe/store";

const PAGE_KEYS = Object.freeze(["hasMore", "items", "nextCursor"]);
const EVENT_KEYS = Object.freeze([
  "aggregateId", "aggregateSequence", "commandId", "committedAt", "decisionTrace",
  "domainSchemaVersion", "eventId", "eventType", "globalPosition", "metadata",
  "payload", "payloadCodecVersion", "recordVersion", "requestSha256",
]);
const TRACE_KEYS = Object.freeze([
  "commandId", "commandKind", "principalId", "projectId",
  "requestIdentityVersion", "requestSha256",
]);
const EVENT_STRING_KEYS = Object.freeze([
  "aggregateId", "commandId", "committedAt", "domainSchemaVersion", "eventId",
  "eventType", "payloadCodecVersion", "recordVersion", "requestSha256",
]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "byteLength",
)?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, "byteOffset",
)?.get;

type CapturedEvent = StoredEvent & Readonly<{
  readonly decisionTrace: NonNullable<StoredEvent["decisionTrace"]>;
}>;

export type DeliveryV2SingleEventPageCapture =
  | Readonly<{ readonly kind: "ABSENT" }>
  | Readonly<{ readonly event: CapturedEvent; readonly kind: "EVENT" }>
  | Readonly<{ readonly kind: "UNREADABLE" }>;

const ABSENT = Object.freeze({ kind: "ABSENT" as const });
const UNREADABLE = Object.freeze({ kind: "UNREADABLE" as const });

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || types.isProxy(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some((key) => typeof key !== "string")
      || !keys.every((key) => own.includes(key))) return undefined;
    const captured: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function exactArray(value: unknown): readonly unknown[] | undefined {
  try {
    if (value === null || typeof value !== "object" || types.isProxy(value)
      || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
      || lengthDescriptor.value > 1) return undefined;
    const length = lengthDescriptor.value as number;
    const own = Reflect.ownKeys(value);
    if (own.length !== length + 1 || !own.includes("length")) return undefined;
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!own.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return undefined;
      }
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function detachedBytes(value: unknown): Uint8Array | undefined {
  try {
    if (value === null || typeof value !== "object" || types.isProxy(value)
      || !types.isUint8Array(value) || typedArrayBuffer === undefined
      || typedArrayByteLength === undefined || typedArrayByteOffset === undefined) return undefined;
    const buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike;
    const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    const byteOffset = Reflect.apply(typedArrayByteOffset, value, []) as number;
    if (types.isSharedArrayBuffer(buffer) || byteLength > MAX_BLOB_BYTES) return undefined;
    const captured = new Uint8Array(byteLength);
    captured.set(new Uint8Array(buffer, byteOffset, byteLength));
    return captured;
  } catch {
    return undefined;
  }
}

function captureEvent(value: unknown): CapturedEvent | undefined {
  const event = exactRecord(value, EVENT_KEYS);
  const trace = event === undefined ? undefined : exactRecord(event["decisionTrace"], TRACE_KEYS);
  const aggregateSequence = event?.["aggregateSequence"];
  const globalPosition = event?.["globalPosition"];
  if (event === undefined || trace === undefined
    || !EVENT_STRING_KEYS.every((key) => typeof event[key] === "string")
    || !TRACE_KEYS.every((key) => typeof trace[key] === "string")
    || typeof aggregateSequence !== "number" || !Number.isSafeInteger(aggregateSequence)
    || aggregateSequence < 1 || typeof globalPosition !== "bigint" || globalPosition < 1n) {
    return undefined;
  }
  const metadata = detachedBytes(event["metadata"]);
  const payload = detachedBytes(event["payload"]);
  if (metadata === undefined || payload === undefined) return undefined;
  return Object.freeze({
    ...event,
    aggregateSequence,
    decisionTrace: trace,
    globalPosition,
    metadata,
    payload,
  }) as CapturedEvent;
}

/** Captures exactly one aggregate-event page without executing caller-controlled code. */
export function captureDeliveryV2SingleEventPage(
  value: unknown,
): DeliveryV2SingleEventPageCapture {
  const page = exactRecord(value, PAGE_KEYS);
  const items = page === undefined ? undefined : exactArray(page["items"]);
  const hasMore = page?.["hasMore"];
  const nextCursor = page?.["nextCursor"];
  if (page === undefined || items === undefined || typeof hasMore !== "boolean"
    || (nextCursor !== null && (typeof nextCursor !== "number"
      || !Number.isSafeInteger(nextCursor) || nextCursor < 0))
    || hasMore || items.length > 1) return UNREADABLE;
  if (items.length === 0) return nextCursor === null ? ABSENT : UNREADABLE;
  const event = captureEvent(items[0]);
  return event !== undefined && nextCursor === event.aggregateSequence
    ? Object.freeze({ event, kind: "EVENT" as const })
    : UNREADABLE;
}
