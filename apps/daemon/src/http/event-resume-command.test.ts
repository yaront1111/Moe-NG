import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { RuntimeCommandEnvelope } from "@moe/contracts";
import { STDIO_TOOL_INDEX, decodeAndDispatch } from "@moe/mcp";
import { SqliteEventStore } from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import {
  advanceGeneration, registerSubscription,
} from "@moe/store/subscriptions/subscription-writes.js";
import { describe, expect, it } from "vitest";

import {
  OPERATOR_CAPABILITIES, createDaemonCommandPorts,
} from "../daemon-command-registry.js";
import { DomainRefusal } from "../daemon-command-dispatch.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { createMcpDispatchPort } from "../mcp-dispatch-port.js";
import {
  createMcpHttpHost, type McpHttpHost,
} from "../mcp-http/mcp-http-host.js";
import { runEventResumeCommand } from "./event-resume-command.js";
import {
  createEventStreamAccessPort, createEventStreamSubscriberResolver,
} from "./event-stream-access.js";
import type { AuthenticatedPrincipal, CommandAdapterDeps } from "./http-contract.js";
import type { SubscriptionPort } from "./event-stream-contract.js";

const AT = "2026-08-25T00:00:00.000Z";
const OPERATOR_CREDENTIAL = "event-resume-operator-credential";
const SESSION_CREDENTIAL = "event-resume-session-credential";
const SESSION_PRINCIPAL = "event-resume-session";
const WORK_CREDENTIAL = "event-resume-work-session-credential";
const WORK_PRINCIPAL = "event-resume-work-session";
const PRINCIPAL = "operator-local";
const PROJECTION = "moe.board";
const PROJECT = "project-event-resume";
const STATE_DIGEST = "d".repeat(64);
const SUBSCRIBER = "control-room-1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Cursor {
  readonly generation: number;
  readonly position: string;
}

interface Harness {
  readonly database: DatabaseSync;
  readonly deps: CommandAdapterDeps;
  readonly issuedCursor: Cursor;
  readonly host: McpHttpHost;
  readonly port: ReturnType<typeof createMcpDispatchPort>;
  readonly store: SqliteEventStore;
  readonly subscriptions: SubscriptionPort;
}

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

function cursorDoc(database: DatabaseSync, subscriberId = SUBSCRIBER): string | null {
  const row = database.prepare(
    "SELECT filter_json FROM event_subscriptions WHERE subscriber_id = ?",
  ).get(subscriberId);
  return row === undefined ? null : String(row["filter_json"]);
}

function currentCheckpoint(database: DatabaseSync): bigint {
  const value = database.prepare(
    "SELECT last_applied_position FROM projections WHERE projection_name = ?",
  ).get(PROJECTION)?.["last_applied_position"];
  return typeof value === "bigint" ? value : BigInt(typeof value === "number" ? value : 0);
}

function advance(database: DatabaseSync, reason: string): number {
  const result = advanceGeneration(database, {
    at: AT,
    baselines: [{
      checkpoint: currentCheckpoint(database),
      projection: PROJECTION,
      state: { reason },
      stateDigest: STATE_DIGEST,
    }],
    reason,
  });
  if (result.outcome !== "ADVANCED") throw new Error(JSON.stringify(result));
  return result.generation;
}

function commandBytes(
  commandId: string,
  cursor: Cursor,
  patch: Readonly<Record<string, unknown>> = {},
): Uint8Array {
  const payload = Object.hasOwn(patch, "payload")
    ? patch["payload"]
    : { presentedCursor: cursor, projection: PROJECTION, subscriberId: SUBSCRIBER };
  return encoder.encode(JSON.stringify({
    commandId,
    commandKind: "events.resume",
    correlationId: `correlation:${commandId}`,
    expectedVersion: 0,
    payload,
    requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential: SESSION_CREDENTIAL,
    targetAggregateId: SUBSCRIBER,
    ...patch,
  }));
}

function decisionCount(store: SqliteEventStore): number {
  let cursor = 0n;
  let total = 0;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 100);
    total += page.items.length;
    if (page.nextCursor === null || page.items.length === 0) return total;
    cursor = page.nextCursor;
  }
}

function resumeEnvelope(
  commandId: string, cursor: Cursor, subscriberId: string,
  sessionCredential = SESSION_CREDENTIAL,
): RuntimeCommandEnvelope {
  const payload = Object.freeze({
    presentedCursor: Object.freeze({ ...cursor }), projection: PROJECTION, subscriberId,
  });
  return Object.freeze({
    commandId,
    commandKind: "events.resume",
    correlationId: `correlation:${commandId}`,
    expectedVersion: 0,
    payload,
    requestDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    sessionCredential,
    targetAggregateId: subscriberId,
  });
}

function sessionPrincipal(principalId: string): AuthenticatedPrincipal {
  return Object.freeze({ capabilities: OPERATOR_CAPABILITIES, principalId, projectId: PROJECT });
}

function authenticateSession(
  deps: CommandAdapterDeps, credential: string, sessionId: string,
): AuthenticatedPrincipal {
  const result = deps.authenticator.authenticate(credential);
  expect(result.verdict).toBe("AUTHENTICATED");
  if (result.verdict !== "AUTHENTICATED") throw new Error(`credential ${sessionId} refused`);
  expect(result.principal.principalId).toBe(sessionId);
  return result.principal;
}

function expectDomainRefusal(
  run: () => unknown, code: string, layer: string,
): DomainRefusal {
  try {
    run();
  } catch (error) {
    if (!(error instanceof DomainRefusal)) throw error;
    expect(error.code).toBe(code);
    expect(error.layer).toBe(layer);
    return error;
  }
  throw new Error(`expected ${code}@${layer}`);
}

function mintSession(
  store: SqliteEventStore,
  capabilities: readonly string[],
  credential: string,
  sessionId: string,
): void {
  const minted = createOperatorSessionHandshakePort({
    capabilities,
    clock: () => Date.now(),
    mintCredential: () => credential,
    mintSessionId: () => sessionId,
    operatorPrincipalId: PRINCIPAL,
    projectId: PROJECT,
    sessionTtlMs: 60_000,
    store,
  }).mint();
  if (!minted.ok) throw new Error(minted.code);
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "moe-event-resume-command-"));
  const storePath = join(directory, "store.db");
  const provider = createStoreDependencies({
    clock: () => AT,
    credential: OPERATOR_CREDENTIAL,
    principalId: PRINCIPAL,
    projectId: PROJECT,
    storePath,
  });
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription port");
  const database = new DatabaseSync(storePath, { timeout: 5_000 });
  const store = SqliteEventStore.openForProject(storePath, PROJECT);
  mintSession(store, OPERATOR_CAPABILITIES, SESSION_CREDENTIAL, SESSION_PRINCIPAL);
  const deps = provider.provide();
  const host = createMcpHttpHost({ deps, enableJsonResponse: true, subscriptions });
  try {
    advance(database, "create command-test gap");
    const gap = readSubscriptionPage(store, database, {
      projection: PROJECTION, subscriberId: SUBSCRIBER,
    });
    if (gap.outcome !== "CURSOR_GAP") throw new Error(JSON.stringify(gap));
    const port = createMcpDispatchPort({
      deps, fallbackCredential: SESSION_CREDENTIAL, subscriptions,
    });
    await run({
      database,
      deps,
      host,
      issuedCursor: { generation: gap.snapshot.generation, position: gap.snapshot.checkpoint },
      port,
      store,
      subscriptions,
    });
  } finally {
    await host.stop().catch(() => undefined);
    store.close();
    database.close();
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

const ACCEPT = "application/json, text/event-stream";
const SESSION_HEADER = "mcp-session-id";

function mcpRequest(
  origin: string,
  body: Readonly<Record<string, unknown>>,
  sessionId?: string,
): Request {
  const headers = new Headers({
    accept: ACCEPT,
    authorization: `Bearer ${SESSION_CREDENTIAL}`,
    "content-type": "application/json",
    host: new URL(origin).host,
  });
  if (sessionId !== undefined) headers.set(SESSION_HEADER, sessionId);
  return new Request(`${origin}/`, {
    body: JSON.stringify(body), headers, method: "POST",
  });
}

async function openMcpSession(host: McpHttpHost, origin: string): Promise<string> {
  const response = await host.handleRequest(mcpRequest(origin, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "event-resume-test", version: "0.0.0" },
      protocolVersion: "2025-06-18",
    },
  }));
  const sessionId = response.headers.get(SESSION_HEADER);
  await response.text();
  if (sessionId === null) throw new Error(`initialize refused with ${String(response.status)}`);
  return sessionId;
}

async function callResumeTool(
  host: McpHttpHost,
  origin: string,
  sessionId: string,
  commandId: string,
  cursor: Cursor,
): Promise<Record<string, unknown>> {
  const response = await host.handleRequest(mcpRequest(origin, {
    id: 2,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: {
        commandId,
        correlationId: `correlation:${commandId}`,
        expectedVersion: 0,
        payload: { presentedCursor: cursor, projection: PROJECTION, subscriberId: SUBSCRIBER },
        targetAggregateId: SUBSCRIBER,
      },
      name: "events_resume",
    },
  }, sessionId));
  const rpc = JSON.parse(await response.text()) as {
    result?: { content?: readonly { text?: string }[] };
  };
  const text = rpc.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("tools/call returned no daemon response");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("events.resume authenticated command", () => {
  it("refuses unauthenticated dispatch before decoding and mutates nothing", async () => {
    await withHarness(async (harness) => {
      const before = cursorDoc(harness.database);
      const port = createMcpDispatchPort({
        deps: harness.deps,
        subscriptions: harness.subscriptions,
      });
      const refused = decode(await port.dispatchCommandBytes(commandBytes(
        "resume-unauthenticated", harness.issuedCursor,
      )));

      expect(refused).toMatchObject({
        error: { code: "AUTHENTICATION_FAILED" }, stage: "AUTHENTICATE",
      });
      expect(cursorDoc(harness.database)).toBe(before);
      expect(harness.store.getCommandDecision({
        commandId: "resume-unauthenticated", principalId: SESSION_PRINCIPAL, projectId: PROJECT,
      })).toBeNull();
    });
  });

  it("refuses a WORK-only session from the shared control-room reader", async () => {
    await withHarness(async (harness) => {
      mintSession(harness.store, ["work.write"], WORK_CREDENTIAL, WORK_PRINCIPAL);
      const before = cursorDoc(harness.database);
      const port = createMcpDispatchPort({
        deps: harness.deps,
        fallbackCredential: WORK_CREDENTIAL,
        subscriptions: harness.subscriptions,
      });

      const refused = decode(await port.dispatchCommandBytes(commandBytes(
        "resume-work-session", harness.issuedCursor,
      )));

      expect(refused).toMatchObject({
        httpStatus: 403,
        outcome: "PORT_REFUSED",
        refusal: {
          code: "EVENT_STREAM_RESUME_OPERATOR_AUTHORITY_REQUIRED",
          layer: "DAEMON_AUTHORIZATION",
        },
        stage: "DISPATCH",
      });
      expect(cursorDoc(harness.database)).toBe(before);
      expect(harness.store.getCommandDecision({
        commandId: "resume-work-session", principalId: WORK_PRINCIPAL, projectId: PROJECT,
      })).toBeNull();
    });
  });

  it("refuses when the daemon has no configured event reader", async () => {
    await withHarness(async (harness) => {
      const before = cursorDoc(harness.database);
      const ports = createDaemonCommandPorts({
        clock: () => AT,
        operatorPrincipalId: PRINCIPAL,
        projectId: PROJECT,
        store: harness.store,
      });
      const unbound = createMcpDispatchPort({
        deps: Object.freeze({
          authenticator: harness.deps.authenticator,
          decisions: ports.decisions,
          registry: ports.registry,
        }),
        fallbackCredential: SESSION_CREDENTIAL,
        subscriptions: harness.subscriptions,
      });

      const refused = decode(await unbound.dispatchCommandBytes(commandBytes(
        "resume-unbound-reader", harness.issuedCursor,
      )));

      expect(refused).toMatchObject({
        httpStatus: 503,
        refusal: {
          code: "EVENT_STREAM_RESUME_AUTHORITY_UNAVAILABLE",
          layer: "DAEMON_EVENT_STREAM_RESUME",
        },
        stage: "DISPATCH",
      });
      expect(cursorDoc(harness.database)).toBe(before);
      expect(harness.store.getCommandDecision({
        commandId: "resume-unbound-reader", principalId: SESSION_PRINCIPAL, projectId: PROJECT,
      })).toBeNull();
    });
  });

  it("reseats the reader granted by the event-stream access port once on exact replay", async () => {
    await withHarness(async (harness) => {
      const bytes = commandBytes("resume-once", harness.issuedCursor);
      const first = decode(await harness.port.dispatchCommandBytes(bytes));
      expect(first).toMatchObject({
        decision: { commandId: "resume-once", disposition: "DECIDED",
          resultCode: "EFFECTS_COMMITTED" },
        ok: true,
        outcome: "ACCEPTED",
      });
      const firstDecision = first["decision"];
      const afterFirstDecisionCount = decisionCount(harness.store);
      expect(afterFirstDecisionCount).toBeGreaterThan(0);
      expect(JSON.parse(cursorDoc(harness.database, SUBSCRIBER) ?? "null")).toMatchObject({
        cursor: harness.issuedCursor, projection: PROJECTION,
      });

      advance(harness.database, "prove replay does not reseat");
      const beforeReplay = cursorDoc(harness.database);
      const replay = decode(await harness.port.dispatchCommandBytes(bytes));

      expect(replay).toMatchObject({
        decision: { commandId: "resume-once", disposition: "REPLAYED",
          resultCode: "EFFECTS_COMMITTED" },
        ok: true,
        outcome: "ACCEPTED",
      });
      expect(replay["decision"]).toMatchObject({
        effectId: (firstDecision as Record<string, unknown>)["effectId"],
      });
      expect(cursorDoc(harness.database)).toBe(beforeReplay);
      expect(decisionCount(harness.store)).toBe(afterFirstDecisionCount);
    });
  });

  it("refuses changed correlation bytes under the resume layer without replacing the receipt", async () => {
    await withHarness(async (harness) => {
      const commandId = "resume-conflict";
      const bytes = commandBytes(commandId, harness.issuedCursor);
      const accepted = decode(await harness.port.dispatchCommandBytes(bytes));
      expect(accepted).toMatchObject({ ok: true });
      const acceptedDecision = accepted["decision"] as Record<string, unknown>;
      const key = { commandId, principalId: SESSION_PRINCIPAL, projectId: PROJECT };
      const firstStored = harness.store.getCommandDecision(key);
      if (firstStored === null) throw new Error("accepted resume stored no decision");
      const before = cursorDoc(harness.database);

      const changed = commandBytes(commandId, harness.issuedCursor, {
        correlationId: "different-correlation",
      });
      const refused = decode(await harness.port.dispatchCommandBytes(changed));

      expect(refused).toMatchObject({
        httpStatus: 409,
        refusal: {
          code: "EVENT_STREAM_RESUME_IDEMPOTENCY_CONFLICT",
          layer: "DAEMON_EVENT_STREAM_RESUME",
        },
        stage: "DISPATCH",
      });
      const refusal = refused["refusal"] as Record<string, unknown>;
      expect(refusal["detail"]).toContain(commandId);
      expect(refusal["detail"]).not.toContain("different-correlation");
      expect(cursorDoc(harness.database)).toBe(before);
      const stored = harness.store.getCommandDecision(key);
      expect(stored).toEqual(firstStored);
      expect(stored?.decisionId).toBe(acceptedDecision["effectId"]);
      expect(stored?.resultCode).toBe(acceptedDecision["resultCode"]);
    });
  });

  it("refuses changed payload bytes under one command identity without reseating", async () => {
    await withHarness(async (harness) => {
      const commandId = "resume-payload-conflict";
      const bytes = commandBytes(commandId, harness.issuedCursor);
      const accepted = decode(await harness.port.dispatchCommandBytes(bytes));
      expect(accepted).toMatchObject({ ok: true });
      const acceptedDecision = accepted["decision"] as Record<string, unknown>;
      const key = { commandId, principalId: SESSION_PRINCIPAL, projectId: PROJECT };
      const firstStored = harness.store.getCommandDecision(key);
      if (firstStored === null) throw new Error("accepted resume stored no decision");
      const before = cursorDoc(harness.database);

      const changed = commandBytes(commandId, harness.issuedCursor, { payload: {
        presentedCursor: {
          ...harness.issuedCursor,
          position: (BigInt(harness.issuedCursor.position) + 1n).toString(),
        },
        projection: PROJECTION,
        subscriberId: SUBSCRIBER,
      } });
      const refused = decode(await harness.port.dispatchCommandBytes(changed));

      expect(refused).toMatchObject({
        httpStatus: 409,
        refusal: {
          code: "EVENT_STREAM_RESUME_IDEMPOTENCY_CONFLICT",
          layer: "DAEMON_EVENT_STREAM_RESUME",
        },
        stage: "DISPATCH",
      });
      expect(cursorDoc(harness.database)).toBe(before);
      const stored = harness.store.getCommandDecision(key);
      expect(stored).toEqual(firstStored);
      expect(stored?.decisionId).toBe(acceptedDecision["effectId"]);
      expect(stored?.resultCode).toBe(acceptedDecision["resultCode"]);
    });
  });

  it("records a stale aggregate version without reseating", async () => {
    await withHarness(async (harness) => {
      expect(decode(await harness.port.dispatchCommandBytes(commandBytes(
        "resume-first-version", harness.issuedCursor,
      )))).toMatchObject({ ok: true });
      advance(harness.database, "make a second reseat observable");
      const before = cursorDoc(harness.database);

      const conflicted = decode(await harness.port.dispatchCommandBytes(commandBytes(
        "resume-stale-version", harness.issuedCursor,
      )));

      expect(conflicted).toMatchObject({
        decision: {
          commandId: "resume-stale-version",
          disposition: "DECIDED",
          resultCode: "EXPECTED_VERSION_CONFLICT",
        },
        ok: true,
        outcome: "ACCEPTED",
      });
      expect(cursorDoc(harness.database)).toBe(before);
      expect(harness.store.getCommandDecision({
        commandId: "resume-stale-version", principalId: SESSION_PRINCIPAL, projectId: PROJECT,
      })?.resultCode).toBe("EXPECTED_VERSION_CONFLICT");
      expect(harness.store.getAggregateVersion(SUBSCRIBER)).toBe(1);
    });
  });

  it("refuses malformed and foreign-session payloads without durable mutation", async () => {
    await withHarness(async (harness) => {
      const before = cursorDoc(harness.database);
      const malformed = decode(await harness.port.dispatchCommandBytes(commandBytes(
        "resume-malformed", harness.issuedCursor, { payload: { projection: PROJECTION } },
      )));
      expect(malformed).toMatchObject({
        refusal: {
          code: "EVENT_STREAM_RESUME_INPUT_INVALID", layer: "DAEMON_EVENT_STREAM_RESUME",
        },
      });

      const foreign = decode(await harness.port.dispatchCommandBytes(commandBytes(
        "resume-foreign",
        harness.issuedCursor,
        {
          payload: {
            presentedCursor: harness.issuedCursor,
            projection: PROJECTION,
            subscriberId: "forged-subscriber",
          },
          targetAggregateId: "forged-subscriber",
        },
      )));
      expect(foreign).toMatchObject({
        refusal: {
          code: "EVENT_STREAM_RESUME_SESSION_MISMATCH", layer: "DAEMON_EVENT_STREAM_RESUME",
        },
      });
      expect(cursorDoc(harness.database)).toBe(before);
      expect(harness.store.getCommandDecision({
        commandId: "resume-malformed", principalId: SESSION_PRINCIPAL, projectId: PROJECT,
      })).toBeNull();
      expect(harness.store.getCommandDecision({
        commandId: "resume-foreign", principalId: SESSION_PRINCIPAL, projectId: PROJECT,
      })).toBeNull();
    });
  });

  it("rolls back the receipt when the stream seam refuses the cursor", async () => {
    await withHarness(async (harness) => {
      const before = cursorDoc(harness.database);
      const refused = decode(await harness.port.dispatchCommandBytes(commandBytes(
        "resume-wrong-cursor",
        { ...harness.issuedCursor, position: `${harness.issuedCursor.position}0` },
      )));

      expect(refused).toMatchObject({
        refusal: { code: "EVENT_STREAM_CURSOR_NOT_ISSUED", layer: "SEAM" },
      });
      expect(cursorDoc(harness.database)).toBe(before);
      expect(harness.store.getCommandDecision({
        commandId: "resume-wrong-cursor", principalId: SESSION_PRINCIPAL, projectId: PROJECT,
      })).toBeNull();
      expect(harness.store.getAggregateVersion(SUBSCRIBER)).toBe(0);
    });
  });

  it("rolls back the receipt for a superseded cursor generation", async () => {
    await withHarness(async (harness) => {
      advance(harness.database, "supersede the issued cursor generation");
      const before = cursorDoc(harness.database);
      const refused = decode(await harness.port.dispatchCommandBytes(commandBytes(
        "resume-superseded-generation", harness.issuedCursor,
      )));

      expect(refused).toMatchObject({
        refusal: { code: "EVENT_STREAM_GENERATION_SUPERSEDED", layer: "SEAM" },
        stage: "DISPATCH",
      });
      expect(cursorDoc(harness.database)).toBe(before);
      expect(harness.store.getCommandDecision({
        commandId: "resume-superseded-generation",
        principalId: SESSION_PRINCIPAL,
        projectId: PROJECT,
      })).toBeNull();
      expect(harness.store.getAggregateVersion(SUBSCRIBER)).toBe(0);
    });
  });

  it("reaches the production command handler through the stdio adapter core", async () => {
    await withHarness(async (harness) => {
      const entry = STDIO_TOOL_INDEX.get("events_resume");
      expect(entry).toMatchObject({ kind: "events.resume", surface: "command" });
      if (entry === undefined) throw new Error("events_resume is not generated");

      const answer = decode(await decodeAndDispatch(
        harness.port, entry, commandBytes("resume-stdio", harness.issuedCursor),
      ));

      expect(answer).toMatchObject({
        decision: { commandId: "resume-stdio", resultCode: "EFFECTS_COMMITTED" },
        ok: true,
        outcome: "ACCEPTED",
      });
    });
  });

  it("reseats and replays through the real MCP HTTP initialize and tools/call boundary", async () => {
    await withHarness(async (harness) => {
      const started = await harness.host.start();
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.code);
      const sessionId = await openMcpSession(harness.host, started.origin);

      const first = await callResumeTool(
        harness.host, started.origin, sessionId, "resume-http", harness.issuedCursor,
      );
      expect(first).toMatchObject({
        decision: { commandId: "resume-http", disposition: "DECIDED",
          resultCode: "EFFECTS_COMMITTED" },
        ok: true,
        outcome: "ACCEPTED",
      });
      const firstDecision = first["decision"] as Record<string, unknown>;
      expect(JSON.parse(cursorDoc(harness.database) ?? "null")).toMatchObject({
        cursor: harness.issuedCursor, projection: PROJECTION,
      });

      advance(harness.database, "prove HTTP replay does not reseat");
      const beforeReplay = cursorDoc(harness.database);
      const replay = await callResumeTool(
        harness.host, started.origin, sessionId, "resume-http", harness.issuedCursor,
      );

      expect(replay).toMatchObject({
        decision: {
          commandId: "resume-http",
          disposition: "REPLAYED",
          effectId: firstDecision["effectId"],
          resultCode: "EFFECTS_COMMITTED",
        },
        ok: true,
        outcome: "ACCEPTED",
      });
      expect(cursorDoc(harness.database)).toBe(beforeReplay);
    });
  });
});

describe("task-3a39bcd4 principal-bound command seam", () => {
  it("binds two authenticated sessions to durable independent subscribers", async () => {
    await withHarness(async (harness) => {
      const secondId = "event-resume-second-session";
      const secondCredential = "event-resume-second-credential";
      mintSession(harness.store, OPERATOR_CAPABILITIES, secondCredential, secondId);
      const firstPrincipal = authenticateSession(
        harness.deps, SESSION_CREDENTIAL, SESSION_PRINCIPAL,
      );
      const secondPrincipal = authenticateSession(harness.deps, secondCredential, secondId);
      const access = harness.deps.eventStreamAccess;
      if (access === undefined) throw new Error("event stream access is not wired");
      const first = access.authorize(firstPrincipal);
      const second = access.authorize(secondPrincipal);
      if (!first.ok || !second.ok) throw new Error("real pairing session was refused");
      expect(first.subscriberId).toBe(SUBSCRIBER);
      expect(second.subscriberId).toBe(`reader:${secondId}`);
      expect(first.subscriberId).not.toBe(second.subscriberId);

      const restarted = createEventStreamAccessPort({
        operatorCapabilities: OPERATOR_CAPABILITIES,
        operatorPrincipalId: PRINCIPAL,
        projectId: PROJECT,
        resolveSubscriberId: createEventStreamSubscriberResolver({
          clock: () => Date.now(),
          operatorCapabilities: OPERATOR_CAPABILITIES,
          operatorPrincipalId: PRINCIPAL,
          operatorSubscriberId: SUBSCRIBER,
          projectId: PROJECT,
          store: harness.store,
        }),
        store: harness.store,
      });
      expect(restarted.authorize(firstPrincipal)).toEqual(first);
      expect(restarted.authorize(secondPrincipal)).toEqual(second);

      const registered = registerSubscription(harness.database, {
        at: AT, projection: PROJECTION, subscriberId: second.subscriberId,
      });
      expect(registered.outcome).toBe("REGISTERED");
      advance(harness.database, "create two-session gaps");
      const firstGap = readSubscriptionPage(harness.store, harness.database, {
        projection: PROJECTION, subscriberId: first.subscriberId,
      });
      const secondGap = readSubscriptionPage(harness.store, harness.database, {
        projection: PROJECTION, subscriberId: second.subscriberId,
      });
      expect(firstGap.outcome).toBe("CURSOR_GAP");
      expect(secondGap.outcome).toBe("CURSOR_GAP");
      if (firstGap.outcome !== "CURSOR_GAP" || secondGap.outcome !== "CURSOR_GAP") {
        throw new Error("durable subscribers were not gapped");
      }
      const firstCursor = {
        generation: firstGap.snapshot.generation, position: firstGap.snapshot.checkpoint,
      };
      const secondCursor = {
        generation: secondGap.snapshot.generation, position: secondGap.snapshot.checkpoint,
      };
      const resume = harness.deps.registry.get("events.resume");
      if (resume === undefined) throw new Error("events.resume is not registered");
      const beforeFirst = cursorDoc(harness.database, first.subscriberId);
      const beforeSecond = cursorDoc(harness.database, second.subscriberId);
      const beforeDecisions = decisionCount(harness.store);

      expectDomainRefusal(() => resume.handler({
        envelope: resumeEnvelope(
          "resume-second-against-first", firstCursor, first.subscriberId, secondCredential,
        ),
        principal: secondPrincipal,
      }), "EVENT_STREAM_RESUME_SESSION_MISMATCH", "DAEMON_EVENT_STREAM_RESUME");

      expect(cursorDoc(harness.database, first.subscriberId)).toBe(beforeFirst);
      expect(cursorDoc(harness.database, second.subscriberId)).toBe(beforeSecond);
      expect(decisionCount(harness.store)).toBe(beforeDecisions);
      expect(harness.store.getCommandDecision({
        commandId: "resume-second-against-first", principalId: secondId, projectId: PROJECT,
      })).toBeNull();

      const firstDecision = resume.handler({
        envelope: resumeEnvelope("resume-first-own", firstCursor, first.subscriberId),
        principal: firstPrincipal,
      });
      const secondDecision = resume.handler({
        envelope: resumeEnvelope(
          "resume-second-own", secondCursor, second.subscriberId, secondCredential,
        ),
        principal: secondPrincipal,
      });
      expect(firstDecision.resultCode).toBe("EFFECTS_COMMITTED");
      expect(secondDecision.resultCode).toBe("EFFECTS_COMMITTED");
      expect(harness.store.getCommandDecision({
        commandId: "resume-first-own", principalId: SESSION_PRINCIPAL, projectId: PROJECT,
      })?.resultCode).toBe("EFFECTS_COMMITTED");
      expect(harness.store.getCommandDecision({
        commandId: "resume-second-own", principalId: secondId, projectId: PROJECT,
      })?.resultCode).toBe("EFFECTS_COMMITTED");
      expect(JSON.parse(cursorDoc(harness.database, first.subscriberId) ?? "null"))
        .toMatchObject({ cursor: firstCursor, projection: PROJECTION });
      expect(JSON.parse(cursorDoc(harness.database, second.subscriberId) ?? "null"))
        .toMatchObject({ cursor: secondCursor, projection: PROJECTION });
    });
  });

  it("refuses an authorized session with no subscriber grant at the resume layer", async () => {
    await withHarness(async (harness) => {
      const ungrantedId = "event-resume-ungranted-session";
      mintSession(harness.store, OPERATOR_CAPABILITIES, "ungranted-credential", ungrantedId);
      const access = createEventStreamAccessPort({
        operatorCapabilities: OPERATOR_CAPABILITIES,
        operatorPrincipalId: PRINCIPAL,
        projectId: PROJECT,
        resolveSubscriberId: () => undefined,
        store: harness.store,
      });
      const grant = access.authorize(sessionPrincipal(ungrantedId));
      expect(grant).toEqual({
        code: "EVENT_STREAM_AUTHORITY_UNAVAILABLE",
        httpStatus: 503,
        layer: "DAEMON_AUTHORIZATION",
        ok: false,
      });
      const beforeCursor = cursorDoc(harness.database);
      const beforeDecisions = decisionCount(harness.store);
      const refusal = expectDomainRefusal(() => runEventResumeCommand({
        authorizedSubscriberId: undefined,
        decidedAt: AT,
        envelope: resumeEnvelope("resume-ungranted-session", harness.issuedCursor, SUBSCRIBER),
        principal: sessionPrincipal(ungrantedId),
        projectId: PROJECT,
        store: harness.store,
      }), "EVENT_STREAM_RESUME_AUTHORITY_UNAVAILABLE", "DAEMON_EVENT_STREAM_RESUME");

      expect(refusal.httpStatus).toBe(503);
      expect(refusal.detail).toBe(
        `no event subscriber is bound to authenticated principal ${ungrantedId}`,
      );
      expect(cursorDoc(harness.database)).toBe(beforeCursor);
      expect(decisionCount(harness.store)).toBe(beforeDecisions);
      expect(harness.store.getCommandDecision({
        commandId: "resume-ungranted-session", principalId: ungrantedId, projectId: PROJECT,
      })).toBeNull();
    });
  });

  it("reseats and records a session using its own granted subscriber", async () => {
    await withHarness(async (harness) => {
      const principal = sessionPrincipal(SESSION_PRINCIPAL);
      const access = createEventStreamAccessPort({
        operatorCapabilities: OPERATOR_CAPABILITIES,
        operatorPrincipalId: PRINCIPAL,
        projectId: PROJECT,
        resolveSubscriberId: (candidate) =>
          candidate.principalId === SESSION_PRINCIPAL ? SUBSCRIBER : undefined,
        store: harness.store,
      });
      const grant = access.authorize(principal);
      if (!grant.ok) throw new Error(`session subscriber refused: ${grant.code}`);

      const decision = runEventResumeCommand({
        authorizedSubscriberId: grant.subscriberId,
        decidedAt: AT,
        envelope: resumeEnvelope("resume-own-grant", harness.issuedCursor, grant.subscriberId),
        principal,
        projectId: PROJECT,
        store: harness.store,
      });

      expect(decision).toMatchObject({
        commandId: "resume-own-grant", disposition: "DECIDED", resultCode: "EFFECTS_COMMITTED",
      });
      expect(JSON.parse(cursorDoc(harness.database) ?? "null")).toMatchObject({
        cursor: harness.issuedCursor, projection: PROJECTION,
      });
      expect(harness.store.getCommandDecision({
        commandId: "resume-own-grant", principalId: SESSION_PRINCIPAL, projectId: PROJECT,
      })?.resultCode).toBe("EFFECTS_COMMITTED");
    });
  });
});
