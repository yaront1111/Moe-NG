import { evaluatePolicy } from "@moe/core";
import type { JsonObject, JsonValue } from "@moe/contracts";

import {
  callerSuppliedKey,
  decisionDigestFor,
} from "./bootstrap-policy-authority.js";
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
 * validate hands the caller's evaluation input to the core's `evaluatePolicy` unchanged. The
 * daemon's only judgement is the durable one — whether the policy named by the input was ever
 * installed for this project — and that refusal is marked `DAEMON_PREREQUISITE` so it cannot be
 * mistaken for the core rejecting the policy on its merits.
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
  const evaluated = evaluatePolicy({
    ...input,
    actor: request.principalId,
    sliceChain: [slice],
    waivers: [],
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
