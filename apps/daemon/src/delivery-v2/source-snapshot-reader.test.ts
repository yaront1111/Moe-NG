import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPABILITY_CATALOG_LIMITS,
  SOURCE_SNAPSHOT_VERSION,
  createSourceSnapshot,
  encodeSourceSnapshot,
  type SourceSnapshot,
  type SourceSnapshotDraft,
  type SourceSnapshotRef,
} from "@moe/core";
import {
  DurableStoreError,
  SqliteEventStore,
  type CommandDecisionRecord,
  type CommandReceipt,
  type StoredEvent,
} from "@moe/store";
import { describe, expect, it } from "vitest";

import { deliveryV2Digest } from "./addresses.js";
import { readDeliveryV2SourceSnapshot } from "./source-snapshot-reader.js";
import { deriveDeliveryV2SourceSnapshotEventId } from
  "./source-snapshot-persistence.js";

const PROJECT = "project-source-snapshot";
const PRINCIPAL = "principal:source-snapshot-publisher";
const COMMAND_KIND = "delivery_v2.source_snapshot.commit";
const EVENT_TYPE = "DeliveryV2SourceSnapshotCommitted";
const ADDRESS_DOMAIN = "moe-delivery-v2-source-snapshot-address/1";
const READER_LAYER = "DAEMON_DELIVERY_V2_READER";

const aggregateIdOf = (projectId: string, digest: string): string =>
  `delivery-v2:source-snapshot:${deliveryV2Digest(ADDRESS_DOMAIN, projectId, digest)}`;

function draft(overrides: Partial<SourceSnapshotDraft> = {}): SourceSnapshotDraft {
  return Object.freeze({
    baseRevisionHash: "a".repeat(64),
    projectId: PROJECT,
    repositoryBaseTree: "b".repeat(40),
    repositoryRef: "refs/heads/main",
    scopeRef: "workspace:root",
    ...overrides,
  });
}

function snapshotOf(overrides: Partial<SourceSnapshotDraft> = {}): SourceSnapshot {
  const created = createSourceSnapshot(draft(overrides));
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.snapshot;
}

function bytesOf(snapshot: SourceSnapshot): Uint8Array {
  const encoded = encodeSourceSnapshot(snapshot);
  if (!encoded.ok) throw new Error(`${encoded.code}@${encoded.layer}`);
  return encoded.bytes;
}

function refOf(snapshot: SourceSnapshot): SourceSnapshotRef {
  return Object.freeze({
    projectId: snapshot.projectId,
    sourceSnapshotDigest: snapshot.sourceSnapshotDigest,
  });
}

interface SeedOptions {
  readonly aggregateId?: string;
  readonly commandId?: string;
  readonly commandKind?: string;
  readonly committedResultBytes?: Uint8Array;
  readonly eventCount?: number;
  readonly eventId?: string;
  readonly eventType?: string;
  readonly payload?: Uint8Array;
  readonly principalId?: string;
  readonly requestBytes?: Uint8Array;
  readonly schema?: string;
}

let seedOrdinal = 0;

function seed(
  store: SqliteEventStore,
  snapshot: SourceSnapshot,
  options: SeedOptions = {},
): void {
  seedOrdinal += 1;
  const commandId = options.commandId ?? `source-snapshot-command-${seedOrdinal}`;
  const principalId = options.principalId ?? PRINCIPAL;
  const bytes = options.payload ?? bytesOf(snapshot);
  const result = store.commitExpectedVersionDecision({
    commandKind: options.commandKind ?? COMMAND_KIND,
    committedResultBytes: options.committedResultBytes ?? bytes,
    correlationId: `source-snapshot-correlation-${seedOrdinal}`,
    decidedAt: "2026-09-01T00:00:00.000Z",
    events: Array.from({ length: options.eventCount ?? 1 }, (_, index) => Object.freeze({
      domainSchemaVersion: options.schema ?? SOURCE_SNAPSHOT_VERSION,
      eventId: options.eventId ?? (index === 0
        ? deriveDeliveryV2SourceSnapshotEventId(PROJECT, principalId, commandId)
        : `${deriveDeliveryV2SourceSnapshotEventId(
          PROJECT, principalId, commandId,
        )}:${index}`),
      eventType: options.eventType ?? EVENT_TYPE,
      payload: bytes,
    })),
    expectedVersion: 0,
    key: Object.freeze({
      commandId,
      principalId,
      projectId: PROJECT,
    }),
    requestBytes: options.requestBytes ?? bytes,
    targetAggregateId: options.aggregateId
      ?? aggregateIdOf(PROJECT, snapshot.sourceSnapshotDigest),
  });
  if (result.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(result.decision.resultCode);
  }
}

function storeView(
  store: SqliteEventStore,
  overrides: Partial<Pick<SqliteEventStore,
  "getCommandDecision" | "getCommandReceipt" | "readAggregateEvents">>,
): SqliteEventStore {
  return Object.freeze({
    getCommandDecision: store.getCommandDecision.bind(store),
    getCommandReceipt: store.getCommandReceipt.bind(store),
    readAggregateEvents: store.readAggregateEvents.bind(store),
    ...overrides,
  }) as unknown as SqliteEventStore;
}

function mapEvents(
  store: SqliteEventStore,
  map: (event: StoredEvent) => StoredEvent,
): SqliteEventStore {
  return storeView(store, {
    readAggregateEvents: (aggregateId, afterSequence, limit, maxBytes) => {
      const page = store.readAggregateEvents(aggregateId, afterSequence, limit, maxBytes);
      return Object.freeze({ ...page, items: Object.freeze(page.items.map(map)) });
    },
  });
}

function expectReaderRefusal(result: unknown, code: string, layer = READER_LAYER): void {
  expect(result).toStrictEqual({ code, layer, ok: false });
}

describe("delivery-v2 SourceSnapshot reader", () => {
  it("reads exactly sequence one from the content address and returns the core snapshot", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot);
    const calls: unknown[][] = [];
    const inspected = storeView(store, {
      readAggregateEvents: (...args) => {
        calls.push(args);
        return store.readAggregateEvents(...args);
      },
    });

    expect(readDeliveryV2SourceSnapshot(inspected, refOf(snapshot), PRINCIPAL))
      .toStrictEqual({ ok: true, snapshot });
    expect(calls).toStrictEqual([[aggregateIdOf(
      PROJECT, snapshot.sourceSnapshotDigest,
    ), 0, 2]]);
  });

  it("reads canonical event bytes unchanged after a file-backed close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-source-snapshot-reader-"));
    const path = join(directory, "store.db");
    const snapshot = snapshotOf();
    const expectedBytes = bytesOf(snapshot);
    const aggregateId = aggregateIdOf(PROJECT, snapshot.sourceSnapshotDigest);
    let store = SqliteEventStore.openForProject(path, PROJECT);
    try {
      seed(store, snapshot);
      const before = Object.freeze({
        decisions: store.readCommandDecisionsAfter(0n).items.length,
        events: store.readAggregateEvents(aggregateId, 0, 2).items.length,
      });
      expect(store.readAggregateEvents(aggregateId, 0, 2).items[0]?.payload)
        .toStrictEqual(expectedBytes);
      store.close();

      store = SqliteEventStore.openForProject(path, PROJECT);
      expect(readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL))
        .toStrictEqual({ ok: true, snapshot });
      expect(store.readAggregateEvents(aggregateId, 0, 2).items[0]?.payload)
        .toStrictEqual(expectedBytes);
      expect({
        decisions: store.readCommandDecisionsAfter(0n).items.length,
        events: store.readAggregateEvents(aggregateId, 0, 2).items.length,
      }).toStrictEqual(before);
    } finally {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("returns core SourceSnapshotRef refusal provenance exactly", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    expect(readDeliveryV2SourceSnapshot(store, {
      projectId: PROJECT,
      sourceSnapshotDigest: "not-a-digest",
    }, PRINCIPAL)).toStrictEqual({
      code: "SOURCE_SNAPSHOT_MALFORMED",
      layer: "SOURCE_SNAPSHOT_ADMISSION",
      ok: false,
    });
  });

  it("preserves exact core provenance for hostile and noncanonical refs", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    const safeRef = refOf(snapshot);
    let accessorReads = 0;
    const accessorRef = {
      get projectId() { accessorReads += 1; return PROJECT; },
      sourceSnapshotDigest: snapshot.sourceSnapshotDigest,
    } as SourceSnapshotRef;
    const cases = [
      [new Proxy(safeRef, {}), "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION"],
      [accessorRef, "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION"],
      [{ ...safeRef, projectId: "x".repeat(257) },
        "SOURCE_SNAPSHOT_LIMIT_EXCEEDED", "SOURCE_SNAPSHOT_LIMITS"],
      [{ ...safeRef, projectId: "e\u0301" },
        "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION"],
      [{ ...safeRef, sourceSnapshotDigest: safeRef.sourceSnapshotDigest.toUpperCase() },
        "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION"],
    ] as const;

    for (const [ref, code, layer] of cases) {
      expect(readDeliveryV2SourceSnapshot(store, ref, PRINCIPAL))
        .toStrictEqual({ code, layer, ok: false });
    }
    expect(accessorReads).toBe(0);
  });

  it.each(["", "principal\0invalid", "\ud800",
    "x".repeat(CAPABILITY_CATALOG_LIMITS.maxIdBytes + 1)])(
    "refuses invalid trusted principal %j at the reader boundary",
    (principalId) => {
      const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
      const snapshot = snapshotOf();
      expectReaderRefusal(
        readDeliveryV2SourceSnapshot(store, refOf(snapshot), principalId),
        "DELIVERY_V2_INPUT_INVALID",
      );
    },
  );

  it("refuses absent content without synthesizing an empty snapshot", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_ABSENT",
    );
  });

  it("returns core decoder refusal provenance exactly", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot, { payload: new TextEncoder().encode("{") });
    expect(readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL)).toStrictEqual({
      code: "SOURCE_SNAPSHOT_BYTES_INVALID",
      layer: "SOURCE_SNAPSHOT_CODEC",
      ok: false,
    });
  });

  it.each([
    ["duplicate key", (snapshot: SourceSnapshot) => {
      const text = new TextDecoder().decode(bytesOf(snapshot));
      return new TextEncoder().encode(`{"projectId":"duplicate",${text.slice(1)}`);
    }, "SOURCE_SNAPSHOT_DUPLICATE_KEY", "SOURCE_SNAPSHOT_CODEC"],
    ["noncanonical bytes", (snapshot: SourceSnapshot) => {
      const text = new TextDecoder().decode(bytesOf(snapshot));
      return new TextEncoder().encode(`{ ${text.slice(1)}`);
    }, "SOURCE_SNAPSHOT_NONCANONICAL", "SOURCE_SNAPSHOT_CANONICALIZATION"],
    ["digest-invalid content", (snapshot: SourceSnapshot) => {
      const text = new TextDecoder().decode(bytesOf(snapshot));
      return new TextEncoder().encode(text.replace(
        snapshot.sourceSnapshotDigest, "0".repeat(64),
      ));
    }, "SOURCE_SNAPSHOT_DIGEST_MISMATCH", "SOURCE_SNAPSHOT_DIGEST"],
  ] as const)("preserves exact core decoder provenance for %s", (
    _name, payloadOf, code, layer,
  ) => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot, { payload: payloadOf(snapshot) });
    expect(readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL))
      .toStrictEqual({ code, layer, ok: false });
  });

  it("distinguishes a substituted project in valid snapshot content", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const requested = snapshotOf();
    const substituted = snapshotOf({ projectId: "project-substituted" });
    seed(store, substituted, {
      aggregateId: aggregateIdOf(PROJECT, requested.sourceSnapshotDigest),
    });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(store, refOf(requested), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_PROJECT_MISMATCH",
    );
  });

  it("distinguishes an alternate valid content digest", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const requested = snapshotOf();
    const substituted = snapshotOf({ scopeRef: "workspace:other" });
    seed(store, substituted, {
      aggregateId: aggregateIdOf(PROJECT, requested.sourceSnapshotDigest),
    });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(store, refOf(requested), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_DIGEST_MISMATCH",
    );
  });

  it("refuses alternate cardinality instead of selecting one event", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot, { eventCount: 2 });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
  });

  it.each([
    ["sequence", (event: StoredEvent) => Object.freeze({ ...event, aggregateSequence: 2 })],
    ["aggregate", (event: StoredEvent) => Object.freeze({ ...event, aggregateId: "substituted" })],
    ["schema", (event: StoredEvent) => Object.freeze({
      ...event, domainSchemaVersion: "moe-source-snapshot/999",
    })],
    ["event type", (event: StoredEvent) => Object.freeze({
      ...event, eventType: "UnexpectedSourceSnapshotEvent",
    })],
    ["event id", (event: StoredEvent) => Object.freeze({
      ...event, eventId: `${event.eventId}:substituted`,
    })],
    ["publisher principal", (event: StoredEvent) => {
      if (event.decisionTrace === undefined) return event;
      return Object.freeze({ ...event, decisionTrace: Object.freeze({
        ...event.decisionTrace, principalId: "principal:substituted",
      }) });
    }],
    ["trace command kind", (event: StoredEvent) => {
      if (event.decisionTrace === undefined) return event;
      return Object.freeze({ ...event, decisionTrace: Object.freeze({
        ...event.decisionTrace, commandKind: "delivery_v2.source_snapshot.substituted",
      }) });
    }],
  ] as const)("refuses %s event corruption", (_name, mutate) => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot);
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(mapEvents(store, mutate), refOf(snapshot), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
  });

  it("classifies a substituted decision project before generic provenance corruption", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot);
    const substituted = mapEvents(store, (event) => {
      if (event.decisionTrace === undefined) return event;
      return Object.freeze({ ...event, decisionTrace: Object.freeze({
        ...event.decisionTrace, projectId: "project-substituted",
      }) });
    });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(substituted, refOf(snapshot), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_PROJECT_MISMATCH",
    );
  });

  it("refuses a self-consistent commit by the wrong publisher principal", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot, { principalId: "principal:wrong-publisher" });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
  });

  it("keeps one raw command id distinct across publisher scopes and content addresses", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const commandId = "source-snapshot-shared-command";
    const otherPrincipal = "principal:other-source-snapshot-publisher";
    const first = snapshotOf({ scopeRef: "workspace:first" });
    const second = snapshotOf({ scopeRef: "workspace:second" });
    seed(store, first, {
      commandId,
      eventId: deriveDeliveryV2SourceSnapshotEventId(PROJECT, PRINCIPAL, commandId),
      principalId: PRINCIPAL,
    });
    seed(store, second, {
      commandId,
      eventId: deriveDeliveryV2SourceSnapshotEventId(PROJECT, otherPrincipal, commandId),
      principalId: otherPrincipal,
    });

    expect(readDeliveryV2SourceSnapshot(store, refOf(first), PRINCIPAL))
      .toStrictEqual({ ok: true, snapshot: first });
    expect(readDeliveryV2SourceSnapshot(store, refOf(second), otherPrincipal))
      .toStrictEqual({ ok: true, snapshot: second });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(store, refOf(first), otherPrincipal),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
    const eventIds = [first, second].map((snapshot) => store.readAggregateEvents(
      aggregateIdOf(PROJECT, snapshot.sourceSnapshotDigest), 0, 2,
    ).items[0]?.eventId);
    expect(eventIds).toStrictEqual([
      deriveDeliveryV2SourceSnapshotEventId(PROJECT, PRINCIPAL, commandId),
      deriveDeliveryV2SourceSnapshotEventId(PROJECT, otherPrincipal, commandId),
    ]);
    expect(new Set(eventIds).size).toBe(2);
  });

  it.each([
    ["request", (bytes: Uint8Array) => ({ requestBytes: Uint8Array.of(...bytes, 0) })],
    ["result", (bytes: Uint8Array) => ({ committedResultBytes: Uint8Array.of(...bytes, 0) })],
  ] as const)("refuses a decision with different %s bytes", (_name, options) => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot, options(bytesOf(snapshot)));
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
  });

  it("refuses decision-record corruption", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot);
    const corrupt = storeView(store, {
      getCommandDecision: (key) => {
        const decision = store.getCommandDecision(key);
        return decision === null ? null : Object.freeze({
          ...decision, recordVersion: "synthetic-decision-version",
        }) as unknown as CommandDecisionRecord;
      },
    });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(corrupt, refOf(snapshot), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
  });

  it("refuses receipt corruption", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    seed(store, snapshot);
    const corrupt = storeView(store, {
      getCommandReceipt: (commandId) => {
        const receipt = store.getCommandReceipt(commandId);
        return receipt === null ? null : Object.freeze({
          ...receipt, effectSha256: "f".repeat(64),
        }) as CommandReceipt;
      },
    });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(corrupt, refOf(snapshot), PRINCIPAL),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
  });

  it.each(["readAggregateEvents", "getCommandDecision", "getCommandReceipt"] as const)(
    "preserves DurableStoreError provenance from %s",
    (method) => {
      const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
      const snapshot = snapshotOf();
      seed(store, snapshot);
      const throwing = storeView(store, {
        [method]: () => { throw new DurableStoreError("STORE_CORRUPT", "test corruption"); },
      });
      expectReaderRefusal(
        readDeliveryV2SourceSnapshot(throwing, refOf(snapshot), PRINCIPAL),
        "STORE_CORRUPT",
        "DURABLE_STORE",
      );
    },
  );

  it("maps an unexpected storage exception to reader degradation", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    const throwing = storeView(store, {
      readAggregateEvents: () => { throw new Error("unexpected read failure"); },
    });
    expectReaderRefusal(
      readDeliveryV2SourceSnapshot(throwing, refOf(snapshot), PRINCIPAL),
      "STORAGE_DEGRADED",
    );
  });
});
