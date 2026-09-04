import type { SqliteEventStore } from "@moe/store";

import type { ProviderPauseFacts, SeatExitReading, SeatExitReport } from "./agent-spawn-contract.js";
import { readProviderPause, recordProviderPause, recordSeatExit } from "./provider-pause-ledger.js";
import { classifySeatExit } from "./seat-exit-classifier.js";

/**
 * THE PROVIDER-LIMIT PAUSE GATE.
 *
 * A seat that dies because the PROVIDER refused it is not a failing work item: the
 * item never got its turn. Today a nonzero exit charges the item an attempt and
 * wedges the wrapper, so one usage limit at 21:04 stalls the whole drive until a
 * human notices. This gate reads every exit, and on a limit exit it:
 *
 *   1. records the exit and the pause durably (child 1's ledger),
 *   2. hands the item's attempt BACK, and
 *   3. parks the provider until its reset, so later passes staff nothing.
 *
 * Every other exit keeps today's behaviour byte for byte. The gate NEVER throws:
 * a wrapper that crashes while reading an exit is strictly worse than one that
 * reads it as an ordinary failure.
 */

/** No instant in the line? Park for half an hour: bounded, and short enough to retry. */
export const DEFAULT_PROVIDER_PAUSE_MS = 30 * 60 * 1000;

/** The surface outcome a pass reports when it staffed nothing because of a live pause. */
export const PROVIDER_PAUSED_OUTCOME = "PROVIDER_PAUSED" as const;

export interface ProviderPauseGateConfig {
  readonly clock: () => number;
  /** Override for the bounded fallback window; production takes the default. */
  readonly defaultPauseMs?: number;
  readonly log: (line: string) => void;
  readonly projectId: string;
  /** The provider this wrapper serves — one MOE_AGENT_COMMAND per wrapper process. */
  readonly provider: string;
  readonly store: SqliteEventStore;
}

export interface ProviderPauseGate {
  /**
   * Reads ONE seat's exit. `refund` is called exactly when the reading is a
   * provider limit — the attempt was charged at spawn and the item never ran.
   */
  readonly exitObserver: (
    sessionId: string,
    workItemId: string,
    refund: () => void,
  ) => (report: SeatExitReport) => SeatExitReading;
  /** The live pause at `nowMs`, or null when the provider is free to staff. */
  readonly paused: (nowMs: number) => ProviderPauseFacts | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createProviderPauseGate(config: ProviderPauseGateConfig): ProviderPauseGate {
  const { clock, log, projectId, provider, store } = config;
  const defaultPauseMs = config.defaultPauseMs ?? DEFAULT_PROVIDER_PAUSE_MS;

  /** The pause the ledger answers with at this instant; an unreadable clock parks nothing. */
  const livePause = (nowMs: number): ProviderPauseFacts | null => {
    if (!Number.isFinite(nowMs)) return null;
    const record = readProviderPause(store, projectId, provider, new Date(nowMs).toISOString());
    return record === null
      ? null
      : { provider: record.provider, resetAt: record.resetAt, since: record.since };
  };

  /**
   * When the provider is free again.
   *
   * A LIVE pause's reset is REUSED: a second limit exit inside the window must not
   * slide it forward, or a busy fleet could park itself indefinitely. Otherwise the
   * line's own instant wins, and a line that names none (or names one already past)
   * falls back to the bounded default.
   */
  const resetFor = (nowMs: number, lineReset: string | null): {
    readonly defaulted: boolean;
    readonly resetAt: string;
  } => {
    const live = livePause(nowMs);
    if (live !== null) return { defaulted: false, resetAt: live.resetAt };
    if (lineReset !== null && Date.parse(lineReset) > nowMs) {
      return { defaulted: false, resetAt: lineReset };
    }
    return { defaulted: true, resetAt: new Date(nowMs + defaultPauseMs).toISOString() };
  };

  /** Records the exit for EVERY reading; a refusal is reported by code, never thrown. */
  const recordExit = (
    input: {
      readonly exitAt: string;
      readonly kind: SeatExitReading;
      readonly lastLine: string | null;
      readonly report: SeatExitReport;
      readonly resetAt: string | null;
      readonly sessionId: string;
      readonly workItemId: string;
    },
  ): void => {
    const result = recordSeatExit(store, {
      decidedAt: input.exitAt,
      exitCode: input.report.exitCode,
      kind: input.kind,
      lastLine: input.lastLine,
      projectId,
      provider,
      resetAt: input.resetAt,
      sessionId: input.sessionId,
      workItemId: input.workItemId,
    });
    if (!result.ok) log(`[wrapper] seat exit not recorded: ${result.code}`);
  };

  /** Parks the provider and announces it in the operator's only wrapper UI: the log. */
  const park = (
    input: {
      readonly lastLine: string | null;
      readonly nowMs: number;
      readonly exitAt: string;
      readonly resetAt: string;
      readonly defaulted: boolean;
      readonly workItemId: string;
    },
  ): void => {
    const result = recordProviderPause(store, {
      cause: { lastLine: input.lastLine, workItemId: input.workItemId },
      projectId,
      provider,
      resetAt: input.resetAt,
      since: input.exitAt,
    });
    if (!result.ok) log(`[wrapper] provider pause not recorded: ${result.code}`);
    const bound = input.defaulted ? " (DEFAULT_PROVIDER_PAUSE_MS)" : "";
    log(`[wrapper] provider limit: ${provider} paused until ${input.resetAt}${bound}`
      + ` (${input.lastLine ?? "no output"})`);
  };

  const observe = (
    sessionId: string, workItemId: string, refund: () => void, report: SeatExitReport,
  ): SeatExitReading => {
    const nowMs = clock();
    const exitAt = new Date(nowMs).toISOString();
    const verdict = classifySeatExit({
      exitAt,
      exitCode: report.exitCode,
      provider,
      signal: report.signal,
      tail: report.tail,
    });
    if (verdict.kind !== "PROVIDER_LIMIT") {
      recordExit({
        exitAt, kind: verdict.kind, lastLine: verdict.lastLine, report,
        resetAt: verdict.resetAt, sessionId, workItemId,
      });
      return verdict.kind;
    }
    const { defaulted, resetAt } = resetFor(nowMs, verdict.resetAt);
    recordExit({
      exitAt, kind: verdict.kind, lastLine: verdict.lastLine, report, resetAt, sessionId,
      workItemId,
    });
    park({ defaulted, exitAt, lastLine: verdict.lastLine, nowMs, resetAt, workItemId });
    // The attempt was charged when the seat spawned; the provider, not the item, refused.
    refund();
    return verdict.kind;
  };

  const gate: ProviderPauseGate = {
    exitObserver: (sessionId: string, workItemId: string, refund: () => void) =>
      (report: SeatExitReport): SeatExitReading => {
        try {
          return observe(sessionId, workItemId, refund, report);
        } catch (error) {
          // Fail CLOSED to today's behaviour: an unreadable exit is an ordinary failure.
          log(`[wrapper] seat exit observer failed: ${messageOf(error)}`);
          return "FAILED";
        }
      },
    paused: livePause,
  };
  return Object.freeze(gate);
}
