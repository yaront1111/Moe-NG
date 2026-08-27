import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteEventStore } from "@moe/store";
import { readSubscriptionPage } from "@moe/store/subscriptions/subscription-read-page.js";
import { advanceGeneration } from "@moe/store/subscriptions/subscription-writes.js";

import { OPERATOR_CAPABILITIES } from "../daemon-command-registry.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { createOperatorSessionHandshakePort } from "../identity/session-handshake.js";
import { createMcpHttpHost, type McpHttpHost } from "../mcp-http/mcp-http-host.js";
import type { CommandAdapterDeps } from "./http-contract.js";
import type { SubscriptionPort } from "./event-stream-contract.js";

/**
 * Harness for driving `events.resume` through the REAL MCP HTTP host: a live listener, the
 * real `initialize` and `tools/call` methods, the generated `events_resume` schema, daemon
 * authentication, the production command registry and the durable decision table. Nothing
 * here replaces a production edge. The fixtures only OPEN a store, mint sessions through the
 * production handshake port, and read state back out of SQLite to assert on it.
 *
 * Copied and generalised from the in-file harness in `event-resume-command.test.ts` so that
 * this task never edits task-87c3b098's owned file. The generalisation is the point:
 * `mcpRequest` takes the bearer as an OPTION, including ABSENT, which the original could not
 * express and which the unauthenticated arms need.
 */

export const RESUME_AT = "2026-08-26T00:00:00.000Z";
export const RESUME_OPERATOR_CREDENTIAL = "event-resume-mcp-operator-credential";
export const RESUME_SESSION_CREDENTIAL = "event-resume-mcp-session-credential";
export const RESUME_SESSION_PRINCIPAL = "event-resume-mcp-session";
export const RESUME_PRINCIPAL = "operator-local";
export const RESUME_PROJECTION = "moe.board";
export const RESUME_PROJECT = "project-event-resume-mcp";
export const RESUME_SUBSCRIBER = "control-room-1";

const STATE_DIGEST = "e".repeat(64);
const ACCEPT = "application/json, text/event-stream";
const SESSION_HEADER = "mcp-session-id";

export interface ResumeCursor {
  readonly generation: number;
  readonly position: string;
}

export interface ResumeHarness {
  readonly database: DatabaseSync;
  readonly deps: CommandAdapterDeps;
  readonly host: McpHttpHost;
  readonly issuedCursor: ResumeCursor;
  readonly store: SqliteEventStore;
  readonly subscriptions: SubscriptionPort;
}

/** The subscriber's durable cursor document, verbatim, so an arm can prove byte-equality. */
export function cursorDoc(
  database: DatabaseSync,
  subscriberId: string = RESUME_SUBSCRIBER,
): string | null {
  const row = database.prepare(
    "SELECT filter_json FROM event_subscriptions WHERE subscriber_id = ?",
  ).get(subscriberId);
  return row === undefined ? null : String(row["filter_json"]);
}

function currentCheckpoint(database: DatabaseSync): bigint {
  const value = database.prepare(
    "SELECT last_applied_position FROM projections WHERE projection_name = ?",
  ).get(RESUME_PROJECTION)?.["last_applied_position"];
  return typeof value === "bigint" ? value : BigInt(typeof value === "number" ? value : 0);
}

/** Advances the projection generation, which is what strands the subscriber in a CURSOR_GAP. */
export function advance(database: DatabaseSync, reason: string): number {
  const result = advanceGeneration(database, {
    at: RESUME_AT,
    baselines: [{
      checkpoint: currentCheckpoint(database),
      projection: RESUME_PROJECTION,
      state: { reason },
      stateDigest: STATE_DIGEST,
    }],
    reason,
  });
  if (result.outcome !== "ADVANCED") throw new Error(JSON.stringify(result));
  return result.generation;
}

/** Mints a session through the PRODUCTION handshake port, never a hand-written row. */
export function mintSession(
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
    operatorPrincipalId: RESUME_PRINCIPAL,
    projectId: RESUME_PROJECT,
    sessionTtlMs: 60_000,
    store,
  }).mint();
  if (!minted.ok) throw new Error(minted.code);
}

export function requestDigestOf(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export interface McpRequestOptions {
  /** Absent means NO Authorization header at all, which the unauthenticated arms need. */
  readonly bearer?: string | undefined;
  readonly sessionId?: string | undefined;
}

export function mcpRequest(
  origin: string,
  body: Readonly<Record<string, unknown>>,
  options: McpRequestOptions = {},
): Request {
  const headers = new Headers({
    accept: ACCEPT,
    "content-type": "application/json",
    host: new URL(origin).host,
  });
  if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);
  if (options.sessionId !== undefined) headers.set(SESSION_HEADER, options.sessionId);
  return new Request(`${origin}/`, { body: JSON.stringify(body), headers, method: "POST" });
}

export async function openMcpSession(host: McpHttpHost, origin: string): Promise<string> {
  const response = await host.handleRequest(mcpRequest(origin, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "event-resume-mcp-test", version: "0.0.0" },
      protocolVersion: "2025-06-18",
    },
  }, { bearer: RESUME_SESSION_CREDENTIAL }));
  const sessionId = response.headers.get(SESSION_HEADER);
  await response.text();
  if (sessionId === null) throw new Error(`initialize refused with ${String(response.status)}`);
  return sessionId;
}

export interface ToolCallAnswer {
  /** The parsed daemon answer, or null when the host refused before dispatch. */
  readonly answer: Record<string, unknown> | null;
  /** The raw JSON-RPC envelope, so an arm can read `error.data` directly. */
  readonly rpc: Record<string, unknown>;
  readonly status: number;
}

/** One real `tools/call` for `events_resume`, with the arguments handed over verbatim. */
export async function callResumeTool(
  host: McpHttpHost,
  origin: string,
  toolArguments: Readonly<Record<string, unknown>>,
  options: McpRequestOptions,
): Promise<ToolCallAnswer> {
  const response = await host.handleRequest(mcpRequest(origin, {
    id: 2,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: toolArguments, name: "events_resume" },
  }, options));
  const rpc = JSON.parse(await response.text()) as Record<string, unknown>;
  const result = rpc["result"] as { content?: readonly { text?: string }[] } | undefined;
  const text = result?.content?.[0]?.text;
  return Object.freeze({
    answer: typeof text === "string" ? JSON.parse(text) as Record<string, unknown> : null,
    rpc,
    status: response.status,
  });
}

/** The tool arguments a well-formed resume carries; `patch` overrides any of them. */
export function resumeArguments(
  commandId: string,
  cursor: ResumeCursor,
  patch: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const payload = Object.hasOwn(patch, "payload")
    ? patch["payload"]
    : {
        presentedCursor: cursor,
        projection: RESUME_PROJECTION,
        subscriberId: RESUME_SUBSCRIBER,
      };
  return {
    commandId,
    correlationId: `correlation:${commandId}`,
    expectedVersion: 0,
    payload,
    requestDigest: requestDigestOf(payload),
    targetAggregateId: RESUME_SUBSCRIBER,
    ...patch,
  };
}

/**
 * Opens a real daemon over a temp store, strands the shared control-room subscriber in a
 * CURSOR_GAP, and hands the caller a STARTED MCP HTTP host. Everything is torn down in
 * `finally` so a failing arm cannot leak a listener or a SQLite handle into the next file.
 */
export async function withResumeHarness(
  run: (harness: ResumeHarness, origin: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "moe-event-resume-mcp-"));
  const storePath = join(directory, "store.db");
  const provider = createStoreDependencies({
    clock: () => RESUME_AT,
    credential: RESUME_OPERATOR_CREDENTIAL,
    principalId: RESUME_PRINCIPAL,
    projectId: RESUME_PROJECT,
    storePath,
  });
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription port");
  const database = new DatabaseSync(storePath, { timeout: 5_000 });
  const store = SqliteEventStore.openForProject(storePath, RESUME_PROJECT);
  mintSession(
    store, OPERATOR_CAPABILITIES, RESUME_SESSION_CREDENTIAL, RESUME_SESSION_PRINCIPAL,
  );
  const deps = provider.provide();
  const host = createMcpHttpHost({ deps, enableJsonResponse: true, subscriptions });
  try {
    advance(database, "create mcp-host gap");
    const gap = readSubscriptionPage(store, database, {
      projection: RESUME_PROJECTION, subscriberId: RESUME_SUBSCRIBER,
    });
    if (gap.outcome !== "CURSOR_GAP") throw new Error(JSON.stringify(gap));
    const started = await host.start();
    if (!started.ok) throw new Error(started.code);
    await run({
      database,
      deps,
      host,
      issuedCursor: { generation: gap.snapshot.generation, position: gap.snapshot.checkpoint },
      store,
      subscriptions,
    }, started.origin);
  } finally {
    await host.stop().catch(() => undefined);
    store.close();
    database.close();
    provider.close();
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // A held SQLite handle on Windows must not redden an arm that already answered.
    }
  }
}
