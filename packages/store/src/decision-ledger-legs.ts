import { MAX_COMMIT_BYTES } from "./store-contracts.js";
import type { CommitInput } from "./store-contracts.js";
import { MAX_DECISION_LEGS } from "./decision-legs-contracts.js";
import type { CommitExpectedVersionDecisionLegsInput } from "./decision-legs-contracts.js";
import {
  identifyCommandRequest,
  legReceiptCommandId,
} from "./store-digests.js";
import type { AdditionalLegFence } from "./store-digests.js";
import {
  assertExternalCommitIdentifiers,
  invalidInput,
  limitExceeded,
  readOwnDataProperty,
  requireDataRecord,
  requireIdentifier,
  requireSafeNonnegativeInteger,
  snapshotBytes,
  snapshotCommandDecisionKey,
  snapshotCommitInput,
  snapshotDenseArray,
} from "./store-input.js";
import type {
  ByteBudget,
  DataRecord,
  SnapshotCommitInput,
  SnapshotDecisionMetadata,
  SnapshotExpectedVersionRequest,
  StoredCommandDecision,
} from "./store-internals.js";
import {
  commitAcceptedDecisionEffect,
  commitRejectedDecisionEffect,
} from "./decision-ledger-canonical.js";
import type {
  DecisionEffectContext,
  DecisionIdentities,
} from "./decision-ledger-canonical.js";
import { writeCanonicalDecision } from "./decision-ledger-record.js";
import type { DecisionRecordContext } from "./decision-ledger-record.js";

/** One leg after hostile-input snapshotting, before its events are read. */
interface SnapshotDecisionLeg {
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly inputRecord: DataRecord;
}

/** The primary-leg request view plus every leg's fence, snapshotted once. */
export interface SnapshotLegsRequest {
  readonly legs: readonly SnapshotDecisionLeg[];
  readonly request: SnapshotExpectedVersionRequest;
}

/** One leg's durable commit, plus the request view that names it in a refusal. */
export interface DecisionLegPlan {
  readonly commitInput: SnapshotCommitInput;
  readonly request: SnapshotExpectedVersionRequest;
}

export interface DecisionLegsPlan {
  readonly legs: readonly DecisionLegPlan[];
  readonly resultBytes: Uint8Array;
}

export interface DecisionLegsContext {
  readonly effect: DecisionEffectContext;
  readonly record: DecisionRecordContext;
}

function legRequestView(
  request: SnapshotExpectedVersionRequest,
  leg: SnapshotDecisionLeg,
): SnapshotExpectedVersionRequest {
  return {
    ...request,
    expectedVersion: leg.expectedVersion,
    targetAggregateId: leg.aggregateId,
  };
}

/** Snapshots hostile caller bytes exactly once, before any identity is derived. */
export function snapshotLegsRequest(
  rawInput: CommitExpectedVersionDecisionLegsInput,
): SnapshotLegsRequest {
  const input = requireDataRecord(rawInput, "expected-version decision legs input");
  const rawLegs = snapshotDenseArray(
    readOwnDataProperty(input, "legs", "legs"),
    "legs",
    MAX_DECISION_LEGS,
  );
  if (rawLegs.length === 0) {
    return invalidInput("legs must contain at least one leg");
  }
  if (rawLegs.length > MAX_DECISION_LEGS) {
    return limitExceeded(`legs cannot exceed ${MAX_DECISION_LEGS} per decision`);
  }
  const aggregateIds = new Set<string>();
  const legs = rawLegs.map((rawLeg, legIndex): SnapshotDecisionLeg => {
    const legRecord = requireDataRecord(rawLeg, `legs[${legIndex}]`);
    const aggregateId = requireIdentifier(
      readOwnDataProperty(legRecord, "aggregateId", `legs[${legIndex}].aggregateId`),
      `legs[${legIndex}].aggregateId`,
    );
    if (aggregateIds.has(aggregateId)) {
      return invalidInput(
        `legs[${legIndex}].aggregateId ${JSON.stringify(aggregateId)} is fenced by an earlier leg`,
      );
    }
    aggregateIds.add(aggregateId);
    return {
      aggregateId,
      expectedVersion: requireSafeNonnegativeInteger(
        readOwnDataProperty(
          legRecord,
          "expectedVersion",
          `legs[${legIndex}].expectedVersion`,
        ),
        `legs[${legIndex}].expectedVersion`,
      ),
      inputRecord: legRecord,
    };
  });
  const primary = legs[0]!;
  return {
    legs,
    request: {
      commandKind: requireIdentifier(
        readOwnDataProperty(input, "commandKind", "commandKind"),
        "commandKind",
      ),
      expectedVersion: primary.expectedVersion,
      inputRecord: input,
      key: snapshotCommandDecisionKey(readOwnDataProperty(input, "key", "key")),
      requestBytes: snapshotBytes(
        readOwnDataProperty(input, "requestBytes", "requestBytes"),
        "requestBytes",
      ),
      targetAggregateId: primary.aggregateId,
    },
  };
}

/** Legs 1..N, which the scoped request digest must cover beyond the primary. */
export function additionalLegFences(
  legsRequest: SnapshotLegsRequest,
): readonly AdditionalLegFence[] {
  return legsRequest.legs.slice(1).map((leg) => ({
    aggregateId: leg.aggregateId,
    expectedVersion: leg.expectedVersion,
  }));
}

/**
 * Builds every leg's commit input under ONE shared byte budget, so a multi-leg
 * decision cannot smuggle more bytes past {@link MAX_COMMIT_BYTES} than a
 * single-aggregate one.
 */
export function planLegsDecision(
  legsRequest: SnapshotLegsRequest,
  decisionId: string,
  decidedAt: string,
): DecisionLegsPlan {
  const byteBudget: ByteBudget = { remaining: MAX_COMMIT_BYTES };
  const { request } = legsRequest;
  const resultBytes = snapshotBytes(
    readOwnDataProperty(request.inputRecord, "committedResultBytes", "committedResultBytes"),
    "committedResultBytes",
    byteBudget,
  );
  const legs = legsRequest.legs.map((leg, legIndex): DecisionLegPlan => {
    const receiptCommandId = legReceiptCommandId(decisionId, legIndex);
    const rawCommitInput = {
      aggregateId: leg.aggregateId,
      commandBytes: request.requestBytes,
      commandId: receiptCommandId,
      committedAt: decidedAt,
      events: readOwnDataProperty(leg.inputRecord, "events", `legs[${legIndex}].events`),
      expectedVersion: leg.expectedVersion,
    } as unknown as CommitInput;
    const commitInput = snapshotCommitInput(rawCommitInput, byteBudget);
    assertExternalCommitIdentifiers(commitInput, receiptCommandId);
    return { commitInput, request: legRequestView(request, leg) };
  });
  return { legs, resultBytes };
}

/**
 * Reads EVERY leg's version before writing ANY leg's events, so a stale fence
 * anywhere refuses the whole commit with zero rows on the other legs. Runs inside
 * the caller's already-open transaction; it never opens one of its own.
 */
export function decideLegsUnderLock(
  ctx: DecisionLegsContext,
  identities: DecisionIdentities,
  metadata: SnapshotDecisionMetadata,
  plan: DecisionLegsPlan,
): StoredCommandDecision {
  const observedVersions = plan.legs.map((legPlan) =>
    ctx.effect.assertAggregateTail(legPlan.commitInput.aggregateId),
  );
  const staleIndex = observedVersions.findIndex(
    (observedVersion, legIndex) =>
      observedVersion !== plan.legs[legIndex]!.commitInput.expectedVersion,
  );
  if (staleIndex !== -1) {
    const staleLeg = plan.legs[staleIndex]!;
    const observedVersion = observedVersions[staleIndex]!;
    return writeCanonicalDecision(ctx.record, {
      effect: commitRejectedDecisionEffect(
        ctx.effect,
        staleLeg.request,
        identities,
        metadata.decidedAt,
        observedVersion,
      ),
      identities,
      metadata,
      observedVersion,
      request: staleLeg.request,
    });
  }
  const primary = plan.legs[0]!;
  const effect = commitAcceptedDecisionEffect(
    ctx.effect,
    { commitInput: primary.commitInput, resultBytes: plan.resultBytes },
    observedVersions[0]!,
  );
  for (const [legIndex, legPlan] of plan.legs.entries()) {
    if (legIndex === 0) continue;
    ctx.effect.writeCommitEffects(
      legPlan.commitInput,
      identifyCommandRequest(legPlan.commitInput),
      observedVersions[legIndex]!,
    );
  }
  return writeCanonicalDecision(ctx.record, {
    effect,
    identities,
    metadata,
    observedVersion: observedVersions[0]!,
    request: primary.request,
  });
}
