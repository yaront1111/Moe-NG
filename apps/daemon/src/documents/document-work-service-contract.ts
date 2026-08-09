import type {
  DocumentWorkProposal,
  DocumentWorkProposalErrorCode,
  DocumentWorkProposalLayer,
} from "@moe/contracts";

/** Internal durable record only; this is deliberately not a runtime command affordance. */
export const DOCUMENT_WORK_RECORD_COMMAND_KIND = "document-work.record" as const;
export const DOCUMENT_WORK_EVENT_TYPE = "DocumentWorkProposalRecorded" as const;

export const DOCUMENT_WORK_SERVICE_ERROR_CODES = Object.freeze([
  "DOCUMENT_WORK_PROPOSAL_PROJECT_MISMATCH",
  "DOCUMENT_WORK_DOSSIER_MISSING",
  "DOCUMENT_WORK_DOSSIER_EVENT_TYPE_MISMATCH",
  "DOCUMENT_WORK_DOSSIER_SCHEMA_MISMATCH",
  "DOCUMENT_WORK_DOSSIER_PAYLOAD_INVALID",
  "EXPECTED_VERSION_CONFLICT",
] as const);

export const DOCUMENT_WORK_SERVICE_LAYERS = Object.freeze([
  "DAEMON_PROVENANCE", "DAEMON_READ_MODEL", "DURABLE_STORE",
] as const);

export type DocumentWorkServiceErrorCode =
  | DocumentWorkProposalErrorCode
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
}

export type RecordDocumentWorkProposalResult =
  | DocumentWorkProposalRecorded
  | DocumentWorkServiceRefused;
export type ReadDocumentWorkDossierResult = DocumentWorkDossier | DocumentWorkServiceRefused;
