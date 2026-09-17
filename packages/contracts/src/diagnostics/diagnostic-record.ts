import type { DiagnosticLevel } from "./diagnostic-level.js";

/**
 * ONE DIAGNOSTIC RECORD: what a moe-next process says about something that happened inside it.
 *
 * This is an OBSERVATION and nothing else. A record carries no authority, is never read back to
 * make a decision, and its absence proves nothing — the durable ledgers remain the only source
 * of truth. That separation is deliberate: the moment a diagnostic is load-bearing, dropping one
 * under back-pressure becomes a correctness fault instead of a lost line.
 *
 * Every bound here is hard. A seat that prints a megabyte, an error whose `message` getter
 * returns a novel, and a field map with ten thousand keys must each cost the same fixed budget
 * as a quiet one, because the process that is failing is exactly the process least able to
 * afford unbounded work.
 */

/**
 * What a field may hold. Primitives only, by design: a nested object invites call sites to dump
 * whole domain aggregates into a log line, which is how a credential reaches disk by accident.
 * A caller with structure to report names the parts it means.
 */
export type DiagnosticFieldValue = string | number | boolean | null;

export type DiagnosticFields = Readonly<Record<string, DiagnosticFieldValue>>;

/** The bounded facts kept from a thrown value. See `describeThrown`. */
export interface DiagnosticThrown {
  /** The constructor name, or "Object"/"String" for a non-Error throw. */
  readonly name: string;
  readonly message: string;
  /** `ErrnoException.code` (ENOENT, EBUSY, SQLITE_BUSY) when the throw carried one. */
  readonly code: string | null;
  /** The head of the stack, bounded to `MAX_DIAGNOSTIC_STACK_LINES`. Null when there was none. */
  readonly stack: string | null;
  /** Nested causes and AggregateError members, bounded and flattened to their messages. */
  readonly causes: readonly string[];
}

export interface DiagnosticRecord {
  /** ISO-8601 instant from an INJECTED clock. This module holds none. */
  readonly at: string;
  readonly level: DiagnosticLevel;
  /** Stable subsystem slug: "wrapper", "store", "http", "mcp", "boot". Lowercase, no spaces. */
  readonly component: string;
  /**
   * The stable event code, UPPER_SNAKE, in the same vocabulary as this repository's refusal
   * codes. It is what an operator greps for and what a runbook cites, so it must not be a
   * sentence and must not be minted per call site from interpolated values.
   */
  readonly event: string;
  /** The correlation key: a session, work item, run, or request id. */
  readonly correlation?: string;
  readonly fields?: DiagnosticFields;
  readonly thrown?: DiagnosticThrown;
}

export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 2_000;
export const MAX_DIAGNOSTIC_FIELD_CHARS = 1_000;
export const MAX_DIAGNOSTIC_FIELDS = 32;
export const MAX_DIAGNOSTIC_STACK_LINES = 12;
export const MAX_DIAGNOSTIC_CAUSES = 4;
/** One encoded line, including its newline. A line longer than this is truncated, never dropped. */
export const MAX_DIAGNOSTIC_LINE_BYTES = 16_384;

/** Event codes and component slugs are shaped, so a malformed one is visible at the call site. */
const EVENT_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const COMPONENT_SLUG = /^[a-z][a-z0-9-]{1,31}$/u;

export function isDiagnosticEventCode(value: string): boolean {
  return EVENT_CODE.test(value);
}

export function isDiagnosticComponent(value: string): boolean {
  return COMPONENT_SLUG.test(value);
}
