import { DEAD_END_KINDS } from "@moe/context";
import type { DeadEndJournalEntry } from "@moe/context";

import type { JournalCode } from "./journal-contracts.js";

/**
 * THE STRICT ENTRY DECODER, and it is the fence rather than defence in depth.
 *
 * `createDeadEndJournal` performs NO shape validation: `cloneEntry` SPREADS the
 * caller's entry, so an extra key would survive into the journal AND into its
 * digest, and `clonePredicate` returns `undefined` for a predicate kind it does
 * not know, on which `canonicalSha256` THROWS `Unsupported canonical value type`.
 * An unvalidated entry therefore CRASHES the command instead of refusing it, and
 * a crash is not a refusal. Nothing reaches @moe/context until it has passed
 * through here, and what reaches it is a FRESH plain object this module built.
 *
 * The kinds and the predicate variants are read off @moe/context's own exported
 * members and its published `FactPredicate`; retyping either locally would let
 * the two drift while every test stayed green.
 */

const MAX_TEXT = 64 * 1024;
const MAX_NAME = 512;
const MAX_ENTRIES = 4_096;
const HEX64 = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const ENTRY_KEYS = Object.freeze([
  "actorId", "baseDigest", "environmentDigest", "failureCode", "id", "kind", "occurredAt",
  "primaryScope", "recipeDigest", "retryPredicate", "text",
] as const);

/** Exactly the key set each `FactPredicate` variant declares in
 *  packages/context/src/context-contract.ts:44. Never retyped as a local union:
 *  the kinds and operators are read off @moe/context's own exported members. */
const PREDICATE_KEYS = Object.freeze({
  FACT_DIGEST: ["expectedDigest", "factId", "kind", "operator"],
  FACT_VALUE: ["expectedValue", "factId", "kind", "operator"],
  FACT_VERSION: ["expectedVersion", "factId", "kind", "operator"],
} as const);

const PREDICATE_OPERATORS = Object.freeze({
  FACT_DIGEST: ["EQUALS", "NOT_EQUALS"],
  FACT_VALUE: ["EQUALS", "NOT_EQUALS"],
  FACT_VERSION: ["EQUALS", "GREATER_THAN"],
} as const);

/** Own DATA properties only, and nothing inherited, non-enumerable or symbol
 *  keyed. An accessor or a revoked proxy answers `null` rather than throwing.
 *
 *  BOTH PROTOTYPES ARE ADMITTED, and only these two. A caller's entry arrives as
 *  an ordinary object literal, while an entry read back out of durable bytes
 *  arrives NULL-PROTOTYPED — `parseBoundedJsonText` builds every object with
 *  `Object.create(null)` (packages/contracts/src/bounded-json-parser.ts:87), so
 *  demanding `Object.prototype` would make this decoder unable to read its own
 *  output and the reader would refuse every row it had just written. */
function ownData(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== allowed.length) return null;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return out;
  } catch { return null; }
}

/** NFC-normalised by rule, not by rewrite: two spellings of the same text would
 *  otherwise produce two different journal digests for the same journal. */
const bounded = (value: unknown, maximum: number, minimum = 1): value is string =>
  typeof value === "string" && value.length >= minimum && value.length <= maximum
    && value.normalize("NFC") === value;

const hex64 = (value: unknown): value is string =>
  typeof value === "string" && HEX64.test(value);

/** `-0` is rejected outright: it compares equal to `0`, canonicalises to `0`, and
 *  so is a value two entries can differ by while hashing identically. */
const safeCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && !Object.is(value, -0);

function predicateOf(value: unknown): Record<string, unknown> | null {
  const kind = peekKind(value);
  if (kind === null) return null;
  const keys = PREDICATE_KEYS[kind];
  const record = ownData(value, keys);
  if (record === null || record["kind"] !== kind) return null;
  if (!bounded(record["factId"], MAX_NAME)) return null;
  const operators: readonly string[] = PREDICATE_OPERATORS[kind];
  if (typeof record["operator"] !== "string" || !operators.includes(record["operator"])) {
    return null;
  }
  if (kind === "FACT_DIGEST" && !hex64(record["expectedDigest"])) return null;
  if (kind === "FACT_VERSION" && !safeCount(record["expectedVersion"])) return null;
  if (kind === "FACT_VALUE" && !expectedValue(record["expectedValue"])) return null;
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

function peekKind(value: unknown): keyof typeof PREDICATE_KEYS | null {
  try {
    if (value === null || typeof value !== "object") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    if (descriptor === undefined || !("value" in descriptor)) return null;
    const kind = descriptor.value as string;
    return kind in PREDICATE_KEYS ? kind as keyof typeof PREDICATE_KEYS : null;
  } catch { return null; }
}

const expectedValue = (value: unknown): boolean =>
  value === null || typeof value === "boolean" || bounded(value, MAX_TEXT, 0)
    || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0));

/** One entry, rebuilt as a fresh plain object. The value handed to
 *  `createDeadEndJournal` is never the caller's own object, so its spread cannot
 *  carry a key, an accessor or a prototype this decoder did not admit. */
export function decodeJournalEntry(value: unknown): DeadEndJournalEntry | null {
  const record = ownData(value, ENTRY_KEYS);
  if (record === null) return null;
  const kind = record["kind"];
  if (typeof kind !== "string" || !DEAD_END_KINDS.includes(kind as never)) return null;
  const occurredAt = record["occurredAt"];
  if (typeof occurredAt !== "string" || !ISO_INSTANT.test(occurredAt)
    || Number.isNaN(Date.parse(occurredAt))) return null;
  if (!bounded(record["id"], MAX_NAME) || !bounded(record["actorId"], MAX_NAME)
    || !bounded(record["failureCode"], MAX_NAME) || !bounded(record["primaryScope"], MAX_NAME)
    || !bounded(record["text"], MAX_TEXT, 0)) return null;
  if (!hex64(record["recipeDigest"]) || !hex64(record["baseDigest"])
    || !hex64(record["environmentDigest"])) return null;
  const retryPredicate = predicateOf(record["retryPredicate"]);
  if (retryPredicate === null) return null;
  return {
    actorId: record["actorId"], baseDigest: record["baseDigest"],
    environmentDigest: record["environmentDigest"], failureCode: record["failureCode"],
    id: record["id"], kind, occurredAt, primaryScope: record["primaryScope"],
    recipeDigest: record["recipeDigest"], retryPredicate, text: record["text"],
  } as DeadEndJournalEntry;
}

export type JournalEntryDecode =
  | { readonly code: JournalCode; readonly ok: false }
  | { readonly entries: readonly DeadEndJournalEntry[]; readonly ok: true };

/**
 * The caller's `entries`, admitted one at a time. NO entry-count or text-length
 * bound is applied here beyond the hostile-input ceilings: those two limits
 * belong to `createDeadEndJournal`, which refuses them under its OWN
 * `JOURNAL_LIMIT_REACHED` / `DEAD_END_JOURNAL` pair naming which bound was hit.
 * A cap here would answer first and hide that layer entirely.
 */
export function decodeJournalEntries(value: unknown): JournalEntryDecode {
  const malformed = { code: "JOURNAL_ENTRY_MALFORMED", ok: false } as const;
  let items: readonly unknown[];
  try {
    if (!Array.isArray(value)) return malformed;
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) return malformed;
    const read: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor)) return malformed;
      read.push(descriptor.value);
    }
    items = read;
  } catch { return malformed; }
  if (items.length === 0) return { code: "JOURNAL_ENTRY_LIST_EMPTY", ok: false };
  if (items.length > MAX_ENTRIES) return malformed;
  const entries: DeadEndJournalEntry[] = [];
  for (const item of items) {
    const decoded = decodeJournalEntry(item);
    if (decoded === null) return malformed;
    entries.push(decoded);
  }
  return { entries: Object.freeze(entries), ok: true };
}
