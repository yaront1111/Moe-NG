import { canonicalDigest, deepFreeze } from "../../canonical.js";
import type { CodexStreamAnomaly, CodexStreamDisposition } from "./codex-stream-anomalies.js";
import type { CodexStreamRecord } from "./codex-stream.js";

export const CODEX_RECONCILIATION_VERSION = "moe-codex-reconciliation/1" as const;
export const CODEX_RECONCILED_OUTCOMES = Object.freeze([
  "CANCELLED_CLEAN",
  "CANCELLED_UNKNOWN_TAIL",
  "COMPLETED_BEFORE_CANCEL",
  "CRASHED",
  "HONEST_UNKNOWN",
  "PROVEN_RESULT",
] as const);
export type CodexReconciledOutcome = (typeof CODEX_RECONCILED_OUTCOMES)[number];

export type CodexProcessExit =
  | { readonly kind: "EXITED"; readonly code: number }
  | { readonly kind: "SIGNALLED"; readonly signal: string }
  | { readonly kind: "UNOBSERVED" };

export interface ReconcileCodexRunInput {
  readonly stream: CodexStreamRecord;
  readonly cancelRequested: boolean;
  readonly processExit: CodexProcessExit;
}

export interface CodexReconciliation {
  readonly reconciliationVersion: typeof CODEX_RECONCILIATION_VERSION;
  readonly outcome: CodexReconciledOutcome;
  readonly disposition: CodexStreamDisposition;
  readonly anomalies: readonly CodexStreamAnomaly[];
  readonly streamDigest: string;
  readonly cancelRequested: boolean;
  readonly processExit: CodexProcessExit;
  readonly reconciliationDigest: string;
}

function diedAbnormally(exit: CodexProcessExit): boolean {
  return exit.kind === "SIGNALLED" || (exit.kind === "EXITED" && exit.code !== 0);
}

function reconcileCut(
  cancelRequested: boolean,
  exit: CodexProcessExit,
): CodexReconciledOutcome {
  if (cancelRequested) {
    return exit.kind === "EXITED" && exit.code === 0 ?
      "HONEST_UNKNOWN" : "CANCELLED_UNKNOWN_TAIL";
  }
  return diedAbnormally(exit) ? "CRASHED" : "HONEST_UNKNOWN";
}

const TAIL_DESTROYING = Object.freeze(["TRUNCATION"] as const satisfies readonly CodexStreamAnomaly[]);

function resolveOutcome(input: ReconcileCodexRunInput): CodexReconciledOutcome {
  const { stream, cancelRequested, processExit } = input;
  switch (stream.disposition) {
    case "COMPLETED": return cancelRequested ? "COMPLETED_BEFORE_CANCEL" : "PROVEN_RESULT";
    case "CANCELLED": return "CANCELLED_CLEAN";
    case "INCOMPLETE": return reconcileCut(cancelRequested, processExit);
    case "UNKNOWN":
      return TAIL_DESTROYING.some((value) => stream.anomalies.includes(value)) ?
        reconcileCut(cancelRequested, processExit) : "HONEST_UNKNOWN";
    case "UNKNOWN_SCHEMA":
    case "REFUSED_RESUME_UNSUPPORTED":
      return "HONEST_UNKNOWN";
  }
}

function reconciliationDigestInput(
  input: ReconcileCodexRunInput,
  outcome: CodexReconciledOutcome,
): Record<string, unknown> {
  return {
    reconciliationVersion: CODEX_RECONCILIATION_VERSION,
    outcome,
    disposition: input.stream.disposition,
    anomalies: [...input.stream.anomalies],
    streamDigest: input.stream.recordDigest,
    cancelRequested: input.cancelRequested,
    processExit: { ...input.processExit },
  };
}

export function reconcileCodexRun(input: ReconcileCodexRunInput): CodexReconciliation {
  const outcome = resolveOutcome(input);
  return deepFreeze({
    reconciliationVersion: CODEX_RECONCILIATION_VERSION,
    outcome,
    disposition: input.stream.disposition,
    anomalies: input.stream.anomalies,
    streamDigest: input.stream.recordDigest,
    cancelRequested: input.cancelRequested,
    processExit: { ...input.processExit },
    reconciliationDigest: canonicalDigest(reconciliationDigestInput(input, outcome)),
  } satisfies CodexReconciliation);
}
