import { createHash } from "node:crypto";
import type { HttpDispatchContext } from "@moe/mcp";
import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import { createDaemonCommandPorts, OPERATOR_CAPABILITIES } from "./daemon-command-registry.js";
import { agentCapabilitiesFor } from "./daemon-command-vocabulary.js";
import { createSessionAuthenticator } from "./identity/session-authenticator.js";
import { createMcpDispatchPort } from "./mcp-dispatch-port.js";
import { streamPort } from "./http/event-stream-fixtures.js";
import { afterAll, describe, expect, it } from "vitest";

import type { ProductContractRevisionRef } from "@moe/core";
import type { SqliteEventStore } from "@moe/store";

import { GOAL_ID, PROJECT_ID, closeStores } from "./bootstrap/bootstrap-test-fixtures.js";
import { DESIGN_CODE_LAYERS } from "./design/design-contracts.js";
import { readDesignRevision, submitDesignRevision } from "./design/design-store.js";
import { designRevisionFixture, secondDesignRevisionFixture }
  from "./design/design-test-fixtures.js";
import type { AuthenticationResult, Authenticator } from "./http/http-contract.js";
import { WIRE_PROTOCOL_VERSION } from "./http/http-contract.js";
import { answerDesignReadQuery, createDesignReadPort } from "./mcp-design-read-query.js";
import type { DesignReadPort } from "./mcp-design-read-query.js";
import { OPERATOR, approveGate1, boundWorld, committedRevision }
  from "./planning/plan-reject-test-fixtures.js";

const CREDENTIAL = "sess-design-agent";
const DECIDED_AT = "2026-09-05T09:00:00.000Z";
const OTHER_PROJECT_ID = "project-2";

interface World {
  readonly ref: ProductContractRevisionRef;
  readonly store: SqliteEventStore;
}

function authenticatorFor(projectId: string): Authenticator {
  return {
    authenticate(credential: string | null): AuthenticationResult {
      if (credential !== CREDENTIAL) return { verdict: "UNAUTHENTICATED" };
      return {
        principal: { capabilities: ["goal.write"], principalId: "designer-agent-1", projectId },
        verdict: "AUTHENTICATED",
      };
    },
  };
}

function approvedWorld(): World {
  const store = boundWorld();
  const ref = committedRevision(store);
  approveGate1(store, ref);
  return { ref, store };
}

function submit(world: World, expectedVersion: number, revision: unknown, seed: string): void {
  const result = submitDesignRevision(world.store, {
    commandId: `cmd-design-${seed}`,
    contractRef: world.ref,
    correlationId: `corr-design-${seed}`,
    decidedAt: DECIDED_AT,
    expectedVersion,
    goalRef: GOAL_ID,
    principalId: "designer-agent-1",
    projectId: PROJECT_ID,
    revision,
  });
  if (!result.ok) throw new Error(`submit refused: ${result.code}@${result.layer}`);
}

function portFor(store: SqliteEventStore): DesignReadPort {
  return createDesignReadPort({ store });
}

function ask(options: {
  readonly body: unknown;
  readonly credential?: string | null;
  readonly port: DesignReadPort | undefined;
  readonly projectId?: string;
}): Record<string, unknown> {
  const bytes = answerDesignReadQuery({
    authenticator: authenticatorFor(options.projectId ?? PROJECT_ID),
    body: options.body,
    credential: options.credential === undefined ? CREDENTIAL : options.credential,
    port: options.port,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  });
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

afterAll(() => { closeStores(); });

describe("design.read answers the design aggregate over MCP", () => {
  it("returns the submitted revision, by exact content", () => {
    const world = approvedWorld();
    submit(world, 0, designRevisionFixture(), "green");
    const answer = ask({ body: { goalRef: GOAL_ID }, port: portFor(world.store) });
    expect(answer["ok"]).toBe(true);
    const record = answer["record"] as Record<string, unknown>;
    expect(record["revision"]).toStrictEqual(designRevisionFixture());
    expect(record["goalRef"]).toBe(GOAL_ID);
    expect(record["projectId"]).toBe(PROJECT_ID);
    expect(record["version"]).toBe(1);
    expect(answer["versions"]).toStrictEqual([1]);
  });
  it("reads a NAMED version out of history, not just the latest", () => {
    const world = approvedWorld();
    submit(world, 0, designRevisionFixture(), "v1");
    submit(world, 1, secondDesignRevisionFixture(), "v2");
    const latest = ask({ body: { goalRef: GOAL_ID }, port: portFor(world.store) });
    const first = ask({ body: { goalRef: GOAL_ID, version: 1 }, port: portFor(world.store) });
    expect((latest["record"] as Record<string, unknown>)["revision"])
      .toStrictEqual(secondDesignRevisionFixture());
    expect((first["record"] as Record<string, unknown>)["revision"])
      .toStrictEqual(designRevisionFixture());
    expect((first["record"] as Record<string, unknown>)["version"]).toBe(1);
    expect(latest["versions"]).toStrictEqual([1, 2]);
  });
  it("refuses DESIGN_REVISION_ABSENT with its LEDGER layer, to an AUTHENTICATED caller", () => {
    const world = approvedWorld();
    const answer = ask({ body: { goalRef: GOAL_ID }, port: portFor(world.store) });
    expect(answer["ok"]).toBe(false);
    expect(answer["code"]).toBe("DESIGN_REVISION_ABSENT");
    expect(answer["layer"]).toBe("LEDGER");
    expect(DESIGN_CODE_LAYERS["DESIGN_REVISION_ABSENT"]).toBe("LEDGER");
  });

  it("refuses DESIGN_REVISION_ABSENT for a version that was never appended", () => {
    const world = approvedWorld();
    submit(world, 0, designRevisionFixture(), "absent-version");
    const answer = ask({ body: { goalRef: GOAL_ID, version: 7 }, port: portFor(world.store) });
    expect(answer["ok"]).toBe(false);
    expect(answer["code"]).toBe("DESIGN_REVISION_ABSENT");
    expect(answer["layer"]).toBe("LEDGER");
  });
});

describe("design.read fences before it reads", () => {
  it("refuses an unknown credential at AUTHENTICATE, not with a design code", () => {
    const world = approvedWorld();
    submit(world, 0, designRevisionFixture(), "unauth");
    const answer = ask({
      body: { goalRef: GOAL_ID }, credential: "sess-wrong", port: portFor(world.store),
    });
    expect(answer["ok"]).toBe(false);
    expect(answer["stage"]).toBe("AUTHENTICATE");
    expect(answer["error"]).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(answer["code"]).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain("DESIGN_");
  });

  it("refuses a principal bound to ANOTHER project", () => {
    const world = approvedWorld();
    submit(world, 0, designRevisionFixture(), "cross-project");
    const answer = ask({
      body: { goalRef: GOAL_ID }, port: portFor(world.store), projectId: OTHER_PROJECT_ID,
    });
    expect(answer["ok"]).toBe(false);
    expect(answer["code"]).toBe("DESIGN_RECORD_MALFORMED");
    expect(answer["layer"]).toBe("LEDGER");
  });

  it("refuses a payload that names projectId, rather than honouring it", () => {
    const world = approvedWorld();
    submit(world, 0, designRevisionFixture(), "payload-project");
    const answer = ask({
      body: { goalRef: GOAL_ID, projectId: PROJECT_ID }, port: portFor(world.store),
    });
    expect(answer["ok"]).toBe(false);
    expect((answer["error"] as Record<string, unknown>)["code"]).toBe("INPUT_INVALID");
  });

  it("refuses an unknown key, a missing goalRef, and a non-string goalRef", () => {
    const world = approvedWorld();
    const port = portFor(world.store);
    for (const body of [
      { extra: 1, goalRef: GOAL_ID }, {}, { goalRef: 7 }, { goalRef: "" }, [GOAL_ID], null, "x",
    ]) {
      const answer = ask({ body, port });
      expect((answer["error"] as Record<string, unknown>)["code"]).toBe("INPUT_INVALID");
    }
  });

  it("refuses a version that is not a safe non-negative integer", () => {
    const world = approvedWorld();
    const port = portFor(world.store);
    for (const version of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", null]) {
      const answer = ask({ body: { goalRef: GOAL_ID, version }, port });
      expect((answer["error"] as Record<string, unknown>)["code"]).toBe("INPUT_INVALID");
    }
  });

  it("refuses a goalRef reachable only through the prototype or a getter", () => {
    const world = approvedWorld();
    submit(world, 0, designRevisionFixture(), "proto");
    const port = portFor(world.store);
    const inherited = Object.create({ goalRef: GOAL_ID }) as Record<string, unknown>;
    expect((ask({ body: inherited, port })["error"] as Record<string, unknown>)["code"])
      .toBe("INPUT_INVALID");
    let reads = 0;
    const accessor = Object.defineProperty({}, "goalRef", {
      enumerable: true,
      get: () => { reads += 1; return GOAL_ID; },
    }) as Record<string, unknown>;
    expect((ask({ body: accessor, port })["error"] as Record<string, unknown>)["code"])
      .toBe("INPUT_INVALID");
    expect(reads).toBe(0);
  });

  it("refuses when the daemon composes no design port at all", () => {
    const answer = ask({ body: { goalRef: GOAL_ID }, port: undefined });
    expect((answer["error"] as Record<string, unknown>)["code"]).toBe("INPUT_INVALID");
  });
});

interface DesignMcpPort {
  dispatchCommandBytes(bytes: Uint8Array, context?: HttpDispatchContext): Uint8Array | Promise<Uint8Array>;
  dispatchQueryBytes(bytes: Uint8Array, context?: HttpDispatchContext): Uint8Array | Promise<Uint8Array>;
}

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

const OPERATOR_CREDENTIAL = "mcp-design-operator-fixture";
const DESIGN_NOW = "2026-09-06T00:00:00.000Z";
const DESIGN_SEAT = "mcp-design-seat-fixture";

function designCommand(
  commandKind: string, payload: Record<string, unknown>, credential: string,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    commandId: `cmd-mcp-${commandKind}`, commandKind, correlationId: "corr-mcp-design",
    expectedVersion: 0, payload,
    requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION, sessionCredential: credential,
    targetAggregateId: `design:${GOAL_ID}`,
  }));
}

async function designMcpWorld() {
  const store = boundWorld();
  const contractRef = committedRevision(store);
  approveGate1(store, contractRef);
  const ports = createDaemonCommandPorts({
    clock: () => DESIGN_NOW, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID, store,
  });
  const authenticator = createSessionAuthenticator(store, {
    clock: () => Date.parse(DESIGN_NOW), operatorCapabilities: OPERATOR_CAPABILITIES,
    operatorCredential: OPERATOR_CREDENTIAL, operatorPrincipalId: OPERATOR, projectId: PROJECT_ID,
  });
  const config = {
    deps: { authenticator, decisions: ports.decisions, registry: ports.registry },
    design: createDesignReadPort({ store }),
    subscriptions: streamPort(),
  };
  const operator = createMcpDispatchPort({ ...config, fallbackCredential: OPERATOR_CREDENTIAL });
  const capabilities = agentCapabilitiesFor("design.submit");
  expect(capabilities).not.toBeNull();
  const opened = decode(await operator.dispatchCommandBytes(designCommand("session.open", {
    capabilities, credentialSha256: createHash("sha256").update(DESIGN_SEAT).digest("hex"),
    expiresAt: "2027-01-01T00:00:00.000Z", sessionId: "sess-mcp-designer",
  }, OPERATOR_CREDENTIAL)));
  expect(opened).toMatchObject({ outcome: "ACCEPTED", decision: { disposition: "DECIDED" } });
  expect(authenticator.authenticate(DESIGN_SEAT)).toMatchObject({
    verdict: "AUTHENTICATED", principal: { principalId: "sess-mcp-designer" },
  });
  const agent: DesignMcpPort = createMcpDispatchPort({ ...config, fallbackCredential: DESIGN_SEAT });
  return { contractRef, port: agent, store };
}

describe("design MCP agent dispatch", () => {
  it.each(["stdio", "http"] as const)("submits and reads through the real %s MCP port", async (mode) => {
    const world = await designMcpWorld();
    const context = mode === "http" ? { credential: DESIGN_SEAT } : undefined;
    const query = new TextEncoder().encode(JSON.stringify({ queryKind: "design.read", payload: { goalRef: GOAL_ID } }));
    expect(decode(await world.port.dispatchQueryBytes(query, context))).toMatchObject({
      ok: false, code: "DESIGN_REVISION_ABSENT", layer: "LEDGER",
    });
    const submitted = decode(await world.port.dispatchCommandBytes(designCommand("design.submit", {
      contractRef: world.contractRef, goalRef: GOAL_ID, revision: designRevisionFixture(),
    }, DESIGN_SEAT), context));
    expect(submitted).toMatchObject({
      outcome: "ACCEPTED", decision: { disposition: "DECIDED", resultCode: "DESIGN_REVISION_SUBMITTED" },
    });
    const stored = readDesignRevision(world.store, { goalRef: GOAL_ID, projectId: PROJECT_ID });
    expect(stored).toMatchObject({ ok: true, record: { revision: designRevisionFixture(), version: 1 } });
    expect(decode(await world.port.dispatchQueryBytes(query, context))).toEqual(stored);
    const versioned = new TextEncoder().encode(JSON.stringify({
      queryKind: "design.read", payload: { goalRef: GOAL_ID, version: 1 },
    }));
    expect(decode(await world.port.dispatchQueryBytes(versioned, context))).toEqual(stored);
  });

  it("uses the HTTP caller credential instead of the valid fallback", async () => {
    const world = await designMcpWorld();
    const query = new TextEncoder().encode(JSON.stringify({ queryKind: "design.read", payload: { goalRef: GOAL_ID } }));
    expect(decode(await world.port.dispatchQueryBytes(query, { credential: "unknown-caller" })))
      .toMatchObject({ ok: false, error: { code: "AUTHENTICATION_FAILED" }, stage: "AUTHENTICATE" });
  });
});

