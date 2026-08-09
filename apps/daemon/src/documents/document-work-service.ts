import {
  DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
  decodeDocumentWorkProposalBytes,
} from "@moe/contracts";
import type { DocumentWorkProposal } from "@moe/contracts";

import { validateDocumentWorkResponse } from "./document-work-decision.js";
import {
  documentWorkAggregateId,
  documentWorkEventId,
} from "./document-work-identifiers.js";
import { snapshotDocumentWorkRecordInput } from "./document-work-ingress.js";
import { durableStoreRefusal, refuse } from "./document-work-result.js";
import {
  DOCUMENT_WORK_EVENT_TYPE,
  DOCUMENT_WORK_RECORD_COMMAND_KIND,
} from "./document-work-service-contract.js";
import type {
  DocumentWorkProposalRecorded,
  RecordDocumentWorkProposalInput,
  RecordDocumentWorkProposalResult,
} from "./document-work-service-contract.js";
import type { DocumentWorkStorePort } from "./document-work-store-port.js";

export {
  documentWorkAggregateId,
  documentWorkEventId,
} from "./document-work-identifiers.js";
export { readLatestDocumentWorkDossier } from "./document-work-read.js";
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

/** The public decoder returns a normalized, detached, deeply frozen proposal. */
function normalizedBytes(proposal: DocumentWorkProposal): Uint8Array {
  return encoder.encode(JSON.stringify(proposal));
}

function recorded(
  aggregateId: string,
  eventId: string,
  proposal: DocumentWorkProposal,
  decisionId: string,
  currentVersion: number,
  disposition: "DECIDED" | "REPLAYED",
): DocumentWorkProposalRecorded {
  return Object.freeze({
    advisoryOnly: true,
    aggregateId,
    authority: "NONE",
    currentVersion,
    decisionId,
    disposition,
    eventId,
    ok: true,
    outcome: "RECORDED",
    proposal,
  });
}

/** Persists exactly one inert proposal event after an exact hostile-input snapshot. */
export function recordDocumentWorkProposal(
  store: DocumentWorkStorePort,
  input: RecordDocumentWorkProposalInput,
): RecordDocumentWorkProposalResult {
  const snapshot = snapshotDocumentWorkRecordInput(input);
  if (snapshot === null) {
    return refuse("DOCUMENT_WORK_SERVICE_INPUT_INVALID", "DAEMON_INGRESS");
  }
  const decoded = decodeDocumentWorkProposalBytes(snapshot.proposalBytes);
  if (!decoded.ok) return refuse(decoded.code, decoded.layer);
  if (decoded.proposal.projectId !== snapshot.projectId) {
    return refuse("DOCUMENT_WORK_PROPOSAL_PROJECT_MISMATCH", "DAEMON_PROVENANCE");
  }

  const aggregateId = documentWorkAggregateId(snapshot.projectId);
  const eventId = documentWorkEventId(
    snapshot.projectId,
    snapshot.principalId,
    snapshot.commandId,
  );
  const payload = normalizedBytes(decoded.proposal);
  let rawResponse: unknown;
  try {
    rawResponse = store.commitExpectedVersionDecision({
      commandKind: DOCUMENT_WORK_RECORD_COMMAND_KIND,
      committedResultBytes: payload,
      correlationId: snapshot.correlationId,
      decidedAt: snapshot.decidedAt,
      events: [{
        domainSchemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
        eventId,
        eventType: DOCUMENT_WORK_EVENT_TYPE,
        outbox: [],
        payload,
      }],
      expectedVersion: snapshot.expectedVersion,
      key: {
        commandId: snapshot.commandId,
        principalId: snapshot.principalId,
        projectId: snapshot.projectId,
      },
      requestBytes: snapshot.proposalBytes,
      targetAggregateId: aggregateId,
    });
  } catch (error) {
    const mapped = durableStoreRefusal(error);
    if (mapped !== null) return mapped;
    throw error;
  }

  const response = validateDocumentWorkResponse(rawResponse, {
    aggregateId,
    commandId: snapshot.commandId,
    currentVersion: snapshot.expectedVersion + 1,
    decidedAt: snapshot.decidedAt,
    eventId,
    expectedVersion: snapshot.expectedVersion,
    payload,
    principalId: snapshot.principalId,
    projectId: snapshot.projectId,
  });
  if (response === null) {
    return refuse("DOCUMENT_WORK_DECISION_MISMATCH", "DURABLE_STORE");
  }
  if (response.outcome === "EXPECTED_VERSION_CONFLICT") {
    return refuse("EXPECTED_VERSION_CONFLICT", "DURABLE_STORE");
  }
  return recorded(
    aggregateId,
    eventId,
    decoded.proposal,
    response.decision.decisionId,
    response.decision.currentVersion,
    response.disposition,
  );
}
