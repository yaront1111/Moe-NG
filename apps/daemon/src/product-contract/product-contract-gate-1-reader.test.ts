import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import {
  type HumanAuthorityGate, type ProductContractRevisionDraft,
  type ProductContractRevisionRef, productContractGate1Authority,
} from "@moe/core";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import type { CommandDecisionRecord, CommandReceipt, StoredEvent } from "@moe/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { handleCommandRequest } from "../http/http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "../http/http-contract.js";
import type { ControlRoomListener } from "../http/http-listener.js";
import { startControlRoomListener } from "../http/http-listener.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, deriveProductContractGate1AggregateId,
  productContractGate1SubjectDigest,
} from "./product-contract-gate-1-contract.js";
import {
  PRODUCT_CONTRACT_GATE_1_READER_CODES, readProductContractGate1Approval,
} from "./product-contract-gate-1-reader.js";
import { commitProductContractRevision } from "./product-contract-revision-store.js";

const PROJECT = "proj-product-contract-gate-1-reader";
const OPERATOR = "operator-product-contract-gate-1-reader";
const OPERATOR_CREDENTIAL = "operator-credential-product-contract-gate-1-reader";
const CSRF = "csrf-product-contract-gate-1-reader";
const DECIDED_AT = "2026-08-30T12:30:00.000Z";
const NOW = Date.parse(DECIDED_AT);
const READER_LAYER = "PRODUCT_CONTRACT_GATE_1_READER";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let seedOrdinal = 0;

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

interface LawfulFixture {
  readonly directory: string;
  readonly gate: HumanAuthorityGate;
  readonly payload: Uint8Array;
  readonly ref: ProductContractRevisionRef;
  readonly sessionId: string;
  readonly storePath: string;
}

let fixture: LawfulFixture;

function draft(revisionId = "revision-product-contract-gate-1-reader"): ProductContractRevisionDraft {
  return {
    authorRef: OPERATOR,
    contractId: "contract-product-contract-gate-1-reader",
    criteria: [{
      criterionId: "criterion-product-contract-gate-1-reader",
      requirementId: "requirement-product-contract-gate-1-reader",
      statement: "A paired human grants Gate 1 authority.",
      supersedesCriterionId: null,
    }],
    lineage: null,
    requirements: [{
      requirementId: "requirement-product-contract-gate-1-reader",
      statement: "Gate 1 authority is read from the durable writer record.",
      supersedesRequirementId: null,
    }],
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId,
    sourceDocumentDigests: ["a".repeat(64)],
  };
}

function commitRevision(
  store: SqliteEventStore, revisionId = "revision-product-contract-gate-1-reader",
): ProductContractRevisionRef {
  const committed = commitProductContractRevision(store, {
    correlationId: `correlation-${revisionId}`,
    decidedAt: DECIDED_AT,
    draft: draft(revisionId),
    principalId: OPERATOR,
    projectId: PROJECT,
  });
  if (!committed.ok) throw new Error(`revision refused: ${committed.code}@${committed.layer}`);
  return committed.ref;
}

async function post(
  listener: ControlRoomListener, path: string, body: unknown,
): Promise<Reply> {
  const payload = JSON.stringify(body);
  const headers = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  return await new Promise((resolve, reject) => {
    const request = httpRequest(listener.origin + path, { headers, method: "POST" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function commandBytes(
  commandId: string, credential: string, ref: ProductContractRevisionRef, workRef: string,
): Uint8Array {
  const requestDigest = productContractGate1SubjectDigest({ commandId, projectId: PROJECT, workRef });
  return encoder.encode(JSON.stringify({
    commandId,
    commandKind: PRODUCT_CONTRACT_GATE_1_COMMAND_KIND,
    correlationId: `correlation-${commandId}`,
    expectedVersion: 0,
    payload: {
      authentication: { issuedAt: NOW, kind: "BEARER", requestDigest, requestId: commandId },
      contractId: ref.contractId,
      revisionDigest: ref.revisionDigest,
      revisionId: ref.revisionId,
    },
    requestDigest: "b".repeat(64),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: credential,
    targetAggregateId: `gate-1/${commandId}`,
  }));
}

async function createLawfulFixture(): Promise<LawfulFixture> {
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-gate-1-reader-lawful-"));
  const storePath = join(directory, "store.db");
  const setup = SqliteEventStore.openForProject(storePath, PROJECT);
  installTestRecoveryBinding(setup);
  const ref = commitRevision(setup);
  setup.close();
  const provider = createStoreDependencies({
    clock: () => DECIDED_AT, credential: OPERATOR_CREDENTIAL, principalId: OPERATOR,
    projectId: PROJECT, storePath,
  });
  let listener: ControlRoomListener | null = null;
  try {
    const deps = provider.provide();
    const handshake = provider.sessionHandshake;
    if (handshake === undefined) throw new Error("the provider wires no pairing handshake");
    const started = await startControlRoomListener({
      csrfToken: CSRF, deps, pairing: handshake(), pairingMonotonicNow: () => NOW,
    });
    if (!started.ok) throw new Error(`listener refused: ${started.code}`);
    listener = started;
    const requested = await post(listener, "/session/pair/request", {});
    const label = requested.body["confirmationLabel"];
    const requestId = requested.body["requestId"];
    if (typeof label !== "string" || typeof requestId !== "string") {
      throw new Error("pairing request omitted its identity");
    }
    expect(listener.approvePairing(label)).toEqual({ ok: true, state: "APPROVED" });
    const claimed = await post(listener, "/session/pair/claim", { requestId });
    expect(claimed.status).toBe(200);
    const credential = claimed.body["sessionCredential"];
    if (typeof credential !== "string") throw new Error("pairing claim omitted its credential");
    const authenticated = deps.authenticator.authenticate(credential);
    if (authenticated.verdict !== "AUTHENTICATED") throw new Error("paired credential refused");
    const sessionId = authenticated.principal.principalId;
    const gate = productContractGate1Authority(ref);
    const commandId = "approve-product-contract-gate-1-reader";
    const outcome = handleCommandRequest(deps, {
      body: commandBytes(commandId, credential, ref, gate.workRef),
      credential,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "MCP_STDIO");
    expect(outcome).toMatchObject({
      decision: { resultCode: "EFFECTS_COMMITTED" }, outcome: "ACCEPTED",
    });
    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      const events = reader.readEvents(deriveProductContractGate1AggregateId(gate.workRef));
      expect(events).toHaveLength(1);
      const payload = new Uint8Array(events[0]!.payload);
      return Object.freeze({ directory, gate, payload, ref, sessionId, storePath });
    } finally {
      reader.close();
    }
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  } finally {
    if (listener !== null) await listener.close();
    provider.close();
  }
}

function withStore<T>(run: (store: SqliteEventStore) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-gate-1-reader-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  try {
    return run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function seed(
  store: SqliteEventStore, aggregateId: string, payload: Uint8Array,
  options: { eventCount?: number; eventType?: string; schema?: string } = {},
): void {
  seedOrdinal += 1;
  store.commitExpectedVersionDecision({
    commandKind: "product-contract.gate-1.reader.test-seed",
    committedResultBytes: payload,
    correlationId: `seed-correlation-${seedOrdinal}`,
    decidedAt: DECIDED_AT,
    events: Array.from({ length: options.eventCount ?? 1 }, (_, index) => ({
      domainSchemaVersion: options.schema ?? PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
      eventId: `reader-seed-event-${seedOrdinal}-${index}`,
      eventType: options.eventType ?? PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
      payload,
    })),
    expectedVersion: 0,
    key: {
      commandId: `reader-seed-command-${seedOrdinal}`,
      principalId: OPERATOR,
      projectId: PROJECT,
    },
    requestBytes: payload,
    targetAggregateId: aggregateId,
  });
}

function malformedPayload(): Uint8Array {
  const record = JSON.parse(decoder.decode(fixture.payload)) as Record<string, unknown>;
  delete record["gateId"];
  return encoder.encode(JSON.stringify(record));
}

function overrideStore(
  store: SqliteEventStore, overrides: Readonly<Record<string, unknown>>,
): SqliteEventStore {
  return new Proxy(store, { get(target, key) {
    if (typeof key === "string" && key in overrides) return overrides[key];
    const value = Reflect.get(target, key, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function throwingStore(store: SqliteEventStore, error: Error): SqliteEventStore {
  return overrideStore(store, { readEvents: () => { throw error; } });
}

function withLawfulStore<T>(run: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(fixture.storePath, PROJECT);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

/**
 * A generic append with NO scoped command decision — the hostile shape the
 * envelope checks alone cannot tell apart from a lawful writer record.
 */
function directCommit(store: SqliteEventStore, aggregateId: string, payload: Uint8Array): void {
  seedOrdinal += 1;
  store.commit({
    aggregateId,
    commandBytes: payload,
    commandId: `reader-direct-command-${seedOrdinal}`,
    committedAt: DECIDED_AT,
    events: [{
      domainSchemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
      eventId: `reader-direct-event-${seedOrdinal}`,
      eventType: PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
      payload,
    }],
    expectedVersion: 0,
  });
}

function lawfulEvent(store: SqliteEventStore): StoredEvent {
  const events = store.readEvents(deriveProductContractGate1AggregateId(fixture.gate.workRef));
  const event = events[0];
  if (event?.decisionTrace === undefined) {
    throw new Error("the lawful writer event carries no decision trace");
  }
  return event;
}

function lawfulDecision(store: SqliteEventStore): CommandDecisionRecord {
  const trace = lawfulEvent(store).decisionTrace;
  if (trace === undefined) throw new Error("the lawful writer event carries no decision trace");
  const decision = store.getCommandDecision({
    commandId: trace.commandId, principalId: trace.principalId, projectId: PROJECT,
  });
  if (decision === null) throw new Error("the lawful writer decision is unreadable");
  return decision;
}

beforeAll(async () => {
  fixture = await createLawfulFixture();
});

afterAll(() => {
  rmSync(fixture.directory, { force: true, recursive: true });
});

describe("durable Product Contract Gate 1 approval reader", () => {
  it("pins the exact nonzero reader refusal roster", () => {
    expect(PRODUCT_CONTRACT_GATE_1_READER_CODES).toEqual([
      "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT",
      "PRODUCT_CONTRACT_GATE_1_APPROVAL_AMBIGUOUS",
      "PRODUCT_CONTRACT_GATE_1_EVENT_UNEXPECTED",
      "PRODUCT_CONTRACT_GATE_1_SCHEMA_UNSUPPORTED",
      "PRODUCT_CONTRACT_GATE_1_RECORD_MALFORMED",
      "PRODUCT_CONTRACT_GATE_1_WORK_IDENTITY_MISMATCH",
      "PRODUCT_CONTRACT_GATE_1_PROVENANCE_ABSENT",
      "PRODUCT_CONTRACT_GATE_1_COMMAND_KIND_MISMATCH",
      "PRODUCT_CONTRACT_GATE_1_DECISION_UNRESOLVED",
      "PRODUCT_CONTRACT_GATE_1_RECEIPT_UNBOUND",
    ]);
    expect(PRODUCT_CONTRACT_GATE_1_READER_CODES).toHaveLength(10);
    expect(Object.isFrozen(PRODUCT_CONTRACT_GATE_1_READER_CODES)).toBe(true);
  });

  it("reads the exact approval written from a real paired HUMAN bearer", () => {
    withLawfulStore((store) => {
      const result = readProductContractGate1Approval(store, {
        projectId: PROJECT, ref: fixture.ref,
      });
      expect(result).toEqual({
        gate: {
          gateId: fixture.gate.gateId,
          grant: {
            gateId: fixture.gate.gateId,
            grantedAtEpochMs: NOW,
            principalId: fixture.sessionId,
            principalKind: "HUMAN",
            workRef: fixture.gate.workRef,
          },
          workRef: fixture.gate.workRef,
        },
        ok: true,
        ref: fixture.ref,
      });
      if (!result.ok) throw new Error(`lawful approval refused: ${result.code}`);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.ref)).toBe(true);
      expect(Object.isFrozen(result.gate)).toBe(true);
      expect(Object.isFrozen(result.gate.grant)).toBe(true);
    });
  });

  const localCases = [
    ["absent", "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT", READER_LAYER,
      () => withStore((store) => readProductContractGate1Approval(store, {
        projectId: PROJECT, ref: fixture.ref,
      }))],
    ["ambiguous", "PRODUCT_CONTRACT_GATE_1_APPROVAL_AMBIGUOUS", READER_LAYER,
      () => withStore((store) => {
        seed(store, deriveProductContractGate1AggregateId(fixture.gate.workRef), fixture.payload,
          { eventCount: 2 });
        return readProductContractGate1Approval(store, { projectId: PROJECT, ref: fixture.ref });
      })],
    ["foreign event", "PRODUCT_CONTRACT_GATE_1_EVENT_UNEXPECTED", READER_LAYER,
      () => withStore((store) => {
        seed(store, deriveProductContractGate1AggregateId(fixture.gate.workRef), fixture.payload,
          { eventType: "ForeignEvent" });
        return readProductContractGate1Approval(store, { projectId: PROJECT, ref: fixture.ref });
      })],
    ["unsupported schema", "PRODUCT_CONTRACT_GATE_1_SCHEMA_UNSUPPORTED", READER_LAYER,
      () => withStore((store) => {
        seed(store, deriveProductContractGate1AggregateId(fixture.gate.workRef), fixture.payload,
          { schema: "moe-product-contract-gate-1/999" });
        return readProductContractGate1Approval(store, { projectId: PROJECT, ref: fixture.ref });
      })],
    ["malformed record", "PRODUCT_CONTRACT_GATE_1_RECORD_MALFORMED", READER_LAYER,
      () => withStore((store) => {
        seed(store, deriveProductContractGate1AggregateId(fixture.gate.workRef), malformedPayload());
        return readProductContractGate1Approval(store, { projectId: PROJECT, ref: fixture.ref });
      })],
    ["durable store", "STORE_BUSY", "DURABLE_STORE",
      () => withStore((store) => readProductContractGate1Approval(
        throwingStore(store, new DurableStoreError("STORE_BUSY", "reader is contended")),
        { projectId: PROJECT, ref: fixture.ref },
      ))],
    ["unexpected storage", "STORAGE_DEGRADED", READER_LAYER,
      () => withStore((store) => readProductContractGate1Approval(
        throwingStore(store, new Error("unexpected read failure")),
        { projectId: PROJECT, ref: fixture.ref },
      ))],
  ] as const;

  it("pins a nonzero refusal matrix", () => {
    expect(localCases).toHaveLength(7);
    expect(new Set(localCases.map(([name]) => name)).size).toBe(localCases.length);
  });

  it.each(localCases)("refuses %s with its exact code and layer", (_name, code, layer, run) => {
    expect(run()).toEqual({ code, layer, ok: false });
  });

  it("keeps a lawful approval on its own work identity", () => withStore((store) => {
    const otherRef = commitRevision(store, "revision-product-contract-gate-1-other");
    const otherGate = productContractGate1Authority(otherRef);
    seed(store, deriveProductContractGate1AggregateId(otherGate.workRef), fixture.payload);
    expect(readProductContractGate1Approval(store, { projectId: PROJECT, ref: otherRef })).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_WORK_IDENTITY_MISMATCH",
      layer: READER_LAYER,
      ok: false,
    });
  }));

  it("does not return an approval written for foreign work", () => withStore((store) => {
    const otherRef = commitRevision(store, "revision-product-contract-gate-1-foreign");
    expect(readProductContractGate1Approval(store, { projectId: PROJECT, ref: otherRef })).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT",
      layer: READER_LAYER,
      ok: false,
    });
  }));
});

/**
 * The durable shape is not the mint: an envelope-valid record that never
 * traversed `product_contract.approve_gate_1` must refuse. Every arm below is
 * byte-valid at the envelope layer and reaches the provenance leg, so each one
 * pins a mechanism the shape checks alone cannot see.
 */
describe("Gate 1 approval writer provenance", () => {
  it("refuses a direct store commit that never traversed the writer", () => withStore((store) => {
    directCommit(store, deriveProductContractGate1AggregateId(fixture.gate.workRef),
      fixture.payload);
    expect(readProductContractGate1Approval(store, { projectId: PROJECT, ref: fixture.ref }))
      .toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_PROVENANCE_ABSENT", layer: READER_LAYER, ok: false,
      });
  }));

  it("refuses an envelope-valid record decided under a foreign command kind",
    () => withStore((store) => {
      seed(store, deriveProductContractGate1AggregateId(fixture.gate.workRef), fixture.payload);
      expect(readProductContractGate1Approval(store, { projectId: PROJECT, ref: fixture.ref }))
        .toEqual({
          code: "PRODUCT_CONTRACT_GATE_1_COMMAND_KIND_MISMATCH", layer: READER_LAYER, ok: false,
        });
    }));

  it("binds the trace to the reading project", () => withLawfulStore((store) => {
    expect(readProductContractGate1Approval(store, {
      projectId: "proj-product-contract-gate-1-reader-foreign", ref: fixture.ref,
    })).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_DECISION_UNRESOLVED", layer: READER_LAYER, ok: false,
    });
  }));

  it("refuses when no accepted decision resolves the trace", () => withLawfulStore((store) => {
    expect(readProductContractGate1Approval(
      overrideStore(store, { getCommandDecision: () => null }),
      { projectId: PROJECT, ref: fixture.ref },
    )).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_DECISION_UNRESOLVED", layer: READER_LAYER, ok: false,
    });
  }));

  it("refuses a decision that disagrees with the stored event", () => withLawfulStore((store) => {
    const disagreeing: CommandDecisionRecord = {
      ...lawfulDecision(store), targetAggregateId: "aggregate-that-is-not-the-events",
    };
    expect(readProductContractGate1Approval(
      overrideStore(store, { getCommandDecision: () => disagreeing }),
      { projectId: PROJECT, ref: fixture.ref },
    )).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_DECISION_UNRESOLVED", layer: READER_LAYER, ok: false,
    });
  }));

  it("refuses when no receipt binds the decision to the event", () => withLawfulStore((store) => {
    expect(readProductContractGate1Approval(
      overrideStore(store, { getCommandReceipt: () => null }),
      { projectId: PROJECT, ref: fixture.ref },
    )).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_RECEIPT_UNBOUND", layer: READER_LAYER, ok: false,
    });
  }));

  it("refuses a receipt bound to a foreign event", () => withLawfulStore((store) => {
    const receipt = store.getCommandReceipt(lawfulEvent(store).commandId);
    if (receipt === null) throw new Error("the lawful writer receipt is unreadable");
    const disagreeing: CommandReceipt = { ...receipt, eventIds: ["event-that-is-not-the-approval"] };
    expect(readProductContractGate1Approval(
      overrideStore(store, { getCommandReceipt: () => disagreeing }),
      { projectId: PROJECT, ref: fixture.ref },
    )).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_RECEIPT_UNBOUND", layer: READER_LAYER, ok: false,
    });
  }));

  it("surfaces the store's own code when the decision lookup fails",
    () => withLawfulStore((store) => {
      expect(readProductContractGate1Approval(
        overrideStore(store, {
          getCommandDecision: () => { throw new DurableStoreError("STORE_BUSY", "contended"); },
        }),
        { projectId: PROJECT, ref: fixture.ref },
      )).toEqual({ code: "STORE_BUSY", layer: "DURABLE_STORE", ok: false });
    }));
});
