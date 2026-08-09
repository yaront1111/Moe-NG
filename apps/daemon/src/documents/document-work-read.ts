import {
  DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
  decodeDocumentWorkProposalBytes,
} from "@moe/contracts";
import type { DocumentWorkProposal } from "@moe/contracts";
import {
  COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
  EVENT_RECORD_VERSION,
  OPAQUE_PAYLOAD_CODEC_VERSION,
} from "@moe/store";

import { validateDocumentWorkDecision } from "./document-work-decision.js";
import {
  documentWorkAggregateId,
  documentWorkEventId,
} from "./document-work-identifiers.js";
import { durableStoreRefusal, refuse } from "./document-work-result.js";
import {
  copyFixedBytes,
  exactDataArray,
  exactDataRecord,
  sameBytes,
  sha256String,
} from "./document-work-safe-value.js";
import {
  DOCUMENT_WORK_EVENT_TYPE,
  DOCUMENT_WORK_RECORD_COMMAND_KIND,
} from "./document-work-service-contract.js";
import type {
  DocumentWorkDossier,
  DocumentWorkServiceRefused,
  ReadDocumentWorkDossierResult,
} from "./document-work-service-contract.js";
import type { DocumentWorkStorePort } from "./document-work-store-port.js";

const encoder = new TextEncoder();
const TAIL_ATTEMPTS = 3;
const PAGE_KEYS = Object.freeze(["hasMore", "items", "nextCursor"]);
const EVENT_KEYS = Object.freeze([
  "aggregateId", "aggregateSequence", "commandId", "committedAt", "domainSchemaVersion",
  "eventId", "eventType", "globalPosition", "metadata", "payloadCodecVersion", "payload",
  "recordVersion", "requestSha256", "decisionTrace",
]);
const RAW_EVENT_KEYS = EVENT_KEYS.filter((key) => key !== "decisionTrace");
const TRACE_KEYS = Object.freeze([
  "commandId", "commandKind", "principalId", "projectId",
  "requestIdentityVersion", "requestSha256",
]);

interface TailEvent {
  readonly values: Readonly<Record<string, unknown>>;
  readonly payload: Uint8Array;
}

function snapshotEvent(value: unknown): TailEvent | null {
  const values = exactDataRecord(value, EVENT_KEYS) ?? exactDataRecord(value, RAW_EVENT_KEYS);
  if (values === null) return null;
  const payload = copyFixedBytes(values.payload);
  const metadata = copyFixedBytes(values.metadata);
  if (
    payload === null || metadata === null
    || typeof values.aggregateId !== "string"
    || !Number.isSafeInteger(values.aggregateSequence)
    || (values.aggregateSequence as number) < 1
    || typeof values.commandId !== "string"
    || typeof values.committedAt !== "string"
    || typeof values.domainSchemaVersion !== "string"
    || typeof values.eventId !== "string"
    || typeof values.eventType !== "string"
    || typeof values.globalPosition !== "bigint"
    || values.globalPosition < 1n
    || values.payloadCodecVersion !== OPAQUE_PAYLOAD_CODEC_VERSION
    || values.recordVersion !== EVENT_RECORD_VERSION
    || !sha256String(values.requestSha256)
  ) return null;
  return { payload, values };
}

function stableTail(
  store: DocumentWorkStorePort,
  aggregateId: string,
): TailEvent | DocumentWorkServiceRefused {
  for (let attempt = 0; attempt < TAIL_ATTEMPTS; attempt += 1) {
    const before = store.getAggregateVersion(aggregateId);
    if (!Number.isSafeInteger(before) || before < 0) continue;
    if (before === 0) {
      if (store.getAggregateVersion(aggregateId) === 0) {
        return refuse("DOCUMENT_WORK_DOSSIER_MISSING", "DAEMON_READ_MODEL");
      }
      continue;
    }
    const rawPage = store.readAggregateEvents(aggregateId, before - 1, 1);
    const page = exactDataRecord(rawPage, PAGE_KEYS);
    const items = page === null ? null : exactDataArray(page.items);
    const event = items?.length === 1 ? snapshotEvent(items[0]) : null;
    const after = store.getAggregateVersion(aggregateId);
    if (
      page !== null && items !== null && event !== null
      && page.hasMore === false
      && page.nextCursor === before
      && event.values.aggregateSequence === before
      && after === before
    ) return event;
  }
  return refuse("DOCUMENT_WORK_DOSSIER_TAIL_UNSTABLE", "DAEMON_READ_MODEL");
}

function normalizedBytes(proposal: DocumentWorkProposal): Uint8Array {
  return encoder.encode(JSON.stringify(proposal));
}

function dossier(event: TailEvent, proposal: DocumentWorkProposal): DocumentWorkDossier {
  return Object.freeze({
    advisoryOnly: true,
    aggregateId: event.values.aggregateId as string,
    aggregateSequence: event.values.aggregateSequence as number,
    authority: "NONE",
    committedAt: event.values.committedAt as string,
    eventId: event.values.eventId as string,
    ok: true,
    outcome: "DOSSIER",
    proposal,
  });
}

function readStableDossier(
  store: DocumentWorkStorePort,
  projectId: string,
): ReadDocumentWorkDossierResult {
  const aggregateId = documentWorkAggregateId(projectId);
  const tail = stableTail(store, aggregateId);
  if ("ok" in tail) return tail;
  const trace = exactDataRecord(tail.values.decisionTrace, TRACE_KEYS);
  if (trace === null) {
    return refuse("DOCUMENT_WORK_DOSSIER_DECISION_MISMATCH", "DAEMON_READ_MODEL");
  }
  if (tail.values.eventType !== DOCUMENT_WORK_EVENT_TYPE) {
    return refuse("DOCUMENT_WORK_DOSSIER_EVENT_TYPE_MISMATCH", "DAEMON_READ_MODEL");
  }
  if (tail.values.domainSchemaVersion !== DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION) {
    return refuse("DOCUMENT_WORK_DOSSIER_SCHEMA_MISMATCH", "DAEMON_READ_MODEL");
  }
  const decoded = decodeDocumentWorkProposalBytes(tail.payload);
  if (!decoded.ok || !sameBytes(tail.payload, normalizedBytes(decoded.proposal))) {
    return refuse("DOCUMENT_WORK_DOSSIER_PAYLOAD_INVALID", "DAEMON_READ_MODEL");
  }
  if (decoded.proposal.projectId !== projectId) {
    return refuse("DOCUMENT_WORK_PROPOSAL_PROJECT_MISMATCH", "DAEMON_PROVENANCE");
  }
  if (
    typeof trace.commandId !== "string"
    || trace.commandKind !== DOCUMENT_WORK_RECORD_COMMAND_KIND
    || typeof trace.principalId !== "string"
    || trace.projectId !== projectId
    || trace.requestIdentityVersion !== COMMAND_DECISION_REQUEST_IDENTITY_VERSION
    || !sha256String(trace.requestSha256)
    || tail.values.aggregateId !== aggregateId
  ) return refuse("DOCUMENT_WORK_DOSSIER_DECISION_MISMATCH", "DAEMON_READ_MODEL");

  const decision = store.getCommandDecision({
    commandId: trace.commandId,
    principalId: trace.principalId,
    projectId,
  });
  const currentVersion = tail.values.aggregateSequence as number;
  const expectedEventId = documentWorkEventId(projectId, trace.principalId, trace.commandId);
  const validated = validateDocumentWorkDecision(decision, {
    aggregateId,
    commandId: trace.commandId,
    currentVersion,
    decidedAt: tail.values.committedAt as string,
    eventId: expectedEventId,
    expectedVersion: currentVersion - 1,
    payload: tail.payload,
    principalId: trace.principalId,
    projectId,
    requestSha256: trace.requestSha256,
  });
  if (
    validated === null
    || tail.values.eventId !== expectedEventId
    || tail.values.commandId !== `moe-internal:decision-effect:${validated.decisionId}`
  ) return refuse("DOCUMENT_WORK_DOSSIER_DECISION_MISMATCH", "DAEMON_READ_MODEL");
  return dossier(tail, decoded.proposal);
}

/** Reads a decision-backed, normalized, stable aggregate tail only. */
export function readLatestDocumentWorkDossier(
  store: DocumentWorkStorePort,
  projectId: string,
): ReadDocumentWorkDossierResult {
  try {
    return readStableDossier(store, projectId);
  } catch (error) {
    const mapped = durableStoreRefusal(error);
    if (mapped !== null) return mapped;
    throw error;
  }
}
