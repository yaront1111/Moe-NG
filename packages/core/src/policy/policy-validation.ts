/**
 * Hostile-input boundary for the policy area. Cloned from `planning-snapshot.ts` rather than
 * imported: `packages/core/src` has no cross-area imports, and goal -> planning was already a
 * documented clone. Accessors, proxies, symbols, cycles, and exotic prototypes are snapshotted
 * into inert data once, and every later check reads only the snapshot.
 *
 * Nothing in this validation module computes an identity. `validHex64` checks the SHAPE of a
 * supplied digest; policy content hashing lives in the sibling digest module.
 */
import { RUNTIME_LIFECYCLES } from "@moe/contracts";
import type { RuntimeTruthClass } from "@moe/contracts";

import { POLICY_OBLIGATION_KINDS, POLICY_RISK_TIERS, POLICY_RULE_EFFECTS } from
  "./policy-contract.js";
import type {
  PolicyAutoApprovalOptIn,
  PolicyEvaluationInput,
  PolicyFactInput,
  PolicyObligation,
  PolicyRiskTier,
  PolicyRule,
  PolicySlice,
  PolicyWaiver,
} from "./policy-contract.js";

type Snapshot = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const FAILURE = Object.freeze({ ok: false as const });

function snapshotArray(source: readonly unknown[], seen: WeakSet<object>): Snapshot {
  const descriptor = Object.getOwnPropertyDescriptor(source, "length");
  const length = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return FAILURE;
  if (Reflect.ownKeys(source).filter((key) => key !== "length").length !== length) return FAILURE;
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(source, String(index));
    if (entry === undefined || !entry.enumerable || !("value" in entry)) return FAILURE;
    const nested = snapshotData(entry.value, seen);
    if (!nested.ok) return nested;
    items.push(nested.value);
  }
  return { ok: true, value: items };
}

/** Copies hostile input into inert data. Any exotic member fails the whole snapshot closed. */
export function snapshotData(value: unknown, seen = new WeakSet<object>()): Snapshot {
  const kind = typeof value;
  if (value === null || kind === "undefined" || kind === "boolean" || kind === "number"
    || kind === "string") return { ok: true, value };
  if (kind !== "object") return FAILURE;
  const source = value as object;
  if (seen.has(source)) return FAILURE;
  seen.add(source);
  try {
    if (Array.isArray(source)) return snapshotArray(source, seen);
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) return FAILURE;
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") return FAILURE;
      const entry = Object.getOwnPropertyDescriptor(source, key);
      if (entry === undefined || !entry.enumerable || !("value" in entry)) return FAILURE;
      const nested = snapshotData(entry.value, seen);
      if (!nested.ok) return nested;
      copy[key] = nested.value;
    }
    return { ok: true, value: copy };
  } catch {
    return FAILURE;
  } finally {
    seen.delete(source);
  }
}

/**
 * Exact-key match. The descriptor checks matter because these guards are exported: a caller
 * outside this module may reach them with a value that never passed through `snapshotData`,
 * where an accessor or a non-enumerable key would otherwise satisfy `Object.hasOwn`.
 */
export function exact(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const HEX64 = /^[0-9a-f]{64}$/;
export function validRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
export function validHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}
/** Design truth floor: only a daemon-verified or human-approved fact can ground a risk tier. */
export function strongTruth(value: unknown): boolean {
  return value === "DAEMON_VERIFIED" || value === "HUMAN_APPROVED";
}
export function validTruthClass(value: unknown): value is RuntimeTruthClass {
  return typeof value === "string"
    && RUNTIME_LIFECYCLES.TRUTH_CLASS.some((entry) => entry === value);
}
export function validEpochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function validTier(value: unknown): value is PolicyRiskTier {
  return typeof value === "string" && POLICY_RISK_TIERS.some((tier) => tier === value);
}
export function tierRank(tier: PolicyRiskTier): number {
  return POLICY_RISK_TIERS.indexOf(tier);
}
/** Maximum of two tiers; a null operand contributes nothing rather than defaulting to R0. */
export function maxTier(left: PolicyRiskTier | null, right: PolicyRiskTier | null):
PolicyRiskTier | null {
  if (left === null) return right;
  if (right === null) return left;
  return tierRank(left) >= tierRank(right) ? left : right;
}
function validRefList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(validRef);
}
function uniqueRefs(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const OBLIGATION_KEYS = ["kind", "obligationId"] as const;
const FACT_KEYS = ["factId", "tier", "truthClass"] as const;
const RULE_KEYS = ["effect", "obligations", "requiredFactIds", "ruleId"] as const;
const OPT_IN_KEYS = ["action", "tier"] as const;
const CLASSIFICATION_KEYS = ["factId", "tier"] as const;
export const SLICE_KEYS = Object.freeze(["autoApprovalOptIns", "rules", "sliceRef"] as const);
export const CLASSIFIED_SLICE_KEYS = Object.freeze([...SLICE_KEYS, "riskClassifications"] as const);
export const POLICY_CLASSIFICATION_LIMITS = Object.freeze({ entries: 512, factIdBytes: 512 });
const UTF8 = new TextEncoder();
/** Unicode "other": control, format, surrogate, private-use, unassigned. None may spell an id. */
const OPAQUE_CHARACTER = /\p{C}/u;
const WAIVER_KEYS = [
  "expiresAtEpochMs", "humanApprovalRef", "namedObligationId", "scope", "waiverRef",
] as const;
const INPUT_KEYS = [
  "action", "actor", "callerRiskHint", "decisionDigest", "evaluatedAtEpochMs", "evaluatorVersion",
  "facts", "graphNodeRevisionRefs", "policyRevisionRef", "requiredFactIds", "scope", "sliceChain",
  "waivers",
] as const;
export function validObligation(value: unknown): value is PolicyObligation {
  return exact(value, OBLIGATION_KEYS)
    && POLICY_OBLIGATION_KINDS.some((kind) => kind === value["kind"])
    && validRef(value["obligationId"]);
}
export function validFact(value: unknown): value is PolicyFactInput {
  return exact(value, FACT_KEYS) && validRef(value["factId"])
    && (value["tier"] === null || validTier(value["tier"]))
    && validTruthClass(value["truthClass"]);
}
export function validRule(value: unknown): value is PolicyRule {
  return exact(value, RULE_KEYS) && validRef(value["ruleId"])
    && POLICY_RULE_EFFECTS.some((effect) => effect === value["effect"])
    && Array.isArray(value["obligations"]) && value["obligations"].every(validObligation)
    && validRefList(value["requiredFactIds"]);
}
/** Design 710: an opt-in naming R2 or R3 is structurally illegal, not merely overridden. */
export function validOptIn(value: unknown): value is PolicyAutoApprovalOptIn {
  return exact(value, OPT_IN_KEYS) && validRef(value["action"])
    && (value["tier"] === "R0" || value["tier"] === "R1");
}
/**
 * The policy-declared risk table: bounded, exactly-keyed, closed-tier and duplicate-free. Fact
 * ids are bounded in UTF-8 BYTES, not code units, and must ALREADY be NFC — normalizing here
 * would let two spellings of one id both classify while the duplicate check could no longer see
 * the collision it had just created. Two tiers for one id have no fail-closed reading (order
 * would decide risk), so the whole table is refused rather than resolved by position.
 */
function validClassifications(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > POLICY_CLASSIFICATION_LIMITS.entries) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!exact(entry, CLASSIFICATION_KEYS) || !validTier(entry["tier"])) return false;
    const factId: unknown = entry["factId"];
    if (!validRef(factId) || OPAQUE_CHARACTER.test(factId)) return false;
    if (factId.normalize("NFC") !== factId || seen.has(factId)) return false;
    if (UTF8.encode(factId).length > POLICY_CLASSIFICATION_LIMITS.factIdBytes) return false;
    seen.add(factId);
  }
  return true;
}

/**
 * Exactly the legacy three keys or exactly the classified four. An explicitly `undefined` table
 * satisfies the four-key shape and is then refused by the table guard, so "present but
 * unreadable" can never degrade into "classifies nothing".
 */
export function validSlice(value: unknown): value is PolicySlice {
  const classified = exact(value, CLASSIFIED_SLICE_KEYS);
  if (!classified && !exact(value, SLICE_KEYS)) return false;
  const slice = value as Readonly<Record<string, unknown>>;
  return validRef(slice["sliceRef"])
    && Array.isArray(slice["rules"]) && slice["rules"].every(validRule)
    && Array.isArray(slice["autoApprovalOptIns"])
    && slice["autoApprovalOptIns"].every(validOptIn)
    && (!classified || validClassifications(slice["riskClassifications"]));
}
export function validWaiver(value: unknown): value is PolicyWaiver {
  return exact(value, WAIVER_KEYS) && validRef(value["waiverRef"])
    && validRef(value["namedObligationId"]) && validRef(value["humanApprovalRef"])
    && validRefList(value["scope"]) && validEpochMs(value["expiresAtEpochMs"]);
}
/**
 * Validates the snapshotted evaluation input. A duplicate fact ID and an empty slice chain are
 * refusals, not defaults: neither has a fail-closed interpretation.
 */
export function validateEvaluationInput(value: unknown): PolicyEvaluationInput | undefined {
  const snapshot = snapshotData(value);
  if (!snapshot.ok) return undefined;
  const input = snapshot.value;
  if (!exact(input, INPUT_KEYS)) return undefined;
  if (!validRef(input["action"]) || !validRef(input["actor"])
    || !validRef(input["evaluatorVersion"]) || !validHex64(input["decisionDigest"])
    || !validHex64(input["policyRevisionRef"]) || !validEpochMs(input["evaluatedAtEpochMs"])
    || (input["callerRiskHint"] !== null && !validTier(input["callerRiskHint"]))
    || !validRefList(input["graphNodeRevisionRefs"]) || !validRefList(input["scope"])
    || !validRefList(input["requiredFactIds"]) || !uniqueRefs(input["requiredFactIds"])) {
    return undefined;
  }
  const facts = input["facts"];
  if (!Array.isArray(facts) || !facts.every(validFact)
    || !uniqueRefs(facts.map((entry) => entry.factId))) return undefined;
  const chain = input["sliceChain"];
  if (!Array.isArray(chain) || chain.length === 0 || !chain.every(validSlice)) return undefined;
  const waivers = input["waivers"];
  if (!Array.isArray(waivers) || !waivers.every(validWaiver)
    || !uniqueRefs(waivers.map((entry) => entry.waiverRef))) return undefined;
  return input as unknown as PolicyEvaluationInput;
}
