import {
  MAX_COMMIT_BYTES,
  MAX_EVENTS_PER_COMMIT,
} from "./store-contracts.js";
import type { CommitInput } from "./store-contracts.js";
import { MAX_DECISION_LEGS } from "./decision-legs-contracts.js";
import type { CommitExpectedVersionDecisionLegsInput } from "./decision-legs-contracts.js";
import { legReceiptCommandId } from "./store-digests.js";
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
  SnapshotExpectedVersionRequest,
} from "./store-internals.js";

/** One non-primary leg's fence, as it enters the scoped request digest. */
export interface AdditionalLegFence {
  readonly aggregateId: string;
  readonly expectedVersion: number;
}

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

interface DecisionLegPlanBase {
  readonly aggregateId: string;
  readonly expectedVersion: number;
  readonly request: SnapshotExpectedVersionRequest;
}

export interface AppendDecisionLegPlan extends DecisionLegPlanBase {
  readonly kind: "APPEND";
  readonly commitInput: SnapshotCommitInput;
}

export interface FenceDecisionLegPlan extends DecisionLegPlanBase {
  readonly kind: "FENCE";
}

export type DecisionLegPlan = AppendDecisionLegPlan | FenceDecisionLegPlan;

export interface DecisionLegsPlan {
  readonly legs: readonly [AppendDecisionLegPlan, ...DecisionLegPlan[]];
  readonly resultBytes: Uint8Array;
}

function snapshotLeg(rawLeg: unknown, index: number, seen: Set<string>): SnapshotDecisionLeg {
  const field = `legs[${index}]`;
  const inputRecord = requireDataRecord(rawLeg, field);
  const aggregateId = requireIdentifier(
    readOwnDataProperty(inputRecord, "aggregateId", `${field}.aggregateId`),
    `${field}.aggregateId`,
  );
  if (seen.has(aggregateId)) {
    return invalidInput(
      `${field}.aggregateId ${JSON.stringify(aggregateId)} is fenced by an earlier leg`,
    );
  }
  seen.add(aggregateId);
  return {
    aggregateId,
    expectedVersion: requireSafeNonnegativeInteger(
      readOwnDataProperty(inputRecord, "expectedVersion", `${field}.expectedVersion`),
      `${field}.expectedVersion`,
    ),
    inputRecord,
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
  if (rawLegs.length === 0) return invalidInput("legs must contain at least one leg");
  if (rawLegs.length > MAX_DECISION_LEGS) {
    return limitExceeded(`legs cannot exceed ${MAX_DECISION_LEGS} per decision`);
  }
  const aggregateIds = new Set<string>();
  const legs = rawLegs.map((rawLeg, index) => snapshotLeg(rawLeg, index, aggregateIds));
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

/** Legs 1..N, which the scoped request digest covers beyond the primary. */
export function additionalLegFences(
  legsRequest: SnapshotLegsRequest,
): readonly AdditionalLegFence[] {
  return legsRequest.legs.slice(1).map(({ aggregateId, expectedVersion }) => ({
    aggregateId,
    expectedVersion,
  }));
}

function legRequestView(
  request: SnapshotExpectedVersionRequest,
  leg: SnapshotDecisionLeg,
): SnapshotExpectedVersionRequest {
  return { ...request, expectedVersion: leg.expectedVersion, targetAggregateId: leg.aggregateId };
}

function planAppend(
  leg: SnapshotDecisionLeg,
  index: number,
  request: SnapshotExpectedVersionRequest,
  events: readonly unknown[],
  decisionId: string,
  decidedAt: string,
  byteBudget: ByteBudget,
): AppendDecisionLegPlan {
  const receiptCommandId = legReceiptCommandId(decisionId, index);
  const commitInput = snapshotCommitInput({
    aggregateId: leg.aggregateId,
    commandBytes: request.requestBytes,
    commandId: receiptCommandId,
    committedAt: decidedAt,
    events,
    expectedVersion: leg.expectedVersion,
  } as CommitInput, byteBudget);
  assertExternalCommitIdentifiers(commitInput, receiptCommandId);
  return {
    aggregateId: leg.aggregateId,
    commitInput,
    expectedVersion: leg.expectedVersion,
    kind: "APPEND",
    request: legRequestView(request, leg),
  };
}

function planLeg(
  leg: SnapshotDecisionLeg,
  index: number,
  request: SnapshotExpectedVersionRequest,
  decisionId: string,
  decidedAt: string,
  byteBudget: ByteBudget,
): DecisionLegPlan {
  const events = snapshotDenseArray(
    readOwnDataProperty(leg.inputRecord, "events", `legs[${index}].events`),
    "events",
    MAX_EVENTS_PER_COMMIT,
  );
  if (events.length !== 0) {
    return planAppend(leg, index, request, events, decisionId, decidedAt, byteBudget);
  }
  if (index === 0) return invalidInput("events must contain at least one event");
  return {
    aggregateId: leg.aggregateId,
    expectedVersion: leg.expectedVersion,
    kind: "FENCE",
    request: legRequestView(request, leg),
  };
}

/** Builds APPEND/FENCE plans under one shared byte budget. */
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
  const primary = planLeg(
    legsRequest.legs[0]!, 0, request, decisionId, decidedAt, byteBudget,
  );
  if (primary.kind !== "APPEND") return invalidInput("events must contain at least one event");
  const rest = legsRequest.legs.slice(1).map((leg, offset) =>
    planLeg(leg, offset + 1, request, decisionId, decidedAt, byteBudget));
  return { legs: [primary, ...rest], resultBytes };
}
