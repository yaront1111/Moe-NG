import { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { recordDocumentWorkProposal } from "./document-work-service.js";
import {
  PROJECT_ID,
  bytes,
  expectRefusal,
  input,
  proposal,
} from "./document-work-service-test-fixtures.js";

type RecordInput = Parameters<typeof recordDocumentWorkProposal>[1];

function expectIngressRefusal(value: unknown): void {
  const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  try {
    expectRefusal(
      recordDocumentWorkProposal(store, value as RecordInput),
      "DOCUMENT_WORK_SERVICE_INPUT_INVALID",
      "DAEMON_INGRESS",
    );
    expect(store.readEventsAfter(0n).items).toStrictEqual([]);
    expect(store.readCommandDecisionsAfter(0n).items).toStrictEqual([]);
  } finally {
    store.close();
  }
}

describe("document-work record ingress snapshot", () => {
  it("refuses missing, extra, symbol and non-enumerable fields", () => {
    const { projectId: _missing, ...missing } = input();
    expectIngressRefusal(missing);
    expectIngressRefusal({ ...input(), extra: true });

    const symbol = { ...input() } as Record<string | symbol, unknown>;
    symbol[Symbol("extra")] = true;
    expectIngressRefusal(symbol);

    const hidden = { ...input() };
    Object.defineProperty(hidden, "commandId", {
      enumerable: false,
      value: hidden.commandId,
    });
    expectIngressRefusal(hidden);
  });

  it("refuses a proposal accessor without invoking it", () => {
    let reads = 0;
    const hostile = { ...input() };
    Object.defineProperty(hostile, "proposalBytes", {
      enumerable: true,
      get: () => {
        reads += 1;
        return bytes(proposal());
      },
    });

    expectIngressRefusal(hostile);
    expect(reads).toBe(0);
  });

  it("refuses an identity accessor without invoking it", () => {
    let reads = 0;
    const hostile = { ...input() };
    Object.defineProperty(hostile, "commandId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "document-command-1" : "document-command-2";
      },
    });

    expectIngressRefusal(hostile);
    expect(reads).toBe(0);
  });

  it("refuses a proxy without invoking any trap", () => {
    let traps = 0;
    const hostile = new Proxy(input(), {
      get: () => {
        traps += 1;
        throw new Error("proxy get trap must not execute");
      },
      getOwnPropertyDescriptor: () => {
        traps += 1;
        throw new Error("proxy descriptor trap must not execute");
      },
      ownKeys: () => {
        traps += 1;
        throw new Error("proxy ownKeys trap must not execute");
      },
    });

    expectIngressRefusal(hostile);
    expect(traps).toBe(0);
  });

  it("copies accepted proposal bytes before a hostile store can mutate caller memory", () => {
    const raw = bytes(proposal());
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    let detached = false;
    const hostileStore = {
      commitExpectedVersionDecision: (
        commit: Parameters<typeof store.commitExpectedVersionDecision>[0],
      ) => {
        detached = commit.requestBytes !== raw;
        raw.fill(0);
        return store.commitExpectedVersionDecision(commit);
      },
      getAggregateVersion: store.getAggregateVersion.bind(store),
      getCommandDecision: store.getCommandDecision.bind(store),
      readAggregateEvents: store.readAggregateEvents.bind(store),
    };
    try {
      const result = recordDocumentWorkProposal(
        hostileStore as unknown as SqliteEventStore,
        input(raw),
      );
      expect(detached).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      store.close();
    }
  });
});
