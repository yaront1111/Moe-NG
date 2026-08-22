/**
 * Canonical bytes for the durable budget ledger.
 *
 * A version line, a digest line, then one deterministic canonical JSON body. The digest is
 * verified BEFORE the body is parsed, so drifted bytes refuse as a mismatch rather than being
 * half-interpreted, and the parsed record is RE-ENCODED and required to reproduce the input byte
 * for byte — which is what closes duplicate keys, key-order smuggling and whitespace padding in
 * one check, since `JSON.parse` silently keeps the last of two identical keys.
 *
 * The body carries no raw newline: `JSON.stringify` escapes every control character inside a
 * string, so splitting the frame on the first two newlines is unambiguous.
 *
 * WHAT IS VALIDATED HERE is only what this module reasons about — the literals it pins, the
 * counts it compares, the identity fields the reader cross-checks. The remaining producer-owned
 * content is preserved verbatim under the digest; re-declaring `@moe/scheduler`'s validators
 * here would create a second authority that can disagree with the first.
 */

import { createHash } from "node:crypto";

import {
  BUDGET_LEDGER_RECORD_KEYS,
  BUDGET_LEDGER_RECORD_VERSION,
  BUDGET_TRANSITIONS,
  budgetLedgerRefusal,
} from "./budget-ledger-contracts.js";
import type { BudgetLedgerRecord, BudgetLedgerRefusal } from "./budget-ledger-contracts.js";

const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_RECORD_BYTES = 4_194_304;
const encoder = new TextEncoder();
/** Fatal: mis-framed bytes must refuse, never become U+FFFD. */
const decoder = new TextDecoder("utf-8", { fatal: true });

export type BudgetEncodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly digest: string; readonly record: BudgetLedgerRecord }
  | BudgetLedgerRefusal;

export type BudgetDecodeResult =
  | { readonly ok: true; readonly record: BudgetLedgerRecord }
  | BudgetLedgerRefusal;

export function budgetLedgerDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Deterministic serialisation: object keys sorted, so two callers holding the same record
 * produce identical bytes regardless of how their objects were built. Arrays keep their order,
 * which is data. Exported because every byte-identity claim in this family — replay, projection
 * stability, successor equality — has to be made against ONE canonicaliser.
 */
export function canonicalBudgetJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBudgetJson).join(",")}]`;
  if (isPlainObject(value)) {
    const entries = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalBudgetJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hasExactKeys(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== BUDGET_LEDGER_RECORD_KEYS.length) return false;
  return keys.every((key) => (BUDGET_LEDGER_RECORD_KEYS as readonly string[]).includes(key));
}

/**
 * The pruned-evidence summary is this codec's OWN literal to pin: exactly two
 * keys per row, a meter that names something, a count that could have been
 * counted, and strict ascending meter order — sorted rows are what make two
 * writers reaching the same fold byte-identical, and a duplicate meter would
 * let one meter's count be stated twice and read once.
 */
function validSettledMeters(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  let previous = "";
  for (const entry of value) {
    if (!isPlainObject(entry)) return false;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !("measuredLineCount" in entry) || !("meter" in entry)) return false;
    const meter = entry["meter"];
    if (typeof meter !== "string" || meter.length === 0) return false;
    if (!isCount(entry["measuredLineCount"])) return false;
    if (previous !== "" && meter <= previous) return false;
    previous = meter;
  }
  return true;
}

function validate(value: Record<string, unknown>): BudgetLedgerRecord | "VERSION" | "FIELD" {
  if (value["recordVersion"] !== BUDGET_LEDGER_RECORD_VERSION) return "VERSION";
  if (!(BUDGET_TRANSITIONS as readonly string[]).includes(value["transition"] as string)) return "FIELD";
  if (!isCount(value["sequence"])) return "FIELD";
  const digest = value["requestDigest"];
  if (typeof digest !== "string" || !HEX64.test(digest)) return "FIELD";
  const lists = ["accounts", "appended", "reservations", "settlements", "views"];
  if (!lists.every((key) => Array.isArray(value[key]))) return "FIELD";
  if (!validSettledMeters(value["settledMeters"])) return "FIELD";
  if (!isPlainObject(value["authorization"]) || !isPlainObject(value["binding"])) return "FIELD";
  const binding = value["binding"] as Record<string, unknown>;
  const refs = ["budgetAccountRef", "goalRef", "graphRevisionRef", "ownerRef", "projectId"];
  if (!refs.every((key) => typeof binding[key] === "string" && (binding[key] as string).length > 0)) {
    return "FIELD";
  }
  if (!isCount(binding["graphEpoch"])) return "FIELD";
  return value as unknown as BudgetLedgerRecord;
}

/**
 * Serialised in ONE fixed field order taken from the frozen key list, never from the caller's
 * key order, then sealed with a digest over the body.
 */
export function encodeBudgetLedgerRecord(value: unknown): BudgetEncodeResult {
  if (!hasExactKeys(value)) return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_RECORD_MALFORMED");
  const validated = validate(value);
  if (validated === "VERSION") return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_VERSION_UNSUPPORTED");
  if (validated === "FIELD") return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_RECORD_MALFORMED");
  const body = canonicalBudgetJson(validated);
  const digest = budgetLedgerDigest(encoder.encode(body));
  const bytes = encoder.encode(`${BUDGET_LEDGER_RECORD_VERSION}\n${digest}\n${body}`);
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    // Its OWN code, not MALFORMED: a record past the frame cap is well-formed and exhausted.
    // MALFORMED tells a caller to fix the bytes; nothing about these bytes can be fixed.
    return budgetLedgerRefusal("REFUSED", "BUDGET_LEDGER_RECORD_TOO_LARGE");
  }
  return Object.freeze({ bytes, digest, ok: true as const, record: deepFreeze(validated) });
}

interface Frame {
  readonly body: string;
  readonly digest: string;
  readonly version: string;
}

function splitFrame(text: string): Frame | null {
  const first = text.indexOf("\n");
  if (first < 0) return null;
  const second = text.indexOf("\n", first + 1);
  if (second < 0) return null;
  return {
    body: text.slice(second + 1),
    digest: text.slice(first + 1, second),
    version: text.slice(0, first),
  };
}

/**
 * A bounded exact-shape decode, never a cast and never a repair. Digest first, framing second,
 * then a re-encode that must reproduce the body exactly.
 */
export function decodeBudgetLedgerRecord(bytes: unknown): BudgetDecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_RECORD_BYTES) {
    return budgetLedgerRefusal("UNKNOWN", "BUDGET_LEDGER_BYTES_MALFORMED");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return budgetLedgerRefusal("UNKNOWN", "BUDGET_LEDGER_BYTES_MALFORMED");
  }
  const frame = splitFrame(text);
  if (frame === null || !HEX64.test(frame.digest) || frame.body.length === 0) {
    return budgetLedgerRefusal("UNKNOWN", "BUDGET_LEDGER_BYTES_MALFORMED");
  }
  if (budgetLedgerDigest(encoder.encode(frame.body)) !== frame.digest) {
    return budgetLedgerRefusal("UNKNOWN", "BUDGET_LEDGER_DIGEST_MISMATCH");
  }
  if (frame.version !== BUDGET_LEDGER_RECORD_VERSION) {
    return budgetLedgerRefusal("UNKNOWN", "BUDGET_LEDGER_VERSION_UNSUPPORTED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.body) as unknown;
  } catch {
    return budgetLedgerRefusal("UNKNOWN", "BUDGET_LEDGER_BYTES_MALFORMED");
  }
  const reencoded = encodeBudgetLedgerRecord(parsed);
  if (!reencoded.ok) {
    return budgetLedgerRefusal(
      "UNKNOWN",
      reencoded.code === "BUDGET_LEDGER_VERSION_UNSUPPORTED"
        ? "BUDGET_LEDGER_VERSION_UNSUPPORTED"
        : "BUDGET_LEDGER_RECORD_MALFORMED",
    );
  }
  if (reencoded.digest !== frame.digest) {
    return budgetLedgerRefusal("UNKNOWN", "BUDGET_LEDGER_RECORD_MALFORMED");
  }
  return Object.freeze({ ok: true as const, record: reencoded.record });
}
