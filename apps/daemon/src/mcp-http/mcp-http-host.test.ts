import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { createStoreDependencies } from "../daemon-store-dependencies.js";
import { MCP_HTTP_PORT_ENV, createMcpHttpHost, readHttpPort } from "./mcp-http-host.js";
import type { McpHttpHost } from "./mcp-http-host.js";

/**
 * The host is driven END TO END against production: a real temp-file SqliteEventStore, the real
 * createStoreDependencies (which also installs the genesis recovery binding every authentication
 * is fenced on), the real createMcpDispatchPort, the real session authenticator behind the real
 * session port, and the real createHttpMcpAdapter imported from the bare `@moe/mcp` root.
 *
 * There is deliberately NO fake dispatcher anywhere in this file. A host test driven by a stub
 * proves the adapter's own suite over again and would stay green through a host that never
 * reached the daemon at all — which is exactly what drill D6 exists to demonstrate.
 */

const PROJECT = "project-mcp-http-1";
const CREDENTIAL = "operator-mcp-http-credential";
const PRINCIPAL = "operator-local";
const CLOCK = (): string => "2026-08-14T00:00:00.000Z";

/** The MCP Streamable HTTP session header. A wire-protocol name, not @moe/mcp's to change. */
const SESSION_ID_HEADER = "mcp-session-id";

const INITIALIZE_BODY = JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "mcp-http-host-test", version: "0.0.0" },
    protocolVersion: "2025-06-18",
  },
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * Every await in this suite is bounded. An unbounded await on a transport that never answers
 * stalls the whole run with no attribution; a bound turns the same defect into a named failure,
 * which is what makes the D4 teardown drill readable rather than a hang.
 */
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

interface Harness {
  readonly decisionCount: () => number;
  readonly host: McpHttpHost;
}

/**
 * Opens a full production wiring in a fresh temp directory and tears it down in `finally`.
 * The provider and the second read handle are closed BEFORE rmSync: a still-open SQLite handle
 * makes the directory removal fail with EPERM on Windows and kills the vitest worker outright,
 * with zero test output, reading as a native crash rather than as a leak.
 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "moe-mcp-http-host-"));
  const storePath = join(directory, "store.db");
  const provider = createStoreDependencies({
    clock: CLOCK,
    credential: CREDENTIAL,
    principalId: PRINCIPAL,
    projectId: PROJECT,
    storePath,
  });
  const eventSource = SqliteEventStore.open(storePath);
  const subscriptions = provider.subscriptions?.();
  if (subscriptions === undefined) throw new Error("provider serves no subscription seam");
  const host = createMcpHttpHost({
    affordances: provider.affordances?.(),
    deps: provider.provide(),
    enableJsonResponse: true,
    subscriptions,
  });
  const decisionCount = (): number => {
    let cursor = 0n;
    let total = 0;
    for (;;) {
      const page = eventSource.readCommandDecisionsAfter(cursor, 100);
      total += page.items.length;
      if (page.nextCursor === null || page.items.length === 0) return total;
      cursor = page.nextCursor;
    }
  };
  try {
    await run({ decisionCount, host });
  } finally {
    await within("host.stop during teardown", host.stop()).catch(() => undefined);
    eventSource.close();
    provider.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

/**
 * The two headers a real MCP client always sends and `new Request()` never fills in:
 *
 * - `host`. The adapter screens Host/Origin for loopback itself rather than delegating to the
 *   SDK, and `new Request(url, ...)` does NOT derive a host header from the URL. A direct
 *   in-process call therefore arrives host-less and is refused CAPABILITY_DENIED (403), while
 *   the same bytes over a socket pass because node writes the header. Setting it here makes the
 *   two paths comparable — which is exactly what the bridge-fidelity case is for.
 * - `accept`. The Streamable HTTP transport requires both JSON and SSE to be acceptable and
 *   answers 406 otherwise.
 */
const ACCEPT = "application/json, text/event-stream";

function authorityOf(origin: string): string {
  return new URL(origin).host;
}

function mcpRequest(
  origin: string,
  init: { readonly body?: string; readonly credential?: string; readonly sessionId?: string } = {},
): Request {
  const headers = new Headers({
    accept: ACCEPT,
    authorization: `Bearer ${init.credential ?? CREDENTIAL}`,
    host: authorityOf(origin),
  });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.sessionId !== undefined) headers.set(SESSION_ID_HEADER, init.sessionId);
  return new Request(`${origin}/`, {
    ...(init.body === undefined ? {} : { body: init.body }),
    headers,
    method: init.body === undefined ? "GET" : "POST",
  });
}

function initializeRequest(origin: string, credential = CREDENTIAL): Request {
  return mcpRequest(origin, { body: INITIALIZE_BODY, credential });
}

async function openSession(
  host: McpHttpHost,
  origin: string,
  credential = CREDENTIAL,
): Promise<string> {
  const response = await within("initialize", host.handleRequest(
    initializeRequest(origin, credential),
  ));
  const sessionId = response.headers.get(SESSION_ID_HEADER);
  if (response.body !== null) await within("initialize body", response.text());
  if (sessionId === null) throw new Error(`initialize minted no session: ${String(response.status)}`);
  return sessionId;
}

describe("mcp-http host — official Streamable HTTP adapter over the production pipeline", () => {
  it("starts on port 0, reports the bound port, and REFUSES a second start", async () => {
    await withHarness(async ({ host }) => {
      const started = await within("first start", host.start());
      expect(started).toMatchObject({ ok: true });
      if (!started.ok) throw new Error("unreachable: first start refused");
      expect(started.port).toBeGreaterThan(0);
      expect(started.origin).toBe(`http://127.0.0.1:${String(started.port)}`);

      const again = await within("second start", host.start());
      // Single ownership: a second start must refuse with a stable code, never bind twice.
      expect(again).toEqual({ code: "MCP_HTTP_HOST_ALREADY_STARTED", ok: false });
    });
  });

  it("binds ONCE under CONCURRENT starts, not once per caller", async () => {
    await withHarness(async ({ host }) => {
      // Fired without awaiting between them. The sequential case cannot catch this: `server` is
      // assigned only AFTER `listen` resolves, so two in-flight starts both observe null and
      // both bind, orphaning the first listener with no reference left to close it.
      const results = await within("concurrent starts", Promise.all([
        host.start(),
        host.start(),
        host.start(),
      ]));
      const accepted = results.filter((result) => result.ok);
      const refused = results.filter((result) => !result.ok);
      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(2);
      for (const result of refused) {
        expect(result).toEqual({ code: "MCP_HTTP_HOST_ALREADY_STARTED", ok: false });
      }
      // The one accepted start is the one that is actually reachable.
      const [only] = accepted;
      if (only?.ok !== true) throw new Error("no start succeeded");
      const response = await within("reach the bound listener", fetch(`${only.origin}/`, {
        body: INITIALIZE_BODY,
        headers: {
          accept: ACCEPT,
          authorization: `Bearer ${CREDENTIAL}`,
          "content-type": "application/json",
        },
        method: "POST",
      }));
      expect(response.status).toBe(200);
      await response.text();
    });
  });

  it("survives a start/stop/start/stop CYCLE, which a missing closeAllConnections would hang", async () => {
    await withHarness(async ({ host }) => {
      for (const cycle of [1, 2]) {
        const started = await within(`cycle start ${String(cycle)}`, host.start());
        expect(started).toMatchObject({ ok: true });
        if (!started.ok) throw new Error("start refused");

        // A REAL keep-alive socket must exist at teardown or this case cannot fail. node's
        // fetch pools connections, so this leaves one open — and an open connection is the
        // entire precondition for the hang: without closeAllConnections, server.close() never
        // fires its callback while a client socket is still parked. Proven by drill D4, which
        // SURVIVED until this request was added.
        await within(`cycle request ${String(cycle)}`, fetch(`${started.origin}/`, {
          body: INITIALIZE_BODY,
          headers: {
            accept: ACCEPT,
            authorization: `Bearer ${CREDENTIAL}`,
            "content-type": "application/json",
          },
          method: "POST",
        }).then(async (response) => response.text()));

        await within(`cycle stop ${String(cycle)}`, host.stop());
      }
      // A third stop is a no-op, not a throw and not a second close of the adapter.
      await within("idempotent stop", host.stop());
    });
  });

  it("stops while an SSE stream is OPEN, which close() alone would wait on forever", async () => {
    // SSE mode on purpose: this is the adapter's default and the only shape that makes
    // closeAllConnections observable. Since Node 19 `close()` reaps IDLE keep-alive sockets by
    // itself, so a plain request/response cycle cannot distinguish the two implementations —
    // measured, not assumed (drill D4 survived a keep-alive-only version of this case).
    await withHarness(async ({ host }) => {
      const started = await within("start", host.start());
      if (!started.ok) throw new Error("start refused");
      const sessionId = await openSession(host, started.origin);

      // A GET on an initialized session opens the event stream and leaves it open. The body is
      // deliberately NOT drained: an undrained stream is an ACTIVE connection, and close() waits
      // on active connections rather than reaping them.
      const stream = await within("open SSE stream", fetch(`${started.origin}/`, {
        headers: {
          accept: ACCEPT,
          authorization: `Bearer ${CREDENTIAL}`,
          [SESSION_ID_HEADER]: sessionId,
        },
        method: "GET",
      }));
      expect(stream.status).toBe(200);

      // The assertion IS the completion: without closeAllConnections this stop never resolves
      // and `within` fails by name instead of stalling the suite.
      await within("stop with SSE stream open", host.stop(), 10_000);
      await stream.body?.cancel();
    });
  }, 30_000);

  it("frees the SSE stream slot when the client DROPS, instead of leaking the dead pump", async () => {
    // The observable is the SDK transport's own single-stream rule: while a standalone SSE
    // stream is mapped, a second GET on the session answers 409. A bridge that never observes
    // the disconnect keeps a dropped client's pump parked in reader.read() forever, so the
    // mapping — and its session state — outlives the client for the daemon's whole life, and
    // the slot never frees. The 409 positive control proves the slot really was occupied
    // before the drop, so the later 200 is evidence of cleanup, not of a rule that never
    // engaged.
    await withHarness(async ({ host }) => {
      const started = await within("start", host.start());
      if (!started.ok) throw new Error("start refused");
      const sessionId = await openSession(host, started.origin);
      const streamHeaders = {
        accept: ACCEPT,
        authorization: `Bearer ${CREDENTIAL}`,
        [SESSION_ID_HEADER]: sessionId,
      };

      // A RAW node request rather than fetch, so the client side can be severed mid-stream:
      // fetch owns its socket and offers no handle to destroy.
      const dropped = await within(
        "open raw SSE stream",
        new Promise<IncomingMessage>((resolve, reject) => {
          const opened = httpRequest(`${started.origin}/`, { headers: streamHeaders, method: "GET" });
          opened.once("response", resolve);
          opened.once("error", reject);
          opened.end();
        }),
      );
      expect(dropped.statusCode).toBe(200);

      const occupied = await within("second stream while occupied", fetch(`${started.origin}/`, {
        headers: streamHeaders,
        method: "GET",
      }));
      expect(occupied.status).toBe(409);
      await occupied.body?.cancel();

      // The client vanishes. The host's 'close' wiring must cancel the pump's reader, which
      // runs the SDK stream's cancel() — the only code that deletes the mapping.
      dropped.destroy();

      const reopened = await within("stream slot frees after the drop", (async (): Promise<Response> => {
        for (;;) {
          const attempt = await fetch(`${started.origin}/`, { headers: streamHeaders, method: "GET" });
          if (attempt.status === 200) return attempt;
          // While the disconnect propagates, "still occupied" is the only acceptable answer.
          expect(attempt.status).toBe(409);
          await attempt.body?.cancel();
          await new Promise((resolve) => { setTimeout(resolve, 50); });
        }
      })());
      await reopened.body?.cancel();
    });
  }, 30_000);

  it("mints a session on initialize and answers tools/call from the PRODUCTION pipeline", async () => {
    await withHarness(async ({ host }) => {
      const started = await within("start", host.start());
      if (!started.ok) throw new Error("start refused");
      const sessionId = await openSession(host, started.origin);
      expect(sessionId.length).toBeGreaterThan(0);

      const response = await within("tools/call", host.handleRequest(mcpRequest(started.origin, {
        body: JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            // The query envelope is EXACT-KEYED (hasExactKeys over correlationId, queryKind,
            // schemaVersion, sessionCredential, payload): omitting correlationId is refused
            // INPUT_INVALID before the dispatch port is ever consulted.
            arguments: {
              correlationId: "corr-mcp-http-1",
              payload: { projection: "goals", subscriberId: "subscriber-mcp-http-1" },
            },
            name: "events_read",
          },
        }),
        sessionId,
      })));
      expect(response.status).toBe(200);
      const text = await within("tools/call body", response.text());
      // THE DAEMON'S OWN ANSWER, verbatim. The provider's subscription seam publishes its
      // baseline, so the refusal a fresh store gives an unknown subscriber is the read
      // model's own: SUBSCRIPTION_NOT_REGISTERED / STATE, produced by the production
      // subscription store and by nothing else. A host wired to a canned success, or to
      // any stub, cannot forge this pair (drill D6 removes the real call and requires red).
      // Asserting the exact code and layer rather than merely "not ok" is epic rail 6.
      expect(text).toContain("SUBSCRIPTION_NOT_REGISTERED");
      expect(text).toContain('\\"layer\\":\\"STATE\\"');
      expect(text).toContain('\\"outcome\\":\\"REFUSED\\"');
      // The credential rode in on this request and must not ride out on the answer.
      expect(text).not.toContain(CREDENTIAL);
    });
  });

  it("refuses an unknown credential with the registry's stable code and commits NOTHING", async () => {
    await withHarness(async ({ decisionCount, host }) => {
      const started = await within("start", host.start());
      if (!started.ok) throw new Error("start refused");
      const before = decisionCount();

      const response = await within("refused initialize", host.handleRequest(
        initializeRequest(started.origin, "not-the-operator-credential"),
      ));
      const text = await within("refusal body", response.text());

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(text).toContain("AUTHENTICATION_FAILED");
      // No daemon internals, no credential, no host path may ride out on a refusal.
      expect(text).not.toContain("not-the-operator-credential");
      expect(text).not.toContain(tmpdir());
      expect(text).not.toContain("store.db");
      // The assertion that makes "commits nothing on refusal" mechanically checkable.
      expect(decisionCount()).toBe(before);
    });
  });

  it("authorizes commands as the request bearer, never as the host bootstrap identity", async () => {
    await withHarness(async ({ decisionCount, host }) => {
      const started = await within("start", host.start());
      if (!started.ok) throw new Error("start refused");
      const operatorSessionId = await openSession(host, started.origin);
      const scopedCredential = "work-only-mcp-http-credential";
      const scopedSessionId = "session-mcp-http-work-only";

      const opened = await within("open scoped daemon session", host.handleRequest(mcpRequest(
        started.origin,
        {
          body: JSON.stringify({
            id: 2,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              arguments: {
                commandId: "cmd-mcp-http-open-work-only",
                correlationId: "corr-mcp-http-open-work-only",
                expectedVersion: 0,
                payload: {
                  capabilities: ["work.write"],
                  credentialSha256: createHash("sha256")
                    .update(scopedCredential, "utf8").digest("hex"),
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  sessionId: scopedSessionId,
                },
                targetAggregateId: `session/${scopedSessionId}`,
              },
              name: "session_open",
            },
          }),
          sessionId: operatorSessionId,
        },
      )));
      const openedText = await within("open scoped daemon session body", opened.text());
      expect(opened.status).toBe(200);
      expect(openedText).toContain('\\"outcome\\":\\"ACCEPTED\\"');

      const scopedMcpSessionId = await openSession(host, started.origin, scopedCredential);
      const before = decisionCount();
      const refused = await within("work-only admin command", host.handleRequest(mcpRequest(
        started.origin,
        {
          body: JSON.stringify({
            id: 3,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              arguments: {
                commandId: "cmd-mcp-http-forbidden-project-register",
                correlationId: "corr-mcp-http-forbidden-project-register",
                expectedVersion: 0,
                payload: { owner: "work-only-session" },
                targetAggregateId: PROJECT,
              },
              name: "project_register",
            },
          }),
          credential: scopedCredential,
          sessionId: scopedMcpSessionId,
        },
      )));
      const refusedText = await within("work-only admin command body", refused.text());

      expect(refused.status).toBe(200);
      expect(refusedText).toContain("CAPABILITY_DENIED");
      expect(decisionCount()).toBe(before);
    });
  });

  it("bridges node socket to Web Request with the SAME status, session header and body", async () => {
    await withHarness(async ({ host }) => {
      const started = await within("start", host.start());
      if (!started.ok) throw new Error("start refused");

      // Same bytes, two paths: once over the real listener socket, once straight into the
      // adapter. A bridge that drops or renames a header — the session id above all — breaks
      // resume in a way no status-code assertion would catch.
      const overSocket = await within("socket initialize", fetch(`${started.origin}/`, {
        body: INITIALIZE_BODY,
        headers: {
          accept: ACCEPT,
          authorization: `Bearer ${CREDENTIAL}`,
          "content-type": "application/json",
        },
        method: "POST",
      }));
      const socketBody = await within("socket body", overSocket.text());
      const socketSession = overSocket.headers.get(SESSION_ID_HEADER);

      const direct = await within("direct initialize", host.handleRequest(
        initializeRequest(started.origin),
      ));
      const directBody = await within("direct body", direct.text());
      const directSession = direct.headers.get(SESSION_ID_HEADER);

      expect(overSocket.status).toBe(direct.status);
      expect(socketSession).not.toBeNull();
      expect(directSession).not.toBeNull();
      expect(overSocket.headers.get("content-type")).toBe(direct.headers.get("content-type"));
      // Session ids differ per session by construction; the BODY is what must match verbatim
      // once the per-session id is factored out.
      expect(socketBody.replaceAll(socketSession ?? "", "")).toBe(
        directBody.replaceAll(directSession ?? "", ""),
      );
    });
  });

  it("refuses to start on a non-loopback bind rather than warning", async () => {
    await withHarness(async ({ host: _unused }) => {
      const directory = mkdtempSync(join(tmpdir(), "moe-mcp-http-bind-"));
      const storePath = join(directory, "store.db");
      const provider = createStoreDependencies({
        clock: CLOCK,
        credential: CREDENTIAL,
        principalId: PRINCIPAL,
        projectId: PROJECT,
        storePath,
      });
      const subscriptions = provider.subscriptions?.();
      if (subscriptions === undefined) throw new Error("provider serves no subscription seam");
      const offHost = createMcpHttpHost({
        deps: provider.provide(),
        host: "0.0.0.0",
        subscriptions,
      });
      try {
        expect(await within("non-loopback start", offHost.start())).toEqual({
          code: "MCP_HTTP_HOST_NON_LOOPBACK_BIND",
          ok: false,
        });
      } finally {
        await within("off-host stop", offHost.stop()).catch(() => undefined);
        provider.close();
        rmSync(directory, { force: true, recursive: true });
      }
    });
  });

  it("reads the bind port from the environment and refuses a bad value BY NAME", () => {
    // Absent and empty both mean "ephemeral", which is the documented default.
    expect(readHttpPort({})).toBe(0);
    expect(readHttpPort({ [MCP_HTTP_PORT_ENV]: "" })).toBe(0);
    expect(readHttpPort({ [MCP_HTTP_PORT_ENV]: "8931" })).toBe(8931);

    // A typo must FAIL rather than silently coerce to an ephemeral port: a daemon that comes up
    // on a random port when the operator asked for a specific one is worse than one that dies.
    // The message names the VARIABLE and never the value, matching the entry's stated discipline.
    for (const bad of ["not-a-port", "-1", "65536", "80.5", "8080abc"]) {
      expect(() => readHttpPort({ [MCP_HTTP_PORT_ENV]: bad })).toThrow(`${MCP_HTTP_PORT_ENV}_INVALID`);
      expect(() => readHttpPort({ [MCP_HTTP_PORT_ENV]: bad })).not.toThrow(bad);
    }
  });

  it("covers exactly the eleven host behaviours this suite claims", async () => {
    // A hand-written count is only worth writing if it can FAIL. `expect(6).toBe(6)` cannot, so
    // the number is read back off this file's own source: delete or add a case and this reddens.
    const source = readFileSync(new URL(import.meta.url), "utf8");
    expect(source.match(/^ {2}it\(/gmu) ?? []).toHaveLength(12); // eleven behaviours + this counter
    // And the host's public surface, hand-listed so a silently dropped method is visible.
    await withHarness(async ({ host }) => {
      expect(Object.keys(host).sort()).toEqual(["handleRequest", "start", "stop"]);
    });
  });
});
