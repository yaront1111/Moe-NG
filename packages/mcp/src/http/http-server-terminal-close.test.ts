import { describe, expect, it } from "vitest";

import { createRecordingPort } from "../dispatch-conformance.js";
import { createHttpAdapterLifecycle, settleHttpResponseOnClose } from "./http-adapter-lifecycle.js";
import { createHttpMcpAdapter } from "./http-server.js";
import type { HttpAuthAccepted, HttpSessionPort } from "./http-session.js";
import { INITIALIZE_BODY, build, readPayload } from "./http-server-test-helpers.js";

const VERDICT: HttpAuthAccepted = { ok: true, principalRef: "principal-close", sessionRef: "session-close" };

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

async function expectClosed(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(response.headers.get("mcp-session-id")).toBeNull();
  expect(await readPayload(response)).toMatchObject({
    error: { code: -32001, data: { code: "SESSION_EXPIRED" } }, id: null,
  });
}

describe("HTTP adapter terminal close", () => {
  it("does not dispatch initialization after its latch closes before the next microtask", async () => {
    let release!: () => void;
    let dispatched = 0;
    let unsubscribed = 0;
    const closed = new Response(null, { status: 404 });
    const pending = settleHttpResponseOnClose({
      subscribe(onClose): () => void {
        release = onClose;
        return () => { unsubscribed++; };
      },
    }, async () => { dispatched++; return new Response(null); }, () => closed);
    release();
    expect(await pending).toBe(closed);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(dispatched).toBe(0);
    expect(unsubscribed).toBe(1);
  });

  it("shares cleanup with a synchronous close call from an abort listener", async () => {
    let releases = 0;
    const lifecycle = createHttpAdapterLifecycle(async () => { releases++; });
    let nested: Promise<void> | undefined;
    lifecycle.signal.addEventListener("abort", () => { nested = lifecycle.close(); });
    const closing = lifecycle.close();
    expect(nested).toBe(closing);
    await closing;
    expect(releases).toBe(1);
  });

  it("compensates initialization whose asynchronous bind finishes after close", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const bound: string[] = [];
    const closed: string[] = [];
    const sessionPort: HttpSessionPort = {
      validateBearer: () => VERDICT,
      async bindSession(id): Promise<void> { bound.push(id); entered.resolve(); await release.promise; },
      closeSession(id): void { closed.push(id); },
    };
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({ dispatchPort: port, sessionPort });
    const initializing = adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    try {
      await entered.promise;
      // Shutdown seals admission without waiting for an externally owned bind to settle.
      await adapter.close();
      expect(closed).toEqual([]);
      release.resolve();
      await expectClosed(await initializing);
      expect(closed).toEqual(bound);
      expect(closed).toHaveLength(1);
      await expectClosed(await adapter.handleRequest(build({ body: INITIALIZE_BODY })));
      expect(bound).toHaveLength(1);
      expect(port.dispatched).toEqual([]);
    } finally {
      release.resolve();
      await initializing;
      await adapter.close();
    }
  });

  it("refuses initialization whose authentication finishes after close", async () => {
    const entered = deferred<void>();
    const release = deferred<HttpAuthAccepted>();
    let authentications = 0;
    let bindings = 0;
    const sessionPort: HttpSessionPort = {
      validateBearer(): Promise<HttpAuthAccepted> { authentications++; entered.resolve(); return release.promise; },
      bindSession(): void { bindings++; },
      closeSession(): void {},
    };
    const adapter = createHttpMcpAdapter({ dispatchPort: createRecordingPort(), sessionPort });
    const initializing = adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    try {
      await entered.promise;
      await adapter.close();
      release.resolve(VERDICT);
      await expectClosed(await initializing);
      await expectClosed(await adapter.handleRequest(build({ body: INITIALIZE_BODY })));
      expect(authentications).toBe(1);
      expect(bindings).toBe(0);
    } finally {
      release.resolve(VERDICT);
      await initializing;
      await adapter.close();
    }
  });

  it("settles initialization closed after binding but before its SDK response", async () => {
    const released = deferred<void>();
    let closeAttempts = 0;
    const sessionPort: HttpSessionPort = {
      validateBearer: () => VERDICT,
      bindSession(): void {
        // Let bindDaemonSession publish its entry, then close before the SDK can answer.
        queueMicrotask(() => { queueMicrotask(() => { void adapter.close(); }); });
      },
      closeSession(): void { closeAttempts++; released.resolve(); },
    };
    const adapter = createHttpMcpAdapter({ dispatchPort: createRecordingPort(), sessionPort });
    let response: Response | undefined;
    void adapter.handleRequest(build({ body: INITIALIZE_BODY })).then((answer) => { response = answer; });
    try {
      await released.promise;
      await adapter.close();
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(closeAttempts).toBe(1);
      expect(response).toBeDefined();
      if (response !== undefined) await expectClosed(response);
    } finally {
      await adapter.close();
    }
  });

  it("reports a failed compensating release without exposing the boundary error", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let closeAttempts = 0;
    const sessionPort: HttpSessionPort = {
      validateBearer: () => VERDICT,
      async bindSession(): Promise<void> { entered.resolve(); await release.promise; },
      closeSession(): never { closeAttempts++; throw new Error("private-release-failure-detail"); },
    };
    const adapter = createHttpMcpAdapter({ dispatchPort: createRecordingPort(), sessionPort });
    const initializing = adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    try {
      await entered.promise;
      await adapter.close();
      release.resolve();
      const response = await initializing;
      expect(response.status).toBe(500);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      const text = await response.text();
      expect(text).not.toContain("private-release-failure-detail");
      expect(JSON.parse(text)).toMatchObject({
        error: { code: -32603, data: { code: "UNKNOWN_ERROR" } }, id: null,
      });
      expect(closeAttempts).toBe(1);
      await expectClosed(await adapter.handleRequest(build({ body: INITIALIZE_BODY })));
    } finally {
      release.resolve();
      await initializing;
      await adapter.close();
    }
  });

  it("refuses a session request whose authentication finishes after close", async () => {
    const entered = deferred<void>();
    const release = deferred<HttpAuthAccepted>();
    let delay = false;
    const sessionPort: HttpSessionPort = {
      validateBearer(): HttpAuthAccepted | Promise<HttpAuthAccepted> {
        if (!delay) return VERDICT;
        entered.resolve();
        return release.promise;
      },
      bindSession(): void {},
      closeSession(): void {},
    };
    const port = createRecordingPort();
    const adapter = createHttpMcpAdapter({ dispatchPort: port, sessionPort });
    const initialized = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    const sessionId = initialized.headers.get("mcp-session-id") ?? "";
    await initialized.text();
    delay = true;
    const pending = adapter.handleRequest(build({
      body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }), sessionId,
    }));
    try {
      await entered.promise;
      await adapter.close();
      release.resolve(VERDICT);
      await expectClosed(await pending);
      expect(port.dispatched).toEqual([]);
    } finally {
      release.resolve(VERDICT);
      await pending;
      await adapter.close();
    }
  });

  it("shares one shutdown promise across concurrent and repeated closes", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let closes = 0;
    const sessionPort: HttpSessionPort = {
      validateBearer: () => VERDICT,
      bindSession(): void {},
      async closeSession(): Promise<void> { closes++; entered.resolve(); await release.promise; },
    };
    const adapter = createHttpMcpAdapter({ dispatchPort: createRecordingPort(), sessionPort });
    const initialized = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    await initialized.text();
    const first = adapter.close();
    const second = adapter.close();
    try {
      expect(second).toBe(first);
      await entered.promise;
      await expectClosed(await adapter.handleRequest(build({ body: INITIALIZE_BODY })));
      release.resolve();
      await first;
      expect(adapter.close()).toBe(first);
      expect(closes).toBe(1);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
  });

  it("preserves the same rejected shutdown result on repeated close", async () => {
    let closeAttempts = 0;
    const sessionPort: HttpSessionPort = {
      validateBearer: () => VERDICT,
      bindSession(): void {},
      closeSession(): never { closeAttempts++; throw new Error("release failed"); },
    };
    const adapter = createHttpMcpAdapter({ dispatchPort: createRecordingPort(), sessionPort });
    const initialized = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
    await initialized.text();
    const closing = adapter.close();
    await expect(closing).rejects.toMatchObject({ code: "HTTP_SHUTDOWN_SESSION_RELEASE_FAILED" });
    expect(adapter.close()).toBe(closing);
    await expect(adapter.close()).rejects.toMatchObject({ code: "HTTP_SHUTDOWN_SESSION_RELEASE_FAILED" });
    expect(closeAttempts).toBe(1);
    await expectClosed(await adapter.handleRequest(build({ body: INITIALIZE_BODY })));
  });
});
