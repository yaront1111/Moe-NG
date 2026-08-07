import { DurableStoreError } from "./store-contracts.js";
import type {
  CommandDecisionRecord,
  CommitExpectedVersionDecisionInput,
} from "./store-contracts.js";
import {
  expectedVersionConflictResultBytes,
  identifyCommandDecisionId,
  identifyCommandRequest,
  identifyExpectedVersionRequest,
  internalReceiptCommandId,
  rejectionAuditAggregateId,
  rejectionAuditEventId,
  rejectionAuditPayload,
} from "./store-digests.js";
import {
  snapshotCommittedProposal,
  snapshotDecisionMetadata,
  snapshotExpectedVersionRequest,
} from "./store-input.js";
import { EMPTY_BYTES } from "./store-internals.js";
import type {
  SnapshotCommittedProposal,
  SnapshotCommitInput,
  SnapshotDecisionMetadata,
  SnapshotExpectedVersionRequest,
  StoredCommitResult,
} from "./store-internals.js";

export interface DecisionIdentities {
  readonly decisionId: string;
  readonly receiptCommandId: string;
  readonly requestSha256: string;
}

export interface CanonicalDecisionEffect {
  readonly auditEventId: string | null;
  readonly businessEventIds: readonly string[];
  readonly currentVersion: number | null;
  readonly effectDisposition: CommandDecisionRecord["effectDisposition"];
  readonly outboxMessageIds: readonly string[];
  readonly previousVersion: number | null;
  readonly receipt: StoredCommitResult;
  readonly resultBytes: Uint8Array;
  readonly resultCode: CommandDecisionRecord["resultCode"];
}

export interface DecisionEffectContext {
  readonly assertAggregateTail: (aggregateId: string) => number;
  readonly writeCommitEffects: (
    input: SnapshotCommitInput,
    requestSha256: string,
    previousVersion: number,
  ) => StoredCommitResult;
}

export interface DecisionPlan {
  readonly identities: DecisionIdentities;
  readonly metadata: SnapshotDecisionMetadata;
  readonly preflightProposal: SnapshotCommittedProposal | null;
  readonly proposalFailure: Readonly<{ readonly error: unknown }> | null;
  readonly request: SnapshotExpectedVersionRequest;
}

interface RejectionAuditInput {
  readonly auditAggregateId: string;
  readonly auditEventId: string;
  readonly decidedAt: string;
  readonly identities: DecisionIdentities;
  readonly observedVersion: number;
  readonly request: SnapshotExpectedVersionRequest;
}

/** Snapshots hostile caller bytes exactly once, before any identity is derived. */
export function snapshotDecisionRequest(
  rawInput: CommitExpectedVersionDecisionInput,
): SnapshotExpectedVersionRequest {
  return snapshotExpectedVersionRequest(rawInput);
}

export function identifyDecisionRequest(
  request: SnapshotExpectedVersionRequest,
): DecisionIdentities {
  const requestSha256 = identifyExpectedVersionRequest(request);
  const decisionId = identifyCommandDecisionId(request.key);
  return {
    decisionId,
    receiptCommandId: internalReceiptCommandId(decisionId),
    requestSha256,
  };
}

export function snapshotDecisionInputMetadata(
  request: SnapshotExpectedVersionRequest,
): SnapshotDecisionMetadata {
  return snapshotDecisionMetadata(request.inputRecord);
}

/** Precomputes the accepted proposal only when the preflight version already matches. */
export function planDecision(
  request: SnapshotExpectedVersionRequest,
  identities: DecisionIdentities,
  metadata: SnapshotDecisionMetadata,
  observedVersion: number,
): DecisionPlan {
  let preflightProposal: SnapshotCommittedProposal | null = null;
  let proposalFailure: Readonly<{ readonly error: unknown }> | null = null;
  if (observedVersion === request.expectedVersion) {
    try {
      preflightProposal = snapshotCommittedProposal(
        request,
        identities.receiptCommandId,
        metadata.decidedAt,
      );
    } catch (error) {
      proposalFailure = { error };
    }
  }
  return { identities, metadata, preflightProposal, proposalFailure, request };
}

/** Re-snapshots under the lock only when the preflight version did not match. */
export function lockedDecisionProposal(plan: DecisionPlan): SnapshotCommittedProposal {
  if (plan.proposalFailure !== null) {
    throw plan.proposalFailure.error;
  }
  return (
    plan.preflightProposal ??
    snapshotCommittedProposal(
      plan.request,
      plan.identities.receiptCommandId,
      plan.metadata.decidedAt,
    )
  );
}

/** Writes the accepted business effect; must run inside the caller's transaction. */
export function commitAcceptedDecisionEffect(
  ctx: DecisionEffectContext,
  proposal: SnapshotCommittedProposal,
  observedVersion: number,
): CanonicalDecisionEffect {
  const receiptRequestSha256 = identifyCommandRequest(proposal.commitInput);
  const receipt = ctx.writeCommitEffects(
    proposal.commitInput,
    receiptRequestSha256,
    observedVersion,
  );
  return {
    auditEventId: null,
    businessEventIds: receipt.eventIds,
    currentVersion: receipt.currentVersion,
    effectDisposition: "EFFECTS_COMMITTED",
    outboxMessageIds: receipt.outboxMessageIds,
    previousVersion: receipt.previousVersion,
    receipt,
    resultBytes: proposal.resultBytes,
    resultCode: "EFFECTS_COMMITTED",
  };
}

/** Writes the rejection audit receipt; must run inside the caller's transaction. */
export function commitRejectedDecisionEffect(
  ctx: DecisionEffectContext,
  request: SnapshotExpectedVersionRequest,
  identities: DecisionIdentities,
  decidedAt: string,
  observedVersion: number,
): CanonicalDecisionEffect {
  const auditAggregateId = rejectionAuditAggregateId(identities.decisionId);
  const auditEventId = rejectionAuditEventId(identities.decisionId);
  if (ctx.assertAggregateTail(auditAggregateId) !== 0) {
    throw new DurableStoreError(
      "STORE_CORRUPT",
      "the internal rejection-audit aggregate is already occupied",
    );
  }
  const auditCommitInput = rejectionAuditCommitInput({
    auditAggregateId,
    auditEventId,
    decidedAt,
    identities,
    observedVersion,
    request,
  });
  const receipt = ctx.writeCommitEffects(
    auditCommitInput,
    identifyCommandRequest(auditCommitInput),
    0,
  );
  return {
    auditEventId,
    businessEventIds: [],
    currentVersion: null,
    effectDisposition: "NO_BUSINESS_EFFECT",
    outboxMessageIds: [],
    previousVersion: null,
    receipt,
    resultBytes: expectedVersionConflictResultBytes(
      request.expectedVersion,
      observedVersion,
    ),
    resultCode: "EXPECTED_VERSION_CONFLICT",
  };
}

function rejectionAuditCommitInput(input: RejectionAuditInput): SnapshotCommitInput {
  const { auditAggregateId, auditEventId, decidedAt, identities, request } = input;
  const auditPayload = rejectionAuditPayload({
    commandId: request.key.commandId,
    commandKind: request.commandKind,
    decisionId: identities.decisionId,
    expectedVersion: request.expectedVersion,
    observedVersion: input.observedVersion,
    principalId: request.key.principalId,
    projectId: request.key.projectId,
    requestSha256: identities.requestSha256,
    targetAggregateId: request.targetAggregateId,
  });
  return {
    aggregateId: auditAggregateId,
    commandBytes: auditPayload,
    commandId: identities.receiptCommandId,
    committedAt: decidedAt,
    events: [
      {
        eventId: auditEventId,
        eventType: "command.expected-version-rejected",
        metadata: EMPTY_BYTES,
        outbox: [],
        payload: auditPayload,
      },
    ],
    expectedVersion: 0,
  };
}
