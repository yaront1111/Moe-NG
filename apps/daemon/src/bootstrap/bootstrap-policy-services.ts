import {
  POLICY_SLICE_DIGEST_VERSION, derivePolicySliceDigest, evaluatePolicy,
} from "@moe/core";
import type { JsonObject, JsonValue } from "@moe/contracts";

import {
  callerSuppliedKey,
  decisionDigestFor,
  POLICY_DECISION_DIGEST_VERSION,
  POLICY_EVALUATION_TIME_SOURCE,
  POLICY_EVALUATOR_VERSION,
  POLICY_EVALUATOR_VERSION_SOURCE,
} from "./bootstrap-policy-authority.js";
import { resolvePolicyFact, resolvePolicyWaivers } from "./policy-fact-resolver.js";
export { readPolicyEvaluationAuthority } from "./bootstrap-policy-authority-reader.js";
export type {
  PolicyEvaluationAuthority,
  PolicyEvaluationAuthorityRefused,
} from "./bootstrap-policy-authority-reader.js";

import {
  aggregateIdFor,
  commitAccepted,
  payloadObject,
  payloadRef,
  refuse,
  stateOf,
  versionOf,
} from "./bootstrap-ledger.js";
import type { CommandHandler, HandlerContext, ServiceOutcome } from "./bootstrap-ledger.js";

/**
 * Policy install and validate.
 *
 * Neither has a `@moe/core` reducer that owns lifecycle: install records a slice durably, and
 * validate binds the authenticated principal and installed slice before calling `evaluatePolicy`.
 * Caller-supplied facts, slices, and waivers are refused at ingress. The requested action remains
 * a caller-selected evaluation subject; it can distinguish the server's UNKNOWN audit identity,
 * but it cannot create tier or waiver authority or make a live allowance reachable.
 */

interface InstalledPolicies {
  readonly slices: Readonly<Record<string, JsonValue>>;
}

/** Exported for the run-scoped evaluator (task-a888038d): one reading of the installed set. */
export function installedSlices(
  state: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> {
  if (state === undefined || state === null || typeof state !== "object") return {};
  if (Array.isArray(state)) return {};
  const slices = (state as JsonObject)["slices"];
  if (slices === null || slices === undefined || typeof slices !== "object") return {};
  if (Array.isArray(slices)) return {};
  return slices as Readonly<Record<string, JsonValue>>;
}

function expectedVersionStale(context: HandlerContext, aggregateId: string): boolean {
  return context.request.expectedVersion !== versionOf(context.ledger, aggregateId);
}

export const installPolicy: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const aggregateId = aggregateIdFor(request, null);
  const slice = payloadObject(request.payload, "slice");
  const sliceRef = slice === null ? null : payloadRef(slice, "sliceRef");
  if (slice === null || sliceRef === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  // `policy.install` also stores non-evaluation policy artifacts (reviewer calibration and
  // verifier inputs). Only an exact core PolicySlice can become policy.validate authority; when
  // it is one, its public address MUST be its canonical content digest.
  const sliceDigest = derivePolicySliceDigest(slice);
  if (sliceDigest.ok && sliceDigest.digest !== sliceRef) {
    return refuse(
      request.kind, "BOOTSTRAP_POLICY_SLICE_DIGEST_MISMATCH", "DAEMON_INGRESS",
    );
  }
  if (expectedVersionStale(context, aggregateId)) {
    return refuse(request.kind, "BOOTSTRAP_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const current = installedSlices(stateOf(ledger, aggregateId));
  const priorAtRef = current[sliceRef];
  const priorDigest = priorAtRef === undefined ? null : derivePolicySliceDigest(priorAtRef);
  // Evaluation slices are immutable in both directions: neither a core slice nor an arbitrary
  // policy artifact may replace one. Generic calibration/verifier artifacts retain their
  // deliberately superseding well-known refs; they can never pass core policy evaluation.
  if (Object.hasOwn(current, sliceRef)
    && (sliceDigest.ok || priorDigest?.ok === true)) {
    return refuse(
      request.kind, "BOOTSTRAP_POLICY_SLICE_ALREADY_INSTALLED", "DAEMON_PREREQUISITE",
    );
  }
  const next: InstalledPolicies = { slices: { ...current, [sliceRef]: slice } };
  return commitAccepted(store, request, {
    aggregateId,
    eventPayload: { sliceRef },
    eventType: "PolicyInstalled",
    expectedVersion: versionOf(ledger, aggregateId),
    result: next as unknown as JsonValue,
  });
};

export const validatePolicy: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const aggregateId = aggregateIdFor(request, null);
  const input = payloadObject(request.payload, "input");
  if (input === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  // BEFORE ANY STORE READ. A caller that supplied either server-sourced key is refused here, so
  // a spoofed chain cannot cause a durable read on its way to being discarded. Refused rather
  // than IGNORED: silently dropping it is indistinguishable from honouring it at the call site,
  // and a value that happens to agree with the store is still not authority.
  const supplied = callerSuppliedKey(input);
  if (supplied === "sliceChain") {
    return refuse(request.kind, "BOOTSTRAP_POLICY_CHAIN_CALLER_SUPPLIED", "DAEMON_INGRESS");
  }
  if (supplied === "facts") {
    return refuse(request.kind, "BOOTSTRAP_POLICY_FACTS_CALLER_SUPPLIED", "DAEMON_INGRESS");
  }
  if (supplied === "evaluatedAtEpochMs") {
    return refuse(request.kind, "BOOTSTRAP_POLICY_TIME_CALLER_SUPPLIED", "DAEMON_INGRESS");
  }
  if (supplied === "evaluatorVersion") {
    return refuse(request.kind, "BOOTSTRAP_POLICY_EVALUATOR_CALLER_SUPPLIED", "DAEMON_INGRESS");
  }
  if (supplied !== null) {
    return refuse(request.kind, "BOOTSTRAP_POLICY_WAIVER_UNVERIFIABLE", "DAEMON_INGRESS");
  }
  // Bound, not overwritten. An overwrite would make a spoofed actor indistinguishable from an
  // honest one in the durable record, which is exactly the confusion this row exists to remove.
  if (input["actor"] !== undefined && input["actor"] !== request.principalId) {
    return refuse(request.kind, "BOOTSTRAP_POLICY_ACTOR_UNBOUND", "DAEMON_INGRESS");
  }
  const policyRef = payloadRef(input, "policyRevisionRef");
  const installed = installedSlices(stateOf(ledger, aggregateId));
  if (policyRef === null || !Object.hasOwn(installed, policyRef)) {
    return refuse(request.kind, "BOOTSTRAP_POLICY_UNKNOWN", "DAEMON_PREREQUISITE");
  }
  if (expectedVersionStale(context, aggregateId)) {
    return refuse(request.kind, "BOOTSTRAP_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  // The existence check above stopped being the whole judgement and became the SELECTOR: the
  // chain core evaluates is the bytes `installPolicy` wrote, not a chain the caller re-sent.
  const slice = installed[policyRef] as JsonValue;
  // This remains caller-requested. It is passed unchanged to core and may influence only the
  // null-tier UNKNOWN fact's audit identity here. A future tier-bearing source must authenticate
  // and bind the subject under task-b211ac9de4944582ae19aa73afda7b25.
  const callerRequestedAction = typeof input["action"] === "string" ? input["action"] : "";
  const evaluatedAtEpochMs = Date.parse(request.decidedAt);
  let canonicalDecidedAt: string | null = null;
  try {
    canonicalDecidedAt = new Date(evaluatedAtEpochMs).toISOString();
  } catch {
    canonicalDecidedAt = null;
  }
  if (!Number.isSafeInteger(evaluatedAtEpochMs) || evaluatedAtEpochMs < 0
    || canonicalDecidedAt !== request.decidedAt) {
    return refuse(request.kind, "BOOTSTRAP_POLICY_TIME_UNAVAILABLE", "DAEMON_PREREQUISITE");
  }
  const waiverResolution = resolvePolicyWaivers();
  const facts = [resolvePolicyFact(
    store,
    request.projectId,
    request.principalId,
    callerRequestedAction,
  )] as const;
  const evaluationInput = {
    action: input["action"],
    actor: request.principalId,
    callerRiskHint: input["callerRiskHint"],
    decisionDigest: input["decisionDigest"],
    evaluatedAtEpochMs,
    evaluatorVersion: POLICY_EVALUATOR_VERSION,
    facts,
    graphNodeRevisionRefs: input["graphNodeRevisionRefs"],
    policyRevisionRef: input["policyRevisionRef"],
    requiredFactIds: input["requiredFactIds"],
    scope: input["scope"],
    sliceChain: [slice],
    waivers: waiverResolution.waivers,
  };
  const evaluated = evaluatePolicy(evaluationInput);
  if (!evaluated.ok) {
    return refuse(request.kind, evaluated.error.code, "CORE_REDUCER", evaluated.error);
  }
  // Core records the caller's `decisionDigest` unchanged. Remove that passthrough from BOTH the
  // exact object core evaluated and its result, then bind every other field automatically.
  const { decisionDigest: _callerInputDigest, ...verifiedInput } = evaluationInput;
  const { decisionDigest: _callerOutcomeDigest, ...verifiedOutcome } = evaluated.record;
  const decisionMaterial = {
    projectId: request.projectId,
    serverSources: {
      evaluationTimeSource: POLICY_EVALUATION_TIME_SOURCE,
      evaluatorVersionSource: POLICY_EVALUATOR_VERSION_SOURCE,
      policySliceDigestVersion: POLICY_SLICE_DIGEST_VERSION,
      waiverResolutionStatus: waiverResolution.status,
    },
    verifiedInput: verifiedInput as unknown as JsonValue,
    verifiedOutcome: verifiedOutcome as unknown as JsonValue,
  };
  const decisionDigest = decisionDigestFor(decisionMaterial);
  const authoritativeRecord = { ...evaluated.record, decisionDigest };
  return commitAccepted(store, request, {
    aggregateId,
    // WIDENED so the row can answer who evaluated, against which slice, and over what. The two
    // original fields remain as summaries, while the admission reader exact-checks this entire
    // row, recomputes its digest, replays core and binds the resulting subject to the activation.
    eventPayload: {
      decision: evaluated.record.decision,
      decisionDigest,
      decisionDigestVersion: POLICY_DECISION_DIGEST_VERSION,
      decisionMaterial,
      policyRef,
      principalId: request.principalId,
      projectId: request.projectId,
      sliceRef: policyRef,
    },
    eventType: "PolicyEvaluated",
    expectedVersion: versionOf(ledger, aggregateId),
    result: {
      decisionDigestVersion: POLICY_DECISION_DIGEST_VERSION,
      record: authoritativeRecord,
      slices: installed,
    } as unknown as JsonValue,
  });
};
