import { deepFreeze } from "../canonical.js";
import {
  CLAUDE_RECONCILED_OUTCOMES,
  CLAUDE_RECONCILIATION_VERSION,
  type ClaudeProcessExit,
} from "../providers/claude/claude-cancel-reconcile.js";
import type { SettlementEvidence, SupervisorFailure } from "./effect-kernel.js";
import { parseSettlementEvidence } from "./effect-parse.js";
import { exactRecord, isCount, isRef, oneOf } from "./effect-shape.js";
import { launchLockFailure } from "./launch-lock.js";

/**
 * Intake for a caller-supplied process observation.
 *
 * The adapter's `ClaudeProcessExit` is imported rather than mirrored: it lives in
 * the same package, so a structural re-declaration here would be a second source
 * of truth that drifts silently. The reconciliation is bound by REFERENCE for
 * the same reason — `reconcileClaudeRun` owns what a run proved, and a second
 * opinion computed here would contradict it eventually.
 */
export interface BoundProcessObservation {
  readonly processExit: ClaudeProcessExit;
  /** `UNOBSERVED` is not death. Only an observed exit or signal proves an end. */
  readonly proven: boolean;
  readonly reconciliation: SettlementEvidence | null;
}

export type ProcessObservationOutcome =
  | { readonly kind: "OBSERVED"; readonly ok: true; readonly observation: BoundProcessObservation }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

const EXIT_KEYS = {
  EXITED: ["kind", "code"] as const,
  SIGNALLED: ["kind", "signal"] as const,
  UNOBSERVED: ["kind"] as const,
};
const EXIT_KINDS = ["EXITED", "SIGNALLED", "UNOBSERVED"] as const;
const COMMAND = "launchLock.observe";

export function parseProcessExit(value: unknown): ClaudeProcessExit | null {
  for (const kind of EXIT_KINDS) {
    const parsed = exactRecord(value, EXIT_KEYS[kind]);
    if (parsed === null || parsed["kind"] !== kind) continue;
    if (kind === "EXITED" && !isCount(parsed["code"])) return null;
    if (kind === "SIGNALLED" && !isRef(parsed["signal"])) return null;
    return parsed as unknown as ClaudeProcessExit;
  }
  return null;
}

/** A reference to the adapter's verdict, pinned to its version and vocabulary. */
export function parseReconciliationReference(value: unknown): SettlementEvidence | null {
  const parsed = parseSettlementEvidence(value);
  if (parsed === null) return null;
  if (parsed.reconciliationVersion !== CLAUDE_RECONCILIATION_VERSION) return null;
  if (!oneOf(parsed.outcomeClass, CLAUDE_RECONCILED_OUTCOMES)) return null;
  return parsed;
}

export function intakeProcessObservation(
  exitValue: unknown,
  reconciliationValue: unknown,
): ProcessObservationOutcome {
  const no = (message: string): ProcessObservationOutcome =>
    Object.freeze({
      kind: "REFUSED" as const,
      failure: launchLockFailure(
        "PROCESS_OBSERVATION_MALFORMED",
        "LAUNCH_LOCK",
        message,
        COMMAND,
      ),
    });
  const processExit = parseProcessExit(exitValue);
  if (processExit === null) {
    return no("the process observation does not parse");
  }
  const reconciliation =
    reconciliationValue === null ? null : parseReconciliationReference(reconciliationValue);
  if (reconciliationValue !== null && reconciliation === null) {
    return no("the bound reconciliation reference does not parse");
  }
  return deepFreeze({
    kind: "OBSERVED" as const,
    ok: true as const,
    observation: { processExit, proven: processExit.kind !== "UNOBSERVED", reconciliation },
  });
}
