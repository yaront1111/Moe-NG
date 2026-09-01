import { createHash } from "node:crypto";

import {
  SOURCE_SNAPSHOT_VERSION,
  createSourceSnapshot,
  encodeSourceSnapshot,
} from "@moe/core";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import type { DeliveryV2AppendContext } from "./contracts.js";
import {
  DELIVERY_V2_SOURCE_SNAPSHOT_ADDRESS_DOMAIN,
  DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND,
  DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_ID_DOMAIN,
  DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE,
  appendDeliveryV2SourceSnapshot,
  deriveDeliveryV2SourceSnapshotAggregateId,
  deriveDeliveryV2SourceSnapshotEventId,
} from "./source-snapshot-persistence.js";

const PROJECT_ID = "project-source-snapshot";
const PRINCIPAL_ID = "principal:source-publisher";
const encoder = new TextEncoder();

const draft = () => Object.freeze({
  baseRevisionHash: "a".repeat(64),
  projectId: PROJECT_ID,
  repositoryBaseTree: "b".repeat(40),
  repositoryRef: "refs/heads/main",
  scopeRef: "packages/daemon",
});

const context = (commandId: string, expectedVersion = 0): DeliveryV2AppendContext =>
  Object.freeze({
    commandId,
    correlationId: `correlation:${commandId}`,
    decidedAt: "2026-09-01T10:00:00.000Z",
    expectedVersion,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
  });

function createdSnapshot() {
  const created = createSourceSnapshot(draft());
  if (!created.ok) throw new Error(`fixture refused: ${created.code}`);
  return created.snapshot;
}

function exactAddress(projectId: string, digest: string): string {
  const hash = createHash("sha256");
  for (const part of [DELIVERY_V2_SOURCE_SNAPSHOT_ADDRESS_DOMAIN, projectId, digest]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return `delivery-v2:source-snapshot:${hash.digest("hex")}`;
}

function exactEventId(projectId: string, principalId: string, commandId: string): string {
  const hash = createHash("sha256");
  for (const part of [
    DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_ID_DOMAIN, projectId, principalId, commandId,
  ]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return `delivery-v2:source-snapshot-event:${hash.digest("hex")}`;
}

const decisionOf = (store: SqliteEventStore, commandId: string) =>
  store.getCommandDecision({ commandId, principalId: PRINCIPAL_ID, projectId: PROJECT_ID });

describe("delivery-v2 SourceSnapshot persistence", () => {
  it("commits and replays one canonical immutable SourceSnapshot effect", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const request = context("source-snapshot-1");
    const expected = createdSnapshot();
    const encoded = encodeSourceSnapshot(expected);
    if (!encoded.ok) throw new Error(`fixture encoding refused: ${encoded.code}`);
    const aggregateId = exactAddress(PROJECT_ID, expected.sourceSnapshotDigest);
    const eventId = exactEventId(PROJECT_ID, PRINCIPAL_ID, request.commandId);

    expect(DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND)
      .toBe("delivery_v2.source_snapshot.commit");
    expect(DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE)
      .toBe("DeliveryV2SourceSnapshotCommitted");
    expect(deriveDeliveryV2SourceSnapshotEventId(
      PROJECT_ID, PRINCIPAL_ID, request.commandId,
    )).toBe(eventId);
    expect(deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, expected.sourceSnapshotDigest,
    )).toBe(aggregateId);
    expect(appendDeliveryV2SourceSnapshot(store, request, draft())).toEqual({
      bytes: encoded.bytes,
      disposition: "DECIDED",
      ok: true,
      ref: { projectId: PROJECT_ID, sourceSnapshotDigest: expected.sourceSnapshotDigest },
      snapshot: expected,
    });
    expect(appendDeliveryV2SourceSnapshot(store, {
      ...request,
      correlationId: "retry-correlation-is-proposal-only",
      decidedAt: "2026-09-01T11:00:00.000Z",
    }, draft())).toEqual({
      bytes: encoded.bytes,
      disposition: "REPLAYED",
      ok: true,
      ref: { projectId: PROJECT_ID, sourceSnapshotDigest: expected.sourceSnapshotDigest },
      snapshot: expected,
    });

    const event = store.readAggregateEvents(aggregateId, 0, 1).items[0];
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      aggregateId,
      aggregateSequence: 1,
      domainSchemaVersion: SOURCE_SNAPSHOT_VERSION,
      eventId,
      eventType: DELIVERY_V2_SOURCE_SNAPSHOT_EVENT_TYPE,
    });
    expect(event?.payload).toEqual(encoded.bytes);
    expect(event?.decisionTrace).toMatchObject({
      commandId: request.commandId,
      commandKind: DELIVERY_V2_SOURCE_SNAPSHOT_COMMAND_KIND,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    const decision = store.getCommandDecision({
      commandId: request.commandId,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    expect(decision?.resultBytes).toEqual(encoded.bytes);
    expect(decision?.businessEventIds).toEqual([eventId]);
  });

  it("scopes event identity across publishers sharing one raw command id", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const commandId = "shared-source-command";
    const secondPrincipal = "principal:source-publisher-two";
    const changedDraft = { ...draft(), scopeRef: "packages/core" };
    const first = createdSnapshot();
    const second = createSourceSnapshot(changedDraft);
    if (!second.ok) throw new Error(`second fixture refused: ${second.code}`);

    expect(appendDeliveryV2SourceSnapshot(store, context(commandId), draft()))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    expect(appendDeliveryV2SourceSnapshot(store, {
      ...context(commandId),
      principalId: secondPrincipal,
    }, changedDraft)).toMatchObject({ disposition: "DECIDED", ok: true });

    const firstEvent = store.readEvents(deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, first.sourceSnapshotDigest,
    ))[0];
    const secondEvent = store.readEvents(deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, second.snapshot.sourceSnapshotDigest,
    ))[0];
    expect(firstEvent?.eventId).toBe(exactEventId(PROJECT_ID, PRINCIPAL_ID, commandId));
    expect(secondEvent?.eventId).toBe(exactEventId(PROJECT_ID, secondPrincipal, commandId));
    expect(firstEvent?.eventId).not.toBe(secondEvent?.eventId);
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(2);
  });

  it("bounds the event identity for a valid maximum-size command id", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const commandId = "c".repeat(512);
    const request = {
      ...context(commandId),
      correlationId: "correlation:max-command-id",
    };
    const snapshot = createdSnapshot();
    expect(appendDeliveryV2SourceSnapshot(store, request, draft()))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    const event = store.readEvents(deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, snapshot.sourceSnapshotDigest,
    ))[0];
    expect(event?.eventId).toBe(exactEventId(PROJECT_ID, PRINCIPAL_ID, commandId));
    expect(Buffer.byteLength(event?.eventId ?? "", "utf8")).toBeLessThanOrEqual(512);
  });

  it("refuses changed bytes under the same scoped command key without residue", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const request = context("source-snapshot-idempotency");
    const initial = createdSnapshot();
    const changedDraft = { ...draft(), scopeRef: "packages/core" };
    const changed = createSourceSnapshot(changedDraft);
    if (!changed.ok) throw new Error(`changed fixture refused: ${changed.code}`);
    const initialAggregateId = deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, initial.sourceSnapshotDigest,
    );
    const changedAggregateId = deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, changed.snapshot.sourceSnapshotDigest,
    );

    expect(appendDeliveryV2SourceSnapshot(store, request, draft()))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    const decisionBefore = store.getCommandDecision({
      commandId: request.commandId,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    });
    expect(appendDeliveryV2SourceSnapshot(store, request, changedDraft)).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      layer: "DURABLE_STORE",
      ok: false,
    });
    expect(store.readEvents(initialAggregateId)).toHaveLength(1);
    expect(store.readEvents(changedAggregateId)).toHaveLength(0);
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(1);
    expect(store.getCommandDecision({
      commandId: request.commandId,
      principalId: PRINCIPAL_ID,
      projectId: PROJECT_ID,
    })).toEqual(decisionBefore);
  });

  it("preserves core draft refusals without writing", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    expect(appendDeliveryV2SourceSnapshot(store, context("malformed"), {
      ...draft(),
      baseRevisionHash: "not-a-revision",
    })).toEqual({
      code: "SOURCE_SNAPSHOT_MALFORMED",
      layer: "SOURCE_SNAPSHOT_ADMISSION",
      ok: false,
    });
    expect(appendDeliveryV2SourceSnapshot(store, context("full-snapshot"),
      createdSnapshot())).toEqual({
      code: "SOURCE_SNAPSHOT_MALFORMED",
      layer: "SOURCE_SNAPSHOT_ADMISSION",
      ok: false,
    });
    expect(decisionOf(store, "malformed")).toBeNull();
    expect(decisionOf(store, "full-snapshot")).toBeNull();
  });

  it("refuses mismatched projects, nonzero versions, and malformed contexts", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const persistenceRefusal = {
      code: "DELIVERY_V2_INPUT_INVALID",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    } as const;
    expect(appendDeliveryV2SourceSnapshot(store, context("project-mismatch"), {
      ...draft(), projectId: "other-project",
    })).toEqual(persistenceRefusal);
    expect(appendDeliveryV2SourceSnapshot(
      store, context("nonzero-version", 1), draft(),
    )).toEqual(persistenceRefusal);
    expect(appendDeliveryV2SourceSnapshot(store, {
      ...context("negative-zero"), expectedVersion: -0,
    }, draft())).toEqual(persistenceRefusal);
    expect(appendDeliveryV2SourceSnapshot(store, {
      ...context("empty-principal"), principalId: "",
    }, draft())).toEqual(persistenceRefusal);
    expect(appendDeliveryV2SourceSnapshot(store, {
      ...context("extra-context"), extra: true,
    } as never, draft())).toEqual(persistenceRefusal);
    expect(appendDeliveryV2SourceSnapshot(store, {
      ...context("overbound-principal"), principalId: "p".repeat(513),
    }, draft())).toEqual(persistenceRefusal);
    for (const invalidContext of [
      { ...context("overbound-command"), commandId: "c".repeat(513) },
      { ...context("nul-correlation"), correlationId: "correlation\0invalid" },
      { ...context("ill-formed-principal"), principalId: "\ud800" },
      { ...context("invalid-time"), decidedAt: "2026-09-01" },
    ]) {
      expect(appendDeliveryV2SourceSnapshot(store, invalidContext, draft()))
        .toEqual(persistenceRefusal);
    }
    for (const commandId of [
      "project-mismatch", "nonzero-version", "negative-zero", "empty-principal", "extra-context",
    ]) expect(decisionOf(store, commandId)).toBeNull();
    expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(0);
  });

  it("does not invoke hostile context or draft accessors", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    let reads = 0;
    const hostileContext = new Proxy(context("hostile-context"), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(appendDeliveryV2SourceSnapshot(store, hostileContext, draft())).toEqual({
      code: "DELIVERY_V2_INPUT_INVALID",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });
    expect(reads).toBe(0);

    const hostileDraft = { ...draft() };
    Object.defineProperty(hostileDraft, "projectId", {
      enumerable: true,
      get() {
        reads += 1;
        return PROJECT_ID;
      },
    });
    expect(appendDeliveryV2SourceSnapshot(
      store, context("hostile-draft"), hostileDraft,
    )).toEqual({
      code: "SOURCE_SNAPSHOT_MALFORMED",
      layer: "SOURCE_SNAPSHOT_ADMISSION",
      ok: false,
    });
    expect(reads).toBe(0);
  });

  it("preserves durable-store conflicts and errors", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    expect(appendDeliveryV2SourceSnapshot(store, context("first"), draft()))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    expect(appendDeliveryV2SourceSnapshot(store, context("second"), draft())).toEqual({
      code: "EXPECTED_VERSION_CONFLICT",
      layer: "DURABLE_STORE",
      ok: false,
    });
    const closed = {
      commitExpectedVersionDecisionLegs: () => {
        throw new DurableStoreError("STORE_CLOSED", "closed by test");
      },
    } as unknown as SqliteEventStore;
    expect(appendDeliveryV2SourceSnapshot(closed, context("closed"), draft())).toEqual({
      code: "STORE_CLOSED",
      layer: "DURABLE_STORE",
      ok: false,
    });
    const degraded = {
      commitExpectedVersionDecisionLegs: () => {
        throw new Error("unavailable by test");
      },
    } as unknown as SqliteEventStore;
    expect(appendDeliveryV2SourceSnapshot(degraded, context("degraded"), draft())).toEqual({
      code: "STORAGE_DEGRADED",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });
  });

  it("refuses fabricated commit dispositions and unreadable provenance", () => {
    const dispositionStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const fabricatedDisposition = Object.freeze({
      commitExpectedVersionDecisionLegs: (
        input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0],
      ) => Object.freeze({
        ...dispositionStore.commitExpectedVersionDecisionLegs(input),
        disposition: "COMMITTED",
      }),
      getCommandDecision: dispositionStore.getCommandDecision.bind(dispositionStore),
      getCommandReceipt: dispositionStore.getCommandReceipt.bind(dispositionStore),
      readAggregateEvents: dispositionStore.readAggregateEvents.bind(dispositionStore),
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2SourceSnapshot(
      fabricatedDisposition, context("fabricated-disposition"), draft(),
    )).toEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });

    const provenanceStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const fabricatedProvenance = Object.freeze({
      commitExpectedVersionDecisionLegs:
        provenanceStore.commitExpectedVersionDecisionLegs.bind(provenanceStore),
      getCommandDecision: provenanceStore.getCommandDecision.bind(provenanceStore),
      getCommandReceipt: provenanceStore.getCommandReceipt.bind(provenanceStore),
      readAggregateEvents: (
        aggregateId: string,
        afterAggregateSequence?: number,
        limit?: number,
        maxDecodedBytes?: number,
      ) => {
        const page = provenanceStore.readAggregateEvents(
          aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
        );
        return Object.freeze({
          ...page,
          items: Object.freeze(page.items.map((event) => Object.freeze({
            ...event,
            eventId: `${event.eventId}:fabricated`,
          }))),
        });
      },
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2SourceSnapshot(
      fabricatedProvenance, context("fabricated-provenance"), draft(),
    )).toEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });

    const extraEventStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const fabricatedExtraEvent = Object.freeze({
      commitExpectedVersionDecisionLegs:
        extraEventStore.commitExpectedVersionDecisionLegs.bind(extraEventStore),
      getCommandDecision: extraEventStore.getCommandDecision.bind(extraEventStore),
      getCommandReceipt: extraEventStore.getCommandReceipt.bind(extraEventStore),
      readAggregateEvents: (
        aggregateId: string,
        afterAggregateSequence?: number,
        limit?: number,
        maxDecodedBytes?: number,
      ) => {
        const page = extraEventStore.readAggregateEvents(
          aggregateId, afterAggregateSequence, limit, maxDecodedBytes,
        );
        const first = page.items[0];
        return first === undefined ? page : Object.freeze({
          ...page,
          items: Object.freeze([
            first,
            Object.freeze({
              ...first,
              aggregateSequence: 2,
              eventId: `${first.eventId}:fabricated-extra`,
            }),
          ]),
        });
      },
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2SourceSnapshot(
      fabricatedExtraEvent, context("fabricated-extra-event"), draft(),
    )).toEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });

    const substitutedContextStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const substitutedContext = Object.freeze({
      commitExpectedVersionDecisionLegs: (
        input: Parameters<SqliteEventStore["commitExpectedVersionDecisionLegs"]>[0],
      ) => substitutedContextStore.commitExpectedVersionDecisionLegs({
        ...input,
        correlationId: "fabricated-correlation",
        decidedAt: "2026-09-01T12:00:00.000Z",
      }),
      getCommandDecision: substitutedContextStore.getCommandDecision.bind(substitutedContextStore),
      getCommandReceipt: substitutedContextStore.getCommandReceipt.bind(substitutedContextStore),
      readAggregateEvents: substitutedContextStore.readAggregateEvents.bind(
        substitutedContextStore,
      ),
    }) as unknown as SqliteEventStore;
    expect(appendDeliveryV2SourceSnapshot(
      substitutedContext, context("fabricated-submitted-context"), draft(),
    )).toEqual({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: "DAEMON_DELIVERY_V2_PERSISTENCE",
      ok: false,
    });
  });

  it("does not confuse the canonical snapshot bytes with caller-controlled bytes", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
    const mutable = { ...draft(), scopeRef: "packages/daemon" as string };
    const result = appendDeliveryV2SourceSnapshot(store, context("detached"), mutable);
    mutable.scopeRef = "mutated-after-call";
    const snapshot = createdSnapshot();
    const bytes = encodeSourceSnapshot(snapshot);
    if (!bytes.ok) throw new Error(`fixture encoding refused: ${bytes.code}`);
    expect(result).toEqual({
      bytes: bytes.bytes,
      disposition: "DECIDED",
      ok: true,
      ref: { projectId: PROJECT_ID, sourceSnapshotDigest: snapshot.sourceSnapshotDigest },
      snapshot,
    });
    if (!result.ok) throw new Error(`unexpected refusal: ${result.code}`);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ref)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    result.bytes[0] = 0;
    const event = store.readAggregateEvents(deriveDeliveryV2SourceSnapshotAggregateId(
      PROJECT_ID, snapshot.sourceSnapshotDigest,
    ), 0, 1).items[0];
    expect(event?.payload).toEqual(bytes.bytes);
    expect(new TextDecoder().decode(event?.payload ?? encoder.encode("")))
      .not.toContain("mutated-after-call");
  });
});
