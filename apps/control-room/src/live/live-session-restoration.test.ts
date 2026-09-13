import { RUNTIME_COMMAND_ENVELOPE_VERSION, RUNTIME_ERROR_REGISTRY_VERSION, RUNTIME_QUERY_ENVELOPE_VERSION } from "@moe/contracts";
import type { FetchLike } from "@moe/control-room-client";
import { describe, expect, it, vi } from "vitest";
import { resolveLiveSetupFromHandshake } from "./live-handshake.js";
import type { LiveHandshakeResult } from "./live-handshake.js";
import type { LiveTabSessionRecord } from "./live-tab-session.js";

const WIRE = `${RUNTIME_COMMAND_ENVELOPE_VERSION}+${RUNTIME_QUERY_ENVELOPE_VERSION}+${RUNTIME_ERROR_REGISTRY_VERSION}`;
const CREDENTIAL = "restoration-fixture-credential";
const PROJECT = "project-restoration";
const SAVED: LiveTabSessionRecord = { credential: CREDENTIAL, binding: {
  sessionId: "session-fixture", credentialId: "credential-fixture", clientKeyId: "ab".repeat(32), generation: 1,
} };
function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return { headers: new Headers(headers), json: async () => body,
    ok: status >= 200 && status < 300, status } as Response;
}
function sessionStore(initial?: LiveTabSessionRecord) {
  let saved = initial;
  return { read: vi.fn((_projectId: string) => saved),
    write: vi.fn((_projectId: string, value: LiveTabSessionRecord) => { saved = value; }),
    clear: vi.fn(() => { saved = undefined; }) };
}
function pending(result: LiveHandshakeResult) {
  if (!("status" in result) || result.status !== "AWAITING_OPERATOR") throw new Error("expected pairing");
  return result;
}
function requestBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}
function fixture(validation: () => Response | Promise<Response> = () => json({ ok: true, projectId: PROJECT })) {
  const fetchImpl = vi.fn<FetchLike>(async (path, init) => {
    if (path === "/bootstrap") return json({ commandAuthorityPlane: "V2", csrfToken: "fresh-csrf",
      projectId: PROJECT, protocolVersion: WIRE });
    if (path === "/session/validate") return validation();
    if (path === "/session/pair/request") return json({
      confirmationLabel: "abcd-ef01-2345", ok: true, requestId: "ab".repeat(32),
    }, 200, { "x-moe-operator-channel": "true" });
    if (path === "/session/pair/claim") return json({
      capabilities: ["command.send"], expiresAt: "2026-09-13T23:00:00.000Z", ok: true,
      principalId: "principal-restoration", projectId: PROJECT, protocolVersion: WIRE, sessionCredential: CREDENTIAL,
      challenge: { keyEpochRef: "epoch-restoration", profileRevisionId: "profile-restoration", recoveryIncarnationRef: "recovery-restoration" },
    });
    if (path === "/session/pair/open") return json({ ok: true, protocolVersion: WIRE,
      sessionId: requestBody(init)["sessionId"] });
    throw new Error("unexpected downstream request");
  });
  return fetchImpl;
}

describe("project session restoration", () => {
  it("validates the saved signed-session binding after a fresh bootstrap before returning setup", async () => {
    const session = sessionStore(SAVED), fetchImpl = fixture();
    const result = await resolveLiveSetupFromHandshake({ fetchImpl, session });
    expect(result).toMatchObject({ ok: true, projectId: PROJECT, commandAuthorityPlane: "V2" });
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(["/bootstrap", "/session/validate"]);
    expect(session.read).toHaveBeenCalledExactlyOnceWith(PROJECT);
    const validation = fetchImpl.mock.calls[1]?.[1];
    expect(JSON.parse(String(validation?.body))).toEqual(SAVED.binding);
    expect(new Headers(validation?.headers).get("x-moe-session-credential")).toBe(CREDENTIAL);
    expect(new Headers(validation?.headers).get("x-moe-csrf")).toBe("fresh-csrf");
    expect(new Headers(validation?.headers).get("x-moe-protocol-version")).toBe(WIRE);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("x-moe-session-credential")).toBeNull();
    expect(session.write).not.toHaveBeenCalled();
  });

  it("saves only after signed open succeeds and restores without another claim or open", async () => {
    const session = sessionStore(), fetchImpl = fixture();
    const pairing = pending(await resolveLiveSetupFromHandshake({ fetchImpl, session }));
    expect(session.write).not.toHaveBeenCalled();
    expect(await pairing.claim()).toMatchObject({ ok: true });
    const open = requestBody(fetchImpl.mock.calls.find(([path]) => path === "/session/pair/open")![1]);
    expect(session.write).toHaveBeenCalledExactlyOnceWith(PROJECT, { credential: CREDENTIAL,
      binding: { sessionId: open["sessionId"], credentialId: open["credentialId"], clientKeyId: open["clientKeyId"], generation: 1 } });
    expect(await resolveLiveSetupFromHandshake({ fetchImpl, session })).toMatchObject({ ok: true });
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      "/bootstrap", "/session/pair/request", "/session/pair/claim", "/session/pair/open", "/bootstrap", "/session/validate",
    ]);
  });

  it("clears a server-rejected session before requesting fresh operator approval", async () => {
    const session = sessionStore(SAVED), fetchImpl = fixture(() => json({
      ok: false, code: "PAIRING_SESSION_INVALID", layer: "CONTROL_ROOM_PAIRING_SESSION",
    }, 401));
    expect(await resolveLiveSetupFromHandshake({ fetchImpl, session })).toMatchObject({ status: "AWAITING_OPERATOR" });
    expect(session.clear).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(["/bootstrap", "/session/validate", "/session/pair/request"]);
    expect(new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get("x-moe-session-credential")).toBeNull();
    expect(session.write).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", { ok: false, code: "PAIRING_SESSION_UNAVAILABLE", layer: "CONTROL_ROOM_PAIRING_SESSION" }, 503],
    ["wrong project", { ok: true, projectId: "foreign-project" }, 200],
    ["extra fields", { ok: true, projectId: PROJECT, extra: "untrusted" }, 200],
    ["wrong success status", { ok: true, projectId: PROJECT }, 201],
    ["malformed", { ok: true }, 200],
    ["forbidden", { code: "AUTHORIZATION_FAILED" }, 403],
  ])("preserves the candidate and refuses setup on %s validation", async (_label, body, status) => {
    const session = sessionStore(SAVED), fetchImpl = fixture(() => json(body, status as number));
    expect(await resolveLiveSetupFromHandshake({ fetchImpl, session })).toMatchObject({ ok: false, code: "LIVE_PAIRING_REFUSED" });
    expect(session.clear).not.toHaveBeenCalled();
    expect(session.write).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(["/bootstrap", "/session/validate"]);
  });

  it("preserves the candidate when validation is cancelled and ignores a late success", async () => {
    let finish!: (response: Response) => void;
    const delayed = new Promise<Response>(resolve => { finish = resolve; });
    const session = sessionStore(SAVED), fetchImpl = fixture(() => delayed), caller = new AbortController();
    const result = resolveLiveSetupFromHandshake({ fetchImpl, session, signal: caller.signal });
    await vi.waitFor(() => { expect(fetchImpl).toHaveBeenCalledTimes(2); });
    caller.abort();
    expect(await result).toMatchObject({ ok: false, code: "LIVE_PAIRING_REFUSED" });
    finish(json({ ok: true, projectId: PROJECT }));
    await Promise.resolve();
    expect(session.clear).not.toHaveBeenCalled();
    expect(session.write).not.toHaveBeenCalled();
  });

  it("does not save a bearer when its signed open fails", async () => {
    const session = sessionStore(), healthy = fixture();
    const fetchImpl: FetchLike = async (path, init) => path === "/session/pair/open"
      ? json({ code: "SESSION_PROOF_INVALID", layer: "SESSION_AUTHORITY" }, 403) : healthy(path, init);
    expect(await pending(await resolveLiveSetupFromHandshake({ fetchImpl, session })).claim()).toMatchObject({ ok: false });
    expect(session.write).not.toHaveBeenCalled();
  });
});
