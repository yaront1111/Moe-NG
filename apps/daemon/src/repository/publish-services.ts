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
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { decodePublicationApproval, decodePublicationCandidate, samePublicationApproval } from "./publication-approval-contracts.js";
import type { PublicationCandidateReader } from "./publication-approval-contracts.js";
import { publicationGoalIntegrated } from "./publication-goal-integration.js";
import { readProjectRemote } from "./publish-ledger.js";
import {
  PUBLISH_REMOTE_UNBOUND,
  PUBLISH_REMOTE_URL_INVALID,
  REMOTE_BOUND_EVENT_TYPE,
  admitRemoteUrl,
  publishAggregateId,
  remoteAggregateId,
} from "./publish-receipt-contracts.js";

/** A durable human approves an exact daemon-observed commit, branch, remote and repository.
 * The approval and optional project remote binding are recorded atomically before publication. */

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

export interface PublishRepositoryConfig {
  readonly validateGoal?: typeof publicationGoalIntegrated;
  readonly readPublicationCandidate?: PublicationCandidateReader;
  /** Explicit fixture seam; production uses durable principal authority. */
  readonly isHuman?: (store: SqliteEventStore, principalId: string) => boolean;
}

export function createPublishRepository(config: PublishRepositoryConfig = {}): CommandHandler {
 return (context): ServiceOutcome => {
  const { ledger, request, store } = context;
  if (!(config.isHuman ?? isDurableHumanPrincipal)(store, request.principalId)) {
    return refuse(request.kind, "PUBLISH_HUMAN_REQUIRED", "DAEMON_AUTHORIZATION");
  }
  const approval = decodePublicationApproval(request.payload["approval"]);
  if (approval === null) return refuse(request.kind, "PUBLISH_APPROVAL_REQUIRED", "DAEMON_INGRESS");
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
  const measured = config.readPublicationCandidate?.(remote.remoteUrl);
  if (measured === undefined) return refuse(request.kind, "PUBLISH_WORKSPACE_UNCONFIGURED", "DAEMON_PREREQUISITE");
  if (!measured.ok) return refuse(request.kind, measured.code, "DAEMON_PREREQUISITE");
  const candidate = decodePublicationCandidate(measured.candidate);
  if (candidate === null || candidate.approval.remoteUrl !== remote.remoteUrl
    || !samePublicationApproval(candidate.approval, approval)) {
    return refuse(request.kind, "PUBLISH_APPROVAL_STALE", "DAEMON_PREREQUISITE");
  }
  if (!(config.validateGoal ?? publicationGoalIntegrated)(store, request.projectId, goalId, candidate)) {
    return refuse(request.kind, "PUBLISH_GOAL_NOT_INTEGRATED", "DAEMON_PREREQUISITE");
  }
  const result = { candidate: { approval: { ...candidate.approval }, identity: { ...candidate.identity } },
    goalId, remoteUrl: remote.remoteUrl, requestedAt: request.decidedAt };
  const plan = {
    aggregateId,
    eventPayload: { approval: { ...candidate.approval }, goalId, remoteUrl: remote.remoteUrl, requestedAt: request.decidedAt },
    eventType: "RepositoryPublishRequested",
    expectedVersion: versionOf(ledger, aggregateId),
    result,
  };
  if (!remote.bind) return commitAccepted(store, request, plan);
  return commitAcceptedLegs(store, request, plan, [bindingLeg(store, request, remote.remoteUrl)]);
 };
}

export const publishRepository: CommandHandler = createPublishRepository();

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
