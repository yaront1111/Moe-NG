import { describe, expect, it } from "vitest";

import {
  authenticateCommand,
  authenticateSession,
  canonicalizeCapabilities,
  createCredential,
  createPrincipal,
  createSession,
  rotateCredential,
} from "./index.js";
import type {
  AuthenticateCommandInput,
  ProofChallenge,
  SessionAuthenticationInput,
} from "./index.js";

const CURRENT = Object.freeze({
  recoveryIncarnationRef: "a".repeat(64),
  keyEpochRef: "b".repeat(64),
});
const EARLIER = Object.freeze([
  Object.freeze({ recoveryIncarnationRef: "c".repeat(64), keyEpochRef: "d".repeat(64) }),
  Object.freeze({ recoveryIncarnationRef: "e".repeat(64), keyEpochRef: "f".repeat(64) }),
]);
const principal = createPrincipal({
  principalId: "p-1",
  kind: "HUMAN",
  profileRevisionId: "pr-1",
})!;
const SESSION_FACTS = Object.freeze({
  sessionId: "s-1", principalId: "p-1", profileRevisionId: "pr-1", clientKeyId: "k-1",
  transportIds: ["local-ipc"], status: "ACTIVE", expiresAt: 1_000, generation: 1,
});

function session(binding = CURRENT, overrides: Record<string, unknown> = {}) {
  return createSession({
    ...binding,
    ...SESSION_FACTS,
    ...overrides,
  });
}

function credential(binding = CURRENT, overrides: Record<string, unknown> = {}) {
  return createCredential({
    ...binding,
    credentialId: "cr-1",
    sessionId: "s-1",
    generation: 1,
    revoked: false,
    ...overrides,
  });
}

function sessionInput(binding = CURRENT): SessionAuthenticationInput {
  return {
    principal,
    session: session(binding),
    credential: credential(binding),
    projectId: "proj-1",
    transportId: "local-ipc",
    now: 500,
    requestId: "cmd-1",
    requestDigest: "1".repeat(64),
    presentedCredentialId: "cr-1",
    proof: {
      credentialId: "cr-1",
      commandId: "cmd-1",
      requestDigest: "1".repeat(64),
      clientKeyId: "k-1",
    },
    currentRecoveryBinding: CURRENT,
    capabilityRecoveryCandidates: [],
    verifyProof: () => true,
    checkReplay: () => "FRESH",
  } as unknown as SessionAuthenticationInput;
}

const envelope = Object.freeze({
  commandId: "cmd-1",
  commandKind: "goal.create",
  correlationId: "corr-1",
  expectedVersion: 1,
  payload: Object.freeze({}),
  requestDigest: "1".repeat(64),
  schemaVersion: "moe-runtime-command/1",
  sessionCredential: "cr-1",
  targetAggregateId: "agg-1",
});

function grant(binding = CURRENT) {
  return {
    ...binding,
    capabilityId: "cap-1",
    principalId: "p-1",
    projectId: "proj-1",
    commandKind: "goal.create",
    targetAggregateId: "agg-1",
    transportId: "local-ipc",
    requiresRecentStepUp: false,
  };
}

function commandInput(capabilityBinding = CURRENT): AuthenticateCommandInput {
  return {
    envelope,
    principal,
    session: session(),
    credential: credential(),
    capabilities: canonicalizeCapabilities([grant(capabilityBinding)]),
    projectId: "proj-1",
    transportId: "local-ipc",
    now: 500,
    proof: {
      credentialId: "cr-1",
      commandId: "cmd-1",
      requestDigest: "1".repeat(64),
      clientKeyId: "k-1",
    },
    currentRecoveryBinding: CURRENT,
    verifyProof: () => true,
    checkReplay: () => "FRESH",
    recentStepUpAt: null,
  } as unknown as AuthenticateCommandInput;
}

describe("recovery-bound identity records", () => {
  it("accepts, freezes, and rotates exact current public refs", () => {
    const issuedSession = session();
    const issuedCredential = credential();
    const grants = canonicalizeCapabilities([grant()]);
    expect(issuedSession).toMatchObject(CURRENT);
    expect(issuedCredential).toMatchObject(CURRENT);
    expect(grants?.[0]).toMatchObject(CURRENT);
    expect(Object.isFrozen(issuedSession)).toBe(true);
    expect(Object.isFrozen(issuedCredential)).toBe(true);
    expect(Object.isFrozen(grants?.[0])).toBe(true);
    const rotated = rotateCredential(issuedSession!, issuedCredential!, "cr-2");
    expect(rotated?.session).toMatchObject(CURRENT);
    expect(rotated?.current).toMatchObject(CURRENT);
    expect(rotated?.previous).toMatchObject(CURRENT);
  });

  it.each([
    ["missing", { keyEpochRef: undefined }],
    ["uppercase", { keyEpochRef: "B".repeat(64) }],
    ["short", { recoveryIncarnationRef: "a".repeat(63) }],
    ["extra", { extra: true }],
  ])("rejects %s session binding", (_, overrides) => {
    expect(session(CURRENT, overrides)).toBeNull();
  });

  it("contains an accessor recovery ref", () => {
    const missing = { ...CURRENT, ...SESSION_FACTS };
    delete (missing as { keyEpochRef?: string }).keyEpochRef;
    expect(createSession(missing)).toBeNull();

    const value = { ...CURRENT, ...SESSION_FACTS };
    Object.defineProperty(value, "keyEpochRef", {
      enumerable: true,
      get: () => { throw new Error("hostile ref"); },
    });
    expect(() => createSession(value)).not.toThrow();
    expect(createSession(value)).toBeNull();

    const returning = { ...CURRENT, ...SESSION_FACTS };
    Object.defineProperty(returning, "keyEpochRef", {
      enumerable: true,
      get: () => CURRENT.keyEpochRef,
    });
    expect(createSession(returning)).toBeNull();
  });

  it("includes both refs in grant conflict identity", () => {
    expect(canonicalizeCapabilities([grant(), grant(EARLIER[0])])).toBeNull();
  });

  it("rejects a capability array with a caller-defined iterator", () => {
    const grants = [grant(EARLIER[0])];
    Object.defineProperty(grants, Symbol.iterator, {
      value: function* smuggledGrant() { yield grant(); },
    });
    expect(canonicalizeCapabilities(grants)).toBeNull();
  });

  it("rejects accessor grant fields and transport array behavior", () => {
    const accessorGrant = grant();
    Object.defineProperty(accessorGrant, "keyEpochRef", {
      enumerable: true,
      get: () => CURRENT.keyEpochRef,
    });
    expect(canonicalizeCapabilities([accessorGrant])).toBeNull();

    const transportIds = ["local-ipc"];
    Object.defineProperty(transportIds, Symbol.iterator, {
      value: function* smuggledTransport() { yield "remote-http"; },
    });
    expect(session(CURRENT, { transportIds })).toBeNull();
  });
});

describe("the recovery fence precedes expiry and capability", () => {
  it("puts both refs in the proof challenge and successful facts", () => {
    let observed: ProofChallenge | null = null;
    const result = authenticateSession({
      ...sessionInput(),
      verifyProof: (challenge) => { observed = challenge; return true; },
    });
    expect(result.ok).toBe(true);
    expect(observed).toMatchObject(CURRENT);
    if (!result.ok) throw new Error("expected current authentication");
    expect(result.facts).toMatchObject(CURRENT);
    expect(Object.isFrozen(result.facts)).toBe(true);
  });

  it.each(EARLIER)("refuses earlier install %# at RECOVERY_BINDING", (binding) => {
    const result = authenticateSession({
      ...sessionInput(binding),
      now: 2_000,
      transportId: "wrong-transport",
    });
    expect(result).toEqual({
      ok: false,
      code: "SESSION_REPLAYED",
      layer: "RECOVERY_BINDING",
    });
  });

  it("generates exactly two nonzero earlier-install cases", () => {
    expect(EARLIER.length).toBe(2);
  });

  it("keeps cross-record ref disagreement structural", () => {
    const result = authenticateSession({
      ...sessionInput(),
      credential: credential(EARLIER[0]),
    });
    expect(result).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      layer: "BINDING",
    });
  });

  it("contains hostile recovery-candidate iteration at BINDING", () => {
    const candidates = [CURRENT];
    Object.defineProperty(candidates, Symbol.iterator, {
      value: function* hostileIterator() { yield EARLIER[0]; },
    });
    const result = authenticateSession({
      ...sessionInput(),
      capabilityRecoveryCandidates: candidates,
    } as SessionAuthenticationInput);
    expect(result).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      layer: "BINDING",
    });
  });

  it("rejects a candidate array carrying a non-index property", () => {
    const candidates = [CURRENT] as Array<typeof CURRENT> & { extra?: string };
    candidates.extra = "smuggled";
    expect(authenticateSession({
      ...sessionInput(),
      capabilityRecoveryCandidates: candidates,
    })).toEqual({
      ok: false,
      code: "AUTHENTICATION_FAILED",
      layer: "BINDING",
    });
  });

  it("classifies an otherwise matching stale grant as replay", () => {
    const result = authenticateCommand(commandInput(EARLIER[0]));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected stale grant denial");
    expect(result.error.code).toBe("SESSION_REPLAYED");
  });

  it("publishes current refs but no secret material in authorization context", () => {
    const result = authenticateCommand(commandInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected current command authorization");
    expect(result.context).toMatchObject(CURRENT);
    expect(JSON.stringify(result.context)).not.toMatch(/bearer|proof|signature|nonce|private|handle/iu);
  });
});
