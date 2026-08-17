import { deepFreeze, isCanonicalUtcTimestamp } from "../canonical.js";
import type { ClaudeReconciledOutcome } from "../providers/claude/claude-cancel-reconcile.js";
import {
  PROVIDER_INFRASTRUCTURE_OUTCOMES,
  PROVIDER_TELEMETRY_CONTRACT_VERSION,
  PROVIDER_TERMINAL_OUTCOMES,
  snapshotRunRef,
  type ProviderInfrastructureOutcome,
  type ProviderRunRef,
  type ProviderTelemetryRefusal,
  type ProviderTerminalOutcome,
  type ProviderText,
} from "../providers/telemetry/provider-telemetry-contracts.js";
import type { EffectIntent, TerminalEffectState } from "./effect-kernel.js";
import { exactRecord, isDigest, oneOf } from "./effect-shape.js";

/**
 * The admitted input, the refusal vocabulary and the settlement mapping for
 * `provider-effect-settlement.ts`. Split out so neither file grows past the size
 * a reviewer can hold: the table is a contract, the derivation beside it is a
 * behaviour, and they change for different reasons.
 *
 * The EXACT input is the load-bearing part. It carries no `target`,
 * `outcomeClass`, `uncertainty`, `adoptedAt`, result bytes or terminal intent, so
 * a caller cannot supply the authority the settlement derives — the substitute
 * is unrepresentable rather than validated away.
 */
export const PROVIDER_EFFECT_SETTLEMENT_VERSION = "moe-provider-effect-settlement/1" as const;
export const PROVIDER_EFFECT_SETTLEMENT_LAYER = "PROVIDER_EFFECT_SETTLEMENT" as const;

/** The closed refusal vocabulary this layer owns; reducer codes stay the reducer's. */
export const PROVIDER_SETTLEMENT_CODES = Object.freeze([
  "PROVIDER_SETTLEMENT_INTENT_MALFORMED",
  "PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED",
  "PROVIDER_SETTLEMENT_SOURCE_VERSION_UNSUPPORTED",
  "PROVIDER_SETTLEMENT_RUN_REF_MALFORMED",
  "PROVIDER_SETTLEMENT_EFFECT_BINDING_MISMATCH",
  "PROVIDER_SETTLEMENT_UPSTREAM_REFUSED",
  "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_ABSENT",
  "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_UNKNOWN",
  "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_MALFORMED",
] as const);
export type ProviderSettlementCode = (typeof PROVIDER_SETTLEMENT_CODES)[number];

/** Static per-code text: a message quoting provider bytes would re-leak them. */
export const PROVIDER_SETTLEMENT_MESSAGES: Readonly<Record<ProviderSettlementCode, string>> =
  Object.freeze({
    PROVIDER_SETTLEMENT_INTENT_MALFORMED: "the snapshotted effect intent does not parse",
    PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED: "the provider observation is not an exact record",
    PROVIDER_SETTLEMENT_SOURCE_VERSION_UNSUPPORTED:
      "the observation names a telemetry contract version this settlement cannot read",
    PROVIDER_SETTLEMENT_RUN_REF_MALFORMED: "the provider run reference is not an exact record",
    PROVIDER_SETTLEMENT_EFFECT_BINDING_MISMATCH: "the run reference names another effect intent",
    PROVIDER_SETTLEMENT_UPSTREAM_REFUSED: "an upstream layer refused this run, so it proves nothing",
    PROVIDER_SETTLEMENT_COMPLETION_INSTANT_ABSENT: "no completion instant was recorded for this run",
    PROVIDER_SETTLEMENT_COMPLETION_INSTANT_UNKNOWN:
      "the provider recorded that it does not know when this run completed",
    PROVIDER_SETTLEMENT_COMPLETION_INSTANT_MALFORMED:
      "the recorded completion instant is not a canonical UTC timestamp",
  });

export interface ProviderSettlementRefusal {
  readonly ok: false;
  readonly code: ProviderSettlementCode;
  readonly layer: typeof PROVIDER_EFFECT_SETTLEMENT_LAYER;
  readonly message: string;
}

export const PROVIDER_RUN_OBSERVATION_KEYS = Object.freeze([
  "sourceVersion",
  "sourceDigest",
  "runRef",
  "terminal",
  "infrastructure",
  "upstreamRefusal",
  "completedAt",
] as const);

export interface ProviderRunObservation {
  readonly sourceVersion: typeof PROVIDER_TELEMETRY_CONTRACT_VERSION;
  readonly sourceDigest: string;
  readonly runRef: ProviderRunRef;
  readonly terminal: ProviderTerminalOutcome;
  readonly infrastructure: ProviderInfrastructureOutcome;
  readonly upstreamRefusal: ProviderTelemetryRefusal | null;
  /** `null` = nothing recorded; the `known: false` arm = the provider does not know. */
  readonly completedAt: ProviderText | null;
}

export type ProviderSettlementDisposition = TerminalEffectState | "DRAIN";

export interface ProviderSettlementRow {
  readonly from: EffectIntent["state"];
  readonly terminal: ProviderTerminalOutcome;
  readonly infrastructure: ProviderInfrastructureOutcome;
  readonly disposition: ProviderSettlementDisposition;
}

/**
 * The whole mapping, as data rather than as branching, so an exhaustive sweep
 * drives the real table instead of re-deriving the same conditions in a test.
 *
 * Only these four of the 120 published cells buy anything; every other cell is
 * honestly UNKNOWN. `MAX_TURNS_EXHAUSTED` and `REFUSED` are genuine terminal
 * provider facts and are deliberately ABSENT: neither is a completion or an
 * error, so neither may buy SUCCEEDED or FAILED. A cancellation observed on an
 * ACTIVE intent is a drain instruction (design 13.1), never a terminal.
 */
export const PROVIDER_SETTLEMENT_ADMITTED_ROWS: readonly ProviderSettlementRow[] = deepFreeze([
  { from: "ACTIVE", terminal: "COMPLETED", infrastructure: "NONE", disposition: "SUCCEEDED" },
  {
    from: "ACTIVE",
    terminal: "ERROR_DURING_EXECUTION",
    infrastructure: "NONE",
    disposition: "FAILED",
  },
  { from: "ACTIVE", terminal: "CANCELLED", infrastructure: "NONE", disposition: "DRAIN" },
  {
    from: "CANCEL_REQUESTED",
    terminal: "CANCELLED",
    infrastructure: "NONE",
    disposition: "CANCELLED",
  },
] as const satisfies readonly ProviderSettlementRow[]);

/** Reuses the published reconciliation vocabulary rather than forking a second one. */
export const PROVIDER_SETTLEMENT_OUTCOME_CLASSES: Readonly<
  Record<TerminalEffectState, ClaudeReconciledOutcome>
> = Object.freeze({
  SUCCEEDED: "PROVEN_RESULT",
  FAILED: "CRASHED",
  CANCELLED: "CANCELLED_CLEAN",
  UNKNOWN: "HONEST_UNKNOWN",
});

export type ProviderObservationAdmission =
  | { readonly ok: true; readonly observation: ProviderRunObservation; readonly adoptedAt: string }
  | { readonly ok: false; readonly code: ProviderSettlementCode };

type InstantAdmission =
  | { readonly ok: true; readonly at: string }
  | { readonly ok: false; readonly code: ProviderSettlementCode };

const REFUSAL_KEYS = ["ok", "code", "layer", "message"] as const;
const KNOWN_TEXT_KEYS = ["known", "value"] as const;
const UNKNOWN_FACT_KEYS = ["known", "code", "layer"] as const;

const no = (code: ProviderSettlementCode): ProviderObservationAdmission => ({ ok: false, code });
const noInstant = (code: ProviderSettlementCode): InstantAdmission => ({ ok: false, code });

/**
 * Reads the completion instant's three distinct arms apart. They are NOT folded:
 * nothing recorded, the provider recording that it does not know, and a recorded
 * value that is not an instant are three different facts about the same field.
 */
function admitInstant(value: unknown): InstantAdmission {
  if (value === null) return noInstant("PROVIDER_SETTLEMENT_COMPLETION_INSTANT_ABSENT");
  const known = exactRecord(value, KNOWN_TEXT_KEYS);
  if (known !== null && known["known"] === true) {
    return isCanonicalUtcTimestamp(known["value"])
      ? { ok: true, at: known["value"] }
      : noInstant("PROVIDER_SETTLEMENT_COMPLETION_INSTANT_MALFORMED");
  }
  const absent = exactRecord(value, UNKNOWN_FACT_KEYS);
  if (absent === null || absent["known"] !== false) {
    return noInstant("PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED");
  }
  return noInstant("PROVIDER_SETTLEMENT_COMPLETION_INSTANT_UNKNOWN");
}

/**
 * Total by construction: every arm answers a code, so a malformed, foreign or
 * unverifiable observation is never partly adopted. The binding is checked here,
 * before any settlement fact is derived from the record.
 */
export function admitProviderRunObservation(
  intent: EffectIntent,
  value: unknown,
): ProviderObservationAdmission {
  const parsed = exactRecord(value, PROVIDER_RUN_OBSERVATION_KEYS);
  if (parsed === null) return no("PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED");
  if (parsed["sourceVersion"] !== PROVIDER_TELEMETRY_CONTRACT_VERSION) {
    return no("PROVIDER_SETTLEMENT_SOURCE_VERSION_UNSUPPORTED");
  }
  if (
    !isDigest(parsed["sourceDigest"]) ||
    !oneOf(parsed["terminal"], PROVIDER_TERMINAL_OUTCOMES) ||
    !oneOf(parsed["infrastructure"], PROVIDER_INFRASTRUCTURE_OUTCOMES)
  ) {
    return no("PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED");
  }
  const runRef = snapshotRunRef(parsed["runRef"]);
  if (runRef === null) return no("PROVIDER_SETTLEMENT_RUN_REF_MALFORMED");
  if (runRef.effectIntentId !== intent.intentId) {
    return no("PROVIDER_SETTLEMENT_EFFECT_BINDING_MISMATCH");
  }
  const refusal = parsed["upstreamRefusal"];
  if (refusal !== null) {
    return exactRecord(refusal, REFUSAL_KEYS) === null
      ? no("PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED")
      : no("PROVIDER_SETTLEMENT_UPSTREAM_REFUSED");
  }
  const instant = admitInstant(parsed["completedAt"]);
  if (!instant.ok) return no(instant.code);
  return {
    ok: true,
    observation: { ...parsed, runRef } as unknown as ProviderRunObservation,
    adoptedAt: instant.at,
  };
}
