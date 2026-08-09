import { createHash } from "node:crypto";

import {
  DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
  decodeDocumentWorkProposalBytes,
} from "@moe/contracts";
import type { DocumentWorkProposal } from "@moe/contracts";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import {
  DOCUMENT_WORK_EVENT_TYPE,
  DOCUMENT_WORK_RECORD_COMMAND_KIND,
} from "./document-work-service-contract.js";
import type {
  DocumentWorkDossier,
  DocumentWorkProposalRecorded,
  DocumentWorkServiceErrorCode,
  DocumentWorkServiceLayer,
  DocumentWorkServiceRefused,
  ReadDocumentWorkDossierResult,
  RecordDocumentWorkProposalInput,
  RecordDocumentWorkProposalResult,
} from "./document-work-service-contract.js";

export {
  DOCUMENT_WORK_EVENT_TYPE,
  DOCUMENT_WORK_RECORD_COMMAND_KIND,
  DOCUMENT_WORK_SERVICE_ERROR_CODES,
  DOCUMENT_WORK_SERVICE_LAYERS,
} from "./document-work-service-contract.js";
export type {
  DocumentWorkDossier,
  DocumentWorkProposalRecorded,
  DocumentWorkServiceErrorCode,
  DocumentWorkServiceLayer,
  DocumentWorkServiceRefused,
  ReadDocumentWorkDossierResult,
  RecordDocumentWorkProposalInput,
  RecordDocumentWorkProposalResult,
} from "./document-work-service-contract.js";

const encoder = new TextEncoder();
const AGGREGATE_PREFIX = "document-work/";
const EVENT_PREFIX = "document-work-proposal/";
const AGGREGATE_ID_DOMAIN = "moe.document-work.aggregate-id.v1";
const EVENT_ID_DOMAIN = "moe.document-work.event-id.v1";

function framedDigest(domain: string, values: readonly string[]): string {
  const hash = createHash("sha256").update(`${domain}\u0000`, "utf8");
  for (const value of values) {
    const valueBytes = encoder.encode(value);
    hash.update(`${String(valueBytes.byteLength)}:`, "ascii").update(valueBytes);
  }
  return hash.digest("hex");
}

export function documentWorkAggregateId(projectId: string): string {
  return `${AGGREGATE_PREFIX}${framedDigest(AGGREGATE_ID_DOMAIN, [projectId])}`;
}

export function documentWorkEventId(
  projectId: string,
  principalId: string,
  commandId: string,
): string {
  return `${EVENT_PREFIX}${framedDigest(
    EVENT_ID_DOMAIN,
    [projectId, principalId, commandId],
  )}`;
}

function refuse(
  code: DocumentWorkServiceErrorCode,
  layer: DocumentWorkServiceLayer,
): DocumentWorkServiceRefused {
  return Object.freeze({
    advisoryOnly: true,
    authority: "NONE",
    code,
    layer,
    ok: false,
    outcome: "REFUSED",
  });
}

/** The contracts decoder already returns a normalized, detached, deeply frozen proposal. */
function normalizedBytes(proposal: DocumentWorkProposal): Uint8Array {
  return encoder.encode(JSON.stringify(proposal));
}

function recorded(
  aggregateId: string,
  eventId: string,
  proposal: DocumentWorkProposal,
  response: ReturnType<SqliteEventStore["commitExpectedVersionDecision"]>,
): DocumentWorkProposalRecorded | DocumentWorkServiceRefused {
  const { decision } = response;
  if (decision.effectDisposition !== "EFFECTS_COMMITTED") {
    return refuse(decision.resultCode, "DURABLE_STORE");
  }
  return Object.freeze({
    advisoryOnly: true,
    aggregateId,
    authority: "NONE",
    currentVersion: decision.currentVersion,
    decisionId: decision.decisionId,
    disposition: response.disposition,
    eventId,
    ok: true,
    outcome: "RECORDED",
    proposal,
  });
}

/**
 * Persists one inert proposal event. The raw bytes remain the idempotency identity;
 * normalized bytes are the only payload/result that become durable.
 */
export function recordDocumentWorkProposal(
  store: SqliteEventStore,
  input: RecordDocumentWorkProposalInput,
): RecordDocumentWorkProposalResult {
  const decoded = decodeDocumentWorkProposalBytes(input.proposalBytes);
  if (!decoded.ok) return refuse(decoded.code, decoded.layer);
  if (decoded.proposal.projectId !== input.projectId) {
    return refuse("DOCUMENT_WORK_PROPOSAL_PROJECT_MISMATCH", "DAEMON_PROVENANCE");
  }

  const aggregateId = documentWorkAggregateId(input.projectId);
  const eventId = documentWorkEventId(
    input.projectId,
    input.principalId,
    input.commandId,
  );
  const payload = normalizedBytes(decoded.proposal);
  const response = store.commitExpectedVersionDecision({
    commandKind: DOCUMENT_WORK_RECORD_COMMAND_KIND,
    committedResultBytes: payload,
    correlationId: input.correlationId,
    decidedAt: input.decidedAt,
    events: [{
      domainSchemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
      eventId,
      eventType: DOCUMENT_WORK_EVENT_TYPE,
      payload,
    }],
    expectedVersion: input.expectedVersion,
    key: {
      commandId: input.commandId,
      principalId: input.principalId,
      projectId: input.projectId,
    },
    requestBytes: input.proposalBytes as Uint8Array,
    targetAggregateId: aggregateId,
  });
  return recorded(aggregateId, eventId, decoded.proposal, response);
}

function latestEvent(
  store: SqliteEventStore,
  aggregateId: string,
): StoredEvent | DocumentWorkServiceRefused {
  const version = store.getAggregateVersion(aggregateId);
  if (version === 0) {
    return refuse("DOCUMENT_WORK_DOSSIER_MISSING", "DAEMON_READ_MODEL");
  }
  const event = store.readAggregateEvents(aggregateId, version - 1, 1).items[0];
  if (event === undefined || event.aggregateSequence !== version) {
    return refuse("DOCUMENT_WORK_DOSSIER_MISSING", "DAEMON_READ_MODEL");
  }
  return event;
}

function dossier(
  event: StoredEvent,
  proposal: DocumentWorkProposal,
): DocumentWorkDossier {
  return Object.freeze({
    advisoryOnly: true,
    aggregateId: event.aggregateId,
    aggregateSequence: event.aggregateSequence,
    authority: "NONE",
    committedAt: event.committedAt,
    eventId: event.eventId,
    ok: true,
    outcome: "DOSSIER",
    proposal,
  });
}

/** Reads only the aggregate tail and refuses any record outside the exact inert contract. */
export function readLatestDocumentWorkDossier(
  store: SqliteEventStore,
  projectId: string,
): ReadDocumentWorkDossierResult {
  const tail = latestEvent(store, documentWorkAggregateId(projectId));
  if ("ok" in tail) return tail;
  if (tail.eventType !== DOCUMENT_WORK_EVENT_TYPE) {
    return refuse("DOCUMENT_WORK_DOSSIER_EVENT_TYPE_MISMATCH", "DAEMON_READ_MODEL");
  }
  if (tail.domainSchemaVersion !== DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION) {
    return refuse("DOCUMENT_WORK_DOSSIER_SCHEMA_MISMATCH", "DAEMON_READ_MODEL");
  }
  const decoded = decodeDocumentWorkProposalBytes(tail.payload);
  if (!decoded.ok) {
    return refuse("DOCUMENT_WORK_DOSSIER_PAYLOAD_INVALID", "DAEMON_READ_MODEL");
  }
  if (decoded.proposal.projectId !== projectId) {
    return refuse("DOCUMENT_WORK_PROPOSAL_PROJECT_MISMATCH", "DAEMON_PROVENANCE");
  }
  return dossier(tail, decoded.proposal);
}
