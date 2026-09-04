import type { ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import type { BootstrapRequest } from "../bootstrap/bootstrap-contracts.js";
import {
  commitAccepted,
  commitAcceptedLegs,
  payloadRef,
  refuse,
  stateOf,
  versionOf,
} from "../bootstrap/bootstrap-ledger.js";
import type { CommandHandler, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { readProjectRemote } from "./publish-ledger.js";
import {
  PUBLISH_REMOTE_UNBOUND,
  PUBLISH_REMOTE_URL_INVALID,
  REMOTE_BOUND_EVENT_TYPE,
  admitRemoteUrl,
  publishAggregateId,
  remoteAggregateId,
} from "./publish-receipt-contracts.js";

/**
 * `repository.publish`: the human names a remote once, and every publish after that reuses it.
 *
 * The wrapper's publisher pushes the workspace's current branch to the remote in the decision's
 * RESULT and records a receipt beside the decision. The publish fact lands on the goal's publish
 * aggregate (`publish:<goalId>`), so its version fence never moves the goal's own; the BINDING
 * lands on the project's remote aggregate (`remote:<projectId>`) as a second leg of the SAME
 * decision, so a publish whose remote was never recorded — or a binding for a publish that never
 * happened — is not a state the store can reach. Nothing here touches git: a refusal is about the
 * goal or the url, never about the push.
 *
 * `remoteUrl` carries three meanings in one rostered key, because the payload roster is frozen
 * and a fourth key would be a twenty-file backfill:
 *   a STRING      — bind it (replacing any prior binding) and publish to it;
 *   NULL          — publish to whatever the project is already bound to;
 *   anything else — malformed, INCLUDING a missing key, which arrives as `undefined`.
 * The `undefined` case is why the null test is strict: `undefined == null` is true in JavaScript,
 * and a loose check would read a malformed request as "reuse the bound remote" and push to it.
 */

const PUBLISHABLE_LIFECYCLES: ReadonlySet<string> = new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);

const encoder = new TextEncoder();

type RemoteResolution =
  | Readonly<{ bind: boolean; ok: true; remoteUrl: string }>
  | Readonly<{ code: string; ok: false; refusedBy: "DAEMON_INGRESS" | "DAEMON_PREREQUISITE" }>;

/**
 * Resolves the request's `remoteUrl` to the url this publish will carry, and says whether that
 * url is NEW. Both refusals name their own layer: an unusable url is an INGRESS fault (the
 * operator typed it), while "you never named one" is a missing PREREQUISITE of the project.
 */
function resolveRemote(
  raw: unknown, store: SqliteEventStore, projectId: string,
): RemoteResolution {
  if (raw === null) {
    const bound = readProjectRemote(store, projectId);
    if (bound === null) return { code: PUBLISH_REMOTE_UNBOUND, ok: false, refusedBy: "DAEMON_PREREQUISITE" };
    return { bind: false, ok: true, remoteUrl: bound.remoteUrl };
  }
  if (typeof raw !== "string") {
    return { code: "BOOTSTRAP_PAYLOAD_INVALID", ok: false, refusedBy: "DAEMON_INGRESS" };
  }
  const admitted = admitRemoteUrl(raw);
  if (admitted === null) {
    return { code: PUBLISH_REMOTE_URL_INVALID, ok: false, refusedBy: "DAEMON_INGRESS" };
  }
  return { bind: true, ok: true, remoteUrl: admitted };
}

export const publishRepository: CommandHandler = (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  const goalId = payloadRef(request.payload, "goalId");
  if (goalId === null) {
    return refuse(request.kind, "BOOTSTRAP_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  const remote = resolveRemote(request.payload["remoteUrl"], store, request.projectId);
  if (!remote.ok) return refuse(request.kind, remote.code, remote.refusedBy);
  const goal = stateOf(ledger, goalId);
  const state = typeof goal === "object" && goal !== null && !Array.isArray(goal)
    ? goal as Record<string, unknown> : null;
  if (state === null || state["goalId"] !== goalId) {
    return refuse(request.kind, "BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE");
  }
  if (!PUBLISHABLE_LIFECYCLES.has(String(state["lifecycle"]))) {
    return refuse(request.kind, "BOOTSTRAP_PREREQUISITE_MISSING", "DAEMON_PREREQUISITE");
  }
  const aggregateId = publishAggregateId(goalId);
  if (request.expectedVersion !== versionOf(ledger, aggregateId)) {
    return refuse(request.kind, "BOOTSTRAP_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }
  // FROZEN SHAPE: the publisher, the receipt and the runs read all decode this object, and the
  // RESOLVED url is what lands in it — which is why none of them learn the binding exists.
  const result = { goalId, remoteUrl: remote.remoteUrl, requestedAt: request.decidedAt };
  const plan = {
    aggregateId,
    eventPayload: result,
    eventType: "RepositoryPublishRequested",
    expectedVersion: versionOf(ledger, aggregateId),
    result,
  };
  if (!remote.bind) return commitAccepted(store, request, plan);
  return commitAcceptedLegs(store, request, plan, [bindingLeg(store, request, remote.remoteUrl)]);
};

/**
 * The binding leg. Its fence comes from `store.getAggregateVersion` and NOT from `versionOf`:
 * `readDurableLedger` keys its aggregate map by each decision's `targetAggregateId`, and this leg
 * is never a decision's target, so the ledger would report version 0 for a remote aggregate that
 * had already been written and every rebind after the first would refuse on a stale fence.
 */
function bindingLeg(
  store: SqliteEventStore, request: BootstrapRequest, remoteUrl: string,
): ExpectedVersionDecisionLeg {
  const aggregateId = remoteAggregateId(request.projectId);
  return {
    aggregateId,
    events: [{
      eventId: `${request.commandId}-${REMOTE_BOUND_EVENT_TYPE}`,
      eventType: REMOTE_BOUND_EVENT_TYPE,
      payload: encoder.encode(JSON.stringify({
        boundAt: request.decidedAt, boundBy: request.principalId, remoteUrl,
      })),
    }],
    expectedVersion: store.getAggregateVersion(aggregateId),
  };
}
