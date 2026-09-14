import { decodeBoundedJsonBytes } from "@moe/contracts";
import type { JsonObject } from "@moe/contracts";
import { buildReviewPackage, recordReviewRound } from "@moe/review";
import type { SqliteEventStore } from "@moe/store";
import { decisionsOf } from "../decision-ledger-memo.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { readReviewSubmissionSource } from "../review/review-submission-source.js";
import { readSubmittedReviewWorkspace } from "../review/review-submission-read.js";
import { prepareReviewSubmissionPackage } from "../review/review-submission-package.js";
import { verifyStoredPackageItems } from "../review/review-package-restore.js";
import { readSessionLedger } from "../identity/session-read-model.js";
import { readWorkClaimLedger } from "../work/work-claim-read-model.js";
import { liveChildOf } from "../orchestrator/agent-wrapper-reclaim-records.js";
import { AGENT_WRAPPER_PRINCIPAL_ID } from "../orchestrator/provider-pause-contracts.js";
import { SEAT_START_COMMAND_KIND, decodeSeatStartBytes, seatStartAggregateId, seatStartRecordId } from "../orchestrator/seat-start-contracts.js";
import { readLandingBaseline } from "./landing-ledger.js";
import { landingAggregateId, NODE_LANDER_PRINCIPAL_ID } from "./landing-receipt-contracts.js";
import { recoveryRefusal } from "./repository-recovery-contracts.js";
import type { RepositoryRecoveryResult } from "./repository-recovery-contracts.js";
import type { RepositoryExecutionHandle } from "./repository-execution-contracts.js";
import { resolveRepositoryExecutionIdentity } from "./repository-execution-identity.js";
import { repositoryRecoveryOwnerDigest } from "./repository-landing-intent.js";
import type { VerifiedWorkspaceBinding } from "./verified-workspace-contracts.js";

export interface RepositoryReviewResumeEvidence {
  readonly reviewVersion: number;
  readonly reviewDigest: string;
  readonly reviewDecisionId: string;
  readonly reviewDecidedAt: string;
  readonly seatStartedAt: string;
  readonly seatStartDigest: string;
  readonly binding: VerifiedWorkspaceBinding;
  readonly sourceDigest: string;
}

/** Only a failed, host-prepared compiled review with its original baseline can resume. */
export function readRepositoryReviewResumeEvidence(store: SqliteEventStore, handle: RepositoryExecutionHandle):
RepositoryRecoveryResult<{ evidence: RepositoryReviewResumeEvidence }> {
  const invalid = () => recoveryRefusal("REPOSITORY_REVIEW_EVIDENCE_INVALID");
  try {
    const { owner, reservation } = handle;
    if (reservation.phase !== "BLOCKED" || reservation.baselineId === null || reservation.sessionId === null
      || /^(?:publish|criterion):/u.test(owner.nodeRef)) return recoveryRefusal("REPOSITORY_REVIEW_PHASE_UNSUPPORTED");
    const review = readReviewLedger(store, owner.projectId, owner.nodeRef);
    const latest = review.rounds.at(-1);
    if (review.unreadable || review.replanned || review.accepted !== undefined || latest === undefined
      || latest.routing.route === "ACCEPT" || latest.principalId !== reservation.sessionId
      || !verifyStoredPackageItems(latest).ok || !recordReviewRound(latest.lineage, { findings: [], round: latest.round + 1 }).ok) return invalid();
    const source = readReviewSubmissionSource(store, owner.projectId, owner.nodeRef);
    const submitted = readSubmittedReviewWorkspace(store, owner.projectId, owner.nodeRef, latest);
    if (source === null || submitted.status !== "PRESENT" || submitted.binding.root !== reservation.identity.root) return invalid();
    const rebuilt = buildReviewPackage(prepareReviewSubmissionPackage({ source, binding: submitted.binding,
      projectId: owner.projectId, subjectRef: owner.nodeRef }).items);
    if (!rebuilt.ok || rebuilt.value.reviewInputDigest !== latest.reviewInputDigest) return invalid();
    const baseline = readLandingBaseline(store, owner.projectId, owner.nodeRef, reservation.baselineId);
    if (baseline === null) return invalid();
    const identity = resolveRepositoryExecutionIdentity(baseline.workspace);
    if (!identity.ok || JSON.stringify(identity.identity) !== JSON.stringify(reservation.identity)) return invalid();
    const base = store.getCommandDecision({ projectId: owner.projectId, principalId: NODE_LANDER_PRINCIPAL_ID,
      commandId: reservation.baselineId });
    const decisions = decisionsOf(store, 200).filter((row) => row.key.projectId === owner.projectId);
    const decided = decisions.find((row) => row.decisionId === latest.decisionId);
    if (base === null || decided === undefined || base.decisionPosition >= decided.decisionPosition) return invalid();
    const starts = decisions.filter((row) => row.effectDisposition === "EFFECTS_COMMITTED"
      && row.targetAggregateId === seatStartAggregateId(owner.projectId, reservation.sessionId!));
    const start = starts[0];
    const decodedStart = start === undefined ? null : decodeSeatStartBytes(start.resultBytes);
    if (starts.length !== 1 || start === undefined || decodedStart?.ok !== true
      || start.commandKind !== SEAT_START_COMMAND_KIND || start.key.principalId !== AGENT_WRAPPER_PRINCIPAL_ID
      || decodedStart.record.projectId !== owner.projectId || decodedStart.record.sessionId !== reservation.sessionId
      || start.key.commandId !== seatStartRecordId(owner.projectId, reservation.sessionId, decodedStart.record.startedAt)
      || start.decidedAt !== decodedStart.record.startedAt || start.previousVersion !== 0
      || base.decisionPosition >= start.decisionPosition || start.decisionPosition >= decided.decisionPosition
      || !(Date.parse(baseline.observedAt) <= Date.parse(decodedStart.record.startedAt))
      || !(Date.parse(decodedStart.record.startedAt) <= Date.parse(decided.decidedAt))) {
      return recoveryRefusal("REPOSITORY_REVIEW_SEAT_START_INVALID");
    }
    const journalAggregate = `repository-landing:${repositoryRecoveryOwnerDigest(owner)}`;
    for (const row of decisions) {
      if (row.effectDisposition !== "EFFECTS_COMMITTED") continue;
      if ((row.targetAggregateId === owner.nodeRef && row.commandKind === "internal.integration.verifier_receipt")
        || (row.targetAggregateId === landingAggregateId(owner.nodeRef) && row.commandKind !== "internal.repository.landing_baseline")
        || row.targetAggregateId === journalAggregate) return recoveryRefusal("REPOSITORY_REVIEW_EFFECTS_UNRESOLVED");
      if (row.commandKind === "internal.repository.landing_intent" || row.commandKind === "internal.repository.landing_completion") {
        const decoded = decodeBoundedJsonBytes(row.resultBytes);
        const value = decoded.ok ? decoded.value : null;
        if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
        const record = value as JsonObject;
        if (record["nodeRef"] === owner.nodeRef || record["ownerDigest"] === repositoryRecoveryOwnerDigest(owner)) {
          return recoveryRefusal("REPOSITORY_REVIEW_EFFECTS_UNRESOLVED");
        }
      }
    }
    return { ok: true, evidence: { reviewVersion: review.version, reviewDigest: latest.resultSha256,
      reviewDecisionId: latest.decisionId, reviewDecidedAt: decided.decidedAt, binding: submitted.binding,
      seatStartedAt: decodedStart.record.startedAt, seatStartDigest: start.resultSha256,
      sourceDigest: rebuilt.value.reviewInputDigest } };
  } catch { return invalid(); }
}

/** Positive native containment does not revoke a bearer; both durable authority lanes must end. */
export function reviewResumeAuthorityClosed(store: SqliteEventStore, handle: RepositoryExecutionHandle, now: string): boolean {
  try {
    const sessions = readSessionLedger(store, handle.owner.projectId);
    const claims = readWorkClaimLedger(store, handle.owner.projectId);
    if (sessions.unreadable || claims.unreadable) return false;
    const session = sessions.sessions.get(handle.reservation.sessionId ?? "");
    const claim = claims.claims.get(`node.deliver@${handle.owner.nodeRef}`);
    if ((session?.status === "OPEN" && !(Date.parse(session.expiresAt) <= Date.parse(now)))
      || (claim?.status === "OPEN" && !(Date.parse(claim.expiresAt) <= Date.parse(now)))) return false;
    for (const id of store.enumerateAggregateIdsByPrefix("wrapper-staffing/")) {
      if (liveChildOf(store.readEvents(id)) !== null) return false;
    }
    return true;
  } catch { return false; }
}
