import type { SqliteEventStore } from "@moe/store";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { readRepositoryRecoveryReservation } from "./repository-execution-recovery.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import type { RepositoryRecoveryCommand } from "./repository-recovery-service.js";
import { recordRecoveryApproval } from "./repository-recovery-approval.js";
import type { RecoveryApproval } from "./repository-recovery-approval.js";
import { recoveryDigest } from "./repository-recovery-facts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryPayload, RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
import type { RepositoryReviewDrainPort } from "./repository-review-drain-contracts.js";
import { readRepositoryReplanEvidence, replanAuthorityClosed } from "./repository-replan-recovery-evidence.js";
import { captureReplanGit } from "./repository-replan-recovery-git.js";
import { releaseReplannedRepository } from "./repository-replan-recovery-mutation.js";
import { validDrain } from "./repository-review-resume-service.js";
import { withReviewResumeStoreLock } from "./repository-review-resume-lock.js";

export async function recoverReplannedRepository(input: { readonly store: SqliteEventStore; readonly projectId: string;
  readonly storeId: string; readonly handle: RepositoryExecutionHandle; readonly payload: RepositoryRecoveryPayload;
  readonly command: RepositoryRecoveryCommand; readonly priorApproval: RecoveryApproval | null;
  readonly requestSha256: string; readonly clock: () => string; readonly drain: RepositoryReviewDrainPort | undefined;
  readonly assertAuthority?: (() => void) | undefined }): Promise<RepositoryRecoveryResult<{ released: true; replayed: boolean }>> {
  const { store, projectId, storeId, handle, payload, command } = input;
  if (input.drain === undefined) return recoveryRefusal("REPOSITORY_REVIEW_DRAIN_UNAVAILABLE");
  const human = (): boolean => command.principalId === command.operatorPrincipalId
    || isDurableHumanPrincipal(store, command.principalId);
  const before = readRepositoryReplanEvidence(store, handle);
  if (!before.ok) return before;
  if (before.evidence.reviewVersion !== payload.expectedReviewVersion || before.evidence.reviewDigest !== payload.expectedReviewDigest) {
    return recoveryRefusal("REPOSITORY_REVIEW_VERSION_CONFLICT");
  }
  if (!replanAuthorityClosed(store, handle, input.clock())) return recoveryRefusal("REPOSITORY_REVIEW_AUTHORITY_LIVE");
  const captured = await captureReplanGit(handle, before.evidence.binding);
  if (!captured.ok) return captured;
  input.assertAuthority?.();
  if (!human()) return recoveryRefusal("REPOSITORY_RECOVERY_HUMAN_REQUIRED");
  const ready = readRepositoryReplanEvidence(store, handle);
  if (!ready.ok) return ready;
  if (JSON.stringify(ready.evidence) !== JSON.stringify(before.evidence)) return recoveryRefusal("REPOSITORY_REVIEW_EVIDENCE_CHANGED");
  if (!replanAuthorityClosed(store, handle, input.clock())) return recoveryRefusal("REPOSITORY_REVIEW_AUTHORITY_LIVE");
  const approval = { requestSha256: input.requestSha256, ownerDigest: repositoryRecoveryOwnerDigest(handle.owner), identity: handle.reservation.identity };
  if (input.priorApproval !== null && JSON.stringify(input.priorApproval) !== JSON.stringify(approval)) {
    return recoveryRefusal("REPOSITORY_RECOVERY_APPROVAL_CONFLICT");
  }
  if (input.priorApproval === null) {
    const written = recordRecoveryApproval(store, projectId, { ...command, payload }, approval, input.clock());
    if (!written.ok) return written;
  }
  const drained = await input.drain.drain({ controllerPid: handle.reservation.controllerPid,
    notStartedAfter: before.evidence.seatStartedAt, workspace: handle.reservation.identity.root });
  if (!drained.ok) return recoveryRefusal(drained.code);
  try {
    if (!validDrain(drained.evidence, handle.reservation.controllerPid, before.evidence.seatStartedAt, input.clock())) {
      return recoveryRefusal("REPOSITORY_REVIEW_DRAIN_INVALID");
    }
    const afterGit = await captureReplanGit(handle, before.evidence.binding);
    if (!afterGit.ok) return afterGit;
    if (JSON.stringify(afterGit.snapshot) !== JSON.stringify(captured.snapshot)) return recoveryRefusal("REPOSITORY_REVIEW_WORKSPACE_CHANGED");
    input.assertAuthority?.();
    if (!human()) return recoveryRefusal("REPOSITORY_RECOVERY_HUMAN_REQUIRED");
    // Capture both tokens before the complete final read. The actual writer fence checks them
    // again without awaiting, so neither an external writer nor this connection can move facts.
    const dataVersion = store.readCommandDecisionCacheVersion(); const horizon = store.readEventHorizon();
    if (!replanAuthorityClosed(store, handle, input.clock())) return recoveryRefusal("REPOSITORY_REVIEW_AUTHORITY_LIVE");
    const held = readRepositoryRecoveryReservation(handle.reservation.identity.root, storeId, projectId);
    if (!held.ok) return recoveryRefusal(held.code);
    if (held.handle === null || JSON.stringify(held.handle) !== JSON.stringify(handle)) return recoveryRefusal("REPOSITORY_RECOVERY_REVISION_CONFLICT");
    const after = readRepositoryReplanEvidence(store, handle);
    if (!after.ok) return after;
    if (JSON.stringify(after.evidence) !== JSON.stringify(before.evidence)) return recoveryRefusal("REPOSITORY_REVIEW_EVIDENCE_CHANGED");
    return withReviewResumeStoreLock({ storeId, store, dataVersion, horizon }, () => {
      const changed = releaseReplannedRepository({ handle, principalId: command.principalId, commandId: command.commandId,
        requestSha256: input.requestSha256, evidence: before.evidence, drain: drained.evidence,
        snapshotDigest: recoveryDigest(afterGit.snapshot) });
      return changed.ok ? { ok: true, released: true, replayed: changed.replayed === true } : recoveryRefusal(changed.code);
    });
  } finally { await drained.close(); }
}
