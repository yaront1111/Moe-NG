import { isCanonicalUtcTimestamp } from "../canonical.js";
import {
  ATTEMPT_SLICE_STATES,
  EFFECT_COMMANDS,
  EFFECT_STATES,
  GRANT_STATES,
  SUPERVISOR_EFFECT_PROTOCOL_VERSION,
  type ActivationGrant,
  type AttemptSlice,
  type DependencyWitness,
  type EffectClaim,
  type EffectIntent,
  type EffectState,
  type EffectTombstone,
  type SettlementEvidence,
  type UncertaintyEvidence,
} from "./effect-kernel.js";
import {
  exactRecord,
  isCount,
  isDigest,
  isRef,
  oneOf,
  parseMirroredLease,
} from "./effect-shape.js";

/**
 * Full-strictness parsers for every supervisor record.
 *
 * Each parser reads an exact own-data-key set, so an extra field, an accessor,
 * or a prototype-supplied value is refused rather than silently ignored. Every
 * counter is a safe integer within the mirrored ceiling: `canonicalJson` throws
 * on a bigint and on a non-safe number, so a counter that parsed but could not
 * be digested would strand the record it belongs to.
 *
 * A parser answers `null` and never a refusal, so the caller decides which code
 * and which layer the failure belongs to.
 */

const INTENT_KEYS = [
  "protocolVersion",
  "intentId",
  "aggregateId",
  "expectedGraphEpoch",
  "leaseBinding",
  "inputBinding",
  "predecessorCursor",
  "desiredState",
  "idempotencyKey",
  "runtimeObservationDigest",
  "state",
  "version",
] as const;
const ATTEMPT_KEYS = ["attemptId", "aggregateId", "intentId", "state", "version"] as const;
const CLAIM_KEYS = ["claimId", "intentId", "wrapperIdentity", "lockIdentity", "claimedAt"] as const;
const TOMBSTONE_KEYS = ["intentId", "reason", "terminalizedAt"] as const;
const GRANT_KEYS = ["grantId", "intentId", "wrapperIdentity", "state", "version"] as const;
const SETTLEMENT_KEYS = ["reconciliationVersion", "reconciliationDigest", "outcomeClass"] as const;
const UNCERTAINTY_KEYS = ["uncertaintyReason", "uncertaintyDigest"] as const;
const WITNESS_KEYS = ["witnessId", "expectedDigest", "observedDigest"] as const;
const SETTLE_COMMAND_KEYS = ["kind", "target", "settlement", "uncertainty", "adoptedAt"] as const;
const SIMPLE_COMMAND_KEYS = ["kind"] as const;

export interface SettleCommand {
  readonly kind: "settle";
  readonly target: EffectState;
  /** Left `unknown` so the lifecycle decides the evidence-specific refusal code. */
  readonly settlement: unknown;
  readonly uncertainty: unknown;
  readonly adoptedAt: string;
}
export interface SimpleCommand {
  readonly kind: Exclude<(typeof EFFECT_COMMANDS)[number], "settle">;
}
export type EffectCommandInput = SimpleCommand | SettleCommand;

export function parseEffectIntent(value: unknown): EffectIntent | null {
  const parsed = exactRecord(value, INTENT_KEYS);
  if (parsed === null) return null;
  if (parsed["protocolVersion"] !== SUPERVISOR_EFFECT_PROTOCOL_VERSION) return null;
  if (!isRef(parsed["intentId"]) || !isRef(parsed["aggregateId"])) return null;
  if (!isCount(parsed["expectedGraphEpoch"]) || !isCount(parsed["version"])) return null;
  if (parseMirroredLease(parsed["leaseBinding"]) === null) return null;
  if (!isDigest(parsed["inputBinding"]) || !isRef(parsed["predecessorCursor"])) return null;
  if (!isRef(parsed["desiredState"]) || !isRef(parsed["idempotencyKey"])) return null;
  if (!isDigest(parsed["runtimeObservationDigest"])) return null;
  if (!oneOf(parsed["state"], EFFECT_STATES)) return null;
  return parsed as unknown as EffectIntent;
}

export function parseAttemptSlice(value: unknown): AttemptSlice | null {
  const parsed = exactRecord(value, ATTEMPT_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["attemptId"]) || !isRef(parsed["aggregateId"])) return null;
  if (!isRef(parsed["intentId"]) || !isCount(parsed["version"])) return null;
  if (!oneOf(parsed["state"], ATTEMPT_SLICE_STATES)) return null;
  return parsed as unknown as AttemptSlice;
}

export function parseEffectClaim(value: unknown): EffectClaim | null {
  const parsed = exactRecord(value, CLAIM_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["claimId"]) || !isRef(parsed["intentId"])) return null;
  if (!isRef(parsed["wrapperIdentity"]) || !isRef(parsed["lockIdentity"])) return null;
  if (!isCanonicalUtcTimestamp(parsed["claimedAt"])) return null;
  return parsed as unknown as EffectClaim;
}

export function parseEffectTombstone(value: unknown): EffectTombstone | null {
  const parsed = exactRecord(value, TOMBSTONE_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["intentId"]) || !isRef(parsed["reason"])) return null;
  if (!isCanonicalUtcTimestamp(parsed["terminalizedAt"])) return null;
  return parsed as unknown as EffectTombstone;
}

export function parseActivationGrant(value: unknown): ActivationGrant | null {
  const parsed = exactRecord(value, GRANT_KEYS);
  if (parsed === null) return null;
  if (!isDigest(parsed["grantId"]) || !isRef(parsed["intentId"])) return null;
  if (!isRef(parsed["wrapperIdentity"]) || !isCount(parsed["version"])) return null;
  if (!oneOf(parsed["state"], GRANT_STATES)) return null;
  return parsed as unknown as ActivationGrant;
}

export function parseSettlementEvidence(value: unknown): SettlementEvidence | null {
  const parsed = exactRecord(value, SETTLEMENT_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["reconciliationVersion"]) || !isRef(parsed["outcomeClass"])) return null;
  if (!isDigest(parsed["reconciliationDigest"])) return null;
  return parsed as unknown as SettlementEvidence;
}

export function parseUncertaintyEvidence(value: unknown): UncertaintyEvidence | null {
  const parsed = exactRecord(value, UNCERTAINTY_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["uncertaintyReason"]) || !isDigest(parsed["uncertaintyDigest"])) return null;
  return parsed as unknown as UncertaintyEvidence;
}

export function parseDependencyWitness(value: unknown): DependencyWitness | null {
  const parsed = exactRecord(value, WITNESS_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["witnessId"]) || !isDigest(parsed["expectedDigest"])) return null;
  if (!isDigest(parsed["observedDigest"])) return null;
  return parsed as unknown as DependencyWitness;
}

/**
 * The command envelope only. Settlement evidence stays `unknown` here so a
 * malformed reconciliation reference reports its own code instead of collapsing
 * into a generic malformed-command refusal.
 */
export function parseCommandInput(value: unknown): EffectCommandInput | null {
  const settle = exactRecord(value, SETTLE_COMMAND_KEYS);
  if (settle !== null) {
    if (settle["kind"] !== "settle" || !oneOf(settle["target"], EFFECT_STATES)) return null;
    if (!isCanonicalUtcTimestamp(settle["adoptedAt"])) return null;
    return settle as unknown as SettleCommand;
  }
  const simple = exactRecord(value, SIMPLE_COMMAND_KEYS);
  if (simple === null) return null;
  if (!oneOf(simple["kind"], EFFECT_COMMANDS) || simple["kind"] === "settle") return null;
  return simple as unknown as SimpleCommand;
}
