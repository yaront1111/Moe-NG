import { types } from "node:util";

const encoder = new TextEncoder();
const stringIsWellFormed = String.prototype.isWellFormed;
/** Identifiers are printable ASCII with no space, so a hostile value can never be
 *  whitespace-padded, control-bearing, or Unicode-confusable with another session.
 *  Both scans walk UTF-16 code units directly: no regex, no iterator, no escape drift. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point < 0x20 || point === 0x7f) return true;
  }
  return false;
}

function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if (point < 0x21 || point > 0x7e) return false;
  }
  return true;
}

export interface PropertyRead {
  readonly ok: boolean; readonly present: boolean; readonly value: unknown;
}
const ABSENT: PropertyRead = Object.freeze({ ok: true, present: false, value: undefined });
const REJECTED: PropertyRead = Object.freeze({ ok: false, present: false, value: undefined });

/**
 * True only for an ordinary data object: not a proxy, not an array, not a class instance,
 * and not an object carrying an exotic prototype.
 */
export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Reads one own DATA property. Accessors are rejected, never invoked. */
export function readOwnDataProperty(value: object, key: string): PropertyRead {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return ABSENT;
  if (!("value" in descriptor)) return REJECTED;
  return Object.freeze({ ok: true, present: true, value: descriptor.value });
}

/** True when the record's own keys are exactly `expected` — no extras, no missing, no
 *  symbol keys. Prototype-carried and inherited names cannot satisfy it. */
export function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const own = Object.getOwnPropertyNames(value);
  if (own.length !== expected.length) return false;
  const wanted = new Set(expected);
  for (const key of own) {
    if (!wanted.delete(key)) return false;
  }
  return wanted.size === 0;
}

export function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Snapshots an array by index through {@link readOwnDataProperty}, so a subclassed array,
 * an overridden `Symbol.iterator`, an accessor element, or a sparse hole cannot smuggle a
 * value past the length bound. Never invokes the iterator.
 */
export type ListRead =
  | { readonly ok: false; readonly tooLong: boolean }
  | { readonly ok: true; readonly value: readonly unknown[] };

const MALFORMED_LIST: ListRead = Object.freeze({ ok: false, tooLong: false });
const OVERLONG_LIST: ListRead = Object.freeze({ ok: false, tooLong: true });

export function readBoundedList(value: unknown, maximum: number): ListRead {
  if (!Array.isArray(value) || types.isProxy(value)) return MALFORMED_LIST;
  if (Object.getPrototypeOf(value) !== Array.prototype) return MALFORMED_LIST;
  const length = readOwnDataProperty(value, "length");
  if (!length.ok || !length.present || !isSafeCount(length.value)) return MALFORMED_LIST;
  if (length.value > maximum) return OVERLONG_LIST;
  const out: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const entry = readOwnDataProperty(value, String(index));
    if (!entry.ok || !entry.present) return MALFORMED_LIST;
    out.push(entry.value);
  }
  return Object.freeze({ ok: true as const, value: Object.freeze(out) });
}

export function readList(value: unknown, maximum: number): readonly unknown[] | null {
  const read = readBoundedList(value, maximum);
  return read.ok ? read.value : null;
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Well-formed, control-free text within an exact UTF-8 byte budget. */
export function isBoundedText(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const wellFormed = Reflect.apply(stringIsWellFormed, value, []) as boolean;
  if (!wellFormed || hasControlCharacter(value)) return false;
  return utf8ByteLength(value) <= maximumBytes;
}

/** Bounded text further restricted to printable ASCII with no space. */
export function isIdentifier(value: unknown, maximumBytes: number): value is string {
  return isBoundedText(value, maximumBytes) && isPrintableAscii(value);
}

export function textBytes(value: string): Uint8Array {
  return encoder.encode(value);
}
