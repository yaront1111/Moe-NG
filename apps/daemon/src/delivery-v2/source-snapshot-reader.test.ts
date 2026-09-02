import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
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
import { hermeticGitEnvironment } from "@moe/runner";
import {
  DurableStoreError,
  SqliteEventStore,
  type CommandDecisionRecord,
  type CommandReceipt,
  type StoredEvent,
} from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  PROJECT_ID as PUBLISHED_PROJECT, envelope, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { readDurableLedger, versionOf } from "../bootstrap/bootstrap-ledger.js";
import {
  FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
} from "../work/foundation-repository-scope-contracts.js";
import { deliveryV2Digest } from "./addresses.js";
import {
  createDeliveryV2SourceSnapshotPublisher,
  deriveDeliveryV2SourceSnapshotPublishCommandId,
  deriveDeliveryV2SourceSnapshotPublishCorrelationId,
  deriveDeliveryV2SourceSnapshotPublisherPrincipalId,
} from "./source-snapshot-publisher.js";
import * as sourceSnapshotReader from "./source-snapshot-reader.js";
import {
  appendDeliveryV2SourceSnapshot,
  deriveDeliveryV2SourceSnapshotEventId,
} from "./source-snapshot-persistence.js";

const PROJECT = "project-source-snapshot";
const PRINCIPAL = "principal:source-snapshot-publisher";
const COMMAND_KIND = "delivery_v2.source_snapshot.commit";
const EVENT_TYPE = "DeliveryV2SourceSnapshotCommitted";
const ADDRESS_DOMAIN = "moe-delivery-v2-source-snapshot-address/1";
const READER_LAYER = "DAEMON_DELIVERY_V2_READER";

const {
  readDeliveryV2PublishedSourceSnapshot,
  readDeliveryV2SourceSnapshot,
} = sourceSnapshotReader;

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

type SourceSnapshotAppendContext = Parameters<typeof appendDeliveryV2SourceSnapshot>[1];

function publishedContext(
  snapshot: SourceSnapshot,
  overrides: Partial<SourceSnapshotAppendContext> = {},
): SourceSnapshotAppendContext {
  return Object.freeze({
    commandId: deriveDeliveryV2SourceSnapshotPublishCommandId(
      snapshot.projectId,
      snapshot.repositoryRef,
      snapshot.scopeRef,
      snapshot.baseRevisionHash,
    ),
    correlationId: deriveDeliveryV2SourceSnapshotPublishCorrelationId(
      snapshot.projectId,
      snapshot.sourceSnapshotDigest,
    ),
    decidedAt: "2026-09-01T12:34:56.000Z",
    expectedVersion: 0,
    principalId: deriveDeliveryV2SourceSnapshotPublisherPrincipalId(snapshot.projectId),
    projectId: snapshot.projectId,
    ...overrides,
  });
}

function appendCandidate(
  store: SqliteEventStore,
  snapshot: SourceSnapshot,
  overrides: Partial<SourceSnapshotAppendContext> = {},
): void {
  const result = appendDeliveryV2SourceSnapshot(
    store,
    publishedContext(snapshot, overrides),
    Object.freeze({
      baseRevisionHash: snapshot.baseRevisionHash,
      projectId: snapshot.projectId,
      repositoryBaseTree: snapshot.repositoryBaseTree,
      repositoryRef: snapshot.repositoryRef,
      scopeRef: snapshot.scopeRef,
    }),
  );
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: hermeticGitEnvironment(process.env),
    shell: false,
    windowsHide: true,
  }).trim();
}

function registerPublishedProject(store: SqliteEventStore): void {
  const result = send(store, envelope(
    "project.register", 0, { owner: "owner-published-source-reader" },
    "published-source-reader-register",
  ));
  if (!result.ok) throw new Error(`register refused: ${result.code}`);
}

function bindPublishedProject(
  store: SqliteEventStore,
  baseRevisionHash: string,
  commandId: string,
): void {
  const expectedVersion = versionOf(
    readDurableLedger(store, PUBLISHED_PROJECT),
    PUBLISHED_PROJECT,
  );
  const result = send(store, envelope("project.bind_repository", expectedVersion, {
    observation: {
      baseRevisionHash,
      repositoryRef: "repository:published-main",
      scopeRef: "scope:published-root",
      truthClass: "DAEMON_VERIFIED",
    },
  }, commandId));
  if (!result.ok) throw new Error(`bind refused: ${result.code}`);
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
    const malformed = {
      projectId: PROJECT,
      sourceSnapshotDigest: "not-a-digest",
    };
    const expected = {
      code: "SOURCE_SNAPSHOT_MALFORMED",
      layer: "SOURCE_SNAPSHOT_ADMISSION",
      ok: false,
    };
    expect(readDeliveryV2SourceSnapshot(store, malformed, PRINCIPAL)).toStrictEqual(expected);
    expect(readDeliveryV2PublishedSourceSnapshot(store, malformed)).toStrictEqual(expected);
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
    const revoked = Proxy.revocable(safeRef, {});
    revoked.revoke();
    const cases = [
      [new Proxy(safeRef, {}), "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION"],
      [revoked.proxy, "SOURCE_SNAPSHOT_MALFORMED", "SOURCE_SNAPSHOT_ADMISSION"],
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
      expect(readDeliveryV2PublishedSourceSnapshot(store, ref))
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
    const expected = {
      code: "SOURCE_SNAPSHOT_BYTES_INVALID",
      layer: "SOURCE_SNAPSHOT_CODEC",
      ok: false,
    };
    expect(readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL))
      .toStrictEqual(expected);
    expect(readDeliveryV2PublishedSourceSnapshot(store, refOf(snapshot)))
      .toStrictEqual(expected);
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
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(store, refOf(requested)),
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
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(store, refOf(requested)),
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
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(store, refOf(snapshot)),
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
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(mapEvents(store, mutate), refOf(snapshot)),
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
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(store, refOf(snapshot)),
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
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(corrupt, refOf(snapshot)),
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
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(corrupt, refOf(snapshot)),
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
      expectReaderRefusal(
        readDeliveryV2PublishedSourceSnapshot(throwing, refOf(snapshot)),
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
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(throwing, refOf(snapshot)),
      "STORAGE_DEGRADED",
    );
  });
});

describe("delivery-v2 published SourceSnapshot reader", () => {
  it("reopens a real Git-backed publisher result without claiming it is still current", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "moe-published-reader-")));
    const repositoryRoot = join(directory, "repository");
    const worktreeParent = join(directory, "worktrees");
    const storePath = join(directory, "store.db");
    mkdirSync(join(repositoryRoot, "scope"), { recursive: true });
    mkdirSync(worktreeParent);
    writeFileSync(join(repositoryRoot, "scope", "source.txt"), "published snapshot\n", "utf8");
    runGit(repositoryRoot, [
      "init", "--object-format=sha256", "--initial-branch=main", "--quiet",
    ]);
    runGit(repositoryRoot, ["config", "core.autocrlf", "false"]);
    runGit(repositoryRoot, ["add", "--", "scope/source.txt"]);
    runGit(repositoryRoot, [
      "-c", "user.name=Moe Published Reader",
      "-c", "user.email=published-reader@example.invalid",
      "commit", "--quiet", "--no-gpg-sign", "-m", "published reader base",
    ]);
    const head = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
    let store = SqliteEventStore.openForProject(storePath, PUBLISHED_PROJECT);
    try {
      registerPublishedProject(store);
      bindPublishedProject(store, head, "published-source-reader-bind");
      const published = createDeliveryV2SourceSnapshotPublisher({
        catalogSource: () => ({
          catalogVersion: FOUNDATION_REPOSITORY_SCOPE_CATALOG_VERSION,
          entries: [{
            declaredPaths: ["scope/source.txt"],
            projectId: PUBLISHED_PROJECT,
            repositoryRef: "repository:published-main",
            scopeRef: "scope:published-root",
            sourceRepositoryRoot: realpathSync(repositoryRoot),
            worktreeParent: realpathSync(worktreeParent),
          }],
        }),
        clock: () => "2026-09-01T13:00:00.000Z",
        projectId: PUBLISHED_PROJECT,
        store,
      }).publishCurrent();
      if (!published.ok) throw new Error(`${published.code}@${published.layer}`);

      // The reader authenticates how this immutable content was published. A newer
      // repository binding does not turn that historical statement into CURRENT.
      bindPublishedProject(store, "f".repeat(64), "published-source-reader-moved");
      store.close();
      store = SqliteEventStore.openForProject(storePath, PUBLISHED_PROJECT);
      expect(readDeliveryV2PublishedSourceSnapshot(store, published.ref)).toStrictEqual({
        ok: true,
        snapshot: published.snapshot,
      });
    } finally {
      try { store.close(); } catch { /* already closed on an earlier failure */ }
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("refuses a valid generic append that carries no code-owned publisher provenance", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    appendCandidate(store, snapshot, {
      commandId: "source-snapshot-generic-command",
      correlationId: "source-snapshot-generic-correlation",
      principalId: PRINCIPAL,
    });
    expect(readDeliveryV2SourceSnapshot(store, refOf(snapshot), PRINCIPAL))
      .toStrictEqual({ ok: true, snapshot });
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(store, refOf(snapshot)),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
  });

  it.each([
    ["principal", {
      principalId: "principal:wrong-published-source-snapshot",
    }],
    ["command", {
      commandId: "source-snapshot-wrong-publish-command",
    }],
    ["correlation", {
      correlationId: "source-snapshot-wrong-publish-correlation",
    }],
  ] as const)("reaches and refuses a self-consistent wrong published %s", (
    _name,
    overrides,
  ) => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    appendCandidate(store, snapshot, overrides);
    const actualPrincipal = "principalId" in overrides ? overrides.principalId
      : deriveDeliveryV2SourceSnapshotPublisherPrincipalId(PROJECT);
    expect(readDeliveryV2SourceSnapshot(store, refOf(snapshot), actualPrincipal))
      .toStrictEqual({ ok: true, snapshot });
    expectReaderRefusal(
      readDeliveryV2PublishedSourceSnapshot(store, refOf(snapshot)),
      "DELIVERY_V2_MATERIAL_UNREADABLE",
    );
  });

  it("contains hostile decision correlation access without invoking it", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const snapshot = snapshotOf();
    appendCandidate(store, snapshot);
    let reads = 0;
    const hostile = (kind: "ACCESSOR" | "PROXY"): SqliteEventStore => storeView(store, {
      getCommandDecision: (key) => {
        const decision = store.getCommandDecision(key);
        if (decision === null) return null;
        if (kind === "PROXY") {
          return new Proxy(decision, {
            get(): never {
              reads += 1;
              throw new Error("decision proxy was read");
            },
          });
        }
        const accessor = { ...decision } as Record<string, unknown>;
        Object.defineProperty(accessor, "correlationSha256", {
          enumerable: true,
          get(): never {
            reads += 1;
            throw new Error("decision correlation accessor was read");
          },
        });
        return accessor as unknown as CommandDecisionRecord;
      },
    });

    const results = ["PROXY", "ACCESSOR"].map((kind) =>
      readDeliveryV2PublishedSourceSnapshot(
        hostile(kind as "ACCESSOR" | "PROXY"),
        refOf(snapshot),
      ));
    const expected = Object.freeze({
      code: "DELIVERY_V2_MATERIAL_UNREADABLE",
      layer: READER_LAYER,
      ok: false as const,
    });
    expect(results).toStrictEqual([expected, expected]);
    expect(results.every(Object.isFrozen)).toBe(true);
    expect(reads).toBe(0);
  });
});
