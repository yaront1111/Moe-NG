import type {
  DocumentWorkProposal,
  DocumentWorkProposalErrorCode,
  DocumentWorkProposalLayer,
} from "@moe/contracts";
import type { DurableStoreErrorCode } from "@moe/store";

import type { DocumentSourceView } from "./document-source-contract.js";

/** Internal durable record only; this is deliberately not a runtime command affordance. */
export const DOCUMENT_WORK_RECORD_COMMAND_KIND = "document-work.record" as const;
export const DOCUMENT_WORK_EVENT_TYPE = "DocumentWorkProposalRecorded" as const;

export const DOCUMENT_WORK_SERVICE_ERROR_CODES = Object.freeze([
  "DOCUMENT_WORK_SERVICE_INPUT_INVALID",
  "DOCUMENT_WORK_PROPOSAL_PROJECT_MISMATCH",
  "DOCUMENT_WORK_DECISION_MISMATCH",
  "DOCUMENT_WORK_DOSSIER_MISSING",
  "DOCUMENT_WORK_DOSSIER_EVENT_TYPE_MISMATCH",
  "DOCUMENT_WORK_DOSSIER_SCHEMA_MISMATCH",
  "DOCUMENT_WORK_DOSSIER_PAYLOAD_INVALID",
  "DOCUMENT_WORK_DOSSIER_DECISION_MISMATCH",
  "DOCUMENT_WORK_DOSSIER_TAIL_UNSTABLE",
  // Operator document ingest (DAEMON_INGRESS): the payload shape, its media roster, and the
  // explicit text-size cap the daemon enforces before it computes any digest.
  "DOCUMENT_WORK_INGEST_PAYLOAD_INVALID",
  "DOCUMENT_WORK_INGEST_MEDIA_TYPE_UNSUPPORTED",
  "DOCUMENT_WORK_INGEST_TEXT_TOO_LARGE",
  // Dossier source read (DAEMON_READ_MODEL): stored text that does not content-address to the
  // sha its proposal names. Absence of a source is not this refusal; tampering is.
  "DOCUMENT_WORK_DOSSIER_SOURCE_INVALID",
] as const);

export const DOCUMENT_WORK_SERVICE_LAYERS = Object.freeze([
  "DAEMON_INGRESS", "DAEMON_PROVENANCE", "DAEMON_READ_MODEL", "DURABLE_STORE",
] as const);

export type DocumentWorkServiceErrorCode =
  | DocumentWorkProposalErrorCode
  | DurableStoreErrorCode
  | (typeof DOCUMENT_WORK_SERVICE_ERROR_CODES)[number];
export type DocumentWorkServiceLayer =
  | DocumentWorkProposalLayer
  | (typeof DOCUMENT_WORK_SERVICE_LAYERS)[number];

export interface RecordDocumentWorkProposalInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly decidedAt: string;
  readonly expectedVersion: number;
  readonly principalId: string;
  readonly projectId: string;
  /** Hostile bytes: the public contracts decoder remains the only parser. */
  readonly proposalBytes: unknown;
}

export interface DocumentWorkServiceRefused {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly code: DocumentWorkServiceErrorCode;
  readonly layer: DocumentWorkServiceLayer;
  readonly ok: false;
  readonly outcome: "REFUSED";
}

export interface DocumentWorkProposalRecorded {
  readonly advisoryOnly: true;
  readonly aggregateId: string;
  readonly authority: "NONE";
  readonly currentVersion: number;
  readonly decisionId: string;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly eventId: string;
  readonly ok: true;
  readonly outcome: "RECORDED";
  readonly proposal: DocumentWorkProposal;
}

export interface DocumentWorkDossier {
  readonly advisoryOnly: true;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly authority: "NONE";
  readonly committedAt: string;
  readonly eventId: string;
  readonly ok: true;
  readonly outcome: "DOSSIER";
  readonly proposal: DocumentWorkProposal;
  /** The bounded text of `proposal.sources[0]` when an operator ingested it, so the page can
   *  show the document. Absent when no text was ingested for that source; the field is omitted
   *  rather than nulled, so a proposal recorded without ingested text is unchanged. */
  readonly source?: DocumentSourceView;
}

export type RecordDocumentWorkProposalResult =
  | DocumentWorkProposalRecorded
  | DocumentWorkServiceRefused;
export type ReadDocumentWorkDossierResult = DocumentWorkDossier | DocumentWorkServiceRefused;
