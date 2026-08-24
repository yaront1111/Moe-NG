import { evaluatePolicy } from "@moe/core";
import type { JsonObject, JsonValue } from "@moe/contracts";

import {
  callerSuppliedKey,
  decisionDigestFor,
} from "./bootstrap-policy-authority.js";
import { resolvePolicyFact, resolvePolicyWaivers } from "./policy-fact-resolver.js";
export { readPolicyEvaluationAuthority } from "./bootstrap-policy-authority.js";
export type {
  PolicyEvaluationAuthority,
  PolicyEvaluationAuthorityRefused,
} from "./bootstrap-policy-authority.js";

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

function installedSlices(state: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
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
  if (expectedVersionStale(context, aggregateId)) {
    return refuse(request.kind, "BOOTSTRAP_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const current = installedSlices(stateOf(ledger, aggregateId));
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
  const waiverResolution = resolvePolicyWaivers();
  const evaluated = evaluatePolicy({
    action: input["action"],
    actor: request.principalId,
    callerRiskHint: input["callerRiskHint"],
    decisionDigest: input["decisionDigest"],
    evaluatedAtEpochMs: input["evaluatedAtEpochMs"],
    evaluatorVersion: input["evaluatorVersion"],
    facts: [resolvePolicyFact(request.projectId, request.principalId, callerRequestedAction)],
    graphNodeRevisionRefs: input["graphNodeRevisionRefs"],
    policyRevisionRef: input["policyRevisionRef"],
    requiredFactIds: input["requiredFactIds"],
    scope: input["scope"],
    sliceChain: [slice],
    waivers: waiverResolution.waivers,
  });
  if (!evaluated.ok) {
    return refuse(request.kind, evaluated.error.code, "CORE_REDUCER", evaluated.error);
  }
  const decisionDigest = decisionDigestFor(
    evaluated.record.action, evaluated.record.decision, policyRef, request.principalId, slice);
  return commitAccepted(store, request, {
    aggregateId,
    // WIDENED so the row can answer who evaluated, against which slice, and over what. The two
    // original fields are kept in place: the only production reader
    // (`admission-gate-resolver.ts:148-171`) reads `policyRef` and `decision` by NAME and does
    // not exact-key the payload, so this is additive for it.
    eventPayload: {
      decision: evaluated.record.decision,
      decisionDigest,
      policyRef,
      principalId: request.principalId,
      sliceRef: policyRef,
    },
    eventType: "PolicyEvaluated",
    expectedVersion: versionOf(ledger, aggregateId),
    result: { record: evaluated.record, slices: installed } as unknown as JsonValue,
  });
};
