/**
 * The daemon-wire primitives the live read and command clients share, once kept as a verbatim
 * private copy in every client. One home keeps their refusals identical: a frame one reader
 * refuses is refused by every reader.
 *
 * NOTHING HERE IMPORTS AND NOTHING HERE READS THE NETWORK. The daemon's agent wrapper loads
 * live-board-feed.ts and live-command-dispatch.ts under plain Node, which resolves `.js`
 * specifiers literally, so this module sits behind its `.js` bridge and must load on its own.
 */

/** A non-null, non-array object. Prototype and key set are not checked: exactDataRecord does that. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An own-enumerable EXACT-key snapshot: the value must be a plain object whose key set is
 * precisely `expectedKeys`, every one an own, enumerable data property. Anything else - a
 * prototype, an array, a symbol, a missing or extra key, an accessor, a proxy trap that throws -
 * returns null, so the caller never reads a field this reader has not vouched for. The snapshot
 * is a frozen null-prototype copy, and an accessor is refused without ever being called.
 */
export function exactDataRecord(
  value: unknown, expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) return null;
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/** Maps every item into a frozen list, or returns null the moment one item fails its guard. */
export function listOf<T>(value: unknown, itemOf: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const raw of value) {
    const item = itemOf(raw);
    if (item === null) return null;
    items.push(item);
  }
  return Object.freeze(items);
}

/** The lower-case hex SHA-256 of `text`'s UTF-8 bytes: the digest a command request carries. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
