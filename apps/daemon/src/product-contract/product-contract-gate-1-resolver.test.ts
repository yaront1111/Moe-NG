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
import type { StoredEvent } from "@moe/store";
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
import { resolveProductContractGate1 } from "./product-contract-gate-1-resolver.js";
import { commitProductContractRevision } from "./product-contract-revision-store.js";

const PROJECT = "proj-product-contract-gate-1-resolver";
const OPERATOR = "operator-product-contract-gate-1-resolver";
const OPERATOR_CREDENTIAL = "operator-credential-product-contract-gate-1-resolver";
const CSRF = "csrf-product-contract-gate-1-resolver";
const DECIDED_AT = "2026-08-30T12:30:00.000Z";
const NOW = Date.parse(DECIDED_AT);
const READER_LAYER = "PRODUCT_CONTRACT_GATE_1_READER";
const REVISION_READER_LAYER = "PRODUCT_CONTRACT_REVISION_READER";
const AUTHORITY_LAYER = "HUMAN_AUTHORITY_GATE";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let seedOrdinal = 0;

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

interface Fixture {
  readonly directory: string;
  readonly gate: HumanAuthorityGate;
  readonly payload: Uint8Array;
  readonly ref: ProductContractRevisionRef;
  readonly sessionId: string;
  readonly storePath: string;
}

/** The lawfully approved revision, durably committed in the SAME store. */
let lawful: Fixture;
/** A lawful approval over a REAL ref whose revision was never committed here. */
let unbacked: Fixture;

function draft(revisionId: string): ProductContractRevisionDraft {
  return {
    authorRef: OPERATOR,
    contractId: "contract-product-contract-gate-1-resolver",
    criteria: [{
      criterionId: "criterion-product-contract-gate-1-resolver",
      requirementId: "requirement-product-contract-gate-1-resolver",
      statement: "A paired human grants Gate 1 authority.",
      supersedesCriterionId: null,
    }],
    lineage: null,
    requirements: [{
      requirementId: "requirement-product-contract-gate-1-resolver",
      statement: "Gate 1 authority is resolved from the durable writer record.",
      supersedesRequirementId: null,
    }],
    retiredCriterionIds: [],
    retiredRequirementIds: [],
    revisionId,
    sourceDocumentDigests: ["a".repeat(64)],
  };
}

function commitRevision(store: SqliteEventStore, revisionId: string): ProductContractRevisionRef {
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

/**
 * A REAL ref with no durable revision behind the store under test: the digest is
 * derived by a real `commitProductContractRevision` in a throwaway store, never
 * hand-built, and that store is discarded before the approval is written.
 */
function refFromDiscardedStore(revisionId: string): ProductContractRevisionRef {
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-gate-1-resolver-ref-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  try {
    return commitRevision(store, revisionId);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

async function post(listener: ControlRoomListener, path: string, body: unknown): Promise<Reply> {
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

/**
 * The whole point of this row: the approval under test is written by the REAL
 * pairing route (request -> operator approval -> claim) presenting its bearer at
 * the production Gate 1 command. Nothing here hand-builds a revision, a digest,
 * a grant or a gate.
 */
async function createFixture(options: {
  readonly revisionId: string; readonly withRevision: boolean;
}): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-gate-1-resolver-"));
  const storePath = join(directory, "store.db");
  const setup = SqliteEventStore.openForProject(storePath, PROJECT);
  installTestRecoveryBinding(setup);
  const ref = options.withRevision
    ? commitRevision(setup, options.revisionId)
    : refFromDiscardedStore(options.revisionId);
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
    const commandId = `approve-gate-1-resolver-${options.revisionId}`;
    expect(handleCommandRequest(deps, {
      body: commandBytes(commandId, credential, ref, gate.workRef),
      credential,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    }, "MCP_STDIO")).toMatchObject({ decision: { resultCode: "EFFECTS_COMMITTED" }, outcome: "ACCEPTED" });
    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      const events = reader.readEvents(deriveProductContractGate1AggregateId(gate.workRef));
      expect(events).toHaveLength(1);
      return Object.freeze({
        directory, gate, payload: new Uint8Array(events[0]!.payload), ref, sessionId, storePath,
      });
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
  const directory = mkdtempSync(join(tmpdir(), "moe-product-contract-gate-1-resolver-empty-"));
  const store = SqliteEventStore.openForProject(join(directory, "store.db"), PROJECT);
  try {
    return run(store);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function withFixtureStore<T>(fixture: Fixture, run: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(fixture.storePath, PROJECT);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function seed(store: SqliteEventStore, aggregateId: string, payload: Uint8Array): void {
  seedOrdinal += 1;
  store.commitExpectedVersionDecision({
    commandKind: "product-contract.gate-1.resolver.test-seed",
    committedResultBytes: payload,
    correlationId: `seed-correlation-${seedOrdinal}`,
    decidedAt: DECIDED_AT,
    events: [{
      domainSchemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
      eventId: `resolver-seed-event-${seedOrdinal}`,
      eventType: PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
      payload,
    }],
    expectedVersion: 0,
    key: {
      commandId: `resolver-seed-command-${seedOrdinal}`, principalId: OPERATOR, projectId: PROJECT,
    },
    requestBytes: payload,
    targetAggregateId: aggregateId,
  });
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

/**
 * Rewrites ONLY the stored grant of the lawful approval, leaving the event's
 * decision trace, decision and receipt intact — so the record still clears the
 * reader's writer-provenance leg and the grant-internal question is answered by
 * core, which is exactly what these arms are pinning.
 */
function withMutatedGrant(
  fixture: Fixture, store: SqliteEventStore, mutate: (grant: Record<string, unknown>) => void,
): SqliteEventStore {
  const approvalAggregate = deriveProductContractGate1AggregateId(fixture.gate.workRef);
  return overrideStore(store, {
    readEvents: (aggregateId: string): readonly StoredEvent[] => {
      const events = store.readEvents(aggregateId);
      if (aggregateId !== approvalAggregate) return events;
      return events.map((event) => {
        const record = JSON.parse(decoder.decode(event.payload)) as Record<string, unknown>;
        mutate(record["grant"] as Record<string, unknown>);
        return { ...event, payload: encoder.encode(JSON.stringify(record)) };
      });
    },
  });
}

beforeAll(async () => {
  lawful = await createFixture({
    revisionId: "revision-product-contract-gate-1-resolver-lawful", withRevision: true,
  });
  unbacked = await createFixture({
    revisionId: "revision-product-contract-gate-1-resolver-unbacked", withRevision: false,
  });
}, 60_000);

afterAll(() => {
  rmSync(lawful.directory, { force: true, recursive: true });
  rmSync(unbacked.directory, { force: true, recursive: true });
});

describe("Product Contract Gate 1 resolver", () => {
  it("answers core's own verdict for a durable human grant over a durable revision",
    () => withFixtureStore(lawful, (store) => {
      expect(resolveProductContractGate1(store, { projectId: PROJECT, ref: lawful.ref })).toEqual({
        advisoryOnly: true, gate: "GATE_1", ok: true, revisionDigest: lawful.ref.revisionDigest,
      });
    }));

  it("forwards the approval reader's ABSENT verbatim when only a revision exists",
    () => withStore((store) => {
      const ref = commitRevision(store, "revision-product-contract-gate-1-resolver-ungranted");
      expect(resolveProductContractGate1(store, { projectId: PROJECT, ref })).toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT", layer: READER_LAYER, ok: false,
      });
    }));

  it("forwards the revision reader's ABSENT verbatim when the approved revision is not durable",
    () => withFixtureStore(unbacked, (store) => {
      expect(resolveProductContractGate1(store, { projectId: PROJECT, ref: unbacked.ref })).toEqual({
        code: "PRODUCT_CONTRACT_REVISION_ABSENT", layer: REVISION_READER_LAYER, ok: false,
      });
    }));

  it("lets core refuse an AGENT-kind grant, with no daemon restatement",
    () => withFixtureStore(lawful, (store) => {
      const mutated = withMutatedGrant(lawful, store, (grant) => { grant["principalKind"] = "AGENT"; });
      expect(resolveProductContractGate1(mutated, { projectId: PROJECT, ref: lawful.ref })).toEqual({
        code: "APPROVAL_PRINCIPAL_NOT_HUMAN", layer: AUTHORITY_LAYER, ok: false,
      });
    }));

  it("lets core refuse an invalid grant moment, with no daemon restatement",
    () => withFixtureStore(lawful, (store) => {
      const mutated = withMutatedGrant(lawful, store, (grant) => { grant["grantedAtEpochMs"] = -1; });
      expect(resolveProductContractGate1(mutated, { projectId: PROJECT, ref: lawful.ref })).toEqual({
        code: "APPROVAL_GRANT_MOMENT_INVALID", layer: AUTHORITY_LAYER, ok: false,
      });
    }));

  it("lets core refuse a grant bound to other work, with no daemon restatement",
    () => withFixtureStore(lawful, (store) => {
      const mutated = withMutatedGrant(lawful, store, (grant) => {
        grant["workRef"] = `${String(grant["workRef"])}-carried-elsewhere`;
      });
      expect(resolveProductContractGate1(mutated, { projectId: PROJECT, ref: lawful.ref })).toEqual({
        code: "APPROVAL_AUTHORITY_BINDING_MISMATCH", layer: AUTHORITY_LAYER, ok: false,
      });
    }));

  it("refuses a transplanted record at the reader's layer, never reaching core",
    () => withStore((store) => {
      const ref = commitRevision(store, "revision-product-contract-gate-1-resolver-transplant");
      const gate = productContractGate1Authority(ref);
      seed(store, deriveProductContractGate1AggregateId(gate.workRef), lawful.payload);
      expect(resolveProductContractGate1(store, { projectId: PROJECT, ref })).toEqual({
        code: "PRODUCT_CONTRACT_GATE_1_WORK_IDENTITY_MISMATCH", layer: READER_LAYER, ok: false,
      });
    }));

  /**
   * DoD 3's "no caller can invoke a public minter to satisfy the gate" is
   * enforced by the SIGNATURE, and both halves of each arm below are DIVERGENT
   * by construction: the forged gate would flip the answer if the resolver ever
   * preferred it. The `@ts-expect-error` is the static half — each directive is
   * well-typed apart from the excess property, so it goes UNUSED (TS2578, daemon
   * typecheck red) the moment the input widens to accept a gate.
   */
  it("ignores a forged SATISFIED gate when no approval was written", () => withStore((store) => {
    const ref = commitRevision(store, "revision-product-contract-gate-1-resolver-forged-satisfied");
    const unsatisfied = productContractGate1Authority(ref);
    const forgedGate: HumanAuthorityGate = {
      gateId: unsatisfied.gateId,
      grant: {
        gateId: unsatisfied.gateId, grantedAtEpochMs: NOW, principalId: "forged-principal",
        principalKind: "HUMAN", workRef: unsatisfied.workRef,
      },
      workRef: unsatisfied.workRef,
    };
    expect(resolveProductContractGate1(store, {
      // @ts-expect-error the resolver takes no gate parameter: a caller presents no authority
      gate: forgedGate,
      projectId: PROJECT,
      ref,
    })).toEqual({
      code: "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT", layer: READER_LAYER, ok: false,
    });
  }));

  it("ignores a forged UNSATISFIED gate over a lawful durable approval",
    () => withFixtureStore(lawful, (store) => {
      const forgedGate: HumanAuthorityGate = productContractGate1Authority(lawful.ref);
      expect(forgedGate.grant).toBeNull();
      expect(resolveProductContractGate1(store, {
        // @ts-expect-error the resolver takes no gate parameter: a caller presents no authority
        gate: forgedGate,
        projectId: PROJECT,
        ref: lawful.ref,
      })).toEqual({
        advisoryOnly: true, gate: "GATE_1", ok: true, revisionDigest: lawful.ref.revisionDigest,
      });
    }));

  it("forwards the store's own code under the durable store layer", () => withStore((store) => {
    const ref = commitRevision(store, "revision-product-contract-gate-1-resolver-degraded");
    const contended = overrideStore(store, {
      readEvents: () => { throw new DurableStoreError("STORE_BUSY", "resolver is contended"); },
    });
    expect(resolveProductContractGate1(contended, { projectId: PROJECT, ref })).toEqual({
      code: "STORE_BUSY", layer: "DURABLE_STORE", ok: false,
    });
  }));
});
