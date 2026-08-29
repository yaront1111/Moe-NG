import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRODUCT_CONTRACT_VERSION,
  type ProductContractRevision,
  type ProductContractRevisionDraft,
  type ProductContractRevisionRef,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readProductContractRevision,
} from "./product-contract-revision-reader.js";
import {
  PRODUCT_CONTRACT_REVISION_EVENT_TYPE,
  commitProductContractRevision,
  deriveProductContractRevisionAggregateId,
} from "./product-contract-revision-store.js";

const coreCalls = vi.hoisted(() => ({ create: 0, decode: 0, derive: 0, encode: 0 }));

vi.mock("@moe/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moe/core")>();
  return {
    ...actual,
    createProductContractRevision: (
      ...args: Parameters<typeof actual.createProductContractRevision>
    ) => { coreCalls.create += 1; return actual.createProductContractRevision(...args); },
    decodeProductContractRevisionBytes: (
      ...args: Parameters<typeof actual.decodeProductContractRevisionBytes>
    ) => { coreCalls.decode += 1; return actual.decodeProductContractRevisionBytes(...args); },
    deriveProductContractRevisionDigest: (
      ...args: Parameters<typeof actual.deriveProductContractRevisionDigest>
    ) => { coreCalls.derive += 1; return actual.deriveProductContractRevisionDigest(...args); },
    encodeProductContractRevision: (
      ...args: Parameters<typeof actual.encodeProductContractRevision>
    ) => { coreCalls.encode += 1; return actual.encodeProductContractRevision(...args); },
  };
});

const PROJECT = "project-product-contract";
const PRINCIPAL = "operator-product-contract";
const DECIDED_AT = "2026-08-29T00:00:00.000Z";
const READER_LAYER = "PRODUCT_CONTRACT_REVISION_READER";
const ZERO_CORE_CALLS = { create: 0, decode: 0, derive: 0, encode: 0 } as const;
let realCore: typeof import("@moe/core");
let seedOrdinal = 0;

beforeAll(async () => {
  realCore = await vi.importActual<typeof import("@moe/core")>("@moe/core");
});

beforeEach(() => {
  Object.assign(coreCalls, ZERO_CORE_CALLS);
  seedOrdinal = 0;
});

function draft(overrides: Partial<ProductContractRevisionDraft> = {}): ProductContractRevisionDraft {
  return {
    authorRef: PRINCIPAL,
    contractId: "product-contract-a",
    criteria: [{
      criterionId: "criterion-authentication",
      requirementId: "requirement-authentication",
      statement: "A registered user signs in with valid credentials.",
      supersedesCriterionId: null,
    }],
    lineage: null,
    requirements: [{
      requirementId: "requirement-authentication",
      statement: "Registered users can sign in.",
      supersedesRequirementId: null,
    }],
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId: "product-revision-1",
    sourceDocumentDigests: ["a".repeat(64)],
    ...overrides,
  };
}

function revisionOf(value: ProductContractRevisionDraft = draft()): ProductContractRevision {
  const created = realCore.createProductContractRevision(value);
  if (!created.ok) throw new Error(`${created.code}@${created.layer}`);
  return created.revision;
}

function bytesOf(revision: ProductContractRevision): Uint8Array {
  const encoded = realCore.encodeProductContractRevision(revision);
  if (!encoded.ok) throw new Error(`${encoded.code}@${encoded.layer}`);
  return encoded.bytes;
}

function refOf(revision: ProductContractRevision): ProductContractRevisionRef {
  return {
    contractId: revision.contractId,
    revisionDigest: revision.revisionDigest,
    revisionId: revision.revisionId,
  };
}

function input(value: unknown = draft()) {
  return {
    correlationId: "correlation-product-contract",
    decidedAt: DECIDED_AT,
    draft: value,
    principalId: PRINCIPAL,
    projectId: PROJECT,
  } as const;
}

function withStore<T>(run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-reader-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  try {
    return run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function counts(store: SqliteEventStore, aggregateId: string) {
  return {
    decisions: store.readCommandDecisionsAfter(0n).items.length,
    events: store.readEvents(aggregateId).length,
  };
}

function throwingStore(store: SqliteEventStore, method: "readEvents") {
  return new Proxy(store, { get(target, key) {
    if (key === method) return () => { throw new Error(`unexpected ${method} failure`); };
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function seed(
  store: SqliteEventStore,
  aggregateId: string,
  payload: Uint8Array,
  options: { eventCount?: number; eventType?: string; schema?: string } = {},
): void {
  seedOrdinal += 1;
  const eventCount = options.eventCount ?? 1;
  store.commitExpectedVersionDecision({
    commandKind: "product-contract.revision.test-seed",
    committedResultBytes: payload,
    correlationId: `seed-correlation-${seedOrdinal}`,
    decidedAt: DECIDED_AT,
    events: Array.from({ length: eventCount }, (_, index) => ({
      domainSchemaVersion: options.schema ?? PRODUCT_CONTRACT_VERSION,
      eventId: `product-contract-seed-${seedOrdinal}-${index}`,
      eventType: options.eventType ?? PRODUCT_CONTRACT_REVISION_EVENT_TYPE,
      payload,
    })),
    expectedVersion: 0,
    key: {
      commandId: `product-contract-seed-${seedOrdinal}`,
      principalId: PRINCIPAL,
      projectId: PROJECT,
    },
    requestBytes: payload,
    targetAggregateId: aggregateId,
  });
}

describe("full-revision ProductContractRevision reader", () => {
  it("reads a written revision back byte-identical after close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-reopen-"));
    const path = join(directory, "store.db");
    const expectedRevision = revisionOf();
    const expectedBytes = bytesOf(expectedRevision);
    const aggregateId = deriveProductContractRevisionAggregateId(
      PROJECT, expectedRevision.contractId, expectedRevision.revisionId,
    );
    let store = SqliteEventStore.openForProject(path, PROJECT);
    try {
      const written = commitProductContractRevision(store, input());
      if (!written.ok) throw new Error(`${written.code}@${written.layer}`);
      store.close();

      store = SqliteEventStore.openForProject(path, PROJECT);
      const before = counts(store, aggregateId);
      Object.assign(coreCalls, ZERO_CORE_CALLS);
      const read = readProductContractRevision(store, { projectId: PROJECT, ref: written.ref });
      expect(read).toEqual({ bytes: expectedBytes, ok: true, revision: expectedRevision });
      expect(coreCalls).toEqual({ create: 0, decode: 1, derive: 0, encode: 0 });
      expect(counts(store, aggregateId)).toEqual(before);
    } finally {
      store.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  const refusalCases = [
    ["absent", ["PRODUCT_CONTRACT_REVISION_ABSENT", READER_LAYER], () =>
      withStore((store) => readProductContractRevision(store, {
        projectId: PROJECT, ref: refOf(revisionOf()),
      }))],
    ["ambiguous", ["PRODUCT_CONTRACT_REVISION_AMBIGUOUS", READER_LAYER], () =>
      withStore((store) => {
        const revision = revisionOf();
        const aggregate = deriveProductContractRevisionAggregateId(
          PROJECT, revision.contractId, revision.revisionId,
        );
        seed(store, aggregate, bytesOf(revision), { eventCount: 2 });
        return readProductContractRevision(store, { projectId: PROJECT, ref: refOf(revision) });
      })],
    ["wrong event", ["PRODUCT_CONTRACT_REVISION_EVENT_UNEXPECTED", READER_LAYER], () =>
      withStore((store) => seededRead(store, { eventType: "UnexpectedEvent" }))],
    ["wrong schema", ["PRODUCT_CONTRACT_REVISION_SCHEMA_UNSUPPORTED", READER_LAYER], () =>
      withStore((store) => seededRead(store, { schema: "moe-product-contract-revision/999" }))],
    ["malformed bytes", ["PRODUCT_CONTRACT_BYTES_INVALID", "PROVENANCE"], () =>
      withStore((store) => seededRead(store, {}, new TextEncoder().encode("{")))],
    ["identity mismatch", ["PRODUCT_CONTRACT_REVISION_IDENTITY_MISMATCH", READER_LAYER], () =>
      withStore((store) => {
        const requested = revisionOf();
        const other = revisionOf(draft({ revisionId: "product-revision-other" }));
        const aggregate = deriveProductContractRevisionAggregateId(
          PROJECT, requested.contractId, requested.revisionId,
        );
        seed(store, aggregate, bytesOf(other));
        return readProductContractRevision(store, { projectId: PROJECT, ref: refOf(requested) });
      })],
    ["reader storage", ["STORAGE_DEGRADED", READER_LAYER], () =>
      withStore((store) => readProductContractRevision(throwingStore(store, "readEvents"), {
        projectId: PROJECT, ref: refOf(revisionOf()),
      }))],
  ] as const;

  function seededRead(
    store: SqliteEventStore,
    options: { eventType?: string; schema?: string },
    payload?: Uint8Array,
  ) {
    const revision = revisionOf();
    const aggregate = deriveProductContractRevisionAggregateId(
      PROJECT, revision.contractId, revision.revisionId,
    );
    seed(store, aggregate, payload ?? bytesOf(revision), options);
    return readProductContractRevision(store, { projectId: PROJECT, ref: refOf(revision) });
  }

  it("carries a nonzero exact reader refusal roster", () => {
    expect(refusalCases).toHaveLength(7);
    expect(new Set(refusalCases.map(([name]) => name)).size).toBe(refusalCases.length);
  });

  it.each(refusalCases)("pins %s refusal code and layer without UNKNOWN_ERROR", (_name, pair, run) => {
    const result = run();
    expect(result).toMatchObject({ code: pair[0], layer: pair[1], ok: false });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).not.toBe("UNKNOWN_ERROR");
  });
});
