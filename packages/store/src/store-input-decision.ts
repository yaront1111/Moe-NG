import { MAX_COMMIT_BYTES } from "./store-contracts.js";
import type {
  CommandDecisionKey,
  CommitExpectedVersionDecisionInput,
  CommitInput,
} from "./store-contracts.js";
import { identifyCorrelation } from "./store-digests.js";
import type {
  ByteBudget,
  DataRecord,
  SnapshotCommittedProposal,
  SnapshotDecisionMetadata,
  SnapshotExpectedVersionRequest,
} from "./store-internals.js";
import { snapshotBytes } from "./store-input-containers.js";
import {
  assertExternalCommitIdentifiers,
  snapshotCommitInput,
} from "./store-input-commit.js";
import {
  readOwnDataProperty,
  requireCanonicalTimestamp,
  requireDataRecord,
  requireIdentifier,
  requireSafeNonnegativeInteger,
} from "./store-input-primitives.js";

export function snapshotCommandDecisionKey(value: unknown): CommandDecisionKey {
  const key = requireDataRecord(value, "key");
  return Object.freeze({
    commandId: requireIdentifier(
      readOwnDataProperty(key, "commandId", "key.commandId"),
      "key.commandId",
    ),
    principalId: requireIdentifier(
      readOwnDataProperty(key, "principalId", "key.principalId"),
      "key.principalId",
    ),
    projectId: requireIdentifier(
      readOwnDataProperty(key, "projectId", "key.projectId"),
      "key.projectId",
    ),
  });
}

export function snapshotExpectedVersionRequest(
  rawInput: CommitExpectedVersionDecisionInput,
): SnapshotExpectedVersionRequest {
  const input = requireDataRecord(rawInput, "expected-version decision input");
  return {
    commandKind: requireIdentifier(
      readOwnDataProperty(input, "commandKind", "commandKind"),
      "commandKind",
    ),
    expectedVersion: requireSafeNonnegativeInteger(
      readOwnDataProperty(input, "expectedVersion", "expectedVersion"),
      "expectedVersion",
    ),
    inputRecord: input,
    key: snapshotCommandDecisionKey(readOwnDataProperty(input, "key", "key")),
    requestBytes: snapshotBytes(
      readOwnDataProperty(input, "requestBytes", "requestBytes"),
      "requestBytes",
    ),
    targetAggregateId: requireIdentifier(
      readOwnDataProperty(input, "targetAggregateId", "targetAggregateId"),
      "targetAggregateId",
    ),
  };
}

export function snapshotDecisionMetadata(input: DataRecord): SnapshotDecisionMetadata {
  const correlationId = requireIdentifier(
    readOwnDataProperty(input, "correlationId", "correlationId"),
    "correlationId",
  );
  return {
    correlationSha256: identifyCorrelation(correlationId),
    decidedAt: requireCanonicalTimestamp(
      readOwnDataProperty(input, "decidedAt", "decidedAt"),
      "decidedAt",
    ),
  };
}

export function snapshotCommittedProposal(
  request: SnapshotExpectedVersionRequest,
  receiptCommandId: string,
  decidedAt: string,
): SnapshotCommittedProposal {
  const byteBudget: ByteBudget = { remaining: MAX_COMMIT_BYTES };
  const resultBytes = snapshotBytes(
    readOwnDataProperty(
      request.inputRecord,
      "committedResultBytes",
      "committedResultBytes",
    ),
    "committedResultBytes",
    byteBudget,
  );
  const rawCommitInput = {
    aggregateId: request.targetAggregateId,
    commandBytes: request.requestBytes,
    commandId: receiptCommandId,
    committedAt: decidedAt,
    events: readOwnDataProperty(request.inputRecord, "events", "events"),
    expectedVersion: request.expectedVersion,
  } as unknown as CommitInput;
  const commitInput = snapshotCommitInput(rawCommitInput, byteBudget);
  assertExternalCommitIdentifiers(commitInput, receiptCommandId);
  return { commitInput, resultBytes };
}
