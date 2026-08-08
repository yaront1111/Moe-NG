import { deepFreeze } from "../canonical.js";
import {
  isMonotonicDisposition,
  parseDrainDisposition,
  dispositionRefusal,
  type DrainDisposition,
} from "./drain-disposition.js";
import {
  drainTargetOf,
  DRAIN_ATTEMPT_STATES,
  DRAIN_TABLE_ROWS,
  RESOURCE_FACTS,
  type DrainAttemptState,
  type DrainReason,
  type DrainRow,
  type DrainTerminalTarget,
  type ResourceFact,
} from "./drain-table.js";
import {
  supervisorFailure,
  EFFECT_STATES,
  type EffectState,
  type SettlementEvidence,
  type SupervisorErrorCode,
  type SupervisorFailure,
} from "./effect-kernel.js";
import { ADMITTED_EFFECT_TRANSITIONS } from "./effect-lifecycle.js";
import { isRef, oneOf, exactRecord } from "./effect-shape.js";
import { parseReconciliationReference } from "./process-observation.js";

/**
 * Resolves exactly one row of the design-786/787 table.
 *
 * Two rails shape every branch below. First, an input that matches no row is
 * REFUSED rather than falling through to a default — design 784 says the cross
 * product "is generated from this closed table; no reducer invents a missing
 * edge", and a default arm is precisely such an invention. Second, `UNKNOWN` is
 * never optimistically read as released: an unverifiable resource keeps the
 * attempt draining, because epic rail 4 gives unverifiable evidence no authority.
 */
export type DrainOutcome =
  | { readonly kind: "TOMBSTONED"; readonly ok: true; readonly row: DrainRow }
  | {
      readonly kind: "TERMINALIZED";
      readonly ok: true;
      readonly row: DrainRow;
      readonly strongestReason: DrainReason;
      readonly terminalTarget: DrainTerminalTarget;
      readonly safeHandoff: string | null;
    }
  | {
      readonly kind: "DRAINING";
      readonly ok: true;
      readonly row: DrainRow;
      readonly disposition: DrainDisposition;
      readonly capacityHeld: boolean;
      readonly nodeRunHeld: boolean;
      readonly providerSlotReleased: boolean;
      readonly cancelSuccessor: EffectState | null;
    }
  | { readonly kind: "ATOMIC_ACTIVATION"; readonly ok: true; readonly row: DrainRow }
  | { readonly kind: "RECONCILE_ONLY"; readonly ok: true; readonly row: DrainRow }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

const DRAIN_KEYS = [
  "attemptState",
  "effectState",
  "resourceFact",
  "activationRequested",
  "disposition",
  "reconciliation",
  "safeHandoff",
] as const;
const COMMAND = "drain.resolveRow";

interface ParsedDrain {
  readonly attemptState: DrainAttemptState;
  readonly effectState: EffectState;
  readonly resourceFact: ResourceFact;
  readonly activationRequested: boolean;
  readonly disposition: DrainDisposition;
  readonly reconciliation: SettlementEvidence | null;
  readonly safeHandoff: string | null;
}

function refuse(code: SupervisorErrorCode, message: string, command = COMMAND): DrainOutcome {
  return Object.freeze({
    kind: "REFUSED" as const,
    failure: supervisorFailure(code, "DRAIN", message, { state: null, command, leg: null }),
  });
}

function notAdmitted(message: string): DrainOutcome {
  return refuse("DRAIN_ROW_NOT_ADMITTED", message);
}

function parseDrain(value: unknown): ParsedDrain | DrainOutcome {
  const raw = exactRecord(value, DRAIN_KEYS);
  if (raw === null) {
    return notAdmitted("the drain input does not name a row of the closed table");
  }
  if (
    !oneOf(raw["attemptState"], DRAIN_ATTEMPT_STATES) ||
    !oneOf(raw["effectState"], EFFECT_STATES) ||
    !oneOf(raw["resourceFact"], RESOURCE_FACTS) ||
    typeof raw["activationRequested"] !== "boolean"
  ) {
    return notAdmitted("the drain input names a state the closed table does not declare");
  }
  if (raw["safeHandoff"] !== null && !isRef(raw["safeHandoff"])) {
    return notAdmitted("the safe handoff reference does not parse");
  }
  const reconciliation =
    raw["reconciliation"] === null ? null : parseReconciliationReference(raw["reconciliation"]);
  if (raw["reconciliation"] !== null && reconciliation === null) {
    return notAdmitted("the bound reconciliation reference does not parse");
  }
  const disposition = parseDrainDisposition(raw["disposition"]);
  if (disposition === null || !isMonotonicDisposition(disposition)) {
    return Object.freeze({
      kind: "REFUSED" as const,
      failure: dispositionRefusal("the drain disposition is not verifiably monotonic", COMMAND),
    });
  }
  return {
    attemptState: raw["attemptState"],
    effectState: raw["effectState"],
    resourceFact: raw["resourceFact"],
    activationRequested: raw["activationRequested"],
    disposition,
    reconciliation,
    safeHandoff: raw["safeHandoff"] === null ? null : (raw["safeHandoff"] as string),
  };
}

function matchRow(input: ParsedDrain): DrainRow | null {
  return (
    DRAIN_TABLE_ROWS.find(
      (row) =>
        row.activationRequested === input.activationRequested &&
        row.attemptStates.includes(input.attemptState) &&
        row.effectStates.includes(input.effectState) &&
        row.resourceFacts.includes(input.resourceFact),
    ) ?? null
  );
}

/** Reads the successor out of the admitted arc table instead of inventing it. */
function cancelSuccessorFor(effectState: EffectState): EffectState | null {
  const arc = ADMITTED_EFFECT_TRANSITIONS.find(
    (entry) => entry.from === effectState && entry.command === "requestCancel",
  );
  return arc?.to[0] ?? null;
}

function draining(row: DrainRow, input: ParsedDrain): DrainOutcome {
  return deepFreeze({
    kind: "DRAINING" as const,
    ok: true as const,
    row,
    disposition: input.disposition,
    capacityHeld: row.retainsCapacityHold,
    nodeRunHeld: row.retainsCapacityHold,
    providerSlotReleased: row.releasesProviderSlot,
    cancelSuccessor: cancelSuccessorFor(input.effectState),
  });
}

/**
 * Design 786: "`RELEASED` also requires an exact safe handoff." The refusal
 * carries the DRAIN layer so a reader can tell it apart from the identical fact
 * refused by restart reconstruction, which answers at the RESTART layer.
 */
function terminalize(row: DrainRow, input: ParsedDrain): DrainOutcome {
  const strongestReason = input.disposition.strongestReason;
  const terminalTarget = drainTargetOf(strongestReason);
  if (terminalTarget === null) {
    return notAdmitted("the strongest reason maps to no declared terminal target");
  }
  if (terminalTarget === "RELEASED" && input.safeHandoff === null) {
    return refuse(
      "RESTART_SAFE_HANDOFF_ABSENT",
      "a RELEASED terminal requires the exact safe handoff it hands to a successor",
    );
  }
  return deepFreeze({
    kind: "TERMINALIZED" as const,
    ok: true as const,
    row,
    strongestReason,
    terminalTarget,
    safeHandoff: input.safeHandoff,
  });
}

export function resolveDrainRow(inputValue: unknown): DrainOutcome {
  const parsed = parseDrain(inputValue);
  if ("kind" in parsed) {
    return parsed;
  }
  const row = matchRow(parsed);
  if (row === null) {
    return notAdmitted("no row of the design 786/787 table admits this attempt/effect pair");
  }
  switch (row.outcomeKind) {
    case "TOMBSTONED":
    case "ATOMIC_ACTIVATION":
    case "RECONCILE_ONLY":
      return deepFreeze({ kind: row.outcomeKind, ok: true as const, row });
    case "TERMINALIZED":
      return terminalize(row, parsed);
    case "DRAINING":
      // A post-activation row may leave DRAINING only on adapter proof; proven
      // release without that proof is an unreconciled effect, not a finished one.
      if (parsed.resourceFact !== "PROVEN_RELEASED") {
        return draining(row, parsed);
      }
      return parsed.reconciliation === null
        ? refuse(
            "DRAIN_RESOURCE_UNRECONCILED",
            "resources read as released but no adapter reconciliation accounts for the effect",
          )
        : terminalize(row, parsed);
    default:
      return notAdmitted("the matched row declares no disposition this resolver can honour");
  }
}
