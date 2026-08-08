import { createHash } from "node:crypto";

export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function encodeNumber(value: number): string {
  if (Object.is(value, -0)) return '{"$number":"-0"}';
  if (Number.isNaN(value)) return '{"$number":"NaN"}';
  if (value === Number.POSITIVE_INFINITY) return '{"$number":"Infinity"}';
  if (value === Number.NEGATIVE_INFINITY) return '{"$number":"-Infinity"}';
  return String(value);
}

function encodeObject(value: object): string {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodeUnits);
  const fields = keys.map(
    (key) => `${JSON.stringify(key)}:${encodeCanonical(record[key])}`,
  );
  return `{${fields.join(",")}}`;
}

export function encodeCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  if (typeof value === "object") return encodeObject(value);
  throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(encodeCanonical(value), "utf8").digest("hex");
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value);
}
