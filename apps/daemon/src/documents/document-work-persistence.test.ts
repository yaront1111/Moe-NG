import {
  DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
  decodeDocumentWorkProposalBytes,
} from "@moe/contracts";
import { IdempotencyConflictError, SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  documentWorkAggregateId,
  recordDocumentWorkProposal,
} from "./document-work-service.js";
import {
  AGGREGATE_ID,
  EVENT_ID,
  PROJECT_ID,
  appendRawEvent,
  bytes,
  candidate,
  encoder,
  expectRefusal,
  input,
  proposal,
  source,
} from "./document-work-service-test-fixtures.js";

describe("document-work proposal persistence", () => {
  it("forwards the bounded contracts refusal before any mutation", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const result = recordDocumentWorkProposal(store, input(encoder.encode("{")));
      expectRefusal(
        result,
        "DOCUMENT_WORK_PROPOSAL_INPUT_REJECTED",
        "BOUNDED_JSON",
      );
      expect(store.readEventsAfter(0n).items).toStrictEqual([]);
      expect(store.readCommandDecisionsAfter(0n).items).toStrictEqual([]);
    } finally {
      store.close();
    }
  });

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
        aggregateId: AGGREGATE_ID,
        authority: "NONE",
        currentVersion: 1,
        disposition: "DECIDED",
        eventId: EVENT_ID,
        outcome: "RECORDED",
      });
      expect(result.proposal.sources.map((entry) => entry.sourceRef))
        .toStrictEqual(["source-0", "source-1"]);
      expect(result.proposal.candidates.map((entry) => entry.candidateRef))
        .toStrictEqual(["candidate-0", "candidate-1"]);
      expect(result.proposal.candidates[1]?.sourceRefs)
        .toStrictEqual(["source-0", "source-1"]);

      const events = store.readEvents(AGGREGATE_ID);
      expect(events.map((event) => ({
        aggregateId: event.aggregateId,
        domainSchemaVersion: event.domainSchemaVersion,
        eventId: event.eventId,
        eventType: event.eventType,
      }))).toStrictEqual([{
        aggregateId: AGGREGATE_ID,
        domainSchemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
        eventId: EVENT_ID,
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
        eventIds: [EVENT_ID],
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
