import { createHash } from "node:crypto";
import type { SqliteEventStore } from "@moe/store";
import { decisionsOf } from "../decision-ledger-memo.js";
import { isDurableHumanPrincipal } from "../identity/human-approver.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { readWorkClaimLedger } from "../work/work-claim-read-model.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { readTerminalReplan } from "../review/review-terminal-replan.js";
import { liveChildOf } from "../orchestrator/agent-wrapper-reclaim-records.js";
import { decodeSeatStartBytes, seatStartAggregateId } from "../orchestrator/seat-start-contracts.js";
import { AGENT_WRAPPER_PRINCIPAL_ID, SEAT_EXIT_COMMAND_KIND, decodeSeatExitBytes,
  seatExitAggregateId, seatExitRecordId } from "../orchestrator/provider-pause-contracts.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import { readRepositoryFailedReviewEvidence, reviewResumeAuthorityClosed } from "./repository-review-resume-evidence.js";
import type { RepositoryReviewResumeEvidence } from "./repository-review-resume-evidence.js";

export interface RepositoryReplanEvidence extends RepositoryReviewResumeEvidence {
  readonly replanDecisionId: string; readonly replanDigest: string; readonly replanPrincipalId: string;
}

/** A release intent must be the human REPLAN that is the node's last decision and answers its latest reviewed round. */
export function readRepositoryReplanEvidence(store: SqliteEventStore, handle: RepositoryExecutionHandle):
RepositoryRecoveryResult<{ evidence: RepositoryReplanEvidence }> {
  const invalid = () => recoveryRefusal("REPOSITORY_REPLAN_EVIDENCE_INVALID");
  try {
    const ledger = readReviewLedger(store, handle.owner.projectId, handle.owner.nodeRef);
    if (!ledger.replanned) return invalid();
    const common = readRepositoryFailedReviewEvidence(store, handle);
    if (!common.ok) return common;
    if (ledger.continuation !== undefined) return invalid();
    // An agent's earlier re-plan is no evidence against release; live successor work is fenced by
    // the human principal, closed authority, a positive native drain and an unchanged clean tree.
    const terminal = readTerminalReplan(decisionsOf(store, 200), handle.owner.projectId, handle.owner.nodeRef, ledger);
    if (terminal === null || !isDurableHumanPrincipal(store, terminal.replan.key.principalId)) return invalid();
    const { replan } = terminal;
    return { ok: true, evidence: { ...common.evidence, replanDecisionId: replan.decisionId,
      replanDigest: replan.resultSha256, replanPrincipalId: replan.key.principalId } };
  } catch { return invalid(); }
}

/** Missing/expired authority is not positive retirement; retain the exact old seat's closure. */
export function replanAuthorityClosed(store: SqliteEventStore, handle: RepositoryExecutionHandle, now: string): boolean {
  try {
    if (!reviewResumeAuthorityClosed(store, handle, now)) return false;
    const { owner, reservation } = handle; const sessionId = reservation.sessionId;
    if (sessionId === null) return false;
    const workItemId = `node.deliver@${owner.nodeRef}`;
    const session = readSessionLedger(store, owner.projectId).sessions.get(sessionId);
    const claims = readWorkClaimLedger(store, owner.projectId).claims;
    if ([...claims.values()].some((claim) => claim.status === "OPEN" && !(Date.parse(claim.expiresAt) <= Date.parse(now)))) return false;
    const claim = claims.get(workItemId);
    if (session?.status !== "CLOSED" || claim?.status !== "RELEASED" || claim.claimedBy !== sessionId) return false;
    const events = store.readEvents(`wrapper-staffing/${createHash("sha256").update(workItemId).digest("hex")}`);
    const last = events.at(-1); const prior = liveChildOf(events.slice(0, -1));
    if (last?.eventType !== "AgentStaffingRetired" || prior === null || prior === "UNREADABLE"
      || prior.sessionId !== sessionId || prior.childPid !== reservation.pid || prior.workItemId !== workItemId) return false;
    const decisions = decisionsOf(store, 200);
    const start = decisions.find((row) => row.key.projectId === owner.projectId && row.effectDisposition === "EFFECTS_COMMITTED"
      && row.targetAggregateId === seatStartAggregateId(owner.projectId, sessionId));
    const started = start === undefined ? null : decodeSeatStartBytes(start.resultBytes);
    const exits = decisions.filter((row) => row.key.projectId === owner.projectId
      && row.targetAggregateId === seatExitAggregateId(owner.projectId, sessionId) && row.effectDisposition === "EFFECTS_COMMITTED");
    const exit = exits[0]; const decoded = exit === undefined ? null : decodeSeatExitBytes(exit.resultBytes);
    return exits.length === 1 && exit !== undefined && decoded?.ok === true && started?.ok === true && start !== undefined
      && exit.previousVersion === 0 && exit.currentVersion === 1 && start.decisionPosition < exit.decisionPosition
      && exit.commandKind === SEAT_EXIT_COMMAND_KIND && exit.key.principalId === AGENT_WRAPPER_PRINCIPAL_ID
      && exit.key.commandId === seatExitRecordId(owner.projectId, sessionId, decoded.record.decidedAt)
      && decoded.record.projectId === owner.projectId && decoded.record.sessionId === sessionId
      && decoded.record.workItemId === workItemId && exit.decidedAt === decoded.record.decidedAt
      && Date.parse(exit.decidedAt) >= Date.parse(started.record.startedAt)
      && Date.parse(exit.decidedAt) <= Date.parse(now);
  } catch { return false; }
}
