import { canonicalDigest, deepFreeze } from "../canonical.js";
import type { EffectIntent } from "./effect-kernel.js";
import { applyEffectCommand, type LifecycleOutcome } from "./effect-lifecycle.js";
import { parseEffectIntent } from "./effect-parse.js";
import {
  admitProviderRunObservation,
  PROVIDER_EFFECT_SETTLEMENT_LAYER,
  PROVIDER_EFFECT_SETTLEMENT_VERSION,
  PROVIDER_SETTLEMENT_ADMITTED_ROWS,
  PROVIDER_SETTLEMENT_MESSAGES,
  PROVIDER_SETTLEMENT_OUTCOME_CLASSES,
  type ProviderRunObservation,
  type ProviderSettlementCode,
  type ProviderSettlementDisposition,
  type ProviderSettlementRefusal,
} from "./provider-settlement-contracts.js";

/**
 * Turns ONE canonical provider-run observation into the only effect terminal its
 * evidence proves (design 13.1, 774-779). Consumer: task-1879166d7f12474fad8038e2a9d2433a.
 *
 * The reducer this delegates to accepts a caller-chosen `target`: it validates
 * the admitted arc and the SHAPE of the settlement evidence, but nothing there
 * compares `outcomeClass` to `target`, so ACTIVE + `target: "SUCCEEDED"` +
 * `outcomeClass: "HONEST_UNKNOWN"` transitions to SUCCEEDED. That is not fixed by
 * a second reducer — there is exactly one — it is fixed by making the choice
 * unreachable: the admitted observation has no field to carry a target, and
 * every settlement fact below is DERIVED before `applyEffectCommand` is called,
 * whose output is then returned UNCHANGED.
 *
 * `ProviderRunRef.epoch` is deliberately NOT compared to
 * `EffectIntent.expectedGraphEpoch`: those are counters from different domains
 * and equating them would invent an authority this module has no basis for. The
 * epoch is bound into the reconciliation digest instead, so an observation from
 * another epoch cannot be swapped in under an identical receipt.
 */
export type ProviderSettlementOutcome =
  | LifecycleOutcome
  | {
      readonly kind: "PROVIDER_SETTLEMENT_REFUSED";
      readonly failure: ProviderSettlementRefusal;
    };

function refuse(code: ProviderSettlementCode): ProviderSettlementOutcome {
  return deepFreeze({
    kind: "PROVIDER_SETTLEMENT_REFUSED" as const,
    failure: {
      ok: false as const,
      code,
      layer: PROVIDER_EFFECT_SETTLEMENT_LAYER,
      message: PROVIDER_SETTLEMENT_MESSAGES[code],
    },
  });
}

/** The exact value hashed into `SettlementEvidence.reconciliationDigest`. */
function settlementPreimage(
  observation: ProviderRunObservation,
  completedAt: string,
): Record<string, unknown> {
  return {
    settlementVersion: PROVIDER_EFFECT_SETTLEMENT_VERSION,
    sourceVersion: observation.sourceVersion,
    sourceDigest: observation.sourceDigest,
    runRef: observation.runRef,
    terminal: observation.terminal,
    infrastructure: observation.infrastructure,
    completedAt,
  };
}

/** The exact value hashed into `UncertaintyEvidence.uncertaintyDigest`. */
function uncertaintyPreimage(
  observation: ProviderRunObservation,
  unprovenFrom: string,
): Record<string, unknown> {
  return {
    settlementVersion: PROVIDER_EFFECT_SETTLEMENT_VERSION,
    unprovenFrom,
    terminal: observation.terminal,
    infrastructure: observation.infrastructure,
    runRef: observation.runRef,
    sourceDigest: observation.sourceDigest,
  };
}

function dispositionOf(
  intent: EffectIntent,
  observation: ProviderRunObservation,
): ProviderSettlementDisposition {
  const row = PROVIDER_SETTLEMENT_ADMITTED_ROWS.find(
    (entry) =>
      entry.from === intent.state &&
      entry.terminal === observation.terminal &&
      entry.infrastructure === observation.infrastructure,
  );
  return row?.disposition ?? "UNKNOWN";
}

/**
 * Snapshots an intent and one versioned provider observation, derives the single
 * settlement its evidence supports, and returns the production reducer's output
 * unchanged. It never builds an `EffectResult` itself.
 */
export function settleEffectFromProviderObservation(
  intentValue: unknown,
  observationValue: unknown,
): ProviderSettlementOutcome {
  const intent = parseEffectIntent(intentValue);
  if (intent === null) return refuse("PROVIDER_SETTLEMENT_INTENT_MALFORMED");
  const admitted = admitProviderRunObservation(intent, observationValue);
  if (!admitted.ok) return refuse(admitted.code);
  const { observation, adoptedAt } = admitted;
  const disposition = dispositionOf(intent, observation);
  // Design 13.1: once activation has committed, a cancellation is an instruction
  // to drain and reconcile, not a terminal anyone may adopt from a distance.
  if (disposition === "DRAIN") return applyEffectCommand(intent, { kind: "requestCancel" });
  const settlement = {
    reconciliationVersion: PROVIDER_EFFECT_SETTLEMENT_VERSION,
    reconciliationDigest: canonicalDigest(settlementPreimage(observation, adoptedAt)),
    outcomeClass: PROVIDER_SETTLEMENT_OUTCOME_CLASSES[disposition],
  };
  const uncertainty =
    disposition === "UNKNOWN"
      ? {
          uncertaintyReason: PROVIDER_SETTLEMENT_OUTCOME_CLASSES.UNKNOWN,
          uncertaintyDigest: canonicalDigest(uncertaintyPreimage(observation, intent.state)),
        }
      : null;
  return applyEffectCommand(intent, {
    kind: "settle",
    target: disposition,
    settlement,
    uncertainty,
    adoptedAt,
  });
}
