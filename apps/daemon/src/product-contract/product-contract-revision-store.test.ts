import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ProductContractRevision,
  type ProductContractRevisionDraft,
  type ProductContractRevisionRef,
} from "@moe/core";
import { SqliteEventStore } from "@moe/store";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
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
let realCore: typeof import("@moe/core");

beforeAll(async () => {
  realCore = await vi.importActual<typeof import("@moe/core")>("@moe/core");
});

beforeEach(() => {
  Object.assign(coreCalls, { create: 0, decode: 0, derive: 0, encode: 0 });
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
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-"));
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

function throwingStore(store: SqliteEventStore, method: "commitExpectedVersionDecision") {
  return new Proxy(store, { get(target, key) {
    if (key === method) return () => { throw new Error(`unexpected ${method} failure`); };
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

describe("durable ProductContractRevision store", () => {
  it("composes the core codec and commits its exact bytes to event and decision rows", () =>
    withStore((store) => {
      const expectedRevision = revisionOf();
      const expectedBytes = bytesOf(expectedRevision);
      const aggregateId = deriveProductContractRevisionAggregateId(
        PROJECT, expectedRevision.contractId, expectedRevision.revisionId,
      );
      const written = commitProductContractRevision(store, input());
      expect(written).toMatchObject({ disposition: "DECIDED", ok: true });
      if (!written.ok) throw new Error(`${written.code}@${written.layer}`);
      expect(coreCalls).toEqual({ create: 1, decode: 0, derive: 1, encode: 1 });
      expect(written.revision).toEqual(expectedRevision);
      expect(written.bytes).toEqual(expectedBytes);
      expect(written.ref).toEqual(refOf(expectedRevision));
      expect(store.readEvents(aggregateId)[0]?.payload).toEqual(expectedBytes);
      expect(store.readCommandDecisionsAfter(0n).items[0]?.resultBytes).toEqual(expectedBytes);
    }));

  it("replays identical bytes at raw decision/event totals 1/1 -> 1/1", () => withStore((store) => {
    const aggregateId = deriveProductContractRevisionAggregateId(
      PROJECT, draft().contractId, draft().revisionId,
    );
    expect(commitProductContractRevision(store, input())).toMatchObject({
      disposition: "DECIDED", ok: true,
    });
    expect(counts(store, aggregateId)).toEqual({ decisions: 1, events: 1 });
    expect(commitProductContractRevision(store, input())).toMatchObject({
      disposition: "REPLAYED", ok: true,
    });
    expect(counts(store, aggregateId)).toEqual({ decisions: 1, events: 1 });
  }));

  it("refuses changed bytes under one identity without another row", () => withStore((store) => {
    const aggregateId = deriveProductContractRevisionAggregateId(
      PROJECT, draft().contractId, draft().revisionId,
    );
    expect(commitProductContractRevision(store, input())).toMatchObject({ ok: true });
    const changed = draft({ requirements: [{
      ...draft().requirements[0]!, statement: "Registered users sign in securely.",
    }] });
    expect(commitProductContractRevision(store, input(changed))).toEqual({
      code: "IDEMPOTENCY_CONFLICT", layer: "DURABLE_STORE", ok: false,
    });
    expect(counts(store, aggregateId)).toEqual({ decisions: 1, events: 1 });
  }));

  const refusalCases = [
    ["core create", ["PRODUCT_CONTRACT_PROVENANCE_VACUOUS", "PROVENANCE"], () =>
      withStore((store) => commitProductContractRevision(store, input(draft({
        sourceDocumentDigests: [],
      }))))],
    ["writer storage", ["STORAGE_DEGRADED", "PRODUCT_CONTRACT_REVISION_STORE"], () =>
      withStore((store) => commitProductContractRevision(
        throwingStore(store, "commitExpectedVersionDecision"), input(),
      ))],
  ] as const;

  it("carries a nonzero exact writer refusal roster", () => {
    expect(refusalCases).toHaveLength(2);
    expect(new Set(refusalCases.map(([name]) => name)).size).toBe(refusalCases.length);
  });

  it.each(refusalCases)("pins %s refusal code and layer without UNKNOWN_ERROR", (_name, pair, run) => {
    const result = run();
    expect(result).toMatchObject({ code: pair[0], layer: pair[1], ok: false });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).not.toBe("UNKNOWN_ERROR");
  });
});
