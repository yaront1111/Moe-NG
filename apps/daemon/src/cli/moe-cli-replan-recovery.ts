import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SqliteEventStore } from "@moe/store";
import { DEFAULT_OPERATOR_PRINCIPAL_ID } from "../operator-identity.js";
import { createProjectReviewDrainPort } from "../projects/project-review-drain.js";
import { createRepositoryRecoveryService } from "../repository/repository-recovery-service.js";
import { resolveRepositoryExecutionIdentity } from "../repository/repository-execution-identity.js";
import { existingStore } from "./moe-cli-review-recovery.js";
import type { ReviewRecoveryRequest, ReviewRecoveryResult } from "./moe-cli-main.js";

type RecoveryService = ReturnType<typeof createRepositoryRecoveryService>;
const refused = (code: string): ReviewRecoveryResult => ({ ok: false, code });

/**
 * Every checkout this project's reservations can live in: its own working tree, plus each node
 * tree that actually holds one.
 *
 * A node briefed into its own tree (MOE_NODE_TREES) holds its reservation under
 * `<main>/.git/worktrees/<name>/`, not under the project root — and recovery scanned the project
 * root alone. So a replanned node holding its own tree could not be released by ANY cli path.
 * Measured on UnAI 2026-09-16, where exactly that happened and the checkout stayed held with no
 * command able to free it.
 *
 * Only trees whose reservation database EXISTS are named, and that bound is load-bearing rather
 * than tidy: `scan` refuses outright above 32 workspaces and this project has 70 node trees, so
 * listing them all would break recovery for everyone. The handful holding a reservation is the
 * only set that can need recovering.
 */
export function reservationWorkspaces(projectRoot: string): readonly string[] {
  const workspaces = [projectRoot];
  try {
    const worktrees = join(projectRoot, ".git", "worktrees");
    for (const entry of readdirSync(worktrees)) {
      if (!existsSync(join(worktrees, entry, "moe-repository-execution.sqlite"))) continue;
      // Git records the linked worktree's own `.git` file here; its parent is the checkout.
      const gitdir = readFileSync(join(worktrees, entry, "gitdir"), "utf8").trim();
      if (gitdir !== "") workspaces.push(dirname(gitdir));
    }
  } catch { /* No linked worktrees, or one unreadable: the project root still recovers. */ }
  return workspaces;
}
/** The durable human REPLAN authorizes this retirement; startup grants no review or acceptance authority. */
export async function executeReplanRecovery(service: RecoveryService, operator: string,
  log: (line: string) => void, automatic = false): Promise<ReviewRecoveryResult> {
  const view = service.readRecovery();
  if (view.code !== null) return refused(view.code);
  if (automatic && view.reservations.length === 0) return { ok: true };
  // EVERY replanned owner, not the only one. A node in its own tree and the node holding the
  // project's own checkout can both be replanned at once — governance retired two 22 ms apart on
  // UnAI 2026-09-16 — and refusing on sight of the second left both held with nothing able to
  // free them. Each reservation is its own owner and its own release; recovering one says
  // nothing about the next.
  const actionable = view.reservations
    .map((reservation) => ({
      action: reservation.actions.find((candidate) => candidate.action === "RELEASE_REPLANNED"),
      reservation,
    }))
    .filter((entry) => entry.action !== undefined);
  if (actionable.length === 0) return refused("MOE_CLI_REPLAN_RECOVERY_UNAVAILABLE");
  let released = 0;
  for (const { action, reservation } of actionable) {
    // Ordinary nonterminal work follows normal startup. It is never drained by this preflight.
    if (automatic && (action?.code === "REPOSITORY_REPLAN_EVIDENCE_INVALID"
      || action?.code === "REPOSITORY_REVIEW_PHASE_UNSUPPORTED")) continue;
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
    if (result.resultCode !== "REPOSITORY_RECOVERY_RELEASED") return refused("MOE_CLI_REPLAN_RECOVERY_RESULT_INVALID");
    released += 1;
  }
  // Automatic startup may legitimately release nothing: every owner was ordinary work it skipped.
  return released > 0 || automatic ? { ok: true } : refused("MOE_CLI_REPLAN_RECOVERY_UNAVAILABLE");
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
      workspaces: () => reservationWorkspaces(request.projectRoot), clock: () => new Date().toISOString(), mintId: randomUUID,
      reviewDrain: createProjectReviewDrainPort() });
    return await executeReplanRecovery(service, operator, request.log, request.automatic === true);
  } catch { return refused("MOE_CLI_REPLAN_RECOVERY_UNAVAILABLE"); }
  finally { store?.close(); }
}
