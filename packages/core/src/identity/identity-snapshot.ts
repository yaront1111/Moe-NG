/** Hostile-safe snapshots shared by the identity trust boundary. */

function dataValue(value: object, key: PropertyKey, enumerable: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || descriptor.enumerable !== enumerable
    || !("value" in descriptor)
  ) {
    throw new TypeError("identity input property is not exact data");
  }
  return descriptor.value;
}

export function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const actual = Reflect.ownKeys(value);
    if (
      actual.length !== keys.length
      || !actual.every((key) => typeof key === "string" && keys.includes(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) snapshot[key] = dataValue(value, key, true);
    return snapshot;
  } catch {
    return null;
  }
}

export function snapshotExactArray(value: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = dataValue(value, "length", false);
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return null;
    const actual = Reflect.ownKeys(value);
    if (actual.length !== length + 1 || actual.at(-1) !== "length") return null;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (actual[index] !== String(index)) return null;
      snapshot.push(dataValue(value, String(index), true));
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}
