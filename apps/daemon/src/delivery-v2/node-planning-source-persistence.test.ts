import { createAcceptanceCriterionContent, createPlanExecutionContent } from "@moe/core";
import { NODE_AUTHORITY_LIMITS } from "@moe/scheduler";
import { DurableStoreError, SqliteEventStore, type StoredEvent } from "@moe/store";
import { describe, expect, it } from "vitest";

import type { DeliveryV2AppendContext } from "./contracts.js";
import {
  DELIVERY_V2_NODE_PLANNING_SOURCE_COMMAND_KIND,
  DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_TYPE,
  appendDeliveryV2NodePlanningSource,
  deriveDeliveryV2NodePlanningSourceAggregateId,
  deriveDeliveryV2NodePlanningSourceEventId,
} from "./node-planning-source-persistence.js";
import {
  readDeliveryV2AuthoredNodePlanningSource,
  readDeliveryV2NodePlanningSource,
} from "./node-planning-source-reader.js";
import {
  DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
  createDeliveryV2NodePlanningSourceRecord,
  encodeDeliveryV2NodePlanningSourceRecord,
} from "./node-planning-source-record.js";

const PROJECT = "project-node-planning-source";
const PRINCIPAL = "principal:planning-agent-a";
const OTHER_PRINCIPAL = "principal:planning-agent-b";
const hex = (digit: string): string => digit.repeat(64);

function source(description = "Implement the compiler-selected node.") {
  const plan = createPlanExecutionContent({
    affectedCriterionIds: ["criterion-a"],
    affectedNodeIds: ["node-a"],
    steps: [{ description, kind: "IMPLEMENTATION", stepId: "step-a" }],
    verificationRecipeRefs: ["recipe-a"],
  });
  const acceptance = createAcceptanceCriterionContent({
    nodeKind: "LEAF",
    obligations: [{
      criterionId: "criterion-a",
      evidenceRequirements: [{
        evidenceRef: "evidence-a", kind: "ARTIFACT", requirementId: "requirement-a",
      }],
      statement: "The node satisfies criterion A.",
      verificationRecipeRefs: ["recipe-a"],
    }],
  });
  if (!plan.ok || !acceptance.ok) throw new Error("planning-source fixture refused");
  return Object.freeze({
    acceptanceCriterionContent: acceptance.content,
    directHardDependencies: [],
    planExecutionContent: plan.content,
    predicateRegistry: [],
  });
}

function record(principalId = PRINCIPAL, value: unknown = source()) {
  const created = createDeliveryV2NodePlanningSourceRecord(principalId, value);
  if (!created.ok) throw new Error(created.issues.map(
    ({ code, layer }) => `${code}@${layer}`,
  ).join(","));
  return created.record;
}

function bytesOf(principalId = PRINCIPAL, value: unknown = source()): Uint8Array {
  const encoded = encodeDeliveryV2NodePlanningSourceRecord(record(principalId, value));
  if (!encoded.ok) throw new Error(encoded.issues.map(
    ({ code, layer }) => `${code}@${layer}`,
  ).join(","));
  return encoded.bytes;
}

function context(
  commandId: string, principalId = PRINCIPAL, expectedVersion = 0,
): DeliveryV2AppendContext {
  return Object.freeze({
    commandId,
    correlationId: `correlation:${commandId}`,
    decidedAt: "2026-09-01T15:00:00.000Z",
    expectedVersion,
    principalId,
    projectId: PROJECT,
  });
}

type ReaderStoreSurface = Pick<
  SqliteEventStore,
  "getCommandDecision" | "getCommandReceipt" | "readAggregateEvents"
>;

function storeView(
  store: SqliteEventStore,
  overrides: Partial<ReaderStoreSurface> = {},
): SqliteEventStore {
  return Object.freeze({
    getCommandDecision: overrides.getCommandDecision
      ?? store.getCommandDecision.bind(store),
    getCommandReceipt: overrides.getCommandReceipt
      ?? store.getCommandReceipt.bind(store),
    readAggregateEvents: overrides.readAggregateEvents
      ?? store.readAggregateEvents.bind(store),
  }) as unknown as SqliteEventStore;
}

function mapEvents(
  store: SqliteEventStore, map: (event: StoredEvent) => StoredEvent,
): SqliteEventStore {
  return storeView(store, {
    readAggregateEvents: (aggregateId: string, afterSequence: number, limit: number,
      maxBytes?: number) => {
      const page = store.readAggregateEvents(aggregateId, afterSequence, limit, maxBytes);
      return Object.freeze({ ...page, items: Object.freeze(page.items.map(map)) });
    },
  });
}

describe("delivery-v2 authored NodePlanningSource persistence", () => {
  it("commits and replays one inert record with exact content and provenance identities", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const request = context("node-planning-source-1");
    const expected = record();
    const bytes = bytesOf();
    const aggregateId = "delivery-v2:node-planning-source:"
      + "0822e6dd2a484164e8c8088af1c2ae27beb8008d7fb36d236172fdeeac301588";
    const eventId = "delivery-v2:node-planning-source-event:"
      + "00f554cec5a5ca745b48a67bdbd5f1af501337ba913d34d13d956829362033bb";

    expect(expected.sourceDigest)
      .toBe("a217cb030ffc88492c1834dab62f60e1ee85131ea6cc2f036a0dddecf2582c5a");
    expect(expected.revisionDigest)
      .toBe("a5ac1df080253895742ceb6f05481568a3853616f3cf06ebac40779c1604b575");
    expect(bytes).toHaveLength(945);
    expect(deriveDeliveryV2NodePlanningSourceAggregateId(PROJECT, expected.revisionDigest))
      .toBe(aggregateId);
    expect(deriveDeliveryV2NodePlanningSourceEventId(PROJECT, PRINCIPAL, request.commandId))
      .toBe(eventId);
    expect(appendDeliveryV2NodePlanningSource(store, request, source())).toStrictEqual({
      bytes,
      disposition: "DECIDED",
      ok: true,
      record: expected,
      ref: {
        nodeKey: "node-a", projectId: PROJECT,
        revisionDigest: expected.revisionDigest, sourceDigest: expected.sourceDigest,
      },
    });
    expect(appendDeliveryV2NodePlanningSource(store, {
      ...request,
      correlationId: "correlation:retry-proposal-only",
      decidedAt: "2026-09-01T16:00:00.000Z",
    }, source())).toMatchObject({ disposition: "REPLAYED", ok: true });

    const page = store.readAggregateEvents(aggregateId, 0, 2);
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      aggregateId,
      aggregateSequence: 1,
      domainSchemaVersion: DELIVERY_V2_NODE_PLANNING_SOURCE_VERSION,
      eventId,
      eventType: DELIVERY_V2_NODE_PLANNING_SOURCE_EVENT_TYPE,
      payload: bytes,
    });
    expect(page.items[0]?.decisionTrace).toMatchObject({
      commandId: request.commandId,
      commandKind: DELIVERY_V2_NODE_PLANNING_SOURCE_COMMAND_KIND,
      principalId: PRINCIPAL,
      projectId: PROJECT,
    });
  });

  it("binds identical planner content to its authenticated author", () => {
    const first = record(PRINCIPAL);
    const second = record(OTHER_PRINCIPAL);
    expect(first.sourceDigest).toBe(second.sourceDigest);
    expect(first.revisionDigest).not.toBe(second.revisionDigest);
    // Payload bytes remain the Scheduler codec's exact content bytes; author identity is bound by
    // the distinct revision address and the authenticated event provenance, not a reserialization.
    expect(bytesOf(PRINCIPAL)).toStrictEqual(bytesOf(OTHER_PRINCIPAL));

    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(appendDeliveryV2NodePlanningSource(
      store, context("source-author-a", PRINCIPAL), source(),
    )).toMatchObject({ ok: true, record: { authorRef: PRINCIPAL } });
    expect(appendDeliveryV2NodePlanningSource(
      store, context("source-author-b", OTHER_PRINCIPAL), source(),
    )).toMatchObject({ ok: true, record: { authorRef: OTHER_PRINCIPAL } });
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(2);
  });

  it("refuses malformed context and source before any durable effect", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(appendDeliveryV2NodePlanningSource(
      store, context("bad-version", PRINCIPAL, 1), source(),
    )).toEqual({ code: "DELIVERY_V2_INPUT_INVALID", layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false });
    expect(appendDeliveryV2NodePlanningSource(
      store, context("bad-source"), { ...source(), graphId: "caller-graph" },
    )).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_MALFORMED",
        layer: "NODE_PLANNING_SOURCE_ADMISSION",
      }],
      ok: false,
    });
    const noncanonicalNode = structuredClone(source()) as any;
    noncanonicalNode.planExecutionContent.affectedNodeIds = [" node-a "];
    expect(appendDeliveryV2NodePlanningSource(
      store, context("bad-node"), noncanonicalNode,
    )).toMatchObject({
      issues: [{
        code: "NODE_PLANNING_SOURCE_NODE_ROSTER_INVALID",
        layer: "NODE_PLANNING_SOURCE_ADMISSION",
      }],
      ok: false,
    });
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(0);
  });

  it("rejects changed source under one command identity without residue", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const request = context("node-source-idempotency");
    const first = appendDeliveryV2NodePlanningSource(store, request, source());
    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
    const secondRecord = record(PRINCIPAL, source("Implement a changed node plan."));
    expect(appendDeliveryV2NodePlanningSource(
      store, request, source("Implement a changed node plan."),
    )).toEqual({ code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE", ok: false });
    expect(store.readEvents(deriveDeliveryV2NodePlanningSourceAggregateId(
      PROJECT, secondRecord.revisionDigest,
    ))).toHaveLength(0);
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(1);
  });

  it("forwards durable-store failures without appending a decision", () => {
    const degraded = Object.freeze({
      commitExpectedVersionDecisionLegs: () => {
        throw new DurableStoreError("STORE_BUSY", "busy");
      },
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2NodePlanningSource(
      degraded, context("node-source-degraded"), source(),
    )).toEqual({ code: "STORE_BUSY", layer: "DURABLE_STORE", ok: false });
  });
});

describe("delivery-v2 authored NodePlanningSource reader", () => {
  function seeded() {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const appended = appendDeliveryV2NodePlanningSource(
      store, context("node-source-read"), source(),
    );
    if (!appended.ok) throw new Error("code" in appended
      ? `${appended.code}@${appended.layer}`
      : appended.issues.map(({ code, layer }) => `${code}@${layer}`).join(","));
    return { appended, store };
  }

  it("authenticates historical authorship from one explicit immutable ref", () => {
    const { appended, store } = seeded();
    const read = readDeliveryV2AuthoredNodePlanningSource(store, appended.ref);
    expect(read).toStrictEqual({ ok: true, record: appended.record });
  });

  it("supports explicit publisher authentication without selecting a current source", () => {
    const { appended, store } = seeded();
    expect(readDeliveryV2NodePlanningSource(store, appended.ref, PRINCIPAL))
      .toStrictEqual({ ok: true, record: appended.record });
    expect(readDeliveryV2NodePlanningSource(store, appended.ref, OTHER_PRINCIPAL))
      .toEqual({ code: "DELIVERY_V2_MATERIAL_UNREADABLE",
        layer: "DAEMON_DELIVERY_V2_READER", ok: false });
  });

  it.each([
    ["project", (ref: any) => { ref.projectId = "project-foreign"; },
      "DELIVERY_V2_MATERIAL_ABSENT"],
    ["node", (ref: any) => { ref.nodeKey = "node-foreign"; },
      "DELIVERY_V2_MATERIAL_REF_MISMATCH"],
    ["source digest", (ref: any) => { ref.sourceDigest = hex("a"); },
      "DELIVERY_V2_MATERIAL_DIGEST_MISMATCH"],
    ["revision digest", (ref: any) => { ref.revisionDigest = hex("b"); },
      "DELIVERY_V2_MATERIAL_ABSENT"],
  ])("refuses a wrong %s ref", (_name, mutate, code) => {
    const { appended, store } = seeded();
    const ref = structuredClone(appended.ref);
    mutate(ref);
    expect(readDeliveryV2AuthoredNodePlanningSource(store, ref)).toEqual({
      code, layer: "DAEMON_DELIVERY_V2_READER", ok: false,
    });
  });

  it("refuses substituted bytes and event provenance", () => {
    const { appended, store } = seeded();
    const changed = bytesOf(PRINCIPAL, source("Substitute a different source."));
    const payloadView = mapEvents(store, (event) => Object.freeze({ ...event, payload: changed }));
    expect(readDeliveryV2AuthoredNodePlanningSource(payloadView, appended.ref)).toEqual({
      code: "DELIVERY_V2_MATERIAL_DIGEST_MISMATCH",
      layer: "DAEMON_DELIVERY_V2_READER", ok: false,
    });
    const typeView = mapEvents(store, (event) => Object.freeze({
      ...event, eventType: "ForeignNodePlanningSourceCommitted",
    }));
    expect(readDeliveryV2AuthoredNodePlanningSource(typeView, appended.ref)).toEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_READER", ok: false,
    });
  });

  it.each([
    ["aggregate sequence", (event: StoredEvent) => Object.freeze({
      ...event, aggregateSequence: 2,
    }), "DELIVERY_V2_MATERIAL_UNREADABLE"],
    ["domain version", (event: StoredEvent) => Object.freeze({
      ...event, domainSchemaVersion: "moe-planner-authored-node-planning-source/999",
    }), "DELIVERY_V2_MATERIAL_UNREADABLE"],
    ["event id", (event: StoredEvent) => Object.freeze({
      ...event, eventId: `${event.eventId}:forged`,
    }), "DELIVERY_V2_MATERIAL_UNREADABLE"],
    ["trace command kind", (event: StoredEvent) => event.decisionTrace === undefined
      ? event : Object.freeze({ ...event, decisionTrace: Object.freeze({
        ...event.decisionTrace, commandKind: "delivery_v2.node_planning_source.forged",
      }) }), "DELIVERY_V2_MATERIAL_UNREADABLE"],
    ["trace principal", (event: StoredEvent) => event.decisionTrace === undefined
      ? event : Object.freeze({ ...event, decisionTrace: Object.freeze({
        ...event.decisionTrace, principalId: OTHER_PRINCIPAL,
      }) }), "DELIVERY_V2_MATERIAL_UNREADABLE"],
    ["trace command id", (event: StoredEvent) => event.decisionTrace === undefined
      ? event : Object.freeze({ ...event, decisionTrace: Object.freeze({
        ...event.decisionTrace, commandId: "node-source-forged-command",
      }) }), "DELIVERY_V2_MATERIAL_UNREADABLE"],
    ["trace project", (event: StoredEvent) => event.decisionTrace === undefined
      ? event : Object.freeze({ ...event, decisionTrace: Object.freeze({
        ...event.decisionTrace, projectId: "project-forged",
      }) }), "DELIVERY_V2_MATERIAL_PROJECT_MISMATCH"],
  ] as const)("refuses %s corruption at the reader fence", (_name, mutate, code) => {
    const { appended, store } = seeded();
    expect(readDeliveryV2AuthoredNodePlanningSource(
      mapEvents(store, mutate), appended.ref,
    )).toEqual({ code, layer: "DAEMON_DELIVERY_V2_READER", ok: false });
  });

  it("refuses duplicate event cardinality instead of selecting one event", () => {
    const { appended, store } = seeded();
    const duplicate = storeView(store, {
      readAggregateEvents: (...args) => {
        const page = store.readAggregateEvents(...args);
        const event = page.items[0];
        if (event === undefined) return page;
        return Object.freeze({ ...page, items: Object.freeze([event, event]) }) as typeof page;
      },
    });
    expect(readDeliveryV2AuthoredNodePlanningSource(duplicate, appended.ref)).toEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_READER",
      ok: false,
    });
  });

  it("refuses missing or corrupted decision and receipt provenance", () => {
    const cases = [
      (store: SqliteEventStore) => storeView(store, { getCommandDecision: () => null }),
      (store: SqliteEventStore) => storeView(store, { getCommandReceipt: () => null }),
      (store: SqliteEventStore) => storeView(store, {
        getCommandDecision: (key) => {
          const decision = store.getCommandDecision(key);
          return decision === null ? null : Object.freeze({
            ...decision, recordVersion: "forged-decision-version",
          }) as unknown as typeof decision;
        },
      }),
      (store: SqliteEventStore) => storeView(store, {
        getCommandReceipt: (commandId) => {
          const receipt = store.getCommandReceipt(commandId);
          return receipt === null ? null : Object.freeze({
            ...receipt, effectSha256: hex("f"),
          }) as typeof receipt;
        },
      }),
    ];
    expect(cases).toHaveLength(4);
    for (const view of cases) {
      const { appended, store } = seeded();
      expect(readDeliveryV2AuthoredNodePlanningSource(view(store), appended.ref)).toEqual({
        code: "DELIVERY_V2_MATERIAL_UNREADABLE",
        layer: "DAEMON_DELIVERY_V2_READER",
        ok: false,
      });
    }
  });

  it("reads each durable provenance surface exactly once", () => {
    const { appended, store } = seeded();
    const reads = { decision: 0, events: 0, receipt: 0 };
    let decodedByteLimit: number | undefined;
    const inspected = storeView(store, {
      getCommandDecision: (key) => {
        reads.decision += 1;
        return store.getCommandDecision(key);
      },
      getCommandReceipt: (commandId) => {
        reads.receipt += 1;
        return store.getCommandReceipt(commandId);
      },
      readAggregateEvents: (...args) => {
        reads.events += 1;
        decodedByteLimit = args[3];
        return store.readAggregateEvents(...args);
      },
    });
    expect(readDeliveryV2AuthoredNodePlanningSource(inspected, appended.ref))
      .toStrictEqual({ ok: true, record: appended.record });
    expect(reads).toStrictEqual({ decision: 1, events: 1, receipt: 1 });
    expect(decodedByteLimit).toBe(NODE_AUTHORITY_LIMITS.maxBytes + 65_536);
  });
});
