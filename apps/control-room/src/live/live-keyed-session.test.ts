import {
  SESSION_PROOF_ALGORITHM,
  SESSION_PROOF_PROTOCOL_VERSION,
  canonicalSessionProofBytes,
} from "@moe/contracts";
import { openSessionRequestDigest } from "@moe/control-room-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveKeyedSession,
  type LiveKeyedPost,
  type LiveKeyedPostResult,
} from "./live-keyed-session.js";

const PROJECT = "project-keyed";
const PROTOCOL = "wire-keyed-v1";
const REQUEST_ID = "ab".repeat(32);
const CREDENTIAL = "credential-from-approved-claim";
const CHALLENGE = Object.freeze({
  keyEpochRef: "epoch-keyed",
  profileRevisionId: "profile-keyed",
  recoveryIncarnationRef: "recovery-keyed",
});
const CLAIM_KEYS = Object.freeze([
  "capabilities", "challenge", "expiresAt", "ok", "principalId", "projectId",
  "protocolVersion", "sessionCredential",
]);
const OPEN_KEYS = Object.freeze([
  "clientKeyId", "commandId", "correlationId", "credentialId", "principalId", "proof",
  "publicKeySpkiHex", "requestDigest", "sessionId", "transportId", "transportIds",
]);
const PROOF_KEYS = Object.freeze([
  "algorithm", "issuedAt", "nonce", "protocolVersion", "signatureHex",
]);

interface Posted {
  readonly body: Readonly<Record<string, unknown>>;
  readonly path: string;
}
interface HostileCase {
  readonly detail: string;
  readonly name: string;
  readonly open?: (body: Readonly<Record<string, unknown>>) => LiveKeyedPostResult;
  readonly respond?: () => LiveKeyedPostResult;
}

function accepted(body: unknown): LiveKeyedPostResult {
  return Object.freeze({ body, ok: true, status: 200 });
}

function refused(body: unknown, status = 403): LiveKeyedPostResult {
  return Object.freeze({ body, ok: false, status });
}

function claimBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    capabilities: ["command.send"],
    challenge: CHALLENGE,
    expiresAt: "2026-08-31T12:00:00.000Z",
    ok: true,
    principalId: "principal-keyed",
    projectId: PROJECT,
    protocolVersion: PROTOCOL,
    sessionCredential: CREDENTIAL,
    ...overrides,
  };
}

function exactOpen(body: Readonly<Record<string, unknown>>): LiveKeyedPostResult {
  return accepted({ ok: true, protocolVersion: PROTOCOL, sessionId: body["sessionId"] });
}

function recordingPost(
  respond?: (path: string, body: Readonly<Record<string, unknown>>) => LiveKeyedPostResult,
): { readonly calls: Posted[]; readonly post: LiveKeyedPost } {
  const calls: Posted[] = [];
  return {
    calls,
    post: async (path, body) => {
      calls.push({ body, path });
      if (respond !== undefined) return respond(path, body);
      return path === "/session/pair/claim" ? accepted(claimBody()) : exactOpen(body);
    },
  };
}

function session(post: LiveKeyedPost) {
  return createLiveKeyedSession({ post, projectId: PROJECT, protocolVersion: PROTOCOL,
    requestId: REQUEST_ID });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a record");
  }
  return value as Readonly<Record<string, unknown>>;
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("live keyed session claim and signed open", () => {
  it("posts exact keyed claim and signed open shapes before publishing setup material", async () => {
    const port = recordingPost();
    const result = await session(port.post).claimAndOpen();

    expect(Object.keys(claimBody()).toSorted()).toEqual(CLAIM_KEYS);
    expect(result).toEqual({ ok: true, sessionCredential: CREDENTIAL });
    expect(Object.keys(result).toSorted()).toEqual(["ok", "sessionCredential"]);
    expect(port.calls.map(({ path }) => path)).toEqual([
      "/session/pair/claim", "/session/pair/open",
    ]);
    const claim = port.calls[0]!.body;
    expect(Object.keys(claim).toSorted()).toEqual(["publicKeySpkiHex", "requestId"]);
    expect(claim["requestId"]).toBe(REQUEST_ID);
    expect(claim["publicKeySpkiHex"]).toMatch(/^[0-9a-f]{88}$/u);

    const open = port.calls[1]!.body;
    expect(Object.keys(open).toSorted()).toEqual(OPEN_KEYS);
    expect(open["publicKeySpkiHex"]).toBe(claim["publicKeySpkiHex"]);
    expect(open["clientKeyId"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(open["requestDigest"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(open["sessionId"]).toMatch(/^session-[0-9a-f]{32}$/u);
    expect(open["credentialId"]).toMatch(/^credential-[0-9a-f]{32}$/u);
    expect(open["commandId"]).toMatch(/^command-[0-9a-f]{32}$/u);
    expect(open["correlationId"]).toMatch(/^correlation-[0-9a-f]{32}$/u);
    expect(open["transportIds"]).toEqual([open["transportId"]]);
    const proof = record(open["proof"]);
    expect(Object.keys(proof).toSorted()).toEqual(PROOF_KEYS);
    expect(proof).toMatchObject({
      algorithm: SESSION_PROOF_ALGORITHM,
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/u),
      protocolVersion: SESSION_PROOF_PROTOCOL_VERSION,
      signatureHex: expect.stringMatching(/^[0-9a-f]{128}$/u),
    });

    const digestFields = {
      clientKeyId: open["clientKeyId"], credentialId: open["credentialId"], generation: 1,
      kind: "OPEN_SESSION", principalId: open["principalId"], profileRevisionId: CHALLENGE.profileRevisionId,
      projectId: PROJECT, publicKeySpkiHex: open["publicKeySpkiHex"], sessionId: open["sessionId"],
      transportId: open["transportId"], transportIds: open["transportIds"],
    };
    expect(open["requestDigest"]).toBe(await openSessionRequestDigest(digestFields));

    const signable = canonicalSessionProofBytes({
      clientKeyId: String(open["clientKeyId"]), credentialId: String(open["credentialId"]),
      generation: 1, issuedAt: Number(proof["issuedAt"]), keyEpochRef: CHALLENGE.keyEpochRef,
      nonce: String(proof["nonce"]), principalId: String(open["principalId"]), projectId: PROJECT,
      recoveryIncarnationRef: CHALLENGE.recoveryIncarnationRef,
      requestDigest: String(open["requestDigest"]), requestId: String(open["commandId"]),
      sessionId: String(open["sessionId"]), transportId: String(open["transportId"]),
    });
    const publicKey = await crypto.subtle.importKey("spki", fromHex(String(claim["publicKeySpkiHex"])),
      { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, publicKey,
      fromHex(String(proof["signatureHex"])), Uint8Array.from(signable))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("privateKey");
  });

  it("memoizes one key across an approval retry and exposes an exact retry result", async () => {
    let claims = 0;
    const port = recordingPost((path, body) => {
      if (path === "/session/pair/open") return exactOpen(body);
      claims += 1;
      return claims === 1
        ? refused({ code: "PAIRING_APPROVAL_REQUIRED", layer: "CONTROL_ROOM_PAIRING_APPROVAL",
          ok: false }, 409)
        : accepted(claimBody());
    });
    const keyed = session(port.post);
    const retry = await keyed.claimAndOpen();
    expect(retry).toEqual({ status: "RETRY_CLAIM" });
    expect(Object.keys(retry)).toEqual(["status"]);
    expect(await keyed.claimAndOpen()).toEqual({ ok: true, sessionCredential: CREDENTIAL });
    const claimsSent = port.calls.filter(({ path }) => path === "/session/pair/claim");
    expect(claimsSent).toHaveLength(2);
    expect(claimsSent[1]!.body["publicKeySpkiHex"]).toBe(claimsSent[0]!.body["publicKeySpkiHex"]);
  });

  it("refuses a claim without the keyed challenge at its distinct guard", async () => {
    const sign = vi.spyOn(crypto.subtle, "sign");
    const { challenge: _discarded, ...bearerClaim } = claimBody();
    const port = recordingPost((path, body) => path === "/session/pair/claim"
      ? accepted(bearerClaim) : exactOpen(body));
    const result = await session(port.post).claimAndOpen();
    expect(result).toEqual({ code: "LIVE_PAIRING_REFUSED",
      detail: "session pairing challenge refused", ok: false });
    expect(port.calls.map(({ path }) => path)).toEqual(["/session/pair/claim"]);
    expect(sign).not.toHaveBeenCalled();
  });

  it("grades a nonempty hostile sweep by exact refusal stage and stops later effects", async () => {
    const valid = claimBody();
    const hostiles: readonly HostileCase[] = [
      { detail: "session pairing claim refused", name: "claim throw", respond: () => { throw new Error("x"); } },
      { detail: "session pairing claim refused", name: "claim http refusal",
        respond: () => refused({ code: "PAIRING_DENIED", layer: "CONTROL_ROOM_PAIRING_APPROVAL", ok: false }) },
      { detail: "session pairing claim refused", name: "claim unreadable", respond: () => accepted(null) },
      { detail: "session pairing challenge refused", name: "challenge extra",
        respond: () => accepted({ ...valid, challenge: { ...CHALLENGE, extra: "x" } }) },
      { detail: "session pairing claim refused", name: "claim missing key",
        respond: () => accepted(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "principalId"))) },
      { detail: "session pairing open refused", name: "open http refusal",
        open: () => refused({ code: "AUTHENTICATION_FAILED", layer: "PROOF", ok: false }) },
      { detail: "session pairing open refused", name: "open timeout",
        open: () => { throw new Error("timed out"); } },
      { detail: "session pairing open refused", name: "open caller abort",
        open: () => { throw new Error("aborted"); } },
      { detail: "session pairing open refused", name: "open unreadable", open: () => accepted(null) },
      { detail: "session pairing open refused", name: "open missing key",
        open: (body: Readonly<Record<string, unknown>>) => accepted({ ok: true, sessionId: body["sessionId"] }) },
      { detail: "session pairing open refused", name: "open extra key",
        open: (body: Readonly<Record<string, unknown>>) => accepted({ extra: true, ok: true,
          protocolVersion: PROTOCOL, sessionId: body["sessionId"] }) },
      { detail: "session pairing open refused", name: "wrong session",
        open: () => accepted({ ok: true, protocolVersion: PROTOCOL, sessionId: "session-wrong" }) },
      { detail: "session pairing open refused", name: "wrong protocol",
        open: (body: Readonly<Record<string, unknown>>) => accepted({ ok: true,
          protocolVersion: "wire-wrong", sessionId: body["sessionId"] }) },
    ];
    expect(hostiles).toHaveLength(13);
    expect(hostiles.length).toBeGreaterThan(0);
    let graded = 0;
    for (const hostile of hostiles) {
      const calls: Posted[] = [];
      const post: LiveKeyedPost = async (path, body) => {
        calls.push({ body, path });
        if (path === "/session/pair/open") return hostile.open?.(body) ?? exactOpen(body);
        return hostile.respond?.() ?? accepted(valid);
      };
      const result = await session(post).claimAndOpen();
      expect(result, hostile.name).toEqual({ code: "LIVE_PAIRING_REFUSED",
        detail: hostile.detail, ok: false });
      if (hostile.detail !== "session pairing open refused") {
        expect(calls.map(({ path }) => path), hostile.name).toEqual(["/session/pair/claim"]);
      }
      graded += 1;
    }
    expect(graded).toBe(hostiles.length);
  });

  it("maps key generation and signing exceptions to distinct local refusal details", async () => {
    const originalGenerate = crypto.subtle.generateKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "generateKey").mockRejectedValueOnce(new Error("unsupported"));
    expect(await session(recordingPost().post).claimAndOpen()).toEqual({
      code: "LIVE_PAIRING_REFUSED", detail: "session key generation refused", ok: false,
    });
    vi.mocked(crypto.subtle.generateKey).mockImplementation(originalGenerate);
    const port = recordingPost();
    vi.spyOn(crypto.subtle, "sign").mockRejectedValueOnce(new Error("sign refused"));
    expect(await session(port.post).claimAndOpen()).toEqual({
      code: "LIVE_PAIRING_REFUSED", detail: "session pairing proof refused", ok: false,
    });
    expect(port.calls.map(({ path }) => path)).toEqual(["/session/pair/claim"]);
  });
});
