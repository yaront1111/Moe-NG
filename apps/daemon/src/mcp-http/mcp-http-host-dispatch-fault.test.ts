import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpDispatchFault } from "@moe/mcp";
import { afterEach, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { createMcpHttpHost } from "./mcp-http-host.js";
import type { McpHttpHost } from "./mcp-http-host.js";

/**
 * The host's `onDispatchFault` option, driven against the PRODUCTION pipeline: a real store,
 * the real dispatch port, the real session port, the real adapter from `@moe/mcp`. The fault is
 * injected ONE seam past the session screen — `deps.eventStreamAccess.authorize`, which only
 * `events.read` reaches and only after the bearer authenticated — so the request passes every
 * screen and dies inside the dispatch, exactly where a locked store would kill a seat's read.
 *
 * Before this the seat saw UNKNOWN_ERROR and the wrapper's log held nothing.
 */

const PROJECT = "project-mcp-http-fault";
const CREDENTIAL = "operator-mcp-http-fault-credential";
const PRINCIPAL = "operator-local";
const CLOCK = (): string => "2026-09-18T00:00:00.000Z";
const SESSION_ID_HEADER = "mcp-session-id";
const ACCEPT = "application/json, text/event-stream";
const SECRET = "SQLITE_BUSY: database is locked at /var/lib/moe/events.db";

const INITIALIZE_BODY = JSON.stringify({
  id: 1, jsonrpc: "2.0", method: "initialize",
  params: {
    capabilities: {}, clientInfo: { name: "mcp-http-fault-test", version: "0.0.0" },
    protocolVersion: "2025-06-18",
  },
});

const EVENTS_READ_BODY = JSON.stringify({
  id: 2, jsonrpc: "2.0", method: "tools/call",
  params: {
    arguments: {
      correlationId: "corr-mcp-http-fault-1",
      payload: { projection: "goals", subscriberId: "subscriber-mcp-http-fault-1" },
    },
    name: "events_read",
  },
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function within<T>(label: string, promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`TIMED OUT waiting for: ${label}`)); }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function mcpRequest(origin: string, body: string, sessionId?: string): Request {
  const headers = new Headers({
    accept: ACCEPT, authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json",
    host: new URL(origin).host,
  });
  if (sessionId !== undefined) headers.set(SESSION_ID_HEADER, sessionId);
  return new Request(`${origin}/`, { body, headers, method: "POST" });
}

async function withFaultingHost(
  run: (host: McpHttpHost, faults: readonly McpDispatchFault[]) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "moe-mcp-http-fault-"));
  const provider = createStoreDependencies({
    clock: CLOCK, credential: CREDENTIAL, principalId: PRINCIPAL, projectId: PROJECT,
    storePath: join(directory, "store.db"),
  });
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription seam");
  const faults: McpDispatchFault[] = [];
  const host = createMcpHttpHost({
    deps: {
      ...provider.provide(),
      // The one seam that throws. The authenticator is untouched, so the session screen — which
      // re-validates the bearer on every request — passes, and the throw lands in the dispatch.
      eventStreamAccess: {
        authorize(): never {
          throw Object.assign(new Error(SECRET), { code: "SQLITE_BUSY" });
        },
      },
    },
    enableJsonResponse: true,
    onDispatchFault: (fault) => { faults.push(fault); },
    subscriptions,
  });
  try {
    await run(host, faults);
  } finally {
    await within("host.stop during teardown", host.stop()).catch(() => undefined);
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("mcp-http host dispatch fault disclosure", () => {
  it("reports a dispatch that threw inside the production pipeline, while the seat sees UNKNOWN_ERROR", async () => {
    await withFaultingHost(async (host, faults) => {
      const started = await within("start", host.start());
      if (!started.ok) throw new Error(`start refused: ${started.code}`);
      const opened = await within("initialize", host.handleRequest(mcpRequest(started.origin, INITIALIZE_BODY)));
      const sessionId = opened.headers.get(SESSION_ID_HEADER);
      if (opened.body !== null) await opened.text();
      if (sessionId === null) throw new Error(`initialize minted no session: ${String(opened.status)}`);

      const response = await within("tools/call", host.handleRequest(
        mcpRequest(started.origin, EVENTS_READ_BODY, sessionId),
      ));
      const text = await within("tools/call body", response.text());

      // The seat's side is unchanged: the registry's UNKNOWN_ERROR, nothing of the throw.
      expect(text).toContain('"UNKNOWN_ERROR"');
      expect(text).not.toContain("SQLITE_BUSY");
      expect(text).not.toContain(CREDENTIAL);
      // The host's side is new: one fault, naming the kind, the stage and the throw.
      expect(faults).toHaveLength(1);
      expect(faults[0]).toMatchObject({
        stage: "dispatch",
        surface: "query",
        thrown: { code: "SQLITE_BUSY", message: SECRET, name: "Error" },
        toolKind: "events.read",
        transport: "http",
      });
    });
  });
});
