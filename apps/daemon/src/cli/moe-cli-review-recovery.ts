import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventStore } from "@moe/store";
import { DEFAULT_OPERATOR_PRINCIPAL_ID } from "../operator-identity.js";
import { createProjectReviewDrainPort } from "../projects/project-review-drain.js";
import { createRepositoryRecoveryService } from "../repository/repository-recovery-service.js";
import type { ReviewRecoveryRequest, ReviewRecoveryResult } from "./moe-cli-main.js";

type RecoveryService = ReturnType<typeof createRepositoryRecoveryService>;
const refused = (code: string): ReviewRecoveryResult => ({ ok: false, code });

/** Local operator command: select one exact durable offer before requesting any process effect. */
export async function executeReviewRecovery(service: RecoveryService, operator: string,
  log: (line: string) => void): Promise<ReviewRecoveryResult> {
  const view = service.readRecovery();
  if (view.code !== null) return refused(view.code);
  if (view.reservations.length !== 1) return refused("MOE_CLI_REVIEW_RECOVERY_SCOPE_AMBIGUOUS");
  const reservation = view.reservations[0]!;
  const action = reservation.actions.find((candidate) => candidate.action === "RESUME_REVIEW");
  if (action === undefined || !action.available || action.offer === null) {
    return refused(action?.code ?? "MOE_CLI_REVIEW_RECOVERY_UNAVAILABLE");
  }
  if (!Number.isSafeInteger(action.expectedReviewVersion) || action.expectedReviewDigest === undefined) {
    return refused("MOE_CLI_REVIEW_RECOVERY_OFFER_INVALID");
  }
  const { offer } = action;
  log("moe recover-review: verifying the existing Windows Job and waiting for its processes to exit");
  const result = await service.recover({ principalId: operator, operatorPrincipalId: operator,
    commandId: offer.commandId, correlationId: offer.commandId, expectedVersion: offer.expectedVersion,
    targetAggregateId: offer.targetAggregateId, payload: { action: "RESUME_REVIEW", decision: "APPROVE",
      nodeRef: reservation.nodeRef, expectedReservationRevision: reservation.expectedReservationRevision,
      expectedReviewVersion: action.expectedReviewVersion, expectedReviewDigest: action.expectedReviewDigest,
      reason: "Operator requested blocked review recovery and restart." } });
  if (!result.ok) return refused(result.code);
  return result.resultCode === "REPOSITORY_RECOVERY_RESUMED" ? { ok: true }
    : refused("MOE_CLI_REVIEW_RECOVERY_RESULT_INVALID");
}

/** Refuse missing/foreign stores before a writable open can initialize or migrate them. */
function existingStore(request: ReviewRecoveryRequest): string | null {
  let database: DatabaseSync | undefined;
  try {
    const path = realpathSync.native(resolve(request.projectRoot, request.config.storePath));
    if (!statSync(path).isFile()) return null;
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    const rows = database.prepare("SELECT singleton, project_id FROM store_project_binding").all();
    return rows.length === 1 && rows[0]?.singleton === 1 && rows[0]?.project_id === request.config.projectId ? path : null;
  } catch { return null; }
  finally { database?.close(); }
}

/** Loaded only after the artifact's workspace package links have been materialized. */
export async function runProjectReviewRecovery(request: ReviewRecoveryRequest): Promise<ReviewRecoveryResult> {
  const storePath = existingStore(request);
  if (storePath === null) return refused("MOE_CLI_REVIEW_RECOVERY_STORE_UNAVAILABLE");
  let store: SqliteEventStore | undefined;
  try {
    store = SqliteEventStore.openForProject(storePath, request.config.projectId);
    const configuredOperator = request.env.MOE_PRINCIPAL_ID;
    const operator = configuredOperator === undefined || configuredOperator === ""
      ? DEFAULT_OPERATOR_PRINCIPAL_ID : configuredOperator;
    const service = createRepositoryRecoveryService({ store, projectId: request.config.projectId,
      storeId: storePath, workspaces: () => [request.projectRoot], clock: () => new Date().toISOString(),
      mintId: randomUUID, reviewDrain: createProjectReviewDrainPort() });
    return await executeReviewRecovery(service, operator, request.log);
  } catch { return refused("MOE_CLI_REVIEW_RECOVERY_UNAVAILABLE"); }
  finally { store?.close(); }
}
