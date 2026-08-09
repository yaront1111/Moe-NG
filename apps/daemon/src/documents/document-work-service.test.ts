import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
  decodeDocumentWorkProposalBytes,
} from "@moe/contracts";
import { IdempotencyConflictError, SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  DOCUMENT_WORK_EVENT_TYPE,
  DOCUMENT_WORK_RECORD_COMMAND_KIND,
  documentWorkAggregateId,
  recordDocumentWorkProposal,
  readLatestDocumentWorkDossier,
} from "./document-work-service.js";

const PROJECT_ID = "project-1";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const encoder = new TextEncoder();

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function source(index: number): Record<string, unknown> {
  return {
    byteLength: 100 + index,
    contentSha256: index % 2 === 0 ? HASH_A : HASH_B,
    displayPath: `docs/source-${String(index)}.md`,
    sourceRef: `source-${String(index)}`,
  };
}

function candidate(
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

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function input(
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

function appendRawEvent(
  store: SqliteEventStore,
  options: {
    readonly eventType?: string;
    readonly payload?: Uint8Array;
    readonly schemaVersion?: string;
  } = {},
): void {
  const aggregateId = documentWorkAggregateId(PROJECT_ID);
  const expectedVersion = store.getAggregateVersion(aggregateId);
  store.commit({
    aggregateId,
    commandBytes: bytes({ fixture: expectedVersion }),
    commandId: `raw-command-${String(expectedVersion)}`,
    committedAt: "2026-08-09T18:00:00.000Z",
    events: [{
      domainSchemaVersion:
        options.schemaVersion ?? DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
      eventId: `raw-event-${String(expectedVersion)}`,
      eventType: options.eventType ?? DOCUMENT_WORK_EVENT_TYPE,
      payload: options.payload ?? bytes(proposal()),
    }],
    expectedVersion,
  });
}

function expectRefusal(
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

describe("document-work proposal persistence", () => {
  it("refuses a caller/project provenance mismatch before any mutation", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const result = recordDocumentWorkProposal(
        store,
        input(bytes(proposal({ projectId: "other-project" }))),
      );

      expectRefusal(
        result,
        "DOCUMENT_WORK_PROPOSAL_PROJECT_MISMATCH",
        "DAEMON_PROVENANCE",
      );
      expect(store.getAggregateVersion(documentWorkAggregateId(PROJECT_ID))).toBe(0);
      expect(store.readEventsAfter(0n).items).toStrictEqual([]);
      expect(store.readCommandDecisionsAfter(0n).items).toStrictEqual([]);
    } finally {
      store.close();
    }
  });

  it("records one normalized isolated advisory event and no authority effects", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const raw = bytes(proposal({
        candidates: [candidate(1, ["source-1", "source-0"]), candidate(0)],
        sources: [source(1), source(0)],
      }));
      const result = recordDocumentWorkProposal(store, input(raw));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("recording was refused");

      expect({
        advisoryOnly: result.advisoryOnly,
        aggregateId: result.aggregateId,
        authority: result.authority,
        currentVersion: result.currentVersion,
        disposition: result.disposition,
        eventId: result.eventId,
        outcome: result.outcome,
      }).toStrictEqual({
        advisoryOnly: true,
        aggregateId: "document-work/project-1",
        authority: "NONE",
        currentVersion: 1,
        disposition: "DECIDED",
        eventId: "document-work-proposal/document-command-1",
        outcome: "RECORDED",
      });
      expect(result.proposal.sources.map((entry) => entry.sourceRef))
        .toStrictEqual(["source-0", "source-1"]);
      expect(result.proposal.candidates.map((entry) => entry.candidateRef))
        .toStrictEqual(["candidate-0", "candidate-1"]);
      expect(result.proposal.candidates[1]?.sourceRefs)
        .toStrictEqual(["source-0", "source-1"]);

      const events = store.readEvents("document-work/project-1");
      expect(events.map((event) => ({
        aggregateId: event.aggregateId,
        domainSchemaVersion: event.domainSchemaVersion,
        eventId: event.eventId,
        eventType: event.eventType,
      }))).toStrictEqual([{
        aggregateId: "document-work/project-1",
        domainSchemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
        eventId: "document-work-proposal/document-command-1",
        eventType: "DocumentWorkProposalRecorded",
      }]);
      const decoded = decodeDocumentWorkProposalBytes(events[0]?.payload);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error("stored proposal did not decode");
      expect(decoded.proposal).toStrictEqual(result.proposal);
      expect(store.readPendingOutbox()).toStrictEqual([]);
      expect(store.readCommandDecisionsAfter(0n).items.map((decision) => ({
        commandKind: decision.commandKind,
        eventIds: decision.businessEventIds,
        resultCode: decision.resultCode,
      }))).toStrictEqual([{
        commandKind: "document-work.record",
        eventIds: ["document-work-proposal/document-command-1"],
        resultCode: "EFFECTS_COMMITTED",
      }]);
      expect(events.map((event) => event.eventType)).not.toContain("PlanProposed");
      expect(events.some((event) => /Graph|Node|Affordance/u.test(event.eventType))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("replays identical raw bytes and conflicts changed bytes through the store", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const raw = bytes(proposal());
      const trusted = input(raw);
      const first = recordDocumentWorkProposal(store, trusted);
      const replay = recordDocumentWorkProposal(store, trusted);
      expect(first.ok).toBe(true);
      expect(replay.ok).toBe(true);
      if (!first.ok || !replay.ok) throw new Error("recording was refused");
      expect([first.disposition, replay.disposition]).toStrictEqual(["DECIDED", "REPLAYED"]);
      expect(replay.decisionId).toBe(first.decisionId);
      expect(store.readEvents(documentWorkAggregateId(PROJECT_ID))).toHaveLength(1);

      const changed = new Uint8Array(raw.length + 1);
      changed.set(raw);
      changed[raw.length] = 0x20;
      expect(() => recordDocumentWorkProposal(store, input(changed)))
        .toThrowError(IdempotencyConflictError);
      expect(store.readEvents(documentWorkAggregateId(PROJECT_ID))).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("surfaces the store expected-version refusal without claiming authority", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      appendRawEvent(store);
      expectRefusal(
        recordDocumentWorkProposal(store, input()),
        "EXPECTED_VERSION_CONFLICT",
        "DURABLE_STORE",
      );
      expect(store.getAggregateVersion(documentWorkAggregateId(PROJECT_ID))).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("latest document-work dossier read", () => {
  it("refuses when no dossier exists", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      expectRefusal(
        readLatestDocumentWorkDossier(store, PROJECT_ID),
        "DOCUMENT_WORK_DOSSIER_MISSING",
        "DAEMON_READ_MODEL",
      );
    } finally {
      store.close();
    }
  });

  it("returns only the latest deeply frozen detached advisory dossier", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const firstBytes = bytes(proposal());
      const secondBytes = bytes(proposal({
        candidates: [candidate(1)],
        sources: [source(1)],
      }));
      recordDocumentWorkProposal(store, input(firstBytes));
      recordDocumentWorkProposal(store, input(secondBytes, {
        commandId: "document-command-2",
        correlationId: "document-correlation-2",
        decidedAt: "2026-08-09T18:00:01.000Z",
        expectedVersion: 1,
      }));
      firstBytes.fill(0);
      secondBytes.fill(0);

      const dossier = readLatestDocumentWorkDossier(store, PROJECT_ID);
      expect(dossier.ok).toBe(true);
      if (!dossier.ok) throw new Error("dossier read was refused");
      expect({
        advisoryOnly: dossier.advisoryOnly,
        aggregateId: dossier.aggregateId,
        aggregateSequence: dossier.aggregateSequence,
        authority: dossier.authority,
        eventId: dossier.eventId,
        outcome: dossier.outcome,
        title: dossier.proposal.candidates[0]?.title,
      }).toStrictEqual({
        advisoryOnly: true,
        aggregateId: "document-work/project-1",
        aggregateSequence: 2,
        authority: "NONE",
        eventId: "document-work-proposal/document-command-2",
        outcome: "DOSSIER",
        title: "Candidate 1",
      });
      expect([
        Object.isFrozen(dossier), Object.isFrozen(dossier.proposal),
        Object.isFrozen(dossier.proposal.sources), Object.isFrozen(dossier.proposal.sources[0]),
        Object.isFrozen(dossier.proposal.candidates),
        Object.isFrozen(dossier.proposal.candidates[0]),
        Object.isFrozen(dossier.proposal.candidates[0]?.sourceRefs),
      ]).toStrictEqual([true, true, true, true, true, true, true]);
    } finally {
      store.close();
    }
  });

  it("reproduces the same dossier after a file-backed reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "moe-document-work-"));
    const storePath = join(root, "store.sqlite");
    let before: ReturnType<typeof readLatestDocumentWorkDossier>;
    try {
      const first = SqliteEventStore.openForProject(storePath, PROJECT_ID);
      try {
        recordDocumentWorkProposal(first, input());
        before = readLatestDocumentWorkDossier(first, PROJECT_ID);
      } finally {
        first.close();
      }
      const reopened = SqliteEventStore.openForProject(storePath, PROJECT_ID);
      try {
        expect(readLatestDocumentWorkDossier(reopened, PROJECT_ID)).toStrictEqual(before);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "event type",
      { eventType: "PlanProposed" },
      "DOCUMENT_WORK_DOSSIER_EVENT_TYPE_MISMATCH",
    ],
    [
      "event schema",
      { schemaVersion: "moe-document-work-proposal/999" },
      "DOCUMENT_WORK_DOSSIER_SCHEMA_MISMATCH",
    ],
    [
      "event payload",
      { payload: bytes({ malformed: true }) },
      "DOCUMENT_WORK_DOSSIER_PAYLOAD_INVALID",
    ],
  ] as const)("fails closed on an invalid latest %s", (_label, options, code) => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      appendRawEvent(store, options);
      expectRefusal(
        readLatestDocumentWorkDossier(store, PROJECT_ID),
        code,
        "DAEMON_READ_MODEL",
      );
    } finally {
      store.close();
    }
  });

  it("refuses a stored proposal whose claimed project differs from the aggregate", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      appendRawEvent(store, {
        payload: bytes(proposal({ projectId: "other-project" })),
      });
      expectRefusal(
        readLatestDocumentWorkDossier(store, PROJECT_ID),
        "DOCUMENT_WORK_PROPOSAL_PROJECT_MISMATCH",
        "DAEMON_PROVENANCE",
      );
    } finally {
      store.close();
    }
  });
});

describe("document-work service vocabulary", () => {
  it("pins the non-authoritative event and command names", () => {
    expect([DOCUMENT_WORK_RECORD_COMMAND_KIND, DOCUMENT_WORK_EVENT_TYPE])
      .toStrictEqual(["document-work.record", "DocumentWorkProposalRecorded"]);
  });
});
