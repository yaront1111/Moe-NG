import {
  COMMAND_DECISION_IDENTITY_VERSION,
  COMMAND_DECISION_RECORD_VERSION,
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  COMMAND_DECISION_RESULT_VERSION,
  COMMAND_EFFECT_IDENTITY_VERSION,
  EXPECTED_VERSION_DECISION_COVERAGE,
} from "@moe/store";

import { DOCUMENT_WORK_RECORD_COMMAND_KIND } from "./document-work-service-contract.js";
import {
  copyFixedBytes,
  exactDataArray,
  exactDataRecord,
  sameBytes,
  sha256String,
} from "./document-work-safe-value.js";

const RESPONSE_KEYS = Object.freeze([
  "decision", "disposition", "historical", "requiresAffordanceRefresh",
]);
const DECISION_KEYS = Object.freeze([
  "businessEventIds", "commandKind", "correlationSha256", "coverage", "decidedAt",
  "decisionId", "decisionIdentityVersion", "decisionPosition", "decisionSha256",
  "effectIdentityVersion", "effectSha256", "expectedVersion", "key", "observedVersion",
  "outboxMessageIds", "recordVersion", "requestIdentityVersion", "requestSha256",
  "resultBytes", "resultSha256", "resultVersion", "targetAggregateId", "auditEventId",
  "currentVersion", "effectDisposition", "previousVersion", "resultCode",
]);
const KEY_KEYS = Object.freeze(["commandId", "principalId", "projectId"]);
const encoder = new TextEncoder();

export interface ExpectedDocumentWorkDecision {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly currentVersion: number;
  readonly decidedAt: string;
  readonly eventId: string;
  readonly effectSha256?: string;
  readonly expectedVersion: number;
  readonly payload: Uint8Array;
  readonly principalId: string;
  readonly projectId: string;
  readonly requestSha256?: string;
}

export interface ValidatedDocumentWorkDecision {
  readonly currentVersion: number;
  readonly decisionId: string;
  readonly requestSha256: string;
}

interface DecisionParts {
  readonly businessEventIds: readonly unknown[];
  readonly decision: Readonly<Record<string, unknown>>;
  readonly key: Readonly<Record<string, unknown>>;
  readonly outboxMessageIds: readonly unknown[];
  readonly resultBytes: Uint8Array;
}

function decisionParts(value: unknown): DecisionParts | null {
  const decision = exactDataRecord(value, DECISION_KEYS);
  if (decision === null) return null;
  const key = exactDataRecord(decision.key, KEY_KEYS);
  const businessEventIds = exactDataArray(decision.businessEventIds);
  const outboxMessageIds = exactDataArray(decision.outboxMessageIds);
  const resultBytes = copyFixedBytes(decision.resultBytes);
  if (key === null || businessEventIds === null || outboxMessageIds === null || resultBytes === null) {
    return null;
  }
  return { businessEventIds, decision, key, outboxMessageIds, resultBytes };
}

function commonMatches(parts: DecisionParts, expected: ExpectedDocumentWorkDecision): boolean {
  const { decision, key } = parts;
  return key.commandId === expected.commandId
    && key.principalId === expected.principalId
    && key.projectId === expected.projectId
    && decision.commandKind === DOCUMENT_WORK_RECORD_COMMAND_KIND
    && decision.targetAggregateId === expected.aggregateId
    && decision.expectedVersion === expected.expectedVersion
    && decision.decidedAt === expected.decidedAt
    && decision.coverage === EXPECTED_VERSION_DECISION_COVERAGE
    && decision.recordVersion === COMMAND_DECISION_RECORD_VERSION
    && decision.requestIdentityVersion === COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    && decision.resultVersion === COMMAND_DECISION_RESULT_VERSION
    && decision.decisionIdentityVersion === COMMAND_DECISION_IDENTITY_VERSION
    && decision.effectIdentityVersion === COMMAND_EFFECT_IDENTITY_VERSION
    && typeof decision.decisionPosition === "bigint"
    && decision.decisionPosition > 0n
    && sha256String(decision.decisionId)
    && sha256String(decision.correlationSha256)
    && sha256String(decision.decisionSha256)
    && sha256String(decision.effectSha256)
    && sha256String(decision.requestSha256)
    && sha256String(decision.resultSha256)
    && (expected.effectSha256 === undefined
      || decision.effectSha256 === expected.effectSha256)
    && (expected.requestSha256 === undefined
      || decision.requestSha256 === expected.requestSha256);
}

export function validateDocumentWorkDecision(
  value: unknown,
  expected: ExpectedDocumentWorkDecision,
): ValidatedDocumentWorkDecision | null {
  const parts = decisionParts(value);
  if (parts === null || !commonMatches(parts, expected)) return null;
  const { decision } = parts;
  if (
    decision.observedVersion !== expected.expectedVersion
    || decision.previousVersion !== expected.expectedVersion
    || decision.currentVersion !== expected.currentVersion
    || decision.auditEventId !== null
    || decision.effectDisposition !== "EFFECTS_COMMITTED"
    || decision.resultCode !== "EFFECTS_COMMITTED"
    || parts.businessEventIds.length !== 1
    || parts.businessEventIds[0] !== expected.eventId
    || parts.outboxMessageIds.length !== 0
    || !sameBytes(parts.resultBytes, expected.payload)
  ) return null;
  return Object.freeze({
    currentVersion: expected.currentVersion,
    decisionId: decision.decisionId,
    requestSha256: decision.requestSha256,
  }) as ValidatedDocumentWorkDecision;
}

function validRejection(parts: DecisionParts, expected: ExpectedDocumentWorkDecision): boolean {
  const { decision } = parts;
  const observedVersion = decision.observedVersion;
  const resultBytes = Number.isSafeInteger(observedVersion) && (observedVersion as number) >= 0
    ? encoder.encode(JSON.stringify({
      code: "EXPECTED_VERSION_CONFLICT",
      expectedVersion: expected.expectedVersion,
      observedVersion,
      version: COMMAND_DECISION_RESULT_VERSION,
    }))
    : null;
  return commonMatches(parts, expected)
    && resultBytes !== null
    && observedVersion !== expected.expectedVersion
    && decision.previousVersion === null
    && decision.currentVersion === null
    && typeof decision.auditEventId === "string"
    && /^moe-internal:command-rejection-event:[0-9a-f]{64}$/u.test(decision.auditEventId)
    && parts.businessEventIds.length === 0
    && parts.outboxMessageIds.length === 0
    && sameBytes(parts.resultBytes, resultBytes)
    && decision.effectDisposition === "NO_BUSINESS_EFFECT"
    && decision.resultCode === "EXPECTED_VERSION_CONFLICT";
}

export type ValidatedDocumentWorkResponse = Readonly<
  | { readonly outcome: "COMMITTED"; readonly decision: ValidatedDocumentWorkDecision;
      readonly disposition: "DECIDED" | "REPLAYED" }
  | { readonly outcome: "EXPECTED_VERSION_CONFLICT" }
>;

export function validateDocumentWorkResponse(
  value: unknown,
  expected: ExpectedDocumentWorkDecision,
): ValidatedDocumentWorkResponse | null {
  const response = exactDataRecord(value, RESPONSE_KEYS);
  if (response === null) return null;
  const disposition = response.disposition;
  if (
    (disposition !== "DECIDED" && disposition !== "REPLAYED")
    || response.historical !== (disposition === "REPLAYED")
    || response.requiresAffordanceRefresh !== (disposition === "REPLAYED")
  ) return null;
  const committed = validateDocumentWorkDecision(response.decision, expected);
  if (committed !== null) {
    return Object.freeze({ outcome: "COMMITTED", decision: committed, disposition });
  }
  const parts = decisionParts(response.decision);
  if (parts !== null && validRejection(parts, expected)) {
    return Object.freeze({ outcome: "EXPECTED_VERSION_CONFLICT" });
  }
  return null;
}
