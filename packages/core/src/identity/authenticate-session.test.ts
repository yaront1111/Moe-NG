import { describe, expect, it } from "vitest";

import {
  authenticateSession,
  createCredential,
  createPrincipal,
  createSession,
  SESSION_AUTH_LAYERS,
} from "./index.js";
import type {
  ProofChallenge,
  SessionAuthCode,
  SessionAuthenticationInput,
  SessionAuthLayer,
} from "./index.js";
import {
  authenticateSession as rootAuthenticateSession,
  SESSION_AUTH_LAYERS as ROOT_SESSION_AUTH_LAYERS,
} from "../index.js";

const principal = createPrincipal({
  principalId: "p-1",
  kind: "HUMAN",
  profileRevisionId: "pr-1",
})!;
const session = createSession({
  sessionId: "s-1",
  principalId: "p-1",
  profileRevisionId: "pr-1",
  clientKeyId: "k-1",
  transportIds: ["local-ipc"],
  status: "ACTIVE",
  expiresAt: 1_000,
  generation: 1,
})!;
const credential = createCredential({
  credentialId: "cr-1",
  sessionId: "s-1",
  generation: 1,
  revoked: false,
})!;
const proof = Object.freeze({
  credentialId: "cr-1",
  commandId: "request-1",
  requestDigest: "d".repeat(64),
  clientKeyId: "k-1",
});

function input(
  overrides: Partial<SessionAuthenticationInput> = {},
): SessionAuthenticationInput {
  return {
    principal,
    session,
    credential,
    projectId: "proj-1",
    transportId: "local-ipc",
    now: 500,
    requestId: "request-1",
    requestDigest: "d".repeat(64),
    presentedCredentialId: "cr-1",
    proof,
    verifyProof: () => true,
    checkReplay: () => "FRESH",
    ...overrides,
  };
}

interface RefusalCase {
  readonly name: string;
  readonly overrides: Partial<SessionAuthenticationInput>;
  readonly code: SessionAuthCode;
  readonly layer: SessionAuthLayer;
}

const unknownReplay = (() => "UNKNOWN") as unknown as
  SessionAuthenticationInput["checkReplay"];

const REFUSAL_CASES = Object.freeze([
  { name: "missing session", overrides: { session: null }, code: "AUTHENTICATION_FAILED", layer: "BINDING" },
  { name: "proof rejected", overrides: { verifyProof: () => false }, code: "AUTHENTICATION_FAILED", layer: "PROOF" },
  { name: "proof verifier throws", overrides: { verifyProof: () => { throw new Error("proof"); } }, code: "AUTHENTICATION_FAILED", layer: "PROOF" },
  { name: "replay outcome unknown", overrides: { checkReplay: unknownReplay }, code: "AUTHENTICATION_FAILED", layer: "REPLAY" },
  { name: "replay guard throws", overrides: { checkReplay: () => { throw new Error("replay"); } }, code: "AUTHENTICATION_FAILED", layer: "REPLAY" },
  { name: "proof replayed", overrides: { checkReplay: () => "REPLAYED" }, code: "SESSION_REPLAYED", layer: "REPLAY" },
  { name: "credential generation stale", overrides: { credential: createCredential({ credentialId: "cr-1", sessionId: "s-1", generation: 2, revoked: false }) }, code: "SESSION_REPLAYED", layer: "GENERATION" },
  { name: "session closed", overrides: { session: createSession({ sessionId: "s-1", principalId: "p-1", profileRevisionId: "pr-1", clientKeyId: "k-1", transportIds: ["local-ipc"], status: "CLOSED", expiresAt: 1_000, generation: 1 }) }, code: "SESSION_REPLAYED", layer: "SESSION_STATE" },
  { name: "session expired", overrides: { now: 1_000 }, code: "SESSION_EXPIRED", layer: "EXPIRY" },
  { name: "transport unlisted", overrides: { transportId: "remote-http" }, code: "CAPABILITY_DENIED", layer: "TRANSPORT" },
] satisfies readonly RefusalCase[]);

describe("session authentication refusals", () => {
  it("pins the generated case count and every declared layer", () => {
    expect(Object.isFrozen(REFUSAL_CASES)).toBe(true);
    expect(REFUSAL_CASES).toHaveLength(10);
    expect([...new Set(REFUSAL_CASES.map(({ layer }) => layer))]).toEqual([
      ...SESSION_AUTH_LAYERS,
    ]);
  });

  for (const refusal of REFUSAL_CASES) {
    it(`refuses ${refusal.name} at ${refusal.layer}`, () => {
      const result = authenticateSession(input(refusal.overrides));

      expect(result).toEqual({ ok: false, code: refusal.code, layer: refusal.layer });
      expect(Object.keys(result)).toEqual(["ok", "code", "layer"]);
      expect(Object.isFrozen(result)).toBe(true);
    });
  }

  it("rejects a truthy non-boolean verifier result at PROOF", () => {
    const truthyVerifier = (() => 1) as unknown as
      SessionAuthenticationInput["verifyProof"];
    const result = authenticateSession(input({ verifyProof: truthyVerifier }));

    expect(result).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      layer: "PROOF",
    });
    expect(Object.keys(result)).toEqual(["ok", "code", "layer"]);
  });
});

describe("successful session authentication", () => {
  it("returns deeply frozen facts derived from committed records", () => {
    const result = authenticateSession(input());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected ${result.code}`);
    expect(result.facts).toEqual({
      principalId: "p-1",
      principalKind: "HUMAN",
      profileRevisionId: "pr-1",
      sessionId: "s-1",
      clientKeyId: "k-1",
      projectId: "proj-1",
      transportId: "local-ipc",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.facts)).toBe(true);
  });

  it("accepts at one tick before exclusive expiry", () => {
    expect(authenticateSession(input({ now: 999 })).ok).toBe(true);
  });

  it("ignores a caller-supplied positive proof boolean", () => {
    let observed: ProofChallenge | null = null;
    const suppliedProof = Object.freeze({ ...proof, verified: true });
    const result = authenticateSession(input({
      proof: suppliedProof,
      verifyProof: (challenge) => {
        observed = challenge;
        return false;
      },
    }));

    expect(result).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      layer: "PROOF",
    });
    expect(observed).toEqual({
      commandId: "request-1",
      requestDigest: "d".repeat(64),
      credentialId: "cr-1",
      clientKeyId: "k-1",
    });
    expect(observed).not.toHaveProperty("verified");
    expect(Object.isFrozen(observed)).toBe(true);
  });
});

describe("identity publication", () => {
  it("publishes the frozen seam from the core root", () => {
    expect(typeof rootAuthenticateSession).toBe("function");
    expect(rootAuthenticateSession).toBe(authenticateSession);
    expect(ROOT_SESSION_AUTH_LAYERS).toBe(SESSION_AUTH_LAYERS);
    expect(Object.isFrozen(SESSION_AUTH_LAYERS)).toBe(true);
  });
});
