import {
  isMonotonicDisposition,
  parseDrainDisposition,
  type DrainDisposition,
} from "./drain-disposition.js";
import {
  DRAIN_ATTEMPT_STATES,
  RESOURCE_FACTS,
  type DrainAttemptState,
  type ResourceFact,
} from "./drain-table.js";
import type {
  ActivationGrant,
  AttemptSlice,
  EffectClaim,
  EffectIntent,
  EffectTombstone,
  SettlementEvidence,
} from "./effect-kernel.js";
import {
  parseActivationGrant,
  parseAttemptSlice,
  parseEffectClaim,
  parseEffectIntent,
  parseEffectTombstone,
} from "./effect-parse.js";
import { exactRecord, isRef, oneOf } from "./effect-shape.js";
import {
  parseLaunchLockRegistration,
  LAUNCH_LOCK_OBSERVED_STATES,
  type LaunchLockObservedState,
  type LaunchLockRegistration,
} from "./launch-lock.js";
import { parseProcessExit } from "./process-observation.js";
import type { ClaudeProcessExit } from "../providers/claude/claude-cancel-reconcile.js";
import { parseReconciliationReference } from "./process-observation.js";

/**
 * The durable record set a restarting wrapper reads back, and nothing else.
 *
 * Every field is a record somebody committed before the crash. There is no
 * clock and no process here: the reconstruction cannot look at the world to
 * break a tie, so a record set that admits two readings has to say so rather
 * than pick one.
 */
export interface RestartRecords {
  readonly intent: EffectIntent;
  readonly attempt: AttemptSlice | null;
  readonly attemptState: DrainAttemptState;
  readonly claim: EffectClaim | null;
  readonly grant: ActivationGrant | null;
  readonly tombstone: EffectTombstone | null;
  readonly registration: LaunchLockRegistration | null;
  readonly lockState: LaunchLockObservedState;
  readonly observation: ClaudeProcessExit | null;
  readonly reconciliation: SettlementEvidence | null;
  readonly resourceFact: ResourceFact;
  readonly disposition: DrainDisposition;
  readonly safeHandoff: string | null;
}

const RECORD_KEYS = [
  "intent",
  "attempt",
  "attemptState",
  "claim",
  "grant",
  "tombstone",
  "registration",
  "lockState",
  "observation",
  "reconciliation",
  "resourceFact",
  "disposition",
  "safeHandoff",
] as const;

/** `null` stays `null`; anything present must parse or the whole set is rejected. */
function optional<T>(value: unknown, parse: (input: unknown) => T | null): T | null | false {
  if (value === null) return null;
  const parsed = parse(value);
  return parsed === null ? false : parsed;
}

export function parseRestartRecords(value: unknown): RestartRecords | null {
  const raw = exactRecord(value, RECORD_KEYS);
  if (raw === null) return null;
  const intent = parseEffectIntent(raw["intent"]);
  if (intent === null) return null;
  const attempt = optional(raw["attempt"], parseAttemptSlice);
  const claim = optional(raw["claim"], parseEffectClaim);
  const grant = optional(raw["grant"], parseActivationGrant);
  const tombstone = optional(raw["tombstone"], parseEffectTombstone);
  const registration = optional(raw["registration"], parseLaunchLockRegistration);
  const observation = optional(raw["observation"], parseProcessExit);
  const reconciliation = optional(raw["reconciliation"], parseReconciliationReference);
  if (
    attempt === false ||
    claim === false ||
    grant === false ||
    tombstone === false ||
    registration === false ||
    observation === false ||
    reconciliation === false
  ) {
    return null;
  }
  if (!oneOf(raw["attemptState"], DRAIN_ATTEMPT_STATES)) return null;
  if (!oneOf(raw["lockState"], LAUNCH_LOCK_OBSERVED_STATES)) return null;
  if (!oneOf(raw["resourceFact"], RESOURCE_FACTS)) return null;
  if (raw["safeHandoff"] !== null && !isRef(raw["safeHandoff"])) return null;
  const disposition = parseDrainDisposition(raw["disposition"]);
  if (disposition === null || !isMonotonicDisposition(disposition)) return null;
  return {
    intent,
    attempt,
    attemptState: raw["attemptState"],
    claim,
    grant,
    tombstone,
    registration,
    lockState: raw["lockState"],
    observation,
    reconciliation,
    resourceFact: raw["resourceFact"],
    disposition,
    safeHandoff: raw["safeHandoff"] === null ? null : (raw["safeHandoff"] as string),
  };
}

/**
 * Structural disagreements between records that were supposed to be written
 * together. Design 788: the attempt and the effect become `RUNNING`/`ACTIVE`
 * "or neither", so an ACTIVE effect over a pre-launch attempt is half a commit.
 */
export function recordsDisagree(records: RestartRecords): boolean {
  if (records.attempt !== null && records.attempt.state !== records.attemptState) return true;
  if (records.attempt !== null && records.attempt.intentId !== records.intent.intentId) return true;
  const preLaunch: readonly DrainAttemptState[] = ["ABSENT", "LEASED", "LAUNCH_REQUESTED"];
  return records.intent.state === "ACTIVE" && preLaunch.includes(records.attemptState);
}
