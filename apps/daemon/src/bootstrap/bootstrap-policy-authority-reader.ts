import type { JsonObject, JsonValue } from "@moe/contracts";
import {
  POLICY_SLICE_DIGEST_VERSION, derivePolicySliceDigest, evaluatePolicy,
} from "@moe/core";
import type { PolicyOutcome } from "@moe/core";

import {
  POLICY_DECISION_DIGEST_VERSION,
  POLICY_EVALUATION_TIME_SOURCE,
  POLICY_EVALUATOR_VERSION,
  POLICY_EVALUATOR_VERSION_SOURCE,
  decisionDigestFor,
} from "./bootstrap-policy-authority.js";

const ROW_KEYS = [
  "decision", "decisionDigest", "decisionDigestVersion", "decisionMaterial", "policyRef",
  "principalId", "projectId", "sliceRef",
] as const;
const MATERIAL_KEYS = [
  "projectId", "serverSources", "verifiedInput", "verifiedOutcome",
] as const;
const HEX_64 = /^[0-9a-f]{64}$/u;
const ZERO_DIGEST = "0".repeat(64);

const REQUIRED_STRING_FACTS: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(["principalId", "POLICY_AUTHORITY_PRINCIPAL_UNKNOWN"] as const),
  Object.freeze(["sliceRef", "POLICY_AUTHORITY_SLICE_UNKNOWN"] as const),
  Object.freeze(["decisionDigest", "POLICY_AUTHORITY_DIGEST_UNKNOWN"] as const),
  Object.freeze([
    "decisionDigestVersion", "POLICY_AUTHORITY_DIGEST_VERSION_UNKNOWN",
  ] as const),
  Object.freeze(["projectId", "POLICY_AUTHORITY_PROJECT_UNKNOWN"] as const),
]);

export interface PolicyEvaluationAuthority {
  readonly action: string;
  readonly decision: PolicyOutcome;
  readonly decisionDigest: string;
  readonly decisionDigestVersion: typeof POLICY_DECISION_DIGEST_VERSION;
  readonly graphNodeRevisionRefs: readonly string[];
  readonly ok: true;
  readonly policyRef: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly scope: readonly string[];
  readonly sliceRef: string;
}

export interface PolicyEvaluationAuthorityRefused {
  readonly code: string;
  readonly layer: "DAEMON_POLICY_AUTHORITY";
  readonly ok: false;
}

function exactObject(value: unknown, keys: readonly string[]): JsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Reflect.ownKeys(value).length !== keys.length) return null;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
    }
    return value as JsonObject;
  } catch {
    return null;
  }
}

function dataObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
    }
    return value as JsonObject;
  } catch {
    return null;
  }
}

function safeDigest(value: JsonValue): string | null {
  try {
    return decisionDigestFor(value);
  } catch {
    return null;
  }
}

function evaluatedOutcome(input: JsonObject): JsonObject | null {
  if (Object.prototype.hasOwnProperty.call(input, "decisionDigest")) return null;
  const evaluated = evaluatePolicy({ ...input, decisionDigest: ZERO_DIGEST });
  if (!evaluated.ok) return null;
  const { decisionDigest: _passthrough, ...outcome } = evaluated.record;
  return outcome as unknown as JsonObject;
}

/**
 * Reads one exact v2 authority row and independently replays its policy decision.
 *
 * Legacy rows and copied summaries confer nothing. The expected project comes from the aggregate
 * selected by the caller, not from the row, so moving a valid row across project streams also
 * refuses. All failures stay in this reader's one layer; admission deliberately maps them to an
 * absent witness because no malformed authority can satisfy a node.
 */
export function readPolicyEvaluationAuthority(
  payload: JsonValue | null,
  expectedProjectId: string,
  expectedEvaluatedAtEpochMs: number,
): PolicyEvaluationAuthority | PolicyEvaluationAuthorityRefused {
  const refused = (code: string): PolicyEvaluationAuthorityRefused =>
    Object.freeze({ code, layer: "DAEMON_POLICY_AUTHORITY" as const, ok: false as const });
  const record = exactObject(payload, ROW_KEYS);
  if (record === null) {
    // Preserve fact-specific answers for legacy or partially widened rows before exact-key refusal.
    const partial = dataObject(payload);
    if (partial !== null) {
      for (const [key, code] of REQUIRED_STRING_FACTS) {
        const value = partial[key];
        if (typeof value !== "string" || value.length === 0) return refused(code);
      }
      if (exactObject(partial["decisionMaterial"], MATERIAL_KEYS) === null) {
        return refused("POLICY_AUTHORITY_MATERIAL_UNKNOWN");
      }
    }
    return refused("POLICY_AUTHORITY_ROW_UNREADABLE");
  }
  for (const [key, code] of REQUIRED_STRING_FACTS) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) return refused(code);
  }
  if (record["decisionDigestVersion"] !== POLICY_DECISION_DIGEST_VERSION) {
    return refused("POLICY_AUTHORITY_DIGEST_VERSION_UNSUPPORTED");
  }
  const digest = record["decisionDigest"] as string;
  if (!HEX_64.test(digest)) return refused("POLICY_AUTHORITY_DIGEST_INVALID");
  const material = exactObject(record["decisionMaterial"], MATERIAL_KEYS);
  if (material === null) return refused("POLICY_AUTHORITY_MATERIAL_UNKNOWN");
  if (safeDigest(material) !== digest) {
    return refused("POLICY_AUTHORITY_DIGEST_MISMATCH");
  }
  const projectId = record["projectId"] as string;
  if (projectId !== expectedProjectId || material["projectId"] !== projectId) {
    return refused("POLICY_AUTHORITY_PROJECT_MISMATCH");
  }
  const sources = exactObject(material["serverSources"], [
    "evaluationTimeSource", "evaluatorVersionSource", "policySliceDigestVersion",
    "waiverResolutionStatus",
  ]);
  const input = dataObject(material["verifiedInput"]);
  const outcome = dataObject(material["verifiedOutcome"]);
  if (sources === null
    || sources["evaluationTimeSource"] !== POLICY_EVALUATION_TIME_SOURCE
    || sources["evaluatorVersionSource"] !== POLICY_EVALUATOR_VERSION_SOURCE
    || sources["waiverResolutionStatus"] !== "RESOLVED_EMPTY"
    || input === null || outcome === null) {
    return refused("POLICY_AUTHORITY_MATERIAL_UNREADABLE");
  }
  if (sources["policySliceDigestVersion"] !== POLICY_SLICE_DIGEST_VERSION) {
    return refused("POLICY_AUTHORITY_SLICE_DIGEST_VERSION_UNSUPPORTED");
  }
  if (!Number.isSafeInteger(expectedEvaluatedAtEpochMs)
    || input["evaluatedAtEpochMs"] !== expectedEvaluatedAtEpochMs) {
    return refused("POLICY_AUTHORITY_TIME_MISMATCH");
  }
  const replayed = evaluatedOutcome(input);
  const replayedDigest = replayed === null ? null : safeDigest(replayed);
  const outcomeDigest = safeDigest(outcome);
  if (replayed === null || replayedDigest === null || outcomeDigest === null
    || replayedDigest !== outcomeDigest) {
    return refused("POLICY_AUTHORITY_OUTCOME_MISMATCH");
  }
  const action = replayed["action"], decision = replayed["decision"];
  const policyRef = replayed["policyRevisionRef"];
  const principalId = record["principalId"] as string, sliceRef = record["sliceRef"] as string;
  const graphNodeRevisionRefs = replayed["graphNodeRevisionRefs"];
  const scope = input["scope"];
  const slices = input["sliceChain"];
  const selectedSlice = Array.isArray(slices) && slices.length === 1
    ? exactObject(slices[0], ["autoApprovalOptIns", "rules", "sliceRef"])
    : null;
  if (selectedSlice !== null) {
    const selectedDigest = derivePolicySliceDigest(selectedSlice);
    if (!selectedDigest.ok || selectedDigest.digest !== sliceRef) {
      return refused("POLICY_AUTHORITY_SLICE_DIGEST_MISMATCH");
    }
  }
  if (typeof action !== "string" || typeof decision !== "string" || typeof policyRef !== "string"
    || !Array.isArray(graphNodeRevisionRefs) || !graphNodeRevisionRefs.every((ref) =>
      typeof ref === "string")
    || !Array.isArray(scope) || !scope.every((ref) => typeof ref === "string")
    || input["evaluatorVersion"] !== POLICY_EVALUATOR_VERSION
    || record["decision"] !== decision || record["policyRef"] !== policyRef
    || sliceRef !== policyRef || selectedSlice?.["sliceRef"] !== sliceRef
    || input["actor"] !== principalId || replayed["actor"] !== principalId) {
    return refused("POLICY_AUTHORITY_SUMMARY_MISMATCH");
  }
  return Object.freeze({
    action,
    decision: decision as PolicyOutcome,
    decisionDigest: digest,
    decisionDigestVersion: POLICY_DECISION_DIGEST_VERSION,
    graphNodeRevisionRefs: Object.freeze([...graphNodeRevisionRefs]),
    ok: true as const,
    policyRef,
    principalId,
    projectId,
    scope: Object.freeze([...scope]),
    sliceRef,
  });
}
