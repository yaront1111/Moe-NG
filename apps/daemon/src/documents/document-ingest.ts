import { DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION } from "@moe/contracts";

import { DOCUMENT_SOURCE_RECORD_COMMAND_KIND } from "./document-source-contract.js";
import type {
  DocumentIngestRequest,
  DocumentIngestResult,
} from "./document-source-contract.js";
import { provisionalTitle } from "./document-source-codec.js";
import {
  documentIngestContextManifestDigest,
  documentIngestRepositoryBaseHash,
  legacyDocumentSourceRef,
} from "./document-source-identifiers.js";
import {
  admitDocumentSource,
  documentSourceLegOf,
  documentSourceRecordOf,
} from "./document-source-leg.js";
import type { AdmittedDocumentSource, DocumentSourceLeg } from "./document-source-leg.js";
import { selectDocumentIngestIdentity } from "./document-ingest-legacy.js";
import { documentWorkAggregateId } from "./document-work-identifiers.js";
import { durableStoreRefusal, refuse } from "./document-work-result.js";
import type { DocumentWorkServiceRefused } from "./document-work-service-contract.js";
import { recordDocumentWorkProposal } from "./document-work-service.js";
import type { DocumentWorkStorePort } from "./document-work-store-port.js";

const encoder = new TextEncoder();

interface TextLeg {
  readonly aggregateId: string;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly eventId: string;
}

/**
 * Records the document text on the content-addressed sibling aggregate BEFORE the proposal, so
 * whenever the dossier read can read the proposal the text it names is already durable. The
 * source binding includes content plus display metadata, so an exact re-ingest replays while two
 * goal-specific paths for identical text remain separate durable records.
 */
function recordSourceText(
  store: DocumentWorkStorePort,
  request: DocumentIngestRequest,
  leg: DocumentSourceLeg,
): TextLeg | { readonly refusal: DocumentWorkServiceRefused } {
  const { aggregateId, commandId, eventId, payload } = leg;
  try {
    const response = store.commitExpectedVersionDecision({
      commandKind: DOCUMENT_SOURCE_RECORD_COMMAND_KIND,
      committedResultBytes: payload,
      correlationId: request.correlationId,
      decidedAt: request.decidedAt,
      events: [leg.event],
      // The text aggregate is content-addressed and receives exactly one event: identical bytes
      // resolve to this same key and replay, never a second write, so its first and only commit
      // is always at version 0. The store folds expectedVersion into the request identity, so a
      // replay MUST present the same 0 the first write did - reading the live version here would
      // present 1 on the second ingest and be refused as an idempotency conflict.
      expectedVersion: 0,
      key: { commandId, principalId: request.principalId, projectId: request.projectId },
      requestBytes: payload,
      targetAggregateId: aggregateId,
    });
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
      return {
        refusal: refuse(
          response.decision.resultCode as DocumentWorkServiceRefused["code"], "DURABLE_STORE",
        ),
      };
    }
    return { aggregateId, disposition: response.disposition, eventId };
  } catch (error) {
    const mapped = durableStoreRefusal(error);
    if (mapped !== null) return { refusal: mapped };
    throw error;
  }
}

function provisionalProposal(
  projectId: string,
  admitted: AdmittedDocumentSource,
  contentSha256: string,
  byteLength: number,
  sourceRef: string,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    advisoryOnly: true,
    authority: "NONE",
    candidates: [{
      candidateRef: `candidate:${contentSha256}`,
      objective: admitted.objective,
      sourceRefs: [sourceRef],
      title: provisionalTitle(admitted.text, admitted.mediaType === "text/markdown"),
    }],
    contextManifestDigest: documentIngestContextManifestDigest(
      projectId, contentSha256, admitted.displayPath, admitted.mediaType,
    ),
    projectId,
    repositoryBaseHash: documentIngestRepositoryBaseHash(projectId),
    schemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
    sources: [{
      byteLength, contentSha256, displayPath: admitted.displayPath, sourceRef,
    }],
    submissionState: "NOT_SUBMITTED",
    truthClass: "AGENT_REPORTED",
  }));
}

/**
 * Ingests one operator document: the daemon computes the sha and byte length ITSELF, records
 * the text durably, then records a provisional DocumentWorkProposal naming that source. The
 * proposal's decision key binds the sourceRef and objective, so an exact re-ingest replays to the
 * same decision with no second event while a different goal path or objective is a new proposal.
 * The proposal leg's expected version is the aggregate's current version on a first ingest, or
 * the committed decision's own fence on a replay, so an honest re-ingest still validates after
 * other documents advanced the shared aggregate.
 */
export function ingestDocument(
  store: DocumentWorkStorePort,
  request: DocumentIngestRequest,
): DocumentIngestResult {
  const admitted = admitDocumentSource(request.payload);
  if ("refusal" in admitted) return admitted.refusal;
  const { value } = admitted;
  const record = documentSourceRecordOf(value);
  const { byteLength, contentSha256 } = record;

  const identity = selectDocumentIngestIdentity(store, {
    contentSha256,
    displayPath: value.displayPath,
    legacyProposalBytes: provisionalProposal(
      request.projectId, value, contentSha256, byteLength,
      legacyDocumentSourceRef(contentSha256),
    ),
    mediaType: value.mediaType,
    objective: value.objective,
    principalId: request.principalId,
    projectId: request.projectId,
  });
  if ("refusal" in identity) return identity.refusal;
  const { proposalCommandId, sourceRef } = identity.identity;

  const textLeg = recordSourceText(
    store, request, documentSourceLegOf(request.projectId, record, sourceRef),
  );
  if ("refusal" in textLeg) return textLeg.refusal;

  const proposalAggregateId = documentWorkAggregateId(request.projectId);
  const existing = store.getCommandDecision({
    commandId: proposalCommandId, principalId: request.principalId, projectId: request.projectId,
  });
  // On a genuine first ingest the proposal is fenced at the shared aggregate's current version
  // and decided now. On a replay the committed decision already fixed both, and
  // recordDocumentWorkProposal re-validates the replayed decision against the values passed here
  // (it folds expectedVersion into the request identity and compares decidedAt), so the original
  // fence and decision time must be presented back rather than today's.
  const replaying = existing !== null && existing.effectDisposition === "EFFECTS_COMMITTED";
  const expectedVersion = replaying
    ? existing.expectedVersion
    : store.getAggregateVersion(proposalAggregateId);
  const decidedAt = replaying ? existing.decidedAt : request.decidedAt;

  const recorded = recordDocumentWorkProposal(store, {
    commandId: proposalCommandId,
    correlationId: request.correlationId,
    decidedAt,
    expectedVersion,
    principalId: request.principalId,
    projectId: request.projectId,
    proposalBytes: provisionalProposal(
      request.projectId, value, contentSha256, byteLength, sourceRef,
    ),
  });
  if (!recorded.ok) return recorded;

  return Object.freeze({
    advisoryOnly: true,
    authority: "NONE",
    byteLength,
    contentSha256,
    disposition: recorded.disposition,
    ok: true,
    outcome: "INGESTED",
    proposal: recorded.proposal,
    proposalAggregateId: recorded.aggregateId,
    proposalEventId: recorded.eventId,
    sourceAggregateId: textLeg.aggregateId,
    sourceDisposition: textLeg.disposition,
    sourceEventId: textLeg.eventId,
  });
}
