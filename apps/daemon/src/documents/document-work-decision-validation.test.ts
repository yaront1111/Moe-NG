import {
  DurableStoreError,
  SqliteEventStore,
} from "@moe/store";
import type { CommandDecisionResponse } from "@moe/store";
import { describe, expect, it } from "vitest";

import { recordDocumentWorkProposal } from "./document-work-service.js";
import {
  PROJECT_ID,
  bytes,
  expectRefusal,
  input,
  proposal,
} from "./document-work-service-test-fixtures.js";

type RecordStore = Parameters<typeof recordDocumentWorkProposal>[0];

function transformedStore(
  transform: (response: CommandDecisionResponse) => unknown,
): { readonly close: () => void; readonly store: RecordStore } {
  const real = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  return {
    close: () => real.close(),
    store: {
      commitExpectedVersionDecision: (request) =>
        transform(real.commitExpectedVersionDecision(request)),
      getAggregateVersion: real.getAggregateVersion.bind(real),
      getCommandDecision: real.getCommandDecision.bind(real),
      readAggregateEvents: real.readAggregateEvents.bind(real),
    } as unknown as RecordStore,
  };
}

function changedDecision(
  response: CommandDecisionResponse,
  patch: Readonly<Record<string, unknown>>,
): unknown {
  return { ...response, decision: { ...response.decision, ...patch } };
}

describe("document-work committed decision validation", () => {
  it.each([
    ["response extra", (response: CommandDecisionResponse): unknown => ({
      ...response, unexpected: true,
    })],
    ["decision extra", (response: CommandDecisionResponse): unknown => changedDecision(
      response, { unexpected: true },
    )],
    ["event identity", (response: CommandDecisionResponse): unknown => changedDecision(
      response, { businessEventIds: ["forged-event"] },
    )],
    ["outbox effect", (response: CommandDecisionResponse): unknown => changedDecision(
      response, { outboxMessageIds: ["forged-message"] },
    )],
    ["scoped key", (response: CommandDecisionResponse): unknown => changedDecision(
      response, { key: { ...response.decision.key, principalId: "other-principal" } },
    )],
    ["normalized result", (response: CommandDecisionResponse): unknown => changedDecision(
      response, { resultBytes: bytes({ forged: true }) },
    )],
    ["effect disposition", (response: CommandDecisionResponse): unknown => changedDecision(
      response, { effectDisposition: "NO_BUSINESS_EFFECT" },
    )],
  ] as const)("refuses a hostile %s", (_label, transform) => {
    const subject = transformedStore(transform);
    try {
      expectRefusal(
        recordDocumentWorkProposal(subject.store, input()),
        "DOCUMENT_WORK_DECISION_MISMATCH",
        "DURABLE_STORE",
      );
    } finally {
      subject.close();
    }
  });

  it("does not invoke an accessor on a hostile decision response", () => {
    let reads = 0;
    const subject = transformedStore((response) => {
      const hostile = { ...response };
      Object.defineProperty(hostile, "decision", {
        enumerable: true,
        get: () => {
          reads += 1;
          return response.decision;
        },
      });
      return hostile;
    });
    try {
      expectRefusal(
        recordDocumentWorkProposal(subject.store, input()),
        "DOCUMENT_WORK_DECISION_MISMATCH",
        "DURABLE_STORE",
      );
      expect(reads).toBe(0);
    } finally {
      subject.close();
    }
  });

  it("maps an OUTCOME_UNKNOWN store exception to an exact frozen refusal", () => {
    const store = {
      commitExpectedVersionDecision: (): never => {
        throw new DurableStoreError("OUTCOME_UNKNOWN", "commit result is ambiguous");
      },
    } as unknown as RecordStore;
    expectRefusal(
      recordDocumentWorkProposal(store, input()),
      "OUTCOME_UNKNOWN",
      "DURABLE_STORE",
    );
  });

  it("maps STORE_CLOSED from a real closed store", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    store.close();
    expectRefusal(
      recordDocumentWorkProposal(store, input()),
      "STORE_CLOSED",
      "DURABLE_STORE",
    );
  });

  it("does not flatten an unexpected non-store exception", () => {
    const failure = new Error("hostile double exploded");
    const store = {
      commitExpectedVersionDecision: (): never => { throw failure; },
    } as unknown as RecordStore;
    expect(() => recordDocumentWorkProposal(store, input())).toThrow(failure);
  });
});
