import { createHash } from "node:crypto";

import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject, JsonValue } from "@moe/contracts";

import { SEAT_EXIT_KINDS } from "./seat-exit-classifier.js";

/**
 * The DURABLE SHAPES of a seat's exit and a provider's pause.
 *
 * Both are WRAPPER-SIDE FACTS, not commands: nobody asks for them and nobody may forge them from
 * the browser. They ride `store.commitExpectedVersionDecision` under a reserved daemon principal
 * with an internal command kind — the same route `internal.repository.publish_receipt` and
 * `internal.integration.verifier_receipt` already take — so they never enter the daemon command
 * registry and are never reachable over MCP.
 *
 * Both records are EXACT-KEY: a decode that finds one key too many or too few refuses, so a record
 * written by a future shape is ignored rather than half-read.
 */

export const SEAT_EXIT_COMMAND_KIND = "internal.wrapper.seat_exit" as const;
export const PROVIDER_PAUSE_COMMAND_KIND = "internal.wrapper.provider_pause" as const;
export const AGENT_WRAPPER_PRINCIPAL_ID = "daemon:agent-wrapper" as const;
export const SEAT_EXIT_VERSION = "moe-seat-exit/1" as const;
export const PROVIDER_PAUSE_VERSION = "moe-provider-pause/1" as const;

/** A provider line can be arbitrarily long; the durable record keeps only what identifies it. */
export const LAST_LINE_MAX_CHARS = 512;

export interface SeatExitCause {
  readonly lastLine: string | null;
  readonly workItemId: string;
}

export interface SeatExitRecordV1 {
  readonly decidedAt: string;
  /** Null when the seat died on a signal rather than an exit code. */
  readonly exitCode: number | null;
  readonly kind: (typeof SEAT_EXIT_KINDS)[number];
  readonly lastLine: string | null;
  readonly projectId: string;
  readonly provider: string;
  readonly resetAt: string | null;
  readonly sessionId: string;
  readonly version: typeof SEAT_EXIT_VERSION;
  readonly workItemId: string;
}

export interface ProviderPauseRecordV1 {
  /** Null on a CLEAR: nothing caused it, an operator or a lifted limit ended it. */
  readonly cause: SeatExitCause | null;
  readonly projectId: string;
  readonly provider: string;
  readonly resetAt: string;
  readonly since: string;
  readonly version: typeof PROVIDER_PAUSE_VERSION;
}

const SEAT_EXIT_KEYS = [
  "decidedAt", "exitCode", "kind", "lastLine", "projectId", "provider", "resetAt", "sessionId",
  "version", "workItemId",
] as const;
const PAUSE_KEYS = ["cause", "projectId", "provider", "resetAt", "since", "version"] as const;
const CAUSE_KEYS = ["lastLine", "workItemId"] as const;

/** Every pause fact for a provider lands on a stream of its own, one per project and provider. */
export function providerPauseAggregateId(projectId: string, provider: string): string {
  return `provider-pause:${projectId}:${provider}`;
}

/** Every seat's exit lands beside its session, never on the work item it was serving. */
export function seatExitAggregateId(projectId: string, sessionId: string): string {
  return `seat-exit:${projectId}:${sessionId}`;
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 32);
}

/**
 * Command ids are DERIVED FROM THE INPUTS, never minted fresh: a wrapper that retries the same
 * exit replays its own decision instead of writing a second one.
 */
export function seatExitRecordId(projectId: string, sessionId: string, decidedAt: string): string {
  return `seat-exit-${digest([projectId, sessionId, decidedAt])}`;
}

export function providerPauseRecordId(projectId: string, provider: string, since: string): string {
  return `provider-pause-${digest([projectId, provider, since])}`;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object"
    && !Array.isArray(value) && Object.getPrototypeOf(value) === null;
}

function exact(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function ref(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * A readable instant, or nothing.
 *
 * The ISO shape is required, not merely a parseable one: `Date.parse` will happily read "123" or
 * "Sep 8" as a date, and a durable record that accepted those would store a timestamp nobody could
 * compare. Refused, never coerced.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

export function instant(value: JsonValue | undefined): value is string {
  return ref(value) && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function optionalLine(value: JsonValue | undefined): value is string | null {
  return value === null || (typeof value === "string" && value.length <= LAST_LINE_MAX_CHARS);
}

function decodeCause(value: JsonValue | undefined): SeatExitCause | null | false {
  if (value === null) return null;
  if (!isObject(value) || !exact(value, CAUSE_KEYS)) return false;
  const { lastLine, workItemId } = value;
  if (!ref(workItemId) || !optionalLine(lastLine)) return false;
  return Object.freeze({ lastLine: lastLine as string | null, workItemId });
}

export type SeatExitDecodeResult =
  | Readonly<{ ok: true; record: SeatExitRecordV1 }>
  | Readonly<{ code: "SEAT_EXIT_RECORD_INVALID"; ok: false }>;

export type ProviderPauseDecodeResult =
  | Readonly<{ ok: true; record: ProviderPauseRecordV1 }>
  | Readonly<{ code: "PROVIDER_PAUSE_RECORD_INVALID"; ok: false }>;

export function decodeSeatExitBytes(input: unknown): SeatExitDecodeResult {
  const refused = { code: "SEAT_EXIT_RECORD_INVALID", ok: false } as const;
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, SEAT_EXIT_KEYS)) return refused;
  const value = decoded.value;
  const { decidedAt, exitCode, kind, lastLine, projectId, provider, resetAt, sessionId } = value;
  const { version, workItemId } = value;
  if (version !== SEAT_EXIT_VERSION || !instant(decidedAt) || !ref(projectId) || !ref(provider)
    || !ref(sessionId) || !ref(workItemId) || !optionalLine(lastLine)
    || !(SEAT_EXIT_KINDS as readonly string[]).includes(kind as string)
    || !(exitCode === null || (typeof exitCode === "number" && Number.isInteger(exitCode)))
    || !(resetAt === null || instant(resetAt))) {
    return refused;
  }
  return {
    ok: true,
    record: Object.freeze({
      decidedAt,
      exitCode: exitCode as number | null,
      kind: kind as SeatExitRecordV1["kind"],
      lastLine: lastLine as string | null,
      projectId,
      provider,
      resetAt: resetAt as string | null,
      sessionId,
      version: SEAT_EXIT_VERSION,
      workItemId,
    }),
  };
}

export function decodeProviderPauseBytes(input: unknown): ProviderPauseDecodeResult {
  const refused = { code: "PROVIDER_PAUSE_RECORD_INVALID", ok: false } as const;
  const decoded = decodeBoundedJsonBytes(input);
  if (!decoded.ok || !isObject(decoded.value) || !exact(decoded.value, PAUSE_KEYS)) return refused;
  const { cause, projectId, provider, resetAt, since, version } = decoded.value;
  const decodedCause = decodeCause(cause);
  if (version !== PROVIDER_PAUSE_VERSION || decodedCause === false || !ref(projectId)
    || !ref(provider) || !instant(resetAt) || !instant(since)) {
    return refused;
  }
  return {
    ok: true,
    record: Object.freeze({
      cause: decodedCause, projectId, provider, resetAt, since, version: PROVIDER_PAUSE_VERSION,
    }),
  };
}
