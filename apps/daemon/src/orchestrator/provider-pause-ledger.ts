import type { EventDraft, SqliteEventStore } from "@moe/store";

import {
  AGENT_WRAPPER_PRINCIPAL_ID, LAST_LINE_MAX_CHARS, PROVIDER_PAUSE_COMMAND_KIND,
  PROVIDER_PAUSE_VERSION, SEAT_EXIT_COMMAND_KIND, SEAT_EXIT_VERSION, decodeProviderPauseBytes,
  decodeSeatExitBytes, providerPauseAggregateId, providerPauseRecordId, seatExitAggregateId,
  seatExitRecordId,
} from "./provider-pause-contracts.js";
import type {
  ProviderPauseRecordV1, SeatExitCause, SeatExitRecordV1,
} from "./provider-pause-contracts.js";

/**
 * DURABLE WRAPPER FACTS: why a seat exited, and how long a provider is unusable.
 *
 * A pause outlives the wrapper process that observed it — a restart must not walk a fleet straight
 * back into a refusal — so it is a record on the store, not a variable. There is ONE event type:
 * clearing a pause is a record whose reset is NOW, which means a read at or after that instant
 * answers null by the ordinary rule instead of by a second, separately-fallible code path.
 */

export * from "./provider-pause-contracts.js";

const encoder = new TextEncoder();
const LEDGER_PAGE_SIZE = 200;

export interface RecordSeatExitInput {
  readonly decidedAt: string;
  readonly exitCode: number | null;
  readonly kind: string;
  readonly lastLine: string | null;
  readonly projectId: string;
  readonly provider: string;
  readonly resetAt: string | null;
  readonly sessionId: string;
  readonly workItemId: string;
}

export interface RecordProviderPauseInput {
  readonly cause: SeatExitCause | null;
  readonly projectId: string;
  readonly provider: string;
  readonly resetAt: string;
  readonly since: string;
}

export type SeatExitRecordResult =
  | Readonly<{ ok: true; record: SeatExitRecordV1; replayed: boolean }>
  | Readonly<{ code: "EXPECTED_VERSION_CONFLICT" | "SEAT_EXIT_RECORD_INVALID"; ok: false }>;

export type ProviderPauseRecordResult =
  | Readonly<{ ok: true; record: ProviderPauseRecordV1; replayed: boolean }>
  | Readonly<{ code: "EXPECTED_VERSION_CONFLICT" | "PROVIDER_PAUSE_RECORD_INVALID"; ok: false }>;

function clip(line: string | null): string | null {
  return line === null ? null : line.slice(0, LAST_LINE_MAX_CHARS);
}

/** The decision this command id already produced, decoded, or null while there is none to replay. */
function existing(
  store: SqliteEventStore, projectId: string, commandId: string,
): Uint8Array | null {
  let decision;
  try {
    decision = store.getCommandDecision({
      commandId, principalId: AGENT_WRAPPER_PRINCIPAL_ID, projectId,
    });
  } catch {
    return null;
  }
  if (decision === null || decision.effectDisposition !== "EFFECTS_COMMITTED") return null;
  return decision.resultBytes;
}

interface CommitInput {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly commandKind: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly eventType: string;
  readonly projectId: string;
  readonly resultBytes: Uint8Array;
}

/** The internal-kind commit the publish and verifier receipts already use. Never the registry. */
function commit(store: SqliteEventStore, input: CommitInput): boolean {
  const event: EventDraft = {
    eventId: `${input.commandId}-${input.eventType}`,
    eventType: input.eventType,
    payload: encoder.encode(JSON.stringify({ commandId: input.commandId, kind: input.commandKind })),
  };
  const response = store.commitExpectedVersionDecision({
    commandKind: input.commandKind,
    committedResultBytes: input.resultBytes,
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    events: [event],
    expectedVersion: store.getAggregateVersion(input.aggregateId),
    key: {
      commandId: input.commandId,
      principalId: AGENT_WRAPPER_PRINCIPAL_ID,
      projectId: input.projectId,
    },
    requestBytes: encoder.encode(JSON.stringify({ commandId: input.commandId })),
    targetAggregateId: input.aggregateId,
  });
  return response.decision.effectDisposition === "EFFECTS_COMMITTED";
}

/** One durable record per seat exit: which provider refused, how, and when it lifts. */
export function recordSeatExit(
  store: SqliteEventStore, input: RecordSeatExitInput,
): SeatExitRecordResult {
  const commandId = seatExitRecordId(input.projectId, input.sessionId, input.decidedAt);
  const replay = existing(store, input.projectId, commandId);
  if (replay !== null) {
    const decoded = decodeSeatExitBytes(replay);
    return decoded.ok
      ? { ok: true, record: decoded.record, replayed: true }
      : { code: "SEAT_EXIT_RECORD_INVALID", ok: false };
  }
  const resultBytes = encoder.encode(JSON.stringify({
    decidedAt: input.decidedAt,
    exitCode: input.exitCode,
    kind: input.kind,
    lastLine: clip(input.lastLine),
    projectId: input.projectId,
    provider: input.provider,
    resetAt: input.resetAt,
    sessionId: input.sessionId,
    version: SEAT_EXIT_VERSION,
    workItemId: input.workItemId,
  }));
  // Decode BEFORE committing: a record this module could not read back is never written.
  const decoded = decodeSeatExitBytes(resultBytes);
  if (!decoded.ok) return { code: "SEAT_EXIT_RECORD_INVALID", ok: false };
  const committed = commit(store, {
    aggregateId: seatExitAggregateId(input.projectId, input.sessionId),
    commandId,
    commandKind: SEAT_EXIT_COMMAND_KIND,
    correlationId: "agent-wrapper-seat-exit",
    decidedAt: input.decidedAt,
    eventType: "SeatExitRecorded",
    projectId: input.projectId,
    resultBytes,
  });
  return committed
    ? { ok: true, record: decoded.record, replayed: false }
    : { code: "EXPECTED_VERSION_CONFLICT", ok: false };
}

/** The provider is unusable until `resetAt`. A later record supersedes an earlier one. */
export function recordProviderPause(
  store: SqliteEventStore, input: RecordProviderPauseInput,
): ProviderPauseRecordResult {
  const commandId = providerPauseRecordId(input.projectId, input.provider, input.since);
  const replay = existing(store, input.projectId, commandId);
  if (replay !== null) {
    const decoded = decodeProviderPauseBytes(replay);
    return decoded.ok
      ? { ok: true, record: decoded.record, replayed: true }
      : { code: "PROVIDER_PAUSE_RECORD_INVALID", ok: false };
  }
  const resultBytes = encoder.encode(JSON.stringify({
    cause: input.cause === null
      ? null
      : { lastLine: clip(input.cause.lastLine), workItemId: input.cause.workItemId },
    projectId: input.projectId,
    provider: input.provider,
    resetAt: input.resetAt,
    since: input.since,
    version: PROVIDER_PAUSE_VERSION,
  }));
  const decoded = decodeProviderPauseBytes(resultBytes);
  if (!decoded.ok) return { code: "PROVIDER_PAUSE_RECORD_INVALID", ok: false };
  const committed = commit(store, {
    aggregateId: providerPauseAggregateId(input.projectId, input.provider),
    commandId,
    commandKind: PROVIDER_PAUSE_COMMAND_KIND,
    correlationId: "agent-wrapper-provider-pause",
    decidedAt: input.since,
    eventType: "ProviderPaused",
    projectId: input.projectId,
    resultBytes,
  });
  return committed
    ? { ok: true, record: decoded.record, replayed: false }
    : { code: "EXPECTED_VERSION_CONFLICT", ok: false };
}

/**
 * The provider's live pause, or null.
 *
 * The LATEST record in ledger order is the current answer, and it answers only while `resetAt` is
 * strictly ahead of `now`: at the reset instant the limit is over. An undecodable record is skipped
 * rather than trusted — a row this module cannot read is not a reason to park a fleet.
 */
export function readProviderPause(
  store: SqliteEventStore, projectId: string, provider: string, now: string,
): ProviderPauseRecordV1 | null {
  const aggregateId = providerPauseAggregateId(projectId, provider);
  const nowMs = Date.parse(now);
  // An unreadable clock must not park the fleet forever: no answer beats an unbounded pause.
  if (!Number.isFinite(nowMs)) return null;
  let latest: ProviderPauseRecordV1 | null = null;
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, LEDGER_PAGE_SIZE);
    for (const decision of page.items) {
      if (decision.key.projectId !== projectId
        || decision.effectDisposition !== "EFFECTS_COMMITTED"
        || decision.commandKind !== PROVIDER_PAUSE_COMMAND_KIND
        || decision.key.principalId !== AGENT_WRAPPER_PRINCIPAL_ID
        || decision.targetAggregateId !== aggregateId) {
        continue;
      }
      const decoded = decodeProviderPauseBytes(decision.resultBytes);
      if (!decoded.ok || decoded.record.provider !== provider
        || decoded.record.projectId !== projectId) {
        continue;
      }
      latest = decoded.record;
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  if (latest === null) return null;
  return Date.parse(latest.resetAt) > nowMs ? latest : null;
}

/** Clearing is a pause whose reset is NOW: one event type, one read rule, no second path. */
export function clearProviderPause(
  store: SqliteEventStore,
  input: Readonly<{ now: string; projectId: string; provider: string }>,
): ProviderPauseRecordResult {
  return recordProviderPause(store, {
    cause: null,
    projectId: input.projectId,
    provider: input.provider,
    resetAt: input.now,
    since: input.now,
  });
}
