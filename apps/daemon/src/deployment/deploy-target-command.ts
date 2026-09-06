import { commitAccepted, refuse } from "../bootstrap/bootstrap-ledger.js";
import type { CommandHandler } from "../bootstrap/bootstrap-ledger.js";
import {
  DEPLOY_TARGET_BOUND_EVENT, DEPLOY_TARGET_INVALID,
  admitDeployTargetPayload, deployTargetAggregateId,
} from "./deploy-target-contracts.js";

/** Admission and one synchronous, per-environment write; no deploy effect is performed here. */
export const setDeployTarget: CommandHandler = ({ request, store }) => {
  const admitted = admitDeployTargetPayload(request.payload);
  if (admitted === null) return refuse(request.kind, DEPLOY_TARGET_INVALID, "DAEMON_INGRESS");
  const { network, sshTarget, url } = admitted.target;
  const target = { network, sshTarget, url };
  return commitAccepted(store, request, {
    aggregateId: deployTargetAggregateId(request.projectId, admitted.environment),
    eventPayload: target,
    eventType: DEPLOY_TARGET_BOUND_EVENT,
    // There is no core reducer here to enforce the caller's optimistic fence for us.
    expectedVersion: request.expectedVersion,
    result: target,
  });
};
