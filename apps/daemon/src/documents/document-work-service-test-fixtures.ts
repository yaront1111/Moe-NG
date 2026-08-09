import { DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION } from "@moe/contracts";
import type { SqliteEventStore } from "@moe/store";
import { expect } from "vitest";

import {
  DOCUMENT_WORK_EVENT_TYPE,
  DOCUMENT_WORK_RECORD_COMMAND_KIND,
  documentWorkAggregateId,
  documentWorkEventId,
  recordDocumentWorkProposal,
  readLatestDocumentWorkDossier,
} from "./document-work-service.js";

export const PROJECT_ID = "project-1";
export const AGGREGATE_ID =
  "document-work/769304b95ae0ac97b229f401563babf7152fd02686b8839826c9d80b1fba4052";
export const EVENT_ID =
  "document-work-proposal/6e303ee0883b1013f729e63b94f4ec53f87a3408926c3543e3e19c7dd5a77670";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
export const encoder = new TextEncoder();

export function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function source(index: number): Record<string, unknown> {
  return {
    byteLength: 100 + index,
    contentSha256: index % 2 === 0 ? HASH_A : HASH_B,
    displayPath: `docs/source-${String(index)}.md`,
    sourceRef: `source-${String(index)}`,
  };
}

export function candidate(
  index: number,
  sourceRefs: readonly string[] = [`source-${String(index)}`],
): Record<string, unknown> {
  return {
    candidateRef: `candidate-${String(index)}`,
    objective: `Implement candidate ${String(index)} from its bound documents.`,
    sourceRefs,
    title: `Candidate ${String(index)}`,
  };
}

export function proposal(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    advisoryOnly: true,
    authority: "NONE",
    candidates: [candidate(0)],
    contextManifestDigest: HASH_B,
    projectId: PROJECT_ID,
    repositoryBaseHash: HASH_A,
    schemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
    sources: [source(0)],
    submissionState: "NOT_SUBMITTED",
    truthClass: "AGENT_REPORTED",
    ...overrides,
  };
}

export function input(
  proposalBytes: unknown = bytes(proposal()),
  overrides: Partial<Parameters<typeof recordDocumentWorkProposal>[1]> = {},
): Parameters<typeof recordDocumentWorkProposal>[1] {
  return {
    commandId: "document-command-1",
    correlationId: "document-correlation-1",
    decidedAt: "2026-08-09T18:00:00.000Z",
    expectedVersion: 0,
    principalId: "agent-1",
    projectId: PROJECT_ID,
    proposalBytes,
    ...overrides,
  };
}

export function appendRawEvent(
  store: SqliteEventStore,
  options: {
    readonly eventType?: string;
    readonly payload?: Uint8Array;
    readonly schemaVersion?: string;
  } = {},
): void {
  const aggregateId = documentWorkAggregateId(PROJECT_ID);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  const commandId = `fixture-command-${String(expectedVersion)}`;
  const principalId = "fixture-agent";
  const payload = options.payload ?? bytes(proposal());
  store.commitExpectedVersionDecision({
    commandKind: DOCUMENT_WORK_RECORD_COMMAND_KIND,
    committedResultBytes: payload,
    correlationId: `fixture-correlation-${String(expectedVersion)}`,
    decidedAt: "2026-08-09T18:00:00.000Z",
    events: [{
      domainSchemaVersion:
        options.schemaVersion ?? DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
      eventId: documentWorkEventId(PROJECT_ID, principalId, commandId),
      eventType: options.eventType ?? DOCUMENT_WORK_EVENT_TYPE,
      outbox: [],
      payload,
    }],
    expectedVersion,
    key: { commandId, principalId, projectId: PROJECT_ID },
    requestBytes: payload,
    targetAggregateId: aggregateId,
  });
}

export function appendUnscopedRawEvent(store: SqliteEventStore): void {
  const aggregateId = documentWorkAggregateId(PROJECT_ID);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  store.commit({
    aggregateId,
    commandBytes: bytes({ fixture: expectedVersion }),
    commandId: `raw-command-${String(expectedVersion)}`,
    committedAt: "2026-08-09T18:00:00.000Z",
    events: [{
      domainSchemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
      eventId: `raw-event-${String(expectedVersion)}`,
      eventType: DOCUMENT_WORK_EVENT_TYPE,
      payload: bytes(proposal()),
    }],
    expectedVersion,
  });
}

export function expectRefusal(
  result: ReturnType<typeof recordDocumentWorkProposal>
    | ReturnType<typeof readLatestDocumentWorkDossier>,
  code: string,
  layer: string,
): void {
  expect(result).toStrictEqual({
    advisoryOnly: true,
    authority: "NONE",
    code,
    layer,
    ok: false,
    outcome: "REFUSED",
  });
  expect(Object.isFrozen(result)).toBe(true);
}
