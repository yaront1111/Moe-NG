import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { DEFAULT_OPERATOR_PRINCIPAL_ID } from "../operator-identity.js";
import { createProjectReviewDrainPort } from "../projects/project-review-drain.js";
import { createRepositoryRecoveryService } from "../repository/repository-recovery-service.js";
import { resolveRepositoryExecutionIdentity } from "../repository/repository-execution-identity.js";
import { existingStore } from "./moe-cli-review-recovery.js";
import type { ReviewRecoveryRequest, ReviewRecoveryResult } from "./moe-cli-main.js";

type RecoveryService = ReturnType<typeof createRepositoryRecoveryService>;
const refused = (code: string): ReviewRecoveryResult => ({ ok: false, code });
/** The durable human REPLAN authorizes this retirement; startup grants no review or acceptance authority. */
export async function executeReplanRecovery(service: RecoveryService, operator: string,
  log: (line: string) => void, automatic = false): Promise<ReviewRecoveryResult> {
  const view = service.readRecovery();
  if (view.code !== null) return refused(view.code);
  if (automatic && view.reservations.length === 0) return { ok: true };
  if (view.reservations.length !== 1) return refused("MOE_CLI_REPLAN_RECOVERY_SCOPE_AMBIGUOUS");
  const reservation = view.reservations[0]!;
  const action = reservation.actions.find((candidate) => candidate.action === "RELEASE_REPLANNED");
  // Ordinary nonterminal work follows normal startup. It is never drained by this preflight.
  if (automatic && (action?.code === "REPOSITORY_REPLAN_EVIDENCE_INVALID"
    || action?.code === "REPOSITORY_REVIEW_PHASE_UNSUPPORTED")) return { ok: true };
  if (action === undefined || !action.available || action.offer === null) return refused(action?.code ?? "MOE_CLI_REPLAN_RECOVERY_UNAVAILABLE");
  if (!Number.isSafeInteger(action.expectedReviewVersion) || action.expectedReviewDigest === undefined) return refused("MOE_CLI_REPLAN_RECOVERY_OFFER_INVALID");
  const { offer } = action;
  log("moe recover-replan: preserving the reviewed commit and verifying the retired runtime's Windows Job");
  const result = await service.recover({ principalId: operator, operatorPrincipalId: operator,
    commandId: offer.commandId, correlationId: offer.commandId, expectedVersion: offer.expectedVersion,
    targetAggregateId: offer.targetAggregateId, payload: { action: "RELEASE_REPLANNED", decision: "APPROVE",
      nodeRef: reservation.nodeRef, expectedReservationRevision: reservation.expectedReservationRevision,
      expectedReviewVersion: action.expectedReviewVersion, expectedReviewDigest: action.expectedReviewDigest,
      reason: "Retire the exact human-replanned owner while preserving the reviewed committed tree." } });
  if (!result.ok) return refused(result.code);
  return result.resultCode === "REPOSITORY_RECOVERY_RELEASED" ? { ok: true } : refused("MOE_CLI_REPLAN_RECOVERY_RESULT_INVALID");
}

/** Loaded after package links. An absent initial store or non-Git project requires no recovery. */
export async function runProjectReplanRecovery(request: ReviewRecoveryRequest): Promise<ReviewRecoveryResult> {
  if (request.automatic === true && (!existsSync(resolve(request.projectRoot, request.config.storePath))
    || !resolveRepositoryExecutionIdentity(request.projectRoot).ok)) return { ok: true };
  const storePath = existingStore(request);
  if (storePath === null) return refused("MOE_CLI_REPLAN_RECOVERY_STORE_UNAVAILABLE");
  let store: SqliteEventStore | undefined;
  try {
    store = SqliteEventStore.openForProject(storePath, request.config.projectId);
    const operator = request.env.MOE_PRINCIPAL_ID || DEFAULT_OPERATOR_PRINCIPAL_ID;
    const service = createRepositoryRecoveryService({ store, projectId: request.config.projectId, storeId: storePath,
      workspaces: () => [request.projectRoot], clock: () => new Date().toISOString(), mintId: randomUUID,
      reviewDrain: createProjectReviewDrainPort() });
    return await executeReplanRecovery(service, operator, request.log, request.automatic === true);
  } catch { return refused("MOE_CLI_REPLAN_RECOVERY_UNAVAILABLE"); }
  finally { store?.close(); }
}
