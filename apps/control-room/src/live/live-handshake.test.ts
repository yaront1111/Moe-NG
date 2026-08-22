import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_ERROR_REGISTRY_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
} from "@moe/contracts";
import type { FetchLike } from "@moe/control-room-client";
import { describe, expect, it } from "vitest";

import { resolveLiveSetupFromHandshake } from "./live-handshake.js";

// The real runtime wire string, composed exactly as the generated client composes
// it (command + query + error registry). A bootstrap that serves this admits; any
// other string is a drift the compat gate must refuse.
const WIRE =
  `${RUNTIME_COMMAND_ENVELOPE_VERSION}+${RUNTIME_QUERY_ENVELOPE_VERSION}+${RUNTIME_ERROR_REGISTRY_VERSION}`;

const CSRF = "csrf-token-1";
const CREDENTIAL = "session-credential-secret-1";
const TOKEN = "pairing-token-FRAG";

interface RecordedCall {
  readonly init: RequestInit;
  readonly input: string;
}

type Responder = () => Response;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

function makeFetch(responders: Readonly<Record<string, Responder>>): {
  readonly calls: RecordedCall[];
  readonly fetchImpl: FetchLike;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ init, input });
    const responder = responders[input];
    if (responder === undefined) {
      return Promise.reject(new Error(`unexpected fetch to ${input}`));
    }
    return Promise.resolve(responder());
  };
  return { calls, fetchImpl };
}

function goodBootstrap(protocolVersion = WIRE): Responder {
  return () =>
    jsonResponse({ csrfToken: CSRF, projectId: "proj-1", protocolVersion });
}

function goodPair(): Responder {
  return () =>
    jsonResponse({
      capabilities: ["command.send"],
      expiresAt: "2026-08-22T13:00:00.000Z",
      projectId: "proj-1",
      protocolVersion: WIRE,
      sessionCredential: CREDENTIAL,
    });
}

describe("resolveLiveSetupFromHandshake", () => {
  it("(a) pairs on a healthy bootstrap and returns a usable in-memory setup", async () => {
    const { calls, fetchImpl } = makeFetch({
      "/bootstrap": goodBootstrap(),
      "/session/pair": goodPair(),
    });

    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: `https://localhost:9876/#pair=${TOKEN}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.headers).toEqual({
      "content-type": "application/json",
      "x-moe-csrf": CSRF,
      "x-moe-protocol-version": WIRE,
      "x-moe-session-credential": CREDENTIAL,
    });
    expect(result.sessionCredential).toBe(CREDENTIAL);
    expect(typeof result.transport.sendCommand).toBe("function");

    // The pair request carried the CSRF + protocol pins as headers, and its body
    // was EXACTLY { pairingToken } - no extra key the daemon would refuse.
    const pairCall = calls.find((call) => call.input === "/session/pair");
    expect(pairCall).toBeDefined();
    if (pairCall === undefined) return;
    const headers = pairCall.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-moe-csrf"]).toBe(CSRF);
    expect(headers["x-moe-protocol-version"]).toBe(WIRE);
    const body = JSON.parse(pairCall.init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["pairingToken"]);
    expect(body["pairingToken"]).toBe(TOKEN);

    // The token and the credential appear NOWHERE in any request URL argument.
    for (const call of calls) {
      expect(call.input).not.toContain(TOKEN);
      expect(call.input).not.toContain(CREDENTIAL);
    }
  });

  it("(b) refuses when bootstrap is non-200 and never attempts pairing", async () => {
    const { calls, fetchImpl } = makeFetch({
      "/bootstrap": () => jsonResponse({ error: "boom" }, 503),
    });

    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: `https://localhost:9876/#pair=${TOKEN}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_BOOTSTRAP_UNAVAILABLE");
    expect(calls.some((call) => call.input === "/session/pair")).toBe(false);
  });

  it("(c) refuses a drifted protocol version before pairing", async () => {
    const { calls, fetchImpl } = makeFetch({
      "/bootstrap": goodBootstrap(`${WIRE}x`),
    });

    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: `https://localhost:9876/#pair=${TOKEN}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_COMPAT_REFUSED");
    expect(calls.some((call) => call.input === "/session/pair")).toBe(false);
  });

  it("(d) refuses with a missing-config code when no pairing token is present", async () => {
    const { calls, fetchImpl } = makeFetch({
      "/bootstrap": goodBootstrap(),
    });

    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: "https://localhost:9876/",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_CONFIG_MISSING");
    expect(calls.some((call) => call.input === "/session/pair")).toBe(false);
  });

  it("(e) refuses when the daemon rejects the pairing token", async () => {
    const { fetchImpl } = makeFetch({
      "/bootstrap": goodBootstrap(),
      "/session/pair": () => jsonResponse({ error: "token reused" }, 403),
    });

    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: `https://localhost:9876/#pair=${TOKEN}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_PAIRING_REFUSED");
  });

  it("(g) refuses a 200 pair whose body carries no sessionCredential, never half-attaching", async () => {
    const { fetchImpl } = makeFetch({
      "/bootstrap": goodBootstrap(),
      // A 200 with a well-formed but credential-less body: the fail-open trap. The
      // resolver must refuse, not return an ok setup with an undefined credential.
      "/session/pair": () =>
        jsonResponse({ capabilities: [], expiresAt: "2026-08-22T13:00:00.000Z", projectId: "proj-1" }),
    });

    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: `https://localhost:9876/#pair=${TOKEN}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_PAIRING_REFUSED");
  });

  it("(h) refuses a 200 bootstrap whose body is missing fields, and never pairs", async () => {
    const { calls, fetchImpl } = makeFetch({
      // 200 but no csrfToken / protocolVersion: an unreadable handshake, not an attach.
      "/bootstrap": () => jsonResponse({ projectId: "proj-1" }),
    });

    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: `https://localhost:9876/#pair=${TOKEN}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_BOOTSTRAP_UNAVAILABLE");
    expect(calls.some((call) => call.input === "/session/pair")).toBe(false);
  });

  it("(f) reads the token from the fragment, never the query string", async () => {
    const { calls, fetchImpl } = makeFetch({
      "/bootstrap": goodBootstrap(),
      "/session/pair": goodPair(),
    });

    // Both places carry a token; only the fragment one may be used.
    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: "https://localhost:9876/?pair=QUERY#pair=FRAGMENT",
    });

    expect(result.ok).toBe(true);
    const pairCall = calls.find((call) => call.input === "/session/pair");
    expect(pairCall).toBeDefined();
    if (pairCall === undefined) return;
    const body = JSON.parse(pairCall.init.body as string) as Record<string, unknown>;
    expect(body["pairingToken"]).toBe("FRAGMENT");
  });

  it("(f') refuses when the token lives only in the query and the fragment is empty", async () => {
    const { calls, fetchImpl } = makeFetch({
      "/bootstrap": goodBootstrap(),
    });

    const result = await resolveLiveSetupFromHandshake({
      fetchImpl,
      locationHref: "https://localhost:9876/?pair=QUERY",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("LIVE_CONFIG_MISSING");
    expect(calls.some((call) => call.input === "/session/pair")).toBe(false);
  });
});
