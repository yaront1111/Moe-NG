import { isProxy } from "node:util/types";

import type { DeliveryV2AppendContext } from "./contracts.js";

const MAX_ARRAY = 512;
const MAX_BYTES = 1_048_576;
const MAX_DEPTH = 20;
const MAX_NODES = 100_000;
const CONTEXT_KEYS = Object.freeze([
  "commandId", "correlationId", "decidedAt", "expectedVersion",
  "principalId", "projectId",
]);

function copy(value: unknown, depth: number, nodes: { value: number }): unknown {
  nodes.value += 1;
  if (depth > MAX_DEPTH || nodes.value > MAX_NODES) throw new TypeError("snapshot limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object" || isProxy(value)) throw new TypeError("snapshot type");
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY) {
      throw new TypeError("snapshot array");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string"
      || (key !== "length" && !/^(0|[1-9]\d*)$/u.test(key)))
      || keys.length !== value.length + 1) throw new TypeError("snapshot array keys");
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("snapshot array descriptor");
      }
      result.push(copy(descriptor.value, depth + 1, nodes));
    }
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("snapshot object");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value).sort()) {
    if (typeof key !== "string") throw new TypeError("snapshot symbol");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("snapshot descriptor");
    }
    Object.defineProperty(result, key, {
      configurable: false, enumerable: true,
      value: copy(descriptor.value, depth + 1, nodes), writable: false,
    });
  }
  return Object.freeze(result);
}

/** Rejects proxies/accessors and returns one detached immutable data snapshot. */
export function snapshotDeliveryV2PlainData<T>(value: T): T | undefined {
  try {
    const result = copy(value, 0, { value: 0 }) as T;
    return Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_BYTES ? result : undefined;
  } catch {
    return undefined;
  }
}

export function snapshotDeliveryV2AppendContext(
  value: DeliveryV2AppendContext,
): DeliveryV2AppendContext | undefined {
  const result = snapshotDeliveryV2PlainData(value) as DeliveryV2AppendContext | undefined;
  if (result === undefined || Object.keys(result).length !== CONTEXT_KEYS.length
    || !CONTEXT_KEYS.every((key) => Object.hasOwn(result, key))
    || ![result.commandId, result.correlationId, result.decidedAt,
      result.principalId, result.projectId].every((item) => typeof item === "string" && item !== "")
    || !Number.isSafeInteger(result.expectedVersion) || result.expectedVersion < 0) return undefined;
  return result;
}
