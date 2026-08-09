import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  recordDocumentWorkProposal,
  readLatestDocumentWorkDossier,
} from "./document-work-service.js";
import {
  AGGREGATE_ID,
  PROJECT_ID,
  appendRawEvent,
  bytes,
  candidate,
  expectRefusal,
  input,
  proposal,
  source,
} from "./document-work-service-test-fixtures.js";

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
        aggregateId: AGGREGATE_ID,
        aggregateSequence: 2,
        authority: "NONE",
        eventId:
          "document-work-proposal/d4e5c4ee203f5f6ee09d6dddde1f4466e758c0b30a43cc6d39d5092108a21eda",
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
