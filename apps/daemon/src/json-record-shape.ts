import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

/**
 * Shape primitives shared by the daemon's durable record codecs (deploy, preview, release, landing,
 * publish and verifier receipts; provider-pause and seat-start records), by the command ingress
 * and payload accessors of the bootstrap, session and review surfaces, and by the read models
 * that fold decoded ledger state.
 *
 * TWO OBJECT CHECKS, ON PURPOSE. `isObject` is the codec's gate: `decodeBoundedJsonBytes` yields
 * null-prototype objects, so any other prototype means the value did not come from the bounded
 * decoder and is not trusted. `dataRecord` is a prototype-agnostic VIEW for state a trusted reader
 * already produced; it must never stand in for `isObject` on bytes read from disk or the wire.
 */

/** A decoded JSON object: not null, not an array, and carrying the decoder's null prototype. */
export function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}

/** A CLOSED roster: exactly these keys, in any order, and nothing else. */
export function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

/** A reference is a non-empty string. */
export function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The member at `key` when it is a reference, else null — absent, empty and non-string alike. */
export function payloadRef(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Stored bytes through the bounded decoder, with every refusal folded into null. A stored JSON
 * `null` answers the same null, so a caller that must tell the two apart cannot use this.
 */
export function decodeJsonOrNull(bytes: Uint8Array): JsonValue {
  const decoded = decodeBoundedJsonBytes(bytes);
  return decoded.ok ? decoded.value : null;
}

/** sha256 hex over the JSON text of `parts`: the derivation every stored record id relies on. */
export function hash(parts: readonly JsonValue[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

/** Freezes every own key (symbols and non-enumerables included); an already-frozen root is left as is. */
export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      freezeDeep((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** The value as a read-only record when it is a non-array object of any prototype, else null. */
export function dataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}
