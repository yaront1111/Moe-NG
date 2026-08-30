/**
 * Durable decision commits shared by session-authority lifecycle and replay writes.
 * The single-aggregate seam remains distinct from explicitly multi-leg decisions.
 */

import { DurableStoreError } from "@moe/store";
import type {
  CommandDecisionKey, EffectsCommittedDecision, ExpectedVersionDecisionLeg, SqliteEventStore,
} from "@moe/store";

import { SESSION_AUTHORITY_SCHEMA_VERSION } from "./session-authority-contracts.js";
import type {
  MutationReceipt, SessionAuthorityCode, SessionAuthorityEventType, SessionAuthorityRefusal,
} from "./session-authority-contracts.js";

export interface AuthorityCommit {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly commandKind: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly eventPayload: Readonly<Record<string, unknown>>;
  readonly eventType: SessionAuthorityEventType;
  readonly expectedVersion: number;
  readonly principalId: string;
  readonly projectId: string;
  readonly requestFacts: Readonly<Record<string, unknown>>;
  readonly resultFacts: Readonly<Record<string, unknown>>;
}

export type AuthorityCommitOutcome =
  | Readonly<{ ok: true; disposition: "DECIDED" | "REPLAYED"; decision: EffectsCommittedDecision }>
  | SessionAuthorityRefusal;

type AuthorityDecisionPlan = Omit<
  AuthorityCommit,
  "aggregateId" | "eventPayload" | "eventType" | "expectedVersion"
>;

const encoder = new TextEncoder();

function refusal(code: SessionAuthorityCode): SessionAuthorityRefusal {
  return Object.freeze({ ok: false as const, code, layer: "DURABLE_STORE" as const });
}

function storeCode(error: unknown): SessionAuthorityCode {
  if (!(error instanceof DurableStoreError)) return "OUTCOME_UNKNOWN";
  const conflict =
    error.code === "IDEMPOTENCY_CONFLICT" ||
    error.code === "COMMAND_ID_CONFLICT" ||
    error.code === "DURABLE_ID_CONFLICT";
  return conflict ? "SESSION_AUTHORITY_COMMAND_CONFLICT" : error.code;
}

/** Fixed key order, so a retry of the same request hashes identically. */
export function jsonBytes(value: Readonly<Record<string, unknown>>): Uint8Array {
  const sorted = Object.keys(value).sort().map((key) => [key, value[key]] as const);
  return encoder.encode(JSON.stringify(Object.fromEntries(sorted)));
}

export function receiptOf(decision: EffectsCommittedDecision): MutationReceipt {
  return Object.freeze({
    aggregateId: decision.targetAggregateId,
    commandId: decision.key.commandId,
    committedAt: decision.decidedAt,
    eventIds: Object.freeze([...decision.businessEventIds]),
    previousVersion: decision.previousVersion,
    currentVersion: decision.currentVersion,
    requestSha256: decision.requestSha256, resultSha256: decision.resultSha256,
  });
}

function commandKindConflict(
  store: SqliteEventStore,
  key: CommandDecisionKey,
  plan: Pick<AuthorityCommit, "commandKind">,
): SessionAuthorityRefusal | null {
    // The decision key carries no kind, so without this guard an unrelated
    // command reusing the id would come back as an accepted replay of a command
    // that was never decided.
    const existing = store.getCommandDecision(key);
    if (existing !== null && existing.commandKind !== plan.commandKind) {
      return refusal("SESSION_AUTHORITY_COMMAND_CONFLICT");
    }
  return null;
}

/** The single durable mutation seam; every lifecycle command commits exactly here. */
export function commitAuthorityDecision(
  store: SqliteEventStore,
  plan: AuthorityCommit,
): AuthorityCommitOutcome {
  const key: CommandDecisionKey = {
    commandId: plan.commandId,
    principalId: plan.principalId,
    projectId: plan.projectId,
  };
  try {
    const conflict = commandKindConflict(store, key, plan);
    if (conflict !== null) return conflict;
    const response = store.commitExpectedVersionDecision({
      commandKind: plan.commandKind,
      committedResultBytes: jsonBytes(plan.resultFacts),
      correlationId: plan.correlationId,
      decidedAt: plan.decidedAt,
      events: [{
        domainSchemaVersion: SESSION_AUTHORITY_SCHEMA_VERSION,
        eventId: `${plan.commandId}/${plan.eventType}`,
        eventType: plan.eventType,
        payload: jsonBytes(plan.eventPayload),
      }],
      expectedVersion: plan.expectedVersion,
      key,
      requestBytes: jsonBytes(plan.requestFacts),
      targetAggregateId: plan.aggregateId,
    });
    const decision = response.decision;
    if (decision.effectDisposition !== "EFFECTS_COMMITTED") return refusal(decision.resultCode);
    return Object.freeze({ ok: true as const, disposition: response.disposition, decision });
  } catch (error) {
    return refusal(storeCode(error));
  }
}

export function commitAuthorityDecisionLegs(
  store: SqliteEventStore,
  plan: AuthorityDecisionPlan,
  legs: readonly ExpectedVersionDecisionLeg[],
): AuthorityCommitOutcome {
  const key: CommandDecisionKey = {
    commandId: plan.commandId,
    principalId: plan.principalId,
    projectId: plan.projectId,
  };
  try {
    const conflict = commandKindConflict(store, key, plan);
    if (conflict !== null) return conflict;
    const response = store.commitExpectedVersionDecisionLegs({
      commandKind: plan.commandKind,
      committedResultBytes: jsonBytes(plan.resultFacts),
      correlationId: plan.correlationId,
      decidedAt: plan.decidedAt,
      key,
      legs,
      requestBytes: jsonBytes(plan.requestFacts),
    });
    const decision = response.decision;
    if (decision.effectDisposition !== "EFFECTS_COMMITTED") return refusal(decision.resultCode);
    return Object.freeze({ ok: true as const, disposition: response.disposition, decision });
  } catch (error) {
    return refusal(storeCode(error));
  }
}
