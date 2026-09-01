import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CAPABILITY_CATALOG_LIMITS } from "@moe/core";
import {
  DurableStoreError,
  SqliteEventStore,
  type CommandDecisionRecord,
  type CommandReceipt,
  type StoredEvent,
} from "@moe/store";
import { describe, expect, it } from "vitest";

import {
  createPlannerAdmissionProfileRevision,
  encodePlannerAdmissionProfileRevision,
} from "../planning/v2-compiler/planner-admission-profile-codec.js";
import { PLANNER_ADMISSION_PROFILE_VERSION } from
  "../planning/v2-compiler/planner-admission-profile-contract.js";
import { deliveryV2Digest } from "./addresses.js";
import {
  DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND,
  DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE,
  appendDeliveryV2PlannerAdmissionProfileRevision,
  deriveDeliveryV2PlannerAdmissionProfileRevisionEventId,
} from "./planner-admission-profile-persistence.js";
import {
  readDeliveryV2AuthoredPlannerAdmissionProfileRevision,
  readDeliveryV2PlannerAdmissionProfileRevision,
  type DeliveryV2PlannerAdmissionProfileRevisionRef,
} from "./planner-admission-profile-reader.js";

const PROJECT = "project-planner-admission-profile-reader";
const PRINCIPAL = "principal:planner-admission-profile-reader-publisher";
const ADDRESS_DOMAIN = "moe-delivery-v2-planner-admission-profile-revision-address/1";
const PURPOSES = Object.freeze([
  "CONTINGENCY", "EXECUTION", "FINAL_ACCEPTANCE", "INDEPENDENT_REVIEW", "VERIFICATION",
] as const);
const hex = (digit: string): string => digit.repeat(64);

function draft(overrides: Record<string, unknown> = {}) {
  return {
    admissionGatePolicy: "POLICY_ALLOWANCE",
    allocationDecisionRef: "allocation-decision:reader-build-r1",
    allocationSemantics: "SINGLE_ADMISSION_FULL_ENVELOPE",
    authorRef: PRINCIPAL,
    authorityKind: "BUILDER",
    budgetAllocations: [{
      conversion: {
        authorityRef: "conversion-authority:reader-seconds-to-ms-r1",
        denominator: 1,
        numerator: 1_000,
        targetMeter: "runner.authorized_ms",
      },
      purposeQuantities: PURPOSES.map((purpose) => ({ purpose, quantity: 3_000 })),
      sourceBudget: { budgetId: "budget-time-reader", kind: "TIME", limit: 15, unit: "seconds" },
    }],
    budgetBindingDigest: `moe.v2.budget-bindings.sha256:${hex("b")}`,
    contractBinding: {
      contractId: "contract-reader", revisionDigest: hex("a"), revisionId: "contract-reader-r1",
    },
    graphId: "graph-reader-r1",
    graphSnapshotIdentity: hex("c"),
    nodeIntentDigest: hex("d"),
    nodeKey: "node-reader-build",
    policyRevision: hex("e"),
    profileId: "planner-admission-profile-reader-build",
    revisionId: "planner-admission-profile-reader-build-r1",
    ...overrides,
  };
}

function revisionOf(overrides: Record<string, unknown> = {}) {
  const result = createPlannerAdmissionProfileRevision(draft(overrides));
  if (!result.ok) throw new Error(`${result.code}@${result.layer}`);
  return result.revision;
}

function bytesOf(revision = revisionOf()): Uint8Array {
  const encoded = encodePlannerAdmissionProfileRevision(revision);
  if (!encoded.ok) throw new Error(`${encoded.code}@${encoded.layer}`);
  return encoded.bytes;
}

function refOf(revision = revisionOf()): DeliveryV2PlannerAdmissionProfileRevisionRef {
  return Object.freeze({
    profileId: revision.profileId,
    projectId: PROJECT,
    revisionDigest: revision.revisionDigest,
    revisionId: revision.revisionId,
  });
}

const aggregateIdOf = (projectId: string, revisionDigest: string): string =>
  `delivery-v2:planner-admission-profile-revision:${deliveryV2Digest(
    ADDRESS_DOMAIN, projectId, revisionDigest,
  )}`;

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
  readonly projectId?: string;
  readonly requestBytes?: Uint8Array;
  readonly schema?: string;
}

let seedOrdinal = 0;
function seed(store: SqliteEventStore, revision = revisionOf(), options: SeedOptions = {}): void {
  seedOrdinal += 1;
  const commandId = options.commandId ?? `planner-profile-reader-command-${seedOrdinal}`;
  const principalId = options.principalId ?? PRINCIPAL;
  const projectId = options.projectId ?? PROJECT;
  const bytes = options.payload ?? bytesOf(revision);
  const result = store.commitExpectedVersionDecision({
    commandKind: options.commandKind
      ?? DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_COMMAND_KIND,
    committedResultBytes: options.committedResultBytes ?? bytes,
    correlationId: `planner-profile-reader-correlation-${seedOrdinal}`,
    decidedAt: "2026-09-01T00:00:00.000Z",
    events: Array.from({ length: options.eventCount ?? 1 }, (_, index) => ({
      domainSchemaVersion: options.schema ?? PLANNER_ADMISSION_PROFILE_VERSION,
      eventId: options.eventId ?? (index === 0
        ? deriveDeliveryV2PlannerAdmissionProfileRevisionEventId(
          projectId, principalId, commandId,
        )
        : `${deriveDeliveryV2PlannerAdmissionProfileRevisionEventId(
          projectId, principalId, commandId,
        )}:${index}`),
      eventType: options.eventType
        ?? DELIVERY_V2_PLANNER_ADMISSION_PROFILE_REVISION_EVENT_TYPE,
      payload: bytes,
    })),
    expectedVersion: 0,
    key: { commandId, principalId, projectId },
    requestBytes: options.requestBytes ?? bytes,
    targetAggregateId: options.aggregateId
      ?? aggregateIdOf(PROJECT, revision.revisionDigest),
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

function mapEvents(store: SqliteEventStore, map: (event: StoredEvent) => StoredEvent) {
  return storeView(store, {
    readAggregateEvents: (aggregateId, afterSequence, limit, maxBytes) => {
      const page = store.readAggregateEvents(aggregateId, afterSequence, limit, maxBytes);
      return Object.freeze({ ...page, items: Object.freeze(page.items.map(map)) });
    },
  });
}

const refusal = (code: string, layer = "DAEMON_DELIVERY_V2_READER") =>
  Object.freeze({ code, layer, ok: false as const });

describe("delivery-v2 PlannerAdmissionProfileRevision reader", () => {
  it("reads exactly sequence one by project plus digest without claiming currentness", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const revision = revisionOf();
    seed(store, revision);
    const calls: unknown[][] = [];
    const inspected = storeView(store, {
      readAggregateEvents: (...args) => {
        calls.push(args);
        return store.readAggregateEvents(...args);
      },
    });
    const result = readDeliveryV2PlannerAdmissionProfileRevision(
      inspected, refOf(revision), PRINCIPAL,
    );
    expect(result).toStrictEqual({ ok: true, revision });
    expect(Object.keys(result).sort()).toStrictEqual(["ok", "revision"]);
    expect(calls).toStrictEqual([[
      aggregateIdOf(PROJECT, revision.revisionDigest), 0, 2,
    ]]);
  });

  it("authenticates canonical bytes after file-backed close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-planner-profile-reader-"));
    const path = join(directory, "store.db");
    const revision = revisionOf();
    const bytes = bytesOf(revision);
    const aggregateId = aggregateIdOf(PROJECT, revision.revisionDigest);
    let store = SqliteEventStore.openForProject(path, PROJECT);
    try {
      expect(appendDeliveryV2PlannerAdmissionProfileRevision(store, {
        commandId: "planner-profile-file-reopen",
        correlationId: "correlation:planner-profile-file-reopen",
        decidedAt: "2026-09-01T10:00:00.000Z",
        expectedVersion: 0,
        principalId: PRINCIPAL,
        projectId: PROJECT,
      }, draft())).toMatchObject({ disposition: "DECIDED", ok: true });
      const before = {
        decisions: store.readCommandDecisionsAfter(0n).items.length,
        events: store.readAggregateEvents(aggregateId, 0, 2).items.length,
      };
      store.close();
      store = SqliteEventStore.openForProject(path, PROJECT);
      expect(readDeliveryV2PlannerAdmissionProfileRevision(store, refOf(revision), PRINCIPAL))
        .toStrictEqual({ ok: true, revision });
      expect(readDeliveryV2AuthoredPlannerAdmissionProfileRevision(store, refOf(revision)))
        .toStrictEqual({ ok: true, revision });
      expect(store.readAggregateEvents(aggregateId, 0, 2).items[0]?.payload)
        .toStrictEqual(bytes);
      expect({
        decisions: store.readCommandDecisionsAfter(0n).items.length,
        events: store.readAggregateEvents(aggregateId, 0, 2).items.length,
      }).toStrictEqual(before);
    } finally {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects malformed refs and publisher identities before reading", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const revision = revisionOf();
    const cases: readonly [unknown, string][] = [
      [{ ...refOf(revision), revisionDigest: "not-a-digest" }, PRINCIPAL],
      [{ ...refOf(revision), profileId: " profile-with-space" }, PRINCIPAL],
      [{ ...refOf(revision), revisionId: "e\u0301" }, PRINCIPAL],
      [{ ...refOf(revision), extra: true }, PRINCIPAL],
      [new Proxy(refOf(revision), {}), PRINCIPAL],
      [refOf(revision), ""],
      [refOf(revision), "principal\0invalid"],
      [refOf(revision), "\ud800"],
      [refOf(revision), "p".repeat(CAPABILITY_CATALOG_LIMITS.maxIdBytes + 1)],
    ];
    for (const [ref, principal] of cases) {
      expect(readDeliveryV2PlannerAdmissionProfileRevision(
        store, ref as DeliveryV2PlannerAdmissionProfileRevisionRef, principal,
      )).toStrictEqual(refusal("DELIVERY_V2_INPUT_INVALID"));
    }
  });

  it("distinguishes absent, project, profile/revision, and digest mismatches", () => {
    const empty = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const revision = revisionOf();
    expect(readDeliveryV2PlannerAdmissionProfileRevision(empty, refOf(revision), PRINCIPAL))
      .toStrictEqual(refusal("DELIVERY_V2_MATERIAL_ABSENT"));

    const projectStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(projectStore, revision);
    const wrongProject = mapEvents(projectStore, (event) => event.decisionTrace === undefined
      ? event
      : Object.freeze({ ...event, decisionTrace: Object.freeze({
        ...event.decisionTrace, projectId: "project-substituted",
      }) }));
    expect(readDeliveryV2PlannerAdmissionProfileRevision(
      wrongProject, refOf(revision), PRINCIPAL,
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_PROJECT_MISMATCH"));

    const refStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(refStore, revision);
    expect(readDeliveryV2PlannerAdmissionProfileRevision(refStore, {
      ...refOf(revision), profileId: "profile-substituted",
    }, PRINCIPAL)).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_REF_MISMATCH"));
    expect(readDeliveryV2PlannerAdmissionProfileRevision(refStore, {
      ...refOf(revision), revisionId: "revision-substituted",
    }, PRINCIPAL)).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_REF_MISMATCH"));

    const substituted = revisionOf({ revisionId: "planner-profile-substituted-r1" });
    const digestStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(digestStore, substituted, {
      aggregateId: aggregateIdOf(PROJECT, revision.revisionDigest),
    });
    expect(readDeliveryV2PlannerAdmissionProfileRevision(
      digestStore, refOf(revision), PRINCIPAL,
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_DIGEST_MISMATCH"));
  });

  it("preserves exact profile decoder provenance", () => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const revision = revisionOf();
    seed(store, revision, { payload: new TextEncoder().encode("{") });
    expect(readDeliveryV2PlannerAdmissionProfileRevision(store, refOf(revision), PRINCIPAL))
      .toStrictEqual({
        code: "PLANNER_ADMISSION_PROFILE_BYTES_INVALID",
        layer: "PLANNER_ADMISSION_PROFILE_CODEC",
        ok: false,
      });
  });

  it("requires one exact seq-1 event with the trusted publisher", () => {
    const revision = revisionOf();
    const cardinality = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(cardinality, revision, { eventCount: 2 });
    expect(readDeliveryV2PlannerAdmissionProfileRevision(
      cardinality, refOf(revision), PRINCIPAL,
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));

    const wrongPublisher = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(wrongPublisher, revision, { principalId: "principal:wrong-publisher" });
    expect(readDeliveryV2PlannerAdmissionProfileRevision(
      wrongPublisher, refOf(revision), PRINCIPAL,
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));

    const corruptionCases = [
      (event: StoredEvent) => Object.freeze({ ...event, aggregateSequence: 2 }),
      (event: StoredEvent) => Object.freeze({ ...event, aggregateId: "aggregate:substituted" }),
      (event: StoredEvent) => Object.freeze({ ...event, domainSchemaVersion: "profile/999" }),
      (event: StoredEvent) => Object.freeze({ ...event, eventType: "UnexpectedProfileEvent" }),
      (event: StoredEvent) => Object.freeze({ ...event, eventId: `${event.eventId}:changed` }),
      (event: StoredEvent) => event.decisionTrace === undefined ? event : Object.freeze({
        ...event,
        decisionTrace: Object.freeze({
          ...event.decisionTrace, commandKind: "delivery_v2.profile.changed",
        }),
      }),
    ];
    for (const mutate of corruptionCases) {
      const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
      seed(store, revision);
      expect(readDeliveryV2PlannerAdmissionProfileRevision(
        mapEvents(store, mutate), refOf(revision), PRINCIPAL,
      )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));
    }
  });

  it("refuses decision and receipt corruption", () => {
    const revision = revisionOf();
    const decisionStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(decisionStore, revision);
    const corruptDecision = storeView(decisionStore, {
      getCommandDecision: (key) => {
        const decision = decisionStore.getCommandDecision(key);
        return decision === null ? null : Object.freeze({
          ...decision, recordVersion: "synthetic-version",
        }) as unknown as CommandDecisionRecord;
      },
    });
    expect(readDeliveryV2PlannerAdmissionProfileRevision(
      corruptDecision, refOf(revision), PRINCIPAL,
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));

    const receiptStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(receiptStore, revision);
    const corruptReceipt = storeView(receiptStore, {
      getCommandReceipt: (commandId) => {
        const receipt = receiptStore.getCommandReceipt(commandId);
        return receipt === null ? null : Object.freeze({
          ...receipt, effectSha256: hex("f"),
        }) as CommandReceipt;
      },
    });
    expect(readDeliveryV2PlannerAdmissionProfileRevision(
      corruptReceipt, refOf(revision), PRINCIPAL,
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));
  });

  it.each([
    ["request", (bytes: Uint8Array) => ({ requestBytes: Uint8Array.of(...bytes, 0) })],
    ["result", (bytes: Uint8Array) => ({ committedResultBytes: Uint8Array.of(...bytes, 0) })],
  ] as const)("refuses decision provenance with different %s bytes", (_name, options) => {
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const revision = revisionOf();
    seed(store, revision, options(bytesOf(revision)));
    expect(readDeliveryV2PlannerAdmissionProfileRevision(
      store, refOf(revision), PRINCIPAL,
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));
  });

  it.each(["readAggregateEvents", "getCommandDecision", "getCommandReceipt"] as const)(
    "preserves DurableStoreError provenance from %s",
    (method) => {
      const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
      const revision = revisionOf();
      seed(store, revision);
      const throwing = storeView(store, {
        [method]: () => { throw new DurableStoreError("STORE_CORRUPT", "test corruption"); },
      });
      expect(readDeliveryV2PlannerAdmissionProfileRevision(
        throwing, refOf(revision), PRINCIPAL,
      )).toStrictEqual(refusal("STORE_CORRUPT", "DURABLE_STORE"));
    },
  );
});

describe("delivery-v2 authored PlannerAdmissionProfileRevision reader", () => {
  it("binds the observed durable publisher to authorRef without claiming currentness", () => {
    const acceptedStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const acceptedRevision = revisionOf();
    seed(acceptedStore, acceptedRevision);
    const accepted = readDeliveryV2AuthoredPlannerAdmissionProfileRevision(
      acceptedStore, refOf(acceptedRevision),
    );
    expect(accepted).toStrictEqual({ ok: true, revision: acceptedRevision });
    expect(Object.keys(accepted).sort()).toStrictEqual(["ok", "revision"]);

    const otherPrincipal = "principal:self-consistent-profile-publisher";
    const mismatchedStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    const mismatchedRevision = revisionOf();
    seed(mismatchedStore, mismatchedRevision, { principalId: otherPrincipal });
    expect(readDeliveryV2PlannerAdmissionProfileRevision(
      mismatchedStore, refOf(mismatchedRevision), otherPrincipal,
    )).toStrictEqual({ ok: true, revision: mismatchedRevision });
    expect(readDeliveryV2AuthoredPlannerAdmissionProfileRevision(
      mismatchedStore, refOf(mismatchedRevision),
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));
  });

  it("refuses malformed observed publisher principals before provenance reads", () => {
    const revision = revisionOf();
    const invalidPrincipals = [
      "",
      "principal\0invalid",
      "\ud800",
      "p".repeat(CAPABILITY_CATALOG_LIMITS.maxIdBytes + 1),
    ] as const;
    for (const invalidPrincipal of invalidPrincipals) {
      const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
      seed(store, revision);
      let decisionReads = 0;
      let receiptReads = 0;
      const malformed = storeView(mapEvents(store, (event) => event.decisionTrace === undefined
        ? event
        : Object.freeze({ ...event, decisionTrace: Object.freeze({
          ...event.decisionTrace, principalId: invalidPrincipal,
        }) })), {
        getCommandDecision: () => { decisionReads += 1; return null; },
        getCommandReceipt: () => { receiptReads += 1; return null; },
      });
      expect(readDeliveryV2AuthoredPlannerAdmissionProfileRevision(
        malformed, refOf(revision),
      )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));
      expect({ decisionReads, receiptReads }).toStrictEqual({ decisionReads: 0, receiptReads: 0 });
    }
  });

  it("contains hostile observed principal access without invoking it", () => {
    const revision = revisionOf();
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(store, revision);
    let reads = 0;
    const hostile = (kind: "ACCESSOR" | "PROXY"): SqliteEventStore => mapEvents(
      store,
      (event) => {
        if (event.decisionTrace === undefined) return event;
        if (kind === "PROXY") {
          return Object.freeze({
            ...event,
            decisionTrace: new Proxy(event.decisionTrace, {
              get(): never {
                reads += 1;
                throw new Error("principal proxy was read");
              },
            }),
          });
        }
        const trace = { ...event.decisionTrace } as Record<string, unknown>;
        Object.defineProperty(trace, "principalId", {
          enumerable: true,
          get(): never {
            reads += 1;
            throw new Error("principal accessor was read");
          },
        });
        return Object.freeze({ ...event, decisionTrace: trace }) as StoredEvent;
      },
    );

    expect(["PROXY", "ACCESSOR"].map((kind) =>
      readDeliveryV2AuthoredPlannerAdmissionProfileRevision(
        hostile(kind as "ACCESSOR" | "PROXY"), refOf(revision),
      ))).toStrictEqual([
      refusal("DELIVERY_V2_MATERIAL_UNREADABLE"),
      refusal("DELIVERY_V2_MATERIAL_UNREADABLE"),
    ]);
    expect(reads).toBe(0);
  });

  it("captures the page and complete event without invoking hostile data", () => {
    const revision = revisionOf();
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(store, revision);
    const page = store.readAggregateEvents(
      aggregateIdOf(PROJECT, revision.revisionDigest), 0, 2,
    );
    const event = page.items[0];
    if (event === undefined) throw new Error("seeded event is absent");
    let reads = 0;
    const proxyHandler: ProxyHandler<object> = {
      get: (target, key, receiver) => {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor: (target, key) => {
        reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys: (target) => {
        reads += 1;
        return Reflect.ownKeys(target);
      },
    };
    const aggregateAccessor = { ...event } as Record<string, unknown>;
    Object.defineProperty(aggregateAccessor, "aggregateId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return event.aggregateId;
      },
    });
    const payloadAccessor = { ...event } as Record<string, unknown>;
    const originalPayload = event.payload;
    Object.defineProperty(payloadAccessor, "payload", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads % 2 === 1 ? originalPayload : Uint8Array.of(...originalPayload, 0);
      },
    });
    const sharedPayload = new Uint8Array(new SharedArrayBuffer(originalPayload.byteLength));
    sharedPayload.set(originalPayload);
    const cases = [
      new Proxy(page, proxyHandler),
      Object.freeze({ ...page, items: new Proxy([...page.items], proxyHandler) }),
      Object.freeze({ ...page, items: Object.freeze([
        new Proxy(event, proxyHandler) as StoredEvent,
      ]) }),
      Object.freeze({ ...page, items: Object.freeze([
        aggregateAccessor as unknown as StoredEvent,
      ]) }),
      Object.freeze({ ...page, items: Object.freeze([
        payloadAccessor as unknown as StoredEvent,
      ]) }),
      Object.freeze({ ...page, items: Object.freeze([
        Object.freeze({ ...event, payload: sharedPayload }),
      ]) }),
    ];

    expect(cases.map((hostilePage) => readDeliveryV2AuthoredPlannerAdmissionProfileRevision(
      storeView(store, {
        readAggregateEvents: () => hostilePage as ReturnType<
          SqliteEventStore["readAggregateEvents"]
        >,
      }),
      refOf(revision),
    ))).toStrictEqual(cases.map(() => refusal("DELIVERY_V2_MATERIAL_UNREADABLE")));
    expect(reads).toBe(0);
  });

  it("reads each durable provenance surface once", () => {
    const revision = revisionOf();
    const store = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(store, revision);
    const reads = { decision: 0, events: 0, receipt: 0 };
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
        return store.readAggregateEvents(...args);
      },
    });
    expect(readDeliveryV2AuthoredPlannerAdmissionProfileRevision(inspected, refOf(revision)))
      .toStrictEqual({ ok: true, revision });
    expect(reads).toStrictEqual({ decision: 1, events: 1, receipt: 1 });
  });

  it("retains exact decision and receipt corruption fences", () => {
    const revision = revisionOf();
    const decisionStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(decisionStore, revision);
    const corruptDecision = storeView(decisionStore, {
      getCommandDecision: (key) => {
        const decision = decisionStore.getCommandDecision(key);
        return decision === null ? null : Object.freeze({
          ...decision, recordVersion: "synthetic-version",
        }) as unknown as CommandDecisionRecord;
      },
    });
    expect(readDeliveryV2AuthoredPlannerAdmissionProfileRevision(
      corruptDecision, refOf(revision),
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));

    const receiptStore = SqliteEventStore.openEphemeralForProjectTest(PROJECT);
    seed(receiptStore, revision);
    const corruptReceipt = storeView(receiptStore, {
      getCommandReceipt: (commandId) => {
        const receipt = receiptStore.getCommandReceipt(commandId);
        return receipt === null ? null : Object.freeze({
          ...receipt, effectSha256: hex("f"),
        }) as CommandReceipt;
      },
    });
    expect(readDeliveryV2AuthoredPlannerAdmissionProfileRevision(
      corruptReceipt, refOf(revision),
    )).toStrictEqual(refusal("DELIVERY_V2_MATERIAL_UNREADABLE"));
  });
});
