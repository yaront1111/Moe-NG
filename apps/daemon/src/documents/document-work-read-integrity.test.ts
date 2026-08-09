import { DurableStoreError, SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord, CursorPage, StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  documentWorkAggregateId,
  readLatestDocumentWorkDossier,
  recordDocumentWorkProposal,
} from "./document-work-service.js";
import {
  PROJECT_ID,
  appendRawEvent,
  expectRefusal,
  input,
} from "./document-work-service-test-fixtures.js";

type ReadStore = Parameters<typeof readLatestDocumentWorkDossier>[0];

function transformedStore(options: {
  readonly decision?: (value: CommandDecisionRecord | null) => unknown;
  readonly event?: (value: StoredEvent) => unknown;
}): { readonly close: () => void; readonly store: ReadStore } {
  const real = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  recordDocumentWorkProposal(real, input());
  return {
    close: () => real.close(),
    store: {
      commitExpectedVersionDecision: real.commitExpectedVersionDecision.bind(real),
      getAggregateVersion: real.getAggregateVersion.bind(real),
      getCommandDecision: (key: Parameters<ReadStore["getCommandDecision"]>[0]) =>
        options.decision?.(real.getCommandDecision(key))
        ?? real.getCommandDecision(key),
      readAggregateEvents: (
        aggregateId: string,
        afterSequence: number,
        limit: number,
        maxBytes?: number,
      ) => {
        const page = real.readAggregateEvents(aggregateId, afterSequence, limit, maxBytes);
        return {
          ...page,
          items: page.items.map((event) => options.event?.(event) ?? event),
        } as unknown as CursorPage<StoredEvent, number>;
      },
    } as unknown as ReadStore,
  };
}

describe("document-work dossier decision binding", () => {
  it("rejects a raw valid-payload event without a scoped decision", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    try {
      appendRawEvent(store);
      expectRefusal(
        readLatestDocumentWorkDossier(store, PROJECT_ID),
        "DOCUMENT_WORK_DOSSIER_DECISION_MISMATCH",
        "DAEMON_READ_MODEL",
      );
    } finally {
      store.close();
    }
  });

  it.each([
    ["command kind", (event: StoredEvent) => ({
      ...event, decisionTrace: { ...event.decisionTrace!, commandKind: "goal.create" },
    })],
    ["request hash", (event: StoredEvent) => ({
      ...event, decisionTrace: { ...event.decisionTrace!, requestSha256: "f".repeat(64) },
    })],
    ["command identity", (event: StoredEvent) => ({
      ...event, decisionTrace: { ...event.decisionTrace!, commandId: "forged-command" },
    })],
    ["project identity", (event: StoredEvent) => ({
      ...event, decisionTrace: { ...event.decisionTrace!, projectId: "other-project" },
    })],
    ["event identity", (event: StoredEvent) => ({ ...event, eventId: "forged-event" })],
    ["aggregate identity", (event: StoredEvent) => ({
      ...event, aggregateId: documentWorkAggregateId("other-project"),
    })],
  ] as const)("rejects a forged tail %s", (_label, event) => {
    const subject = transformedStore({ event });
    try {
      expectRefusal(
        readLatestDocumentWorkDossier(subject.store, PROJECT_ID),
        "DOCUMENT_WORK_DOSSIER_DECISION_MISMATCH",
        "DAEMON_READ_MODEL",
      );
    } finally {
      subject.close();
    }
  });

  it("rejects a loaded decision that no longer matches its event", () => {
    const subject = transformedStore({
      decision: (value) => value === null ? null : {
        ...value,
        businessEventIds: ["forged-event"],
      },
    });
    try {
      expectRefusal(
        readLatestDocumentWorkDossier(subject.store, PROJECT_ID),
        "DOCUMENT_WORK_DOSSIER_DECISION_MISMATCH",
        "DAEMON_READ_MODEL",
      );
    } finally {
      subject.close();
    }
  });

  it("maps durable read failures without flattening unexpected exceptions", () => {
    const durable = transformedStore({});
    const unavailable = {
      ...durable.store,
      getAggregateVersion: (): never => {
        throw new DurableStoreError("OUTCOME_UNKNOWN", "tail is ambiguous");
      },
    } as ReadStore;
    try {
      expectRefusal(
        readLatestDocumentWorkDossier(unavailable, PROJECT_ID),
        "OUTCOME_UNKNOWN",
        "DURABLE_STORE",
      );
      const failure = new Error("hostile read exploded");
      const hostile = {
        ...durable.store,
        getAggregateVersion: (): never => { throw failure; },
      } as ReadStore;
      expect(() => readLatestDocumentWorkDossier(hostile, PROJECT_ID)).toThrow(failure);
    } finally {
      durable.close();
    }
  });

  it("maps STORE_CLOSED from a real closed store", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    store.close();
    expectRefusal(
      readLatestDocumentWorkDossier(store, PROJECT_ID),
      "STORE_CLOSED",
      "DURABLE_STORE",
    );
  });
});
