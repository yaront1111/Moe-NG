import { DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION } from "@moe/contracts";
import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_SOURCE_EVENT_TYPE,
  DOCUMENT_SOURCE_RECORD_COMMAND_KIND,
  DOCUMENT_SOURCE_SCHEMA_VERSION,
} from "./document-source-contract.js";
import type { DocumentIngestMediaType, DocumentSourceRecord } from "./document-source-contract.js";
import {
  encodeDocumentSourceRecord,
  provisionalTitle,
  sha256Hex,
  utf8ByteLength,
} from "./document-source-codec.js";
import {
  documentIngestContextManifestDigest,
  documentIngestRepositoryBaseHash,
  documentSourceAggregateId,
  documentSourceCommandId,
  documentSourceEventId,
  documentSourceRef,
  documentWorkIngestCommandId,
  legacyDocumentSourceRef,
} from "./document-source-identifiers.js";
import { ingestDocument } from "./document-ingest.js";
import { documentWorkAggregateId } from "./document-work-identifiers.js";
import { recordDocumentWorkProposal } from "./document-work-service.js";
import type { DocumentWorkStorePort } from "./document-work-store-port.js";
const PROJECT_ID = "legacy-document-project";
const PRINCIPAL_ID = "legacy-document-operator";
const DEFAULT_OBJECTIVE = "Author work candidates from the ingested document.";
const TEXT = "# Legacy goal brief\n\nBuild the durable compatibility path.\n";
const encoder = new TextEncoder();
interface LegacyPayload {
  readonly displayPath: string;
  readonly mediaType: DocumentIngestMediaType;
  readonly objective: string;
  readonly text: string;
}
interface LegacySeed {
  readonly contentSha256: string;
  readonly proposalEventId: string;
  readonly sourceAggregateId: string;
  readonly sourceEventId: string;
  readonly sourceRef: string;
}
function legacyProposalBytes(payload: LegacyPayload, contentSha256: string): Uint8Array {
  const byteLength = utf8ByteLength(payload.text);
  const sourceRef = legacyDocumentSourceRef(contentSha256);
  return encoder.encode(JSON.stringify({
    advisoryOnly: true,
    authority: "NONE",
    candidates: [{
      candidateRef: `candidate:${contentSha256}`,
      objective: payload.objective,
      sourceRefs: [sourceRef],
      title: provisionalTitle(payload.text, payload.mediaType === "text/markdown"),
    }],
    contextManifestDigest: documentIngestContextManifestDigest(
      PROJECT_ID, contentSha256, payload.displayPath, payload.mediaType,
    ),
    projectId: PROJECT_ID,
    repositoryBaseHash: documentIngestRepositoryBaseHash(PROJECT_ID),
    schemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
    sources: [{
      byteLength,
      contentSha256,
      displayPath: payload.displayPath,
      sourceRef,
    }],
    submissionState: "NOT_SUBMITTED",
    truthClass: "AGENT_REPORTED",
  }));
}
function seedLegacyIngest(store: SqliteEventStore, payload: LegacyPayload): LegacySeed {
  const contentSha256 = sha256Hex(payload.text);
  const sourceRef = legacyDocumentSourceRef(contentSha256);
  const sourceAggregateId = documentSourceAggregateId(PROJECT_ID, contentSha256);
  const sourceEventId = documentSourceEventId(PROJECT_ID, contentSha256);
  const sourceRecord: DocumentSourceRecord = Object.freeze({
    byteLength: utf8ByteLength(payload.text),
    contentSha256,
    displayPath: payload.displayPath,
    mediaType: payload.mediaType,
    schemaVersion: DOCUMENT_SOURCE_SCHEMA_VERSION,
    text: payload.text,
  });
  const sourceBytes = encodeDocumentSourceRecord(sourceRecord);
  const source = store.commitExpectedVersionDecision({
    commandKind: DOCUMENT_SOURCE_RECORD_COMMAND_KIND,
    committedResultBytes: sourceBytes,
    correlationId: "legacy-ingest-correlation",
    decidedAt: "2026-08-21T10:00:00.000Z",
    events: [{
      domainSchemaVersion: DOCUMENT_SOURCE_SCHEMA_VERSION,
      eventId: sourceEventId,
      eventType: DOCUMENT_SOURCE_EVENT_TYPE,
      outbox: [],
      payload: sourceBytes,
    }],
    expectedVersion: 0,
    key: {
      commandId: documentSourceCommandId(PROJECT_ID, contentSha256),
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    },
    requestBytes: sourceBytes,
    targetAggregateId: sourceAggregateId,
  });
  expect(source.disposition).toBe("DECIDED");

  const proposal = recordDocumentWorkProposal(store, {
    commandId: documentWorkIngestCommandId(PROJECT_ID, contentSha256),
    correlationId: "legacy-ingest-correlation",
    decidedAt: "2026-08-21T10:00:00.000Z",
    expectedVersion: store.getAggregateVersion(documentWorkAggregateId(PROJECT_ID)),
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    proposalBytes: legacyProposalBytes(payload, contentSha256),
  });
  expect(proposal.ok).toBe(true);
  if (!proposal.ok) throw new Error("legacy proposal seed refused");
  return {
    contentSha256,
    proposalEventId: proposal.eventId,
    sourceAggregateId,
    sourceEventId,
    sourceRef,
  };
}
function ingest(store: DocumentWorkStorePort, payload: Readonly<Record<string, unknown>>) {
  return ingestDocument(store, {
    correlationId: "current-ingest-correlation",
    decidedAt: "2026-08-25T10:00:00.000Z",
    payload,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
  });
}
describe("document ingest legacy identity compatibility", () => {
  it("replays a matching content-only source and proposal without duplicate events", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const payload = {
        displayPath: "moe-goals/legacy-goal/intake.md",
        mediaType: "text/markdown" as const,
        objective: DEFAULT_OBJECTIVE,
        text: TEXT,
      };
      const legacy = seedLegacyIngest(store, payload);
      const replay = ingest(store, payload);
      expect(replay.ok).toBe(true);
      if (!replay.ok) throw new Error("legacy re-ingest refused");

      expect([replay.sourceDisposition, replay.disposition]).toStrictEqual([
        "REPLAYED", "REPLAYED",
      ]);
      expect(replay.sourceAggregateId).toBe(legacy.sourceAggregateId);
      expect(replay.sourceEventId).toBe(legacy.sourceEventId);
      expect(replay.proposalEventId).toBe(legacy.proposalEventId);
      expect(replay.proposal.sources[0]?.sourceRef).toBe(legacy.sourceRef);
      expect(store.readEvents(legacy.sourceAggregateId)).toHaveLength(1);
      expect(store.readEvents(documentWorkAggregateId(PROJECT_ID))).toHaveLength(1);

      const currentRef = documentSourceRef(
        legacy.contentSha256, payload.displayPath, payload.mediaType,
      );
      expect(store.readEvents(documentSourceAggregateId(
        PROJECT_ID, legacy.contentSha256, currentRef,
      ))).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("keeps a different goal path or objective on separate current identities", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const legacyPayload = {
        displayPath: "moe-goals/legacy-goal/intake.md",
        mediaType: "text/markdown" as const,
        objective: DEFAULT_OBJECTIVE,
        text: TEXT,
      };
      const legacy = seedLegacyIngest(store, legacyPayload);
      const differentPath = ingest(store, {
        ...legacyPayload,
        displayPath: "moe-goals/new-goal/intake.md",
      });
      const differentObjective = ingest(store, {
        ...legacyPayload,
        objective: "Author a distinct work candidate for this goal.",
      });
      expect(differentPath.ok && differentObjective.ok).toBe(true);
      if (!differentPath.ok || !differentObjective.ok) throw new Error("current ingest refused");

      for (const current of [differentPath, differentObjective]) {
        expect([current.sourceDisposition, current.disposition]).toStrictEqual([
          "DECIDED", "DECIDED",
        ]);
        expect(current.sourceAggregateId).not.toBe(legacy.sourceAggregateId);
        expect(current.sourceEventId).not.toBe(legacy.sourceEventId);
        expect(current.proposalEventId).not.toBe(legacy.proposalEventId);
        expect(current.proposal.sources[0]?.sourceRef).not.toBe(legacy.sourceRef);
      }
      expect(differentObjective.sourceAggregateId).not.toBe(differentPath.sourceAggregateId);
      expect(differentObjective.proposalEventId).not.toBe(differentPath.proposalEventId);
      expect(store.readEvents(documentWorkAggregateId(PROJECT_ID))).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("fails closed when the matching legacy source record is corrupt", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const payload = {
        displayPath: "moe-goals/legacy-goal/intake.md",
        mediaType: "text/markdown" as const,
        objective: DEFAULT_OBJECTIVE,
        text: TEXT,
      };
      const legacy = seedLegacyIngest(store, payload);
      const corruptingPort: DocumentWorkStorePort = {
        commitExpectedVersionDecision: (input) => store.commitExpectedVersionDecision(input),
        getAggregateVersion: (aggregateId) => store.getAggregateVersion(aggregateId),
        getCommandDecision: (key) => store.getCommandDecision(key),
        readAggregateEvents: (aggregateId, afterSequence, limit, maxBytes) => {
          const page = store.readAggregateEvents(aggregateId, afterSequence, limit, maxBytes);
          return aggregateId !== legacy.sourceAggregateId ? page : {
            ...page,
            items: page.items.map((event) => ({ ...event, payload: encoder.encode("{}") })),
          };
        },
      };
      const result = ingest(corruptingPort, payload);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("corrupt legacy source was accepted");
      expect({ code: result.code, layer: result.layer }).toStrictEqual({
        code: "DOCUMENT_WORK_DOSSIER_SOURCE_INVALID",
        layer: "DAEMON_READ_MODEL",
      });
      expect(store.readEvents(legacy.sourceAggregateId)).toHaveLength(1);
      expect(store.readEvents(documentWorkAggregateId(PROJECT_ID))).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
