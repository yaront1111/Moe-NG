import {
  MAX_DIAGNOSTIC_FIELD_CHARS, MAX_DIAGNOSTIC_FIELDS, MAX_DIAGNOSTIC_LINE_BYTES,
  isDiagnosticComponent, isDiagnosticEventCode,
} from "./diagnostic-record.js";
import type { DiagnosticFieldValue, DiagnosticRecord } from "./diagnostic-record.js";

/**
 * ONE RECORD TO ONE LINE, and the last fence before bytes reach a file.
 *
 * JSON Lines, because the two readers that matter are an operator with `grep` and a program with
 * `JSON.parse`, and one line per record serves both. Keys are emitted in a fixed order so two
 * runs of the same code produce byte-identical lines and a diff shows only what changed.
 *
 * REDACTION HAPPENS HERE, not at the call sites. A call site that has to remember to scrub is a
 * call site that will one day forget, and the value it forgets is a live credential on disk.
 * Two independent rules apply: a field whose NAME reads as a secret is replaced whatever it
 * holds, and every VALUE the host declared secret is replaced wherever it appears — including
 * inside a thrown message or a stack frame, which is how a token most often escapes.
 *
 * TOTAL. Every reduction is a shrink, never a refusal: a record that cannot be encoded whole is
 * encoded smaller, because a truncated line about a failure beats no line about it.
 */

export const DIAGNOSTIC_REDACTED = "[redacted]";

export interface DiagnosticEncodeOptions {
  /** Literal secret values to replace wherever they appear. Order-insensitive; longest wins. */
  readonly secrets?: readonly string[];
}

/** A field name reading as a secret. Word-ish, so `workItemId` and `tokenizer` stay apart. */
const SECRET_NAME
  = /(?:credential|secret|token(?!iz)|authorization|bearer|password|passphrase|api[-_]?key|cookie|signature|private[-_]?key)/iu;

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

/** Longest first so a secret contained inside a longer one cannot leave the longer one's tail. */
function ordered(secrets: readonly string[]): readonly string[] {
  return [...new Set(secrets.filter((secret) => secret !== ""))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function scrub(text: string, secrets: readonly string[]): string {
  return secrets.reduce((carry, secret) => carry.replaceAll(secret, DIAGNOSTIC_REDACTED), text);
}

function fieldValue(
  key: string, value: DiagnosticFieldValue, secrets: readonly string[],
): DiagnosticFieldValue {
  if (SECRET_NAME.test(key)) return DIAGNOSTIC_REDACTED;
  if (typeof value === "string") return scrub(clamp(value, MAX_DIAGNOSTIC_FIELD_CHARS), secrets);
  // A non-finite number is not JSON: `JSON.stringify` would emit `null` silently, so it is made
  // explicit here rather than discovered by a reader wondering which null this is.
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

interface Encodable {
  at: string;
  component: string;
  correlation?: string;
  event: string;
  fields?: Record<string, DiagnosticFieldValue>;
  level: string;
  /** Set when the event code or component slug does not match its shape. Never a refusal. */
  malformed?: true;
  thrown?: {
    causes?: readonly string[];
    code: string | null;
    message: string;
    name: string;
    stack?: string;
  };
  /** Set when a bound forced this line to shed content. */
  truncated?: true;
}

function buildEncodable(record: DiagnosticRecord, secrets: readonly string[]): Encodable {
  const out: Encodable = {
    at: record.at,
    component: record.component,
    event: record.event,
    level: record.level,
  };
  if (!isDiagnosticEventCode(record.event) || !isDiagnosticComponent(record.component)) {
    out.malformed = true;
  }
  if (record.correlation !== undefined) {
    out.correlation = scrub(clamp(record.correlation, MAX_DIAGNOSTIC_FIELD_CHARS), secrets);
  }
  if (record.fields !== undefined) {
    const kept: Record<string, DiagnosticFieldValue> = {};
    // Sorted then bounded, so WHICH fields survive is deterministic rather than insertion-ordered.
    const names = Object.keys(record.fields).sort();
    if (names.length > MAX_DIAGNOSTIC_FIELDS) out.truncated = true;
    for (const name of names.slice(0, MAX_DIAGNOSTIC_FIELDS)) {
      kept[name] = fieldValue(name, record.fields[name] as DiagnosticFieldValue, secrets);
    }
    out.fields = kept;
  }
  if (record.thrown !== undefined) {
    const thrown = record.thrown;
    out.thrown = {
      code: thrown.code === null ? null : scrub(thrown.code, secrets),
      message: scrub(thrown.message, secrets),
      name: thrown.name,
      ...(thrown.stack === null ? {} : { stack: scrub(thrown.stack, secrets) }),
      ...(thrown.causes.length === 0
        ? {}
        : { causes: thrown.causes.map((cause) => scrub(cause, secrets)) }),
    };
  }
  return out;
}

/** The reduction ladder: each rung sheds the largest thing that is not the record's identity. */
function shrink(out: Encodable): boolean {
  if (out.thrown?.stack !== undefined) {
    delete out.thrown.stack;
    out.truncated = true;
    return true;
  }
  if (out.thrown?.causes !== undefined) {
    delete out.thrown.causes;
    out.truncated = true;
    return true;
  }
  if (out.fields !== undefined) {
    delete out.fields;
    out.truncated = true;
    return true;
  }
  if (out.thrown !== undefined) {
    out.thrown = { code: out.thrown.code, message: "", name: out.thrown.name };
    out.truncated = true;
    return true;
  }
  return false;
}

export function encodeDiagnosticLine(
  record: DiagnosticRecord, options: DiagnosticEncodeOptions = {},
): string {
  const secrets = ordered(options.secrets ?? []);
  const out = buildEncodable(record, secrets);
  for (;;) {
    // `JSON.stringify` escapes every control character, so no encoded line can carry a literal
    // newline — a record cannot forge a second record out of a field an attacker controls.
    const line = `${JSON.stringify(out)}\n`;
    if (Buffer.byteLength(line, "utf8") <= MAX_DIAGNOSTIC_LINE_BYTES) return line;
    if (!shrink(out)) {
      // The identity alone still exceeds the bound: emit the smallest honest record there is.
      return `${JSON.stringify({
        at: clamp(out.at, 64), component: clamp(out.component, 64), event: clamp(out.event, 128),
        level: out.level, truncated: true,
      })}\n`;
    }
  }
}
