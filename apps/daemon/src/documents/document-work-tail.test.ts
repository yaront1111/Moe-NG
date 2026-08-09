import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  readLatestDocumentWorkDossier,
  recordDocumentWorkProposal,
} from "./document-work-service.js";
import {
  PROJECT_ID,
  expectRefusal,
  input,
} from "./document-work-service-test-fixtures.js";

type ReadStore = Parameters<typeof readLatestDocumentWorkDossier>[0];

function driftingStore(always: boolean): {
  readonly close: () => void;
  readonly reads: () => number;
  readonly store: ReadStore;
} {
  const real = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  recordDocumentWorkProposal(real, input());
  let reads = 0;
  return {
    close: () => real.close(),
    reads: () => reads,
    store: {
      commitExpectedVersionDecision: real.commitExpectedVersionDecision.bind(real),
      getAggregateVersion: real.getAggregateVersion.bind(real),
      getCommandDecision: real.getCommandDecision.bind(real),
      readAggregateEvents: (
        aggregateId: string,
        afterSequence: number,
        limit: number,
        maxBytes?: number,
      ) => {
        reads += 1;
        const page = real.readAggregateEvents(aggregateId, afterSequence, limit, maxBytes);
        if (!always && reads === 1) {
          recordDocumentWorkProposal(real, input(undefined, {
            commandId: "document-command-interleaved",
            correlationId: "document-correlation-interleaved",
            decidedAt: "2026-08-09T18:00:01.000Z",
            expectedVersion: 1,
          }));
          return page;
        }
        if (always) return { ...page, hasMore: true };
        return page;
      },
    } as unknown as ReadStore,
  };
}

describe("document-work dossier stable tail", () => {
  it("retries a bounded version/page interleaving and returns the stable tail", () => {
    const subject = driftingStore(false);
    try {
      const result = readLatestDocumentWorkDossier(subject.store, PROJECT_ID);
      expect(result.ok).toBe(true);
      expect(subject.reads()).toBe(2);
    } finally {
      subject.close();
    }
  });

  it("refuses when the aggregate tail never stabilizes", () => {
    const subject = driftingStore(true);
    try {
      expectRefusal(
        readLatestDocumentWorkDossier(subject.store, PROJECT_ID),
        "DOCUMENT_WORK_DOSSIER_TAIL_UNSTABLE",
        "DAEMON_READ_MODEL",
      );
      expect(subject.reads()).toBeGreaterThan(1);
    } finally {
      subject.close();
    }
  });
});
