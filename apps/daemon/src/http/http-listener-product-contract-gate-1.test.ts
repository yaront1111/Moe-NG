import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import {
  productContractGate1Authority,
  type HumanAuthorityGate, type ProductContractRevisionDraft, type ProductContractRevisionRef,
} from "@moe/core";
import { DurableStoreError, SqliteEventStore } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { installTestRecoveryBinding } from "../identity/session-test-fixtures.js";
import {
  PRODUCT_CONTRACT_GATE_1_COMMAND_KIND, PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
  PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION, deriveProductContractGate1AggregateId,
  productContractGate1SubjectDigest,
} from "../product-contract/product-contract-gate-1-contract.js";
import {
  commitProductContractRevision,
} from "../product-contract/product-contract-revision-store.js";
import { handleCommandRequest } from "./http-adapter.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import type { AuthenticationResult, CommandAdapterDeps } from "./http-contract.js";
import { startControlRoomListener } from "./http-listener.js";
import type { ControlRoomListener } from "./http-listener.js";
import {
  PRODUCT_CONTRACT_GATE_1_READ_CODES, PRODUCT_CONTRACT_GATE_1_READ_PATH,
  createProductContractGate1ReadPort,
} from "./product-contract-gate-1-read.js";
import type { ProductContractGate1ReadPort } from "./product-contract-gate-1-read.js";

/**
 * task-8e62300c: the consumer edge that makes P2.10a's Gate 1 resolver reachable
 * from outside `apps/daemon/src/product-contract`.
 *
 * The lawful session is minted through the REAL pairing route (request ->
 * operator approval -> claim). Its bearer is refused at the browser transport,
 * then the identical request is admitted through the surviving MCP stdio origin.
 * Nothing here hand-builds a revision, digest, grant or gate: the arms below
 * measure what the production command and HTTP read route do with durable state
 * they did not author.
 */

const PROJECT = "proj-listener-product-contract-gate-1";
const FOREIGN_PROJECT = "proj-listener-product-contract-gate-1-foreign";
const OPERATOR = "operator-listener-product-contract-gate-1";
const OPERATOR_CREDENTIAL = "operator-credential-listener-product-contract-gate-1";
const CSRF = "csrf-listener-product-contract-gate-1";
const CREDENTIAL = "listener-product-contract-gate-1-session";
const NO_CAPABILITY_CREDENTIAL = "listener-product-contract-gate-1-readonly";
const FOREIGN_PROJECT_CREDENTIAL = "listener-product-contract-gate-1-foreign";
const DECIDED_AT = "2026-08-30T13:00:00.000Z";
const NOW = Date.parse(DECIDED_AT);

const READ_LAYER = "PRODUCT_CONTRACT_GATE_1_READ";
const READER_LAYER = "PRODUCT_CONTRACT_GATE_1_READER";
const AUTHORITY_LAYER = "HUMAN_AUTHORITY_GATE";
const LISTENER_LAYER = "CONTROL_ROOM_LISTENER";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The seven upstream refusals this route forwards VERBATIM, one per arm below,
 * spanning every owner above it: core's ref admission (PROVENANCE), core's
 * authority gate, the approval reader, and the durable store. The roster exists
 * so deleting an arm and its entry cannot quietly shrink what "forwards
 * verbatim" is proven to mean.
 */
const FORWARDED_REFUSALS = Object.freeze([
  "APPROVAL_AUTHORITY_BINDING_MISMATCH",
  "APPROVAL_PRINCIPAL_NOT_HUMAN",
  "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT",
  "PRODUCT_CONTRACT_GATE_1_WORK_IDENTITY_MISMATCH",
  "PRODUCT_CONTRACT_PROVENANCE_INVALID",
  "STORAGE_DEGRADED",
  "STORE_BUSY",
] as const);

/**
 * The body keys a caller might use to present its own authority. Every one is
 * refused by the LISTENER before the port is asked, so the resolver is never
 * put in the position of having to ignore them.
 */
const FORGED_KEYS = Object.freeze([
  "gate", "grant", "grantedAt", "principalId", "revision",
] as const);

interface Reply {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}

interface Fixture {
  readonly directory: string;
  readonly gate: HumanAuthorityGate;
  readonly grantPayload: Uint8Array;
  readonly lawfulRef: ProductContractRevisionRef;
  readonly storePath: string;
  readonly transplantRef: ProductContractRevisionRef;
  readonly ungrantedRef: ProductContractRevisionRef;
}

let fixture: Fixture;
const listeners: ControlRoomListener[] = [];
const stores: SqliteEventStore[] = [];
let seedOrdinal = 0;

function draft(revisionId: string): ProductContractRevisionDraft {
  return {
    authorRef: OPERATOR,
    contractId: "contract-listener-product-contract-gate-1",
    criteria: [{
      criterionId: "criterion-listener-product-contract-gate-1",
      requirementId: "requirement-listener-product-contract-gate-1",
      statement: "A paired human grants Gate 1 authority.",
      supersedesCriterionId: null,
    }],
    lineage: null,
    requirements: [{
      requirementId: "requirement-listener-product-contract-gate-1",
      statement: "Gate 1 is readable over HTTP from durable state alone.",
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
  if (!committed.ok) throw new Error(`revision fixture refused: ${committed.code}`);
  return committed.ref;
}

async function readReply(
  listener: ControlRoomListener, path: string, method: string,
  headers: Record<string, string>, payload: string,
): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(listener.origin + path, { headers, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: (text === "" ? {} : JSON.parse(text)) as Readonly<Record<string, unknown>>,
          status: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

async function post(
  listener: ControlRoomListener,
  options: {
    readonly body?: unknown;
    readonly credential?: string | null;
    readonly method?: string;
  } = {},
): Promise<Reply> {
  const payload = JSON.stringify(options.body ?? {});
  const headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  };
  if (options.credential !== null) {
    headers["x-moe-session-credential"] = options.credential ?? CREDENTIAL;
  }
  return await readReply(
    listener, PRODUCT_CONTRACT_GATE_1_READ_PATH, options.method ?? "POST", headers, payload,
  );
}

async function pair(listener: ControlRoomListener, path: string, body: unknown): Promise<Reply> {
  const payload = JSON.stringify(body);
  return await readReply(listener, path, "POST", {
    "content-length": String(Buffer.byteLength(payload)),
    "content-type": "application/json",
    host: `127.0.0.1:${String(listener.port)}`,
    origin: listener.origin,
    "x-moe-csrf": CSRF,
    "x-moe-protocol-version": WIRE_PROTOCOL_VERSION,
  }, payload);
}

function authentication(credential: string | null): AuthenticationResult {
  if (credential === CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.GOAL], principalId: "operator-local", projectId: PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === NO_CAPABILITY_CREDENTIAL) {
    return {
      principal: { capabilities: [], principalId: "reader", projectId: PROJECT },
      verdict: "AUTHENTICATED",
    };
  }
  if (credential === FOREIGN_PROJECT_CREDENTIAL) {
    return {
      principal: {
        capabilities: [CAPABILITIES.GOAL], principalId: "foreign-reader",
        projectId: FOREIGN_PROJECT,
      },
      verdict: "AUTHENTICATED",
    };
  }
  return { verdict: "UNAUTHENTICATED" };
}

/**
 * A listener whose ONLY wired collaborator is the route under test: the decision
 * port and the command registry throw, so an arm that reached either would fail
 * loudly rather than pass for the wrong reason.
 */
async function start(port?: ProductContractGate1ReadPort): Promise<ControlRoomListener> {
  const deps: CommandAdapterDeps = {
    authenticator: { authenticate: authentication },
    decisions: {
      decide: (): never => { throw new Error("gate 1 read entered the decision port"); },
    },
    registry: {
      get: (): never => { throw new Error("gate 1 read entered the command registry"); },
    },
  } as unknown as CommandAdapterDeps;
  const started = await startControlRoomListener({
    csrfToken: CSRF,
    deps,
    ...(port === undefined ? {} : { productContractGate1: port }),
  });
  if (!started.ok) throw new Error(`listener refused: ${started.code}`);
  listeners.push(started);
  return started;
}

function openFixtureStore(): SqliteEventStore {
  const store = SqliteEventStore.openForProject(fixture.storePath, PROJECT);
  stores.push(store);
  return store;
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
 * Rewrites ONLY the stored grant, leaving the decision trace, decision and
 * receipt intact — so the record still clears the reader's writer-provenance leg
 * and the grant-internal question is answered by core. The recipe is owned by
 * product-contract-gate-1-resolver.test.ts; this suite replicates the store
 * mutation, never the adjudication.
 */
function withMutatedGrant(
  store: SqliteEventStore, mutate: (grant: Record<string, unknown>) => void,
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

function seedGrant(store: SqliteEventStore, aggregateId: string, payload: Uint8Array): void {
  seedOrdinal += 1;
  store.commitExpectedVersionDecision({
    commandKind: "product-contract.gate-1.listener.test-seed",
    committedResultBytes: payload,
    correlationId: `listener-seed-correlation-${String(seedOrdinal)}`,
    decidedAt: DECIDED_AT,
    events: [{
      domainSchemaVersion: PRODUCT_CONTRACT_GATE_1_SCHEMA_VERSION,
      eventId: `listener-seed-event-${String(seedOrdinal)}`,
      eventType: PRODUCT_CONTRACT_GATE_1_EVENT_TYPE,
      payload,
    }],
    expectedVersion: 0,
    key: {
      commandId: `listener-seed-command-${String(seedOrdinal)}`,
      principalId: OPERATOR,
      projectId: PROJECT,
    },
    requestBytes: payload,
    targetAggregateId: aggregateId,
  });
}

function commandBytes(
  commandId: string, sessionCredential: string, ref: ProductContractRevisionRef, workRef: string,
): Uint8Array {
  const requestDigest = productContractGate1SubjectDigest({
    commandId, projectId: PROJECT, workRef,
  });
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
    sessionCredential,
    targetAggregateId: `gate-1/${commandId}`,
  }));
}

async function buildFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "moe-listener-product-contract-gate-1-"));
  const storePath = join(directory, "store.db");
  const setup = SqliteEventStore.openForProject(storePath, PROJECT);
  let lawfulRef: ProductContractRevisionRef;
  let ungrantedRef: ProductContractRevisionRef;
  let transplantRef: ProductContractRevisionRef;
  try {
    installTestRecoveryBinding(setup);
    lawfulRef = commitRevision(setup, "revision-listener-product-contract-gate-1-lawful");
    ungrantedRef = commitRevision(setup, "revision-listener-product-contract-gate-1-ungranted");
    transplantRef = commitRevision(setup, "revision-listener-product-contract-gate-1-transplant");
  } finally {
    setup.close();
  }
  const provider = createStoreDependencies({
    clock: () => DECIDED_AT,
    credential: OPERATOR_CREDENTIAL,
    principalId: OPERATOR,
    projectId: PROJECT,
    storePath,
  });
  let pairingListener: ControlRoomListener | null = null;
  let fixtureResult: Fixture | undefined;
  let workSucceeded = false;
  try {
    const deps = provider.provide();
    const handshake = provider.sessionHandshake;
    if (handshake === undefined) throw new Error("the provider wires no pairing handshake");
    const started = await startControlRoomListener({
      csrfToken: CSRF, deps, pairing: handshake(), pairingMonotonicNow: () => NOW,
    });
    if (!started.ok) throw new Error(`pairing listener refused: ${started.code}`);
    pairingListener = started;
    const requested = await pair(started, "/session/pair/request", {});
    const label = requested.body["confirmationLabel"];
    const requestId = requested.body["requestId"];
    if (typeof label !== "string" || typeof requestId !== "string") {
      throw new Error("pairing request omitted its identity");
    }
    expect(started.approvePairing(label)).toEqual({ ok: true, state: "APPROVED" });
    const claimed = await pair(started, "/session/pair/claim", { requestId });
    expect(claimed.status).toBe(200);
    const credential = claimed.body["sessionCredential"];
    if (typeof credential !== "string") throw new Error("pairing claim omitted its credential");
    const gate = productContractGate1Authority(lawfulRef);
    const commandId = "listener-product-contract-gate-1-approve";
    const request = Object.freeze({
      body: commandBytes(commandId, credential, lawfulRef, gate.workRef),
      credential,
      protocolVersion: WIRE_PROTOCOL_VERSION,
    });
    // The BROWSER origin now admits the paired durable HUMAN principal (the
    // Gate 1 card's own wire, same ruling as approval.decide_intent). The very
    // first dispatch is the browser one and it COMMITS; every later origin,
    // MCP included, replays the identical durable decision.
    expect(handleCommandRequest(deps, request, "HTTP_LISTENER")).toMatchObject({
      decision: { disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED" },
      outcome: "ACCEPTED",
    });
    expect(handleCommandRequest(deps, request, "MCP_STDIO")).toMatchObject({
      decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
      outcome: "ACCEPTED",
    });
    expect(handleCommandRequest(deps, request, "HTTP_LISTENER")).toMatchObject({
      decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
      outcome: "ACCEPTED",
    });
    expect(handleCommandRequest(deps, request, "MCP_HTTP")).toMatchObject({
      decision: { disposition: "REPLAYED", resultCode: "EFFECTS_COMMITTED" },
      outcome: "ACCEPTED",
    });
    const reader = SqliteEventStore.openForProject(storePath, PROJECT);
    try {
      const events = reader.readEvents(deriveProductContractGate1AggregateId(gate.workRef));
      expect(events).toHaveLength(1);
      const stored = events[0];
      if (stored === undefined) throw new Error("the lawful grant vanished after commit");
      fixtureResult = Object.freeze({
        directory,
        gate,
        grantPayload: new Uint8Array(stored.payload),
        lawfulRef,
        storePath,
        transplantRef,
        ungrantedRef,
      });
    } finally {
      reader.close();
    }
    workSucceeded = true;
  } finally {
    let cleanupSucceeded = false;
    try {
      try {
        if (pairingListener !== null) await pairingListener.close();
      } finally {
        provider.close();
      }
      cleanupSucceeded = true;
    } finally {
      if (!workSucceeded || !cleanupSucceeded) {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  }
  if (fixtureResult === undefined) throw new Error("fixture construction produced no result");
  return fixtureResult;
}

beforeAll(async () => {
  fixture = await buildFixture();
}, 120_000);

afterAll(async () => {
  while (listeners.length > 0) await listeners.pop()?.close();
  while (stores.length > 0) stores.pop()?.close();
  if (fixture !== undefined) rmSync(fixture.directory, { force: true, recursive: true });
});

describe("POST /product-contract/gate-1/read", () => {
  it("answers core's own verdict for a durable human grant over a durable revision", async () => {
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: openFixtureStore(),
    }));
    const reply = await post(listener, { body: { ref: { ...fixture.lawfulRef } } });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      gate: {
        advisoryOnly: true,
        gate: "GATE_1",
        ok: true,
        revisionDigest: fixture.lawfulRef.revisionDigest,
      },
      outcome: "GATE",
    });
  });

  it("forwards the approval reader's ABSENT verbatim when no grant was written", async () => {
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: openFixtureStore(),
    }));
    const reply = await post(listener, { body: { ref: { ...fixture.ungrantedRef } } });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      code: "PRODUCT_CONTRACT_GATE_1_APPROVAL_ABSENT", layer: READER_LAYER, outcome: "REFUSED",
    });
  });

  it("lets core refuse an AGENT-kind grant, with no daemon restatement", async () => {
    const mutated = withMutatedGrant(openFixtureStore(), (grant) => {
      grant["principalKind"] = "AGENT";
    });
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: mutated,
    }));
    const reply = await post(listener, { body: { ref: { ...fixture.lawfulRef } } });
    expect(reply.body).toStrictEqual({
      code: "APPROVAL_PRINCIPAL_NOT_HUMAN", layer: AUTHORITY_LAYER, outcome: "REFUSED",
    });
  });

  it("lets core refuse a grant bound to other work, with no daemon restatement", async () => {
    const mutated = withMutatedGrant(openFixtureStore(), (grant) => {
      grant["workRef"] = `${String(grant["workRef"])}-carried-elsewhere`;
    });
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: mutated,
    }));
    const reply = await post(listener, { body: { ref: { ...fixture.lawfulRef } } });
    expect(reply.body).toStrictEqual({
      code: "APPROVAL_AUTHORITY_BINDING_MISMATCH", layer: AUTHORITY_LAYER, outcome: "REFUSED",
    });
  });

  it("forwards the reader's transplant refusal, never reaching core", async () => {
    const store = openFixtureStore();
    const transplantGate = productContractGate1Authority(fixture.transplantRef);
    seedGrant(
      store, deriveProductContractGate1AggregateId(transplantGate.workRef), fixture.grantPayload,
    );
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store,
    }));
    const reply = await post(listener, { body: { ref: { ...fixture.transplantRef } } });
    expect(reply.body).toStrictEqual({
      code: "PRODUCT_CONTRACT_GATE_1_WORK_IDENTITY_MISMATCH",
      layer: READER_LAYER,
      outcome: "REFUSED",
    });
  });

  it("forwards core's own admission refusal for a malformed ref", async () => {
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: openFixtureStore(),
    }));
    const reply = await post(listener, {
      body: {
        ref: {
          contractId: fixture.lawfulRef.contractId,
          revisionDigest: "not-a-digest",
          revisionId: fixture.lawfulRef.revisionId,
        },
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      code: "PRODUCT_CONTRACT_PROVENANCE_INVALID", layer: "PROVENANCE", outcome: "REFUSED",
    });
  });

  it("forwards seven distinct upstream refusal codes, one per arm above", () => {
    expect(FORWARDED_REFUSALS).toHaveLength(7);
    expect(new Set(FORWARDED_REFUSALS).size).toBe(FORWARDED_REFUSALS.length);
  });

  /** The route's own roster stays at exactly the two questions it may ask. */
  it("declares no route-local code beyond capability and project binding", () => {
    expect(PRODUCT_CONTRACT_GATE_1_READ_CODES).toStrictEqual([
      "PRODUCT_CONTRACT_GATE_1_READ_CAPABILITY_DENIED",
      "PRODUCT_CONTRACT_GATE_1_READ_PROJECT_MISMATCH",
    ]);
  });

  it("refuses a body that presents its own authority BEFORE the port is asked", async () => {
    const trap: ProductContractGate1ReadPort = Object.freeze({
      boundProjectId: PROJECT,
      readGate: (): never => { throw new Error("a forged body reached the resolver"); },
    });
    const listener = await start(trap);
    expect(FORGED_KEYS).toHaveLength(5);
    for (const key of FORGED_KEYS) {
      const reply = await post(listener, {
        body: { [key]: { forged: true }, ref: { ...fixture.lawfulRef } },
      });
      expect(reply.status).toBe(400);
      expect(reply.body).toStrictEqual({
        code: "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID", layer: LISTENER_LAYER,
      });
    }
  });

  it("refuses a caller without the goal capability at its own private layer", async () => {
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: openFixtureStore(),
    }));
    const reply = await post(listener, {
      body: { ref: { ...fixture.lawfulRef } }, credential: NO_CAPABILITY_CREDENTIAL,
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual({
      code: "PRODUCT_CONTRACT_GATE_1_READ_CAPABILITY_DENIED",
      layer: READ_LAYER,
      outcome: "REFUSED",
    });
  });

  it("refuses a caller bound to another project", async () => {
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: openFixtureStore(),
    }));
    const reply = await post(listener, {
      body: { ref: { ...fixture.lawfulRef } }, credential: FOREIGN_PROJECT_CREDENTIAL,
    });
    expect(reply.body).toStrictEqual({
      code: "PRODUCT_CONTRACT_GATE_1_READ_PROJECT_MISMATCH",
      layer: READ_LAYER,
      outcome: "REFUSED",
    });
  });

  it("refuses a non-POST method at the listener", async () => {
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: openFixtureStore(),
    }));
    const reply = await post(listener, { method: "GET" });
    expect(reply.status).toBe(400);
    expect(reply.body).toStrictEqual({
      code: "LISTENER_PRODUCT_CONTRACT_GATE_1_REQUEST_INVALID", layer: LISTENER_LAYER,
    });
  });

  it("refuses when the daemon wired no gate 1 port", async () => {
    const listener = await start();
    const reply = await post(listener, { body: { ref: { ...fixture.lawfulRef } } });
    expect(reply.status).toBe(503);
    expect(reply.body).toStrictEqual({
      code: "LISTENER_PRODUCT_CONTRACT_GATE_1_UNAVAILABLE", layer: LISTENER_LAYER,
    });
  });

  it("forwards the durable store's own code when the store refuses to answer", async () => {
    const contended = overrideStore(openFixtureStore(), {
      readEvents: (): never => { throw new DurableStoreError("STORE_BUSY", "route is contended"); },
    });
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: contended,
    }));
    const reply = await post(listener, { body: { ref: { ...fixture.lawfulRef } } });
    expect(reply.body).toStrictEqual({
      code: "STORE_BUSY", layer: "DURABLE_STORE", outcome: "REFUSED",
    });
  });

  /**
   * The throw that names nothing durable is classified UPSTREAM too, at the
   * reader's own layer. This arm is why the route declares no local "unreadable"
   * code: there is no store failure it would ever be reached for, and stamping
   * one would replace a stable upstream pair with a local invention.
   */
  it("forwards the reader's STORAGE_DEGRADED when the store throws no durable code", async () => {
    const broken = overrideStore(openFixtureStore(), {
      readEvents: (): never => { throw new TypeError("the store handle is gone"); },
    });
    const listener = await start(createProductContractGate1ReadPort({
      projectId: PROJECT, store: broken,
    }));
    const reply = await post(listener, { body: { ref: { ...fixture.lawfulRef } } });
    expect(reply.body).toStrictEqual({
      code: "STORAGE_DEGRADED", layer: READER_LAYER, outcome: "REFUSED",
    });
  });
});
