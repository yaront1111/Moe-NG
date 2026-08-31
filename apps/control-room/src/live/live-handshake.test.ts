import { RUNTIME_COMMAND_ENVELOPE_VERSION, RUNTIME_ERROR_REGISTRY_VERSION, RUNTIME_QUERY_ENVELOPE_VERSION } from "@moe/contracts";
import type { FetchLike } from "@moe/control-room-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLiveSetupFromHandshake } from "./live-handshake.js";
import type { LiveHandshakeResult, LivePairingPending } from "./live-handshake.js";
const WIRE = `${RUNTIME_COMMAND_ENVELOPE_VERSION}+${RUNTIME_QUERY_ENVELOPE_VERSION}+${RUNTIME_ERROR_REGISTRY_VERSION}`;
const REQUEST_ID = "ab".repeat(32);
const CREDENTIAL = "credential-in-memory";
interface Call { readonly init: RequestInit; readonly path: string }
interface Deferred<T> { readonly promise: Promise<T>; readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void }
type Responder = (path: string, init: RequestInit) => Promise<Response> | Response;
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, reject, resolve };
}
// Real Headers, never a defaulted operator-channel value: the missing-header case
// must stay constructible, so only the successful pairing-request fixture below
// spells the literal out. The header name is written literally here rather than
// imported from production so a producer-side typo reds instead of following.
const OPERATOR_CHANNEL_HEADER = "x-moe-operator-channel";
function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return {
    headers: new Headers(headers), json: async () => body,
    ok: status >= 200 && status < 300, status,
  } as Response;
}
function bodyResponse(body: Promise<unknown>, status = 200): Response {
  return {
    headers: new Headers(), json: () => body,
    ok: status >= 200 && status < 300, status,
  } as Response;
}
function pending(result: LiveHandshakeResult): LivePairingPending {
  if (!("status" in result) || result.status !== "AWAITING_OPERATOR") throw new Error("expected pending pairing");
  return result;
}
function makeFetch(respond: Responder): { readonly calls: Call[]; readonly fetchImpl: FetchLike } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (path, init) => { calls.push({ init, path }); return respond(path, init); },
  };
}
const bootstrap = (): Response => json({ csrfToken: "csrf-local", projectId: "project-a", protocolVersion: WIRE });
const OPERATOR_PRESENT: HeadersInit = { [OPERATOR_CHANNEL_HEADER]: "true" };
const requestCreated = (headers: HeadersInit = OPERATOR_PRESENT): Response =>
  json({ confirmationLabel: "abcd-ef01-2345", ok: true, requestId: REQUEST_ID }, 200, headers);
const claimBody = (projectId = "project-a"): Record<string, unknown> => ({
  capabilities: ["command.send"],
  challenge: {
    keyEpochRef: "key-epoch-live", profileRevisionId: "profile-live",
    recoveryIncarnationRef: "recovery-live",
  },
  expiresAt: "2026-08-25T01:00:00.000Z", ok: true,
  principalId: "principal-live", projectId, protocolVersion: WIRE,
  sessionCredential: CREDENTIAL,
});
function postedBody(init: RequestInit): Readonly<Record<string, unknown>> {
  if (typeof init.body !== "string") throw new Error("expected JSON request body");
  return JSON.parse(init.body) as Readonly<Record<string, unknown>>;
}
function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected record");
  }
  return value as Readonly<Record<string, unknown>>;
}
function healthy(path: string, init: RequestInit = {}): Response {
  if (path === "/bootstrap") return bootstrap();
  if (path === "/session/pair/request") return requestCreated();
  if (path === "/session/pair/claim") return json(claimBody());
  if (path === "/session/pair/open") {
    return json({ ok: true, protocolVersion: WIRE, sessionId: postedBody(init)["sessionId"] });
  }
  return json({}, 404);
}
async function elapse(milliseconds: number): Promise<void> { await vi.advanceTimersByTimeAsync(milliseconds); }
async function waitForCalls(calls: readonly Call[], count: number): Promise<void> {
  for (let turn = 0; turn < 100 && calls.length < count; turn += 1) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  expect(calls).toHaveLength(count);
}
async function settledAfterCancellation<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  let failure: unknown;
  let value: T | undefined;
  void promise.then(
    (result) => { done = true; value = result; },
    (reason: unknown) => { done = true; failure = reason; },
  );
  for (let turn = 0; turn < 20 && !done; turn += 1) await Promise.resolve();
  if (!done) throw new Error("handshake did not settle after cancellation");
  if (failure !== undefined) throw failure;
  return value as T;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe("plain-origin live pairing handshake", () => {
  it("uses distinct defaulted deadlines and releases them after healthy settlement", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetch = makeFetch(healthy);
    const pairing = pending(await resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl, signal: caller.signal }));
    const firstClaim = pairing.claim();
    expect(pairing.claim()).toBe(firstClaim);
    const setup = await firstClaim;
    expect("ok" in setup && setup.ok).toBe(true);
    if (!("ok" in setup) || !setup.ok) throw new Error("expected attached setup");
    expect(setup.projectId).toBe("project-a");
    expect(setup.sessionCredential).toBe(CREDENTIAL);
    expect(fetch.calls.map(({ path }) => path)).toEqual([
      "/bootstrap", "/session/pair/request", "/session/pair/claim", "/session/pair/open",
    ]);
    const signals = fetch.calls.map(({ init }) => init.signal);
    expect(new Set(signals).size).toBe(4);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);
    expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 15_000)).toHaveLength(4);
    const claimRequest = postedBody(fetch.calls[2]!.init);
    expect(Object.keys(claimRequest).toSorted()).toEqual(["publicKeySpkiHex", "requestId"]);
    expect(claimRequest["requestId"]).toBe(REQUEST_ID);
    expect(claimRequest["publicKeySpkiHex"]).toMatch(/^[0-9a-f]{88}$/u);
    const openRequest = postedBody(fetch.calls[3]!.init);
    expect(Object.keys(openRequest).toSorted()).toEqual([
      "clientKeyId", "commandId", "correlationId", "credentialId", "principalId", "proof",
      "publicKeySpkiHex", "requestDigest", "sessionId", "transportId", "transportIds",
    ]);
    expect(Object.keys(recordOf(openRequest["proof"])).toSorted()).toEqual([
      "algorithm", "issuedAt", "nonce", "protocolVersion", "signatureHex",
    ]);
    expect(JSON.stringify({ claimRequest, openRequest })).not.toContain("privateKey");
    expect(vi.getTimerCount()).toBe(0);
    caller.abort("must not reach settled requests");
    await elapse(20_000);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(pairing)).not.toContain(REQUEST_ID);
    expect(fetch.calls.every(({ path }) => !path.includes(REQUEST_ID) && !path.includes(CREDENTIAL))).toBe(true);
  });
  it("times out bootstrap once and ignores a late response", async () => {
    vi.useFakeTimers();
    const late = deferred<Response>();
    const fetch = makeFetch(() => late.promise);
    const resultPromise = resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl, requestTimeoutMs: 20 });
    await elapse(20);
    const result = await settledAfterCancellation(resultPromise);
    expect(result).toEqual({ code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "daemon bootstrap unavailable", ok: false });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.init.signal?.aborted).toBe(true);
    late.resolve(bootstrap());
    await vi.runAllTimersAsync();
    expect("ok" in result && result.ok).toBe(false);
    expect(fetch.calls).toHaveLength(1);
  });
  it("maps caller cancellation before bootstrap settles to the bootstrap layer", async () => {
    const caller = new AbortController();
    const fetch = makeFetch(() => deferred<Response>().promise);
    const resultPromise = resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl,
      requestTimeoutMs: 100, signal: caller.signal });
    caller.abort(new Error("hostile raw caller reason"));
    const result = await settledAfterCancellation(resultPromise);
    expect(result).toEqual({ code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "daemon bootstrap unavailable", ok: false });
    expect(fetch.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("hostile raw caller reason");
    const preAborted = new AbortController(); preAborted.abort();
    const untouched = makeFetch(healthy);
    const preResult = await resolveLiveSetupFromHandshake({ fetchImpl: untouched.fetchImpl, signal: preAborted.signal });
    expect(preResult).toEqual({ code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "daemon bootstrap unavailable", ok: false });
    expect(untouched.calls).toHaveLength(0);
  });
  it("bounds a bootstrap body that stalls after headers", async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const fetch = makeFetch(() => bodyResponse(body.promise));
    const resultPromise = resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl, requestTimeoutMs: 10 });
    await elapse(10);
    const result = await settledAfterCancellation(resultPromise);
    expect(result).toEqual({ code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "daemon bootstrap unavailable", ok: false });
    expect(fetch.calls).toHaveLength(1);
  });
  it("refuses timeout and caller abort while creating the pairing request", async () => {
    const modes = ["timeout", "caller-abort"] as const;
    expect(modes).toHaveLength(2);
    expect(modes.length).toBeGreaterThan(0);
    for (const mode of modes) {
      vi.useFakeTimers();
      const caller = new AbortController();
      const fetch = makeFetch((path) => path === "/bootstrap"
        ? bootstrap() : deferred<Response>().promise);
      const resultPromise = resolveLiveSetupFromHandshake({
        fetchImpl: fetch.fetchImpl, requestTimeoutMs: 10, signal: caller.signal,
      });
      if (mode === "timeout") {
        await elapse(10);
      } else {
        for (let turn = 0; turn < 20 && fetch.calls.length < 2; turn += 1) await Promise.resolve();
        expect(fetch.calls).toHaveLength(2);
        caller.abort();
      }
      const result = await settledAfterCancellation(resultPromise);
      expect(result).toEqual({ code: "LIVE_PAIRING_REFUSED", detail: "pairing request refused", ok: false });
      expect(fetch.calls).toHaveLength(2);
      expect(fetch.calls[1]?.init.signal?.aborted).toBe(true);
      vi.useRealTimers();
    }
  });
  it("times out a stalled pairing body at the local pairing layer", async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    const fetch = makeFetch((path) => path === "/bootstrap"
      ? bootstrap() : bodyResponse(body.promise));
    const resultPromise = resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl, requestTimeoutMs: 10 });
    await elapse(10);
    const result = await settledAfterCancellation(resultPromise);
    expect(result).toEqual({ code: "LIVE_PAIRING_REFUSED", detail: "pairing request refused", ok: false });
    expect(fetch.calls).toHaveLength(2);
  });
  it("does not let a late successful claim settle the pending closure", async () => {
    vi.useRealTimers();
    const late = deferred<Response>();
    let claimCalls = 0;
    const fetch = makeFetch((path) => {
      if (path === "/bootstrap") return bootstrap();
      if (path === "/session/pair/request") return requestCreated();
      claimCalls += 1;
      return claimCalls === 1 ? late.promise : json({
        code: "PAIRING_APPROVAL_REQUIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false,
      }, 409);
    });
    const pairing = pending(await resolveLiveSetupFromHandshake({
      fetchImpl: fetch.fetchImpl, requestTimeoutMs: 10,
    }));
    const firstClaim = pairing.claim();
    await waitForCalls(fetch.calls, 3);
    expect(await firstClaim).toEqual({
      code: "LIVE_PAIRING_REFUSED", detail: "session pairing claim refused", ok: false,
    });
    late.resolve(json(claimBody()));
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(await pairing.claim()).toBe(pairing);
    expect(claimCalls).toBe(2);
    expect(fetch.calls).toHaveLength(4);
  });
  it("maps caller cancellation during claim to the local pairing layer", async () => {
    vi.useRealTimers();
    const caller = new AbortController();
    const fetch = makeFetch((path) => path === "/bootstrap" ? bootstrap()
      : path === "/session/pair/request" ? requestCreated()
      : deferred<Response>().promise);
    const pairing = pending(await resolveLiveSetupFromHandshake({
      fetchImpl: fetch.fetchImpl, requestTimeoutMs: 100, signal: caller.signal,
    }));
    const claim = pairing.claim();
    await waitForCalls(fetch.calls, 3);
    caller.abort();
    const result = await settledAfterCancellation(claim);
    expect(result).toEqual({
      code: "LIVE_PAIRING_REFUSED", detail: "session pairing claim refused", ok: false,
    });
    expect(fetch.calls).toHaveLength(3);
  });
  it("preserves only validated daemon code and layer tokens on non-2xx responses", async () => {
    const hostile = {
      code: "PAIRING_TOKEN_REJECTED", credential: CREDENTIAL, error: "raw daemon secret",
      layer: "DAEMON_PAIRING_GATE", pairingToken: "pairing-token-secret", url: "https://secret.invalid",
    };
    const forbidden = Object.freeze([
      hostile.credential, hostile.error, hostile.pairingToken, hostile.url,
    ] as const);
    expect(forbidden).toHaveLength(4);
    expect(forbidden.length).toBeGreaterThan(0);
    const stages = ["bootstrap", "request", "claim", "open"] as const;
    expect(stages).toHaveLength(4);
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) {
      const fetch = makeFetch((path, init) => {
        if (stage === "bootstrap" || (stage === "request" && path !== "/bootstrap")
          || (stage === "claim" && path === "/session/pair/claim")
          || (stage === "open" && path === "/session/pair/open")) return json(hostile, 403);
        return healthy(path, init);
      });
      const initial = await resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl });
      const result = stage === "claim" || stage === "open" ? await pending(initial).claim() : initial;
      expect("ok" in result && result.ok).toBe(false);
      if (!("ok" in result) || result.ok) throw new Error("expected local refusal");
      expect(result.code).toBe(stage === "bootstrap"
        ? "LIVE_BOOTSTRAP_UNAVAILABLE" : "LIVE_PAIRING_REFUSED");
      expect(result.detail).toContain("status 403");
      expect(result.detail).toContain("code PAIRING_TOKEN_REJECTED");
      expect(result.detail).toContain("layer DAEMON_PAIRING_GATE");
      for (const secret of forbidden) {
        expect(result.detail).not.toContain(secret);
      }
    }
    const invalid = makeFetch(() => json({ code: "PAIRING_TOKEN_REJECTED https://secret.invalid", layer: "lowercase-secret" }, 503));
    const invalidResult = await resolveLiveSetupFromHandshake({ fetchImpl: invalid.fetchImpl });
    expect(invalidResult).toEqual({ code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "daemon bootstrap unavailable (status 503)", ok: false });
  });
  it("rejects invalid timeout values before performing I/O", async () => {
    const invalid = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2_147_483_648];
    expect(invalid).toHaveLength(6);
    expect(invalid.length).toBeGreaterThan(0);
    for (const requestTimeoutMs of invalid) {
      const fetch = makeFetch(healthy);
      const result = await resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl, requestTimeoutMs });
      expect(result).toEqual({
        code: "LIVE_BOOTSTRAP_UNAVAILABLE", detail: "invalid handshake request timeout", ok: false,
      });
      expect(fetch.calls).toHaveLength(0);
    }
  });
  it("keeps approval-required claims pending and retries the same closure request", async () => {
    let claims = 0;
    const fetch = makeFetch((path, init) => {
      if (path === "/bootstrap") return bootstrap();
      if (path === "/session/pair/request") return requestCreated();
      if (path === "/session/pair/open") return healthy(path, init);
      claims += 1;
      return claims === 1
        ? json({ code: "PAIRING_APPROVAL_REQUIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false }, 409)
        : json(claimBody());
    });
    const pairing = pending(await resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl }));
    expect(await pairing.claim()).toBe(pairing);
    const result = await pairing.claim();
    expect("ok" in result && result.ok).toBe(true);
    expect(claims).toBe(2);
  });
  it("refuses protocol drift and malformed pairing without attaching", async () => {
    const cases = [
      [(path: string): Response => path === "/bootstrap"
        ? json({ csrfToken: "csrf", projectId: "p", protocolVersion: "drift" })
        : requestCreated(), "LIVE_COMPAT_REFUSED"],
      // Carries the exact true header on purpose, so this arm still reaches and
      // measures the BODY fence rather than the new header fence in front of it.
      [(path: string): Response => path === "/bootstrap" ? bootstrap()
        : json({ confirmationLabel: "NOT-A-LABEL", ok: true, requestId: REQUEST_ID },
          200, OPERATOR_PRESENT),
      "LIVE_PAIRING_REFUSED"],
    ] as const;
    expect(cases).toHaveLength(2);
    expect(cases.length).toBeGreaterThan(0);
    for (const [respond, code] of cases) {
      const result = await resolveLiveSetupFromHandshake({ fetchImpl: makeFetch(respond).fetchImpl });
      expect("ok" in result && result.ok).toBe(false);
      if (!("ok" in result) || result.ok) throw new Error("expected refusal");
      expect(result.code).toBe(code);
    }
  });
  it("refuses a successful claim bound to another project", async () => {
    const fetch = makeFetch((path) => path === "/bootstrap" ? bootstrap()
      : path === "/session/pair/request" ? requestCreated()
      : json(claimBody("project-b")));
    const result = await pending(await resolveLiveSetupFromHandshake({
      fetchImpl: fetch.fetchImpl,
    })).claim();
    expect(result).toEqual({
      code: "LIVE_PAIRING_REFUSED", detail: "session pairing project mismatch", ok: false,
    });
  });
  it("refuses malformed authority metadata in a successful claim", async () => {
    const cases = [
      { capabilities: "command.send" },
      { capabilities: [] },
      { capabilities: [""] },
      { capabilities: ["   "] },
      { expiresAt: 42 },
      { expiresAt: "" },
      { expiresAt: "not-an-instant" },
      { expiresAt: "2026-08-25" },
      // The roster admits exactly the wire shape (+ optional challenge), nothing
      // more: a surplus key, a blank principal, and a malformed challenge all refuse.
      { surplus: "smuggled" },
      { principalId: "   " },
      { challenge: "not-an-object" },
      { challenge: { keyEpochRef: "epoch-1", profileRevisionId: "rev-1" } },
      {
        challenge: {
          extra: "x", keyEpochRef: "epoch-1", profileRevisionId: "rev-1",
          recoveryIncarnationRef: "inc-1",
        },
      },
    ] as const;
    expect(cases).toHaveLength(13);
    expect(cases.length).toBeGreaterThan(0);
    for (const replacement of cases) {
      const fetch = makeFetch((path) => path === "/bootstrap" ? bootstrap()
        : path === "/session/pair/request" ? requestCreated()
        : json({ ...claimBody(), ...replacement }));
      const result = await pending(await resolveLiveSetupFromHandshake({
        fetchImpl: fetch.fetchImpl,
      })).claim();
      expect(result).toEqual({
        code: "LIVE_PAIRING_REFUSED",
        detail: "challenge" in replacement
          ? "session pairing challenge refused" : "session pairing claim refused",
        ok: false,
      });
    }
  });

  it("refuses an otherwise valid bearer claim at the distinct required-challenge guard", async () => {
    const { challenge: _discarded, ...bearerClaim } = claimBody();
    const fetch = makeFetch((path) => path === "/bootstrap" ? bootstrap()
      : path === "/session/pair/request" ? requestCreated()
      : json(bearerClaim));
    const result = await pending(await resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl })).claim();
    expect(result).toEqual({ code: "LIVE_PAIRING_REFUSED",
      detail: "session pairing challenge refused", ok: false });
    expect(fetch.calls.map(({ path }) => path))
      .toEqual(["/bootstrap", "/session/pair/request", "/session/pair/claim"]);
  });
});

/**
 * The no-terminal fact is DAEMON-STATED and arrives only on the
 * `x-moe-operator-channel` response header of a successful pairing request. The
 * client admits exactly `true` and exactly `false` and refuses everything else at
 * its own boundary, so an absent or mangled header can never be read as "a
 * terminal is listening".
 */
const SENTINEL_LABEL = "beef-cafe-d00d";
const SENTINEL_REQUEST_ID = "fa".repeat(32);
const duplicatedOperatorChannel = new Headers();
duplicatedOperatorChannel.append(OPERATOR_CHANNEL_HEADER, "true");
duplicatedOperatorChannel.append(OPERATOR_CHANNEL_HEADER, "false");
// Every entry pairs with an HTTP 200 and the exact valid three-key body, so the
// header fence is the ONLY mechanism in the chain that can refuse it.
const HOSTILE_OPERATOR_CHANNEL_HEADERS = Object.freeze([
  Object.freeze({ headers: {} as HeadersInit, name: "the header is missing" }),
  Object.freeze({ headers: duplicatedOperatorChannel as HeadersInit, name: "two appended values" }),
  Object.freeze({ headers: { [OPERATOR_CHANNEL_HEADER]: "false, true" } as HeadersInit,
    name: "an explicit comma-joined value" }),
  Object.freeze({ headers: { [OPERATOR_CHANNEL_HEADER]: "1" } as HeadersInit,
    name: "another truthy token" }),
  Object.freeze({ headers: { [OPERATOR_CHANNEL_HEADER]: "TRUE" } as HeadersInit,
    name: "an uppercase value" }),
] as const);

describe("daemon-stated operator channel availability", () => {
  it("keeps the existing pending closure when the header is exactly true", async () => {
    const fetch = makeFetch(healthy);
    const result = await resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl });
    expect(Object.keys(result).toSorted()).toEqual(["claim", "confirmationLabel", "status"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(pending(result).status).toBe("AWAITING_OPERATOR");
    expect(pending(result).confirmationLabel).toBe("abcd-ef01-2345");
    const attached = await pending(result).claim();
    expect("ok" in attached && attached.ok).toBe(true);
    if (!("ok" in attached) || !attached.ok) throw new Error("expected attached setup");
    expect(attached.sessionCredential).toBe(CREDENTIAL);
    expect(fetch.calls.map(({ path }) => path))
      .toEqual(["/bootstrap", "/session/pair/request", "/session/pair/claim", "/session/pair/open"]);
  });

  it("yields a one-key non-authoritative state when the header is exactly false", async () => {
    const fetch = makeFetch((path) => path === "/bootstrap" ? bootstrap()
      : json({ confirmationLabel: SENTINEL_LABEL, ok: true, requestId: SENTINEL_REQUEST_ID },
        200, { [OPERATOR_CHANNEL_HEADER]: "false" }));
    const result = await resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl });
    expect(result).toEqual({ status: "OPERATOR_CHANNEL_UNAVAILABLE" });
    expect(Object.keys(result)).toEqual(["status"]);
    expect(Object.isFrozen(result)).toBe(true);
    for (const forbidden of ["claim", "confirmationLabel", "requestId"] as const) {
      expect(forbidden in result, forbidden).toBe(false);
    }
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SENTINEL_LABEL);
    expect(serialized).not.toContain(SENTINEL_REQUEST_ID);
    expect(fetch.calls.map(({ path }) => path)).toEqual(["/bootstrap", "/session/pair/request"]);
  });

  it("refuses every hostile operator-channel header at the live client boundary", async () => {
    expect(HOSTILE_OPERATOR_CHANNEL_HEADERS).toHaveLength(5);
    expect(HOSTILE_OPERATOR_CHANNEL_HEADERS.length).toBeGreaterThan(0);
    let graded = 0;
    for (const hostile of HOSTILE_OPERATOR_CHANNEL_HEADERS) {
      const fetch = makeFetch((path) => path === "/bootstrap"
        ? bootstrap() : requestCreated(hostile.headers));
      const result = await resolveLiveSetupFromHandshake({ fetchImpl: fetch.fetchImpl });
      expect(result, hostile.name).toEqual({
        code: "LIVE_PAIRING_REFUSED", detail: "pairing request refused", ok: false,
      });
      expect(fetch.calls.map(({ path }) => path), hostile.name)
        .toEqual(["/bootstrap", "/session/pair/request"]);
      graded += 1;
    }
    expect(graded).toBe(HOSTILE_OPERATOR_CHANNEL_HEADERS.length);
  });
});
