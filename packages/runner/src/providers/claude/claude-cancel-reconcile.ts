import { canonicalDigest, deepFreeze } from "../../canonical.js";
import type { ClaudeStreamAnomaly, ClaudeStreamDisposition } from "./claude-stream-anomalies.js";
import type { ClaudeStreamRecord } from "./claude-stream.js";

/**
 * Reconciles what a run actually proved, from evidence only.
 *
 * This module has NO process authority: it neither signals, terminates, waits
 * on, nor relaunches anything. Cancellation is an input — "a cancel was
 * requested" — and process death is an observation the caller supplies. Launch
 * locks, job-object death proof, ARMED/SUSPECT state, and relaunch decisions all
 * belong to the wrapper/supervisor (design 13).
 *
 * The rule the whole table serves: a run may reconcile to a proven result or to
 * an honest UNKNOWN, and never to an invented completion.
 */
export const CLAUDE_RECONCILIATION_VERSION = "moe-claude-reconciliation/1" as const;

export const CLAUDE_RECONCILED_OUTCOMES = Object.freeze([
  "CANCELLED_CLEAN",
  "CANCELLED_UNKNOWN_TAIL",
  "COMPLETED_BEFORE_CANCEL",
  "CRASHED",
  "HONEST_UNKNOWN",
  "PROVEN_RESULT",
] as const);
export type ClaudeReconciledOutcome = (typeof CLAUDE_RECONCILED_OUTCOMES)[number];

export type ClaudeProcessExit =
  | { readonly kind: "EXITED"; readonly code: number }
  | { readonly kind: "SIGNALLED"; readonly signal: string }
  | { readonly kind: "UNOBSERVED" };

export interface ReconcileClaudeRunInput {
  readonly stream: ClaudeStreamRecord;
  readonly cancelRequested: boolean;
  readonly processExit: ClaudeProcessExit;
}

export interface ClaudeReconciliation {
  readonly reconciliationVersion: typeof CLAUDE_RECONCILIATION_VERSION;
  readonly outcome: ClaudeReconciledOutcome;
  readonly disposition: ClaudeStreamDisposition;
  readonly anomalies: readonly ClaudeStreamAnomaly[];
  readonly streamDigest: string;
  readonly cancelRequested: boolean;
  readonly processExit: ClaudeProcessExit;
  readonly reconciliationDigest: string;
}

/** Death that the caller actually observed, as opposed to merely not seeing life. */
function diedAbnormally(processExit: ClaudeProcessExit): boolean {
  return (
    processExit.kind === "SIGNALLED" || (processExit.kind === "EXITED" && processExit.code !== 0)
  );
}

/**
 * A stream that stopped without saying why. If a cancel was requested, the
 * missing tail is exactly what a cancel produces, so the outcome names the
 * uncertainty rather than claiming a clean cancel. Without a cancel, observed
 * abnormal death is a crash; anything else stays UNKNOWN, because "the process
 * exited zero but never reported a result" is not evidence of completion.
 */
function reconcileCutStream(
  cancelRequested: boolean,
  processExit: ClaudeProcessExit,
): ClaudeReconciledOutcome {
  if (cancelRequested) {
    return processExit.kind === "EXITED" && processExit.code === 0
      ? "HONEST_UNKNOWN"
      : "CANCELLED_UNKNOWN_TAIL";
  }
  return diedAbnormally(processExit) ? "CRASHED" : "HONEST_UNKNOWN";
}

/** Anomalies that leave the stream unable to say what happened at its end. */
const TAIL_DESTROYING: readonly ClaudeStreamAnomaly[] = Object.freeze(["TRUNCATION"]);

function resolveOutcome(input: ReconcileClaudeRunInput): ClaudeReconciledOutcome {
  const { stream, cancelRequested, processExit } = input;
  switch (stream.disposition) {
    case "COMPLETED":
      return cancelRequested ? "COMPLETED_BEFORE_CANCEL" : "PROVEN_RESULT";
    case "CANCELLED":
      return "CANCELLED_CLEAN";
    case "INCOMPLETE":
      return reconcileCutStream(cancelRequested, processExit);
    case "UNKNOWN":
      // Only a cut tail can be read as a cancellation or a crash. A gap, a
      // counter restart, or an unreadable record says nothing about the end of
      // the run, so those stay UNKNOWN whatever the process did.
      return TAIL_DESTROYING.some((anomaly) => stream.anomalies.includes(anomaly))
        ? reconcileCutStream(cancelRequested, processExit)
        : "HONEST_UNKNOWN";
    case "UNKNOWN_SCHEMA":
    case "REFUSED_RESUME_UNSUPPORTED":
      // We could not read the stream, so we cannot claim anything about it —
      // including that it crashed.
      return "HONEST_UNKNOWN";
  }
}

function reconciliationDigestInput(
  input: ReconcileClaudeRunInput,
  outcome: ClaudeReconciledOutcome,
): Record<string, unknown> {
  return {
    reconciliationVersion: CLAUDE_RECONCILIATION_VERSION,
    outcome,
    disposition: input.stream.disposition,
    anomalies: [...input.stream.anomalies],
    streamDigest: input.stream.recordDigest,
    cancelRequested: input.cancelRequested,
    processExit: { ...input.processExit },
  };
}

export function reconcileClaudeRun(input: ReconcileClaudeRunInput): ClaudeReconciliation {
  const outcome = resolveOutcome(input);
  return deepFreeze({
    reconciliationVersion: CLAUDE_RECONCILIATION_VERSION,
    outcome,
    disposition: input.stream.disposition,
    anomalies: input.stream.anomalies,
    streamDigest: input.stream.recordDigest,
    cancelRequested: input.cancelRequested,
    processExit: { ...input.processExit },
    reconciliationDigest: canonicalDigest(reconciliationDigestInput(input, outcome)),
  } satisfies ClaudeReconciliation);
}
