import { evaluatePolicy } from "@moe/core";
import type { JsonObject, JsonValue } from "@moe/contracts";

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
  const policyRef = payloadRef(input, "policyRevisionRef");
  const installed = installedSlices(stateOf(ledger, aggregateId));
  if (policyRef === null || !Object.hasOwn(installed, policyRef)) {
    return refuse(request.kind, "BOOTSTRAP_POLICY_UNKNOWN", "DAEMON_PREREQUISITE");
  }
  if (expectedVersionStale(context, aggregateId)) {
    return refuse(request.kind, "BOOTSTRAP_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  const evaluated = evaluatePolicy(input);
  if (!evaluated.ok) {
    return refuse(request.kind, evaluated.error.code, "CORE_REDUCER", evaluated.error);
  }
  return commitAccepted(store, request, {
    aggregateId,
    eventPayload: { decision: evaluated.record.decision, policyRef },
    eventType: "PolicyEvaluated",
    expectedVersion: versionOf(ledger, aggregateId),
    result: { record: evaluated.record, slices: installed } as unknown as JsonValue,
  });
};
