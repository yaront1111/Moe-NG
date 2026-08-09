import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  documentWorkAggregateId,
  recordDocumentWorkProposal,
  readLatestDocumentWorkDossier,
} from "./document-work-service.js";
import {
  AGGREGATE_ID,
  EVENT_ID,
  PROJECT_ID,
  bytes,
  encoder,
  input,
  proposal,
} from "./document-work-service-test-fixtures.js";

describe("document-work durable identifiers", () => {
  it("hashes a maximum-length command into an exact bounded control-free event id", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const result = recordDocumentWorkProposal(store, input(undefined, {
        commandId: "x".repeat(512),
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("recording was refused");
      expect(result.eventId).toBe(
        "document-work-proposal/e5a0f4f0e33fabe58fa92d920429926dc2bcc5bc9e4787a3ef2e66449b7e2844",
      );
      expect(encoder.encode(result.eventId).byteLength).toBeLessThanOrEqual(512);
      expect(/[\u0000-\u001f\u007f]/u.test(result.eventId)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("binds event identity to the complete store idempotency scope", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      const first = recordDocumentWorkProposal(store, input());
      const second = recordDocumentWorkProposal(store, input(undefined, {
        expectedVersion: 1,
        principalId: "agent-2",
      }));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error("recording was refused");
      expect([first.eventId, second.eventId]).toStrictEqual([
        EVENT_ID,
        "document-work-proposal/12e77561d2eea093301ed207b8cc93dee7d300cb0ff967142c83349f61148d08",
      ]);
      expect(store.readEvents(AGGREGATE_ID).map((event) => event.eventId))
        .toStrictEqual([first.eventId, second.eventId]);
    } finally {
      store.close();
    }
  });

  it("hashes a 512-byte valid project id for persistence and tail reads", () => {
    const projectId = "😀".repeat(128);
    const aggregateId =
      "document-work/30df12326b3e4186c20265e9a564005df1a2610ef5bb7e7e7ac2cdf5bca5a516";
    const store = SqliteEventStore.openEphemeralForProjectTest(projectId);
    try {
      const raw = bytes(proposal({ projectId }));
      const result = recordDocumentWorkProposal(store, input(raw, {
        commandId: "document-command-astral",
        projectId,
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("recording was refused");
      expect(result.aggregateId).toBe(aggregateId);
      expect(result.eventId).toBe(
        "document-work-proposal/44493ad114979548a07594b4d186e38830e85cce65002ec880838b31525ac845",
      );
      expect(documentWorkAggregateId(projectId)).toBe(aggregateId);
      const dossier = readLatestDocumentWorkDossier(store, projectId);
      expect(dossier.ok).toBe(true);
      if (!dossier.ok) throw new Error("dossier read was refused");
      expect(dossier.aggregateId).toBe(aggregateId);
      expect(dossier.proposal.projectId).toBe(projectId);
    } finally {
      store.close();
    }
  });
});
