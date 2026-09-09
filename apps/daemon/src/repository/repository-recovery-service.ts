import type { SqliteEventStore } from "@moe/store";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RepositoryRecoveryGitPort } from "./repository-recovery-git.js";
import { createRepositoryRecoveryGitPort } from "./repository-recovery-git.js";
import { REPOSITORY_RECOVERY_ACTIONS, REPOSITORY_RECOVERY_COMMAND_KIND, REPOSITORY_RECOVERY_VERSION, recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult, RepositoryRecoveryView } from "./repository-recovery-contracts.js";
import { decodeRepositoryRecoveryPayload } from "./repository-recovery-codec.js";
import { readRepositoryRecoveryReservation, recoverRepositoryExecution } from "./repository-execution-recovery.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
import { readRecoveryLandingEvidence } from "./repository-recovery-evidence.js";
import { recoveryDigest } from "./repository-recovery-facts.js";
import { readRecoveryApproval, recordRecoveryApproval } from "./repository-recovery-approval.js";
import { readRepositoryRecoveryReplay } from "./repository-recovery-replay.js";
import { recordLandingReceipt } from "./landing-ledger.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
export interface RepositoryRecoveryServiceOptions {
  readonly store: SqliteEventStore; readonly projectId: string; readonly storeId: string;
  readonly workspaces: () => readonly string[]; readonly clock: () => string; readonly mintId: () => string;
  readonly git?: RepositoryRecoveryGitPort;
}
export interface RepositoryRecoveryCommand {
  readonly principalId: string; readonly operatorPrincipalId: string; readonly commandId: string;
  readonly correlationId: string; readonly expectedVersion: number; readonly targetAggregateId: string; readonly payload: unknown;
}
export interface RepositoryRecoverySuccess { readonly commandId: string; readonly disposition: "COMMITTED" | "REPLAYED"; readonly resultCode: "REPOSITORY_RECOVERY_RELEASED" }
type Held = { handle: RepositoryExecutionHandle; everExecuted: boolean };
const targetFor = (handle: RepositoryExecutionHandle) => `repository-recovery:${repositoryRecoveryOwnerDigest(handle.owner)}`;
function abortCode(held: Held): string | null {
  if (/^(?:publish|criterion):/u.test(held.handle.owner.nodeRef)) return "REPOSITORY_RECOVERY_WORKFLOW_UNSUPPORTED";
  const state = held.handle.reservation;
  return !held.everExecuted && ["RESERVED", "BLOCKED"].includes(state.phase) && state.pid === null && state.sessionId === null
    ? null : "REPOSITORY_RECOVERY_CONTAINMENT_UNKNOWN";
}
export function createRepositoryRecoveryService(options: RepositoryRecoveryServiceOptions) {
  const git = options.git ?? createRepositoryRecoveryGitPort();
  const scan = (): { held: Held[]; code: string | null } => {
    const held: Held[] = []; let code: string | null = null;
    try {
      const workspaces = options.workspaces(); if (workspaces.length > 32) return { held, code: "REPOSITORY_RECOVERY_SCOPE_UNBOUNDED" };
      const seen = new Set<string>();
      for (const workspace of new Set(workspaces)) {
        const read = readRepositoryRecoveryReservation(workspace, options.storeId, options.projectId);
        if (!read.ok) { code = read.code; continue; }
        if (read.handle === null || seen.has(read.handle.reservation.identity.gitDirectory)) continue;
        seen.add(read.handle.reservation.identity.gitDirectory); held.push({ handle: read.handle, everExecuted: read.everExecuted });
      }
    } catch { code = "REPOSITORY_RECOVERY_UNAVAILABLE"; }
    return { held, code };
  };
  const success = (commandId: string, replayed: boolean): RepositoryRecoveryResult<RepositoryRecoverySuccess> =>
    ({ ok: true, commandId, disposition: replayed ? "REPLAYED" : "COMMITTED", resultCode: "REPOSITORY_RECOVERY_RELEASED" });
  return {
    readRecovery(): RepositoryRecoveryView {
      const { held, code } = scan();
      return { version: REPOSITORY_RECOVERY_VERSION, projectId: options.projectId, code, reservations: held.map((item) => {
        const { handle } = item; const targetAggregateId = targetFor(handle);
        const landing = readRecoveryLandingEvidence(options.store, handle);
        return { nodeRef: handle.owner.nodeRef, phase: handle.reservation.phase, expectedReservationRevision: handle.reservation.revision,
          actions: REPOSITORY_RECOVERY_ACTIONS.map((action) => {
            const refusal = action === "ABORT_UNEXECUTED" ? abortCode(item) : landing.ok ? null : landing.code;
            return { action, available: refusal === null, code: refusal, offer: refusal !== null ? null : {
              commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, commandId: options.mintId(), commandKind: REPOSITORY_RECOVERY_COMMAND_KIND,
              expectedVersion: options.store.getAggregateVersion(targetAggregateId), inputSchemaVersion: REPOSITORY_RECOVERY_VERSION, targetAggregateId } };
          }) };
      }) };
    },
    async recover(input: RepositoryRecoveryCommand): Promise<RepositoryRecoveryResult<RepositoryRecoverySuccess>> {
      try {
        if (input.operatorPrincipalId.trim() === "" || (input.principalId !== input.operatorPrincipalId
          && !isDurableHumanPrincipal(options.store, input.principalId))) return recoveryRefusal("REPOSITORY_RECOVERY_HUMAN_REQUIRED");
        const payload = decodeRepositoryRecoveryPayload(input.payload);
        if (payload === null || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
          || input.commandId.trim() === "" || input.commandId.length > 4096) return recoveryRefusal("REPOSITORY_RECOVERY_INPUT_INVALID");
        const requestSha256 = recoveryDigest([options.projectId, input.principalId, input.commandId, input.expectedVersion, input.targetAggregateId, payload]);
        const prior = readRecoveryApproval(options.store, options.projectId, input, requestSha256); if (!prior.ok) return prior;
        if (prior.approval !== null) {
          const replay = readRepositoryRecoveryReplay(prior.approval.identity, { projectId: options.projectId, principalId: input.principalId,
            commandId: input.commandId, requestSha256, ownerDigest: prior.approval.ownerDigest, expectedRevision: payload.expectedReservationRevision });
          if (!replay.ok) return replay; if (replay.released) return success(input.commandId, true);
        }
        const candidates = scan().held.filter((item) => item.handle.owner.nodeRef === payload.nodeRef && targetFor(item.handle) === input.targetAggregateId);
        if (candidates.length !== 1) return recoveryRefusal("REPOSITORY_RECOVERY_RESERVATION_UNAVAILABLE");
        const held = candidates[0]!; const { handle } = held;
        if (handle.reservation.revision !== payload.expectedReservationRevision) return recoveryRefusal("REPOSITORY_RECOVERY_REVISION_CONFLICT");
        const abort = abortCode(held);
        const landing = payload.action === "RECONCILE_LANDED" ? readRecoveryLandingEvidence(options.store, handle) : null;
        if (payload.action === "ABORT_UNEXECUTED" && abort !== null) return recoveryRefusal(abort);
        if (landing !== null && !landing.ok) return landing;
        const approval = { requestSha256, ownerDigest: repositoryRecoveryOwnerDigest(handle.owner), identity: handle.reservation.identity };
        if (prior.approval !== null && JSON.stringify(prior.approval) !== JSON.stringify(approval)) return recoveryRefusal("REPOSITORY_RECOVERY_APPROVAL_CONFLICT");
        if (prior.approval === null) {
          const written = recordRecoveryApproval(options.store, options.projectId, { ...input, payload }, approval, options.clock());
          if (!written.ok) return written;
        }
        const release = (proof: Parameters<typeof recoverRepositoryExecution>[0]["proof"]): RepositoryRecoveryResult<RepositoryRecoverySuccess> => {
          const result = recoverRepositoryExecution({ handle, expectedRevision: payload.expectedReservationRevision, commandId: input.commandId,
            principalId: input.principalId, requestSha256, proof });
          return result.ok ? success(input.commandId, result.replayed) : recoveryRefusal(result.code);
        };
        if (landing === null) return release({ kind: "ABORT_UNEXECUTED" });
        if (!landing.ok) return landing;
        return await git.guard(landing.evidence, () => {
          // Rejoin durable evidence while the Git identity and owned index entries are held.
          const checked = readRecoveryLandingEvidence(options.store, handle); if (!checked.ok) return checked;
          if (JSON.stringify(checked.evidence) !== JSON.stringify(landing.evidence)) return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_CONFLICT");
          if (checked.evidence.needsLandingReceipt) {
            const recorded = recordLandingReceipt(options.store, { projectId: options.projectId, subjectRef: handle.owner.nodeRef,
              verifierReceiptId: checked.evidence.verifierReceiptId, workspace: checked.evidence.binding.root, commit: checked.evidence.commit,
              decidedAt: options.clock(), refusal: null });
            if (!recorded.ok) return recoveryRefusal(recorded.code);
            const confirmed = readRecoveryLandingEvidence(options.store, handle);
            if (!confirmed.ok || confirmed.evidence.needsLandingReceipt || JSON.stringify(confirmed.evidence.commit) !== JSON.stringify(checked.evidence.commit)) {
              return recoveryRefusal("REPOSITORY_RECOVERY_EVIDENCE_CONFLICT");
            }
          }
          return release(checked.evidence.proof);
        });
      } catch { return recoveryRefusal("REPOSITORY_RECOVERY_UNAVAILABLE"); }
    },
  };
}
