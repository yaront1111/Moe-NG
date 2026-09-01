import { describe, expect, it } from "vitest";

import { authenticateCommand, canonicalizeCapabilities, createCredential, createPrincipal, createSession } from "./index.js";
import type { AuthenticateCommandInput } from "./index.js";

const RECOVERY = { recoveryIncarnationRef: "a".repeat(64), keyEpochRef: "b".repeat(64) };

const ENVELOPE = {
  commandId: "cmd-1",
  commandKind: "goal.create",
  correlationId: "corr-1",
  expectedVersion: 1,
  payload: Object.freeze({}),
  requestDigest: "d".repeat(64),
  schemaVersion: "moe-runtime-command/1",
  sessionCredential: "cr-1",
  targetAggregateId: "agg-1",
};

const principal = createPrincipal({ principalId: "p-1", kind: "HUMAN", profileRevisionId: "pr-1" })!;
const session = createSession({
  ...RECOVERY,
  sessionId: "s-1", principalId: "p-1", profileRevisionId: "pr-1", clientKeyId: "k-1",
  transportIds: ["local-ipc"], status: "ACTIVE", expiresAt: 1_000, generation: 1,
})!;
const credential = createCredential({
  ...RECOVERY,
  credentialId: "cr-1", sessionId: "s-1", generation: 1, revoked: false,
})!;
const capabilities = canonicalizeCapabilities([{
  ...RECOVERY,
  capabilityId: "c-1", principalId: "p-1", projectId: "proj-1", commandKind: "goal.create",
  targetAggregateId: "agg-1", transportId: "local-ipc", requiresRecentStepUp: false,
}])!;

function input(overrides: Partial<AuthenticateCommandInput> = {}): AuthenticateCommandInput {
  return {
    envelope: ENVELOPE,
    principal,
    session,
    credential,
    capabilities,
    projectId: "proj-1",
    transportId: "local-ipc",
    now: 500,
    proof: { credentialId: "cr-1", commandId: "cmd-1", requestDigest: "d".repeat(64), clientKeyId: "k-1" },
    currentRecoveryBinding: RECOVERY,
    verifyProof: () => true,
    checkReplay: () => "FRESH",
    recentStepUpAt: null,
    ...overrides,
  } as AuthenticateCommandInput;
}

function expectDenied(overrides: Partial<AuthenticateCommandInput>, code: string): void {
  const result = authenticateCommand(input(overrides));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected ${code}`);
  expect(result.error.code).toBe(code);
  expect(Object.isFrozen(result.error)).toBe(true);
}

describe("successful authentication", () => {
  const result = authenticateCommand(input());

  it("returns a deeply frozen context of derived identity facts only", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(result.context.principalId).toBe("p-1");
    expect(result.context.sessionId).toBe("s-1");
    expect(result.context.capabilityId).toBe("c-1");
    // Object.isFrozen on a primitive is vacuously true, so prove immutability
    // by behaviour instead.
    expect(() => {
      (result.context as { principalId: string }).principalId = "p-hijack";
    }).toThrow(TypeError);
    expect(result.context.principalId).toBe("p-1");
  });

  it("grants no presence, lease, approval, evidence, or truth authority", () => {
    if (!result.ok) throw new Error("expected success");
    const keys = Object.keys(result.context).join(",").toLowerCase();
    for (const forbidden of ["presence", "lease", "approval", "evidence", "truth", "effect"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("carries no raw bearer or proof material into the context", () => {
    if (!result.ok) throw new Error("expected success");
    const serialized = JSON.stringify(result.context).toLowerCase();
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("clientkeyid");
  });

  it("treats a same-command idempotent retry as fresh, not replay", () => {
    const first = authenticateCommand(input());
    const second = authenticateCommand(input());
    expect(first.ok && second.ok).toBe(true);
  });
});

describe("structural and binding faults are AUTHENTICATION_FAILED", () => {
  it.each([
    [{ principal: null }, "missing principal"],
    [{ session: null }, "missing session"],
    [{ credential: null }, "missing credential"],
    [{ envelope: { ...ENVELOPE, sessionCredential: "cr-other" } }, "bearer/credential swap"],
    [{ credential: createCredential({ ...RECOVERY, credentialId: "cr-1", sessionId: "s-other", generation: 1, revoked: false }) }, "credential bound to another session"],
    [{ principal: createPrincipal({ principalId: "p-2", kind: "HUMAN", profileRevisionId: "pr-1" }) }, "principal/session mismatch"],
    [{ principal: createPrincipal({ principalId: "p-1", kind: "HUMAN", profileRevisionId: "pr-9" }) }, "profile revision mismatch"],
    [{ proof: { credentialId: "cr-1", commandId: "cmd-1", requestDigest: "d".repeat(64), clientKeyId: "k-9" } }, "client key mismatch"],
    [{ proof: null }, "absent proof"],
    [{ proof: { credentialId: "cr-1", commandId: "cmd-other", requestDigest: "d".repeat(64), clientKeyId: "k-1" } }, "proof bound to another command"],
    [{ proof: { credentialId: "cr-1", commandId: "cmd-1", requestDigest: "e".repeat(64), clientKeyId: "k-1" } }, "proof bound to another digest"],
    [{ verifyProof: () => false }, "verifier rejects"],
  ] as [Partial<AuthenticateCommandInput>, string][])("rejects %o (%s)", (overrides) => {
    expectDenied(overrides, "AUTHENTICATION_FAILED");
  });

  it("fails closed when the verifier throws", () => {
    const call = (): unknown => authenticateCommand(input({
      verifyProof: () => {
        throw new Error("hsm offline");
      },
    }));
    expect(call).not.toThrow();
    expectDenied({ verifyProof: () => {
      throw new Error("hsm offline");
    } }, "AUTHENTICATION_FAILED");
  });

  it("never accepts a caller-supplied verified flag as authority", () => {
    expectDenied(
      { verifyProof: () => false, proof: { credentialId: "cr-1", commandId: "cmd-1", requestDigest: "d".repeat(64), clientKeyId: "k-1", verified: true } as never },
      "AUTHENTICATION_FAILED",
    );
  });

  it.each([
    [() => "UNKNOWN" as never, "unknown replay outcome"],
    [() => undefined as never, "undefined replay outcome"],
  ])("fails closed on %s from the replay guard", (checkReplay) => {
    expectDenied({ checkReplay }, "AUTHENTICATION_FAILED");
  });

  it("fails closed when the replay guard throws", () => {
    expectDenied({ checkReplay: () => {
      throw new Error("store down");
    } }, "AUTHENTICATION_FAILED");
  });
});

describe("replay and expiry precedence", () => {
  it.each([
    [{ checkReplay: () => "REPLAYED" as const }, "proven replayed proof"],
    [{ credential: createCredential({ ...RECOVERY, credentialId: "cr-1", sessionId: "s-1", generation: 1, revoked: true }) }, "revoked credential"],
    [{ session: createSession({ ...RECOVERY, sessionId: "s-1", principalId: "p-1", profileRevisionId: "pr-1", clientKeyId: "k-1", transportIds: ["local-ipc"], status: "ACTIVE", expiresAt: 1_000, generation: 2 }) }, "stale credential generation"],
    [{ session: createSession({ ...RECOVERY, sessionId: "s-1", principalId: "p-1", profileRevisionId: "pr-1", clientKeyId: "k-1", transportIds: ["local-ipc"], status: "CLOSED", expiresAt: 1_000, generation: 1 }) }, "closed session"],
  ] as [Partial<AuthenticateCommandInput>, string][])("reports SESSION_REPLAYED for %o (%s)", (overrides) => {
    expectDenied(overrides, "SESSION_REPLAYED");
  });

  it("accepts at one tick before expiry", () => {
    expect(authenticateCommand(input({ now: 999 })).ok).toBe(true);
  });

  it.each([1_000, 1_001])("reports SESSION_EXPIRED at now=%i", (now) => {
    expectDenied({ now }, "SESSION_EXPIRED");
  });

  it("prefers AUTHENTICATION_FAILED over replay and expiry when combined", () => {
    expectDenied({ verifyProof: () => false, checkReplay: () => "REPLAYED", now: 9_999 }, "AUTHENTICATION_FAILED");
  });

  it("prefers SESSION_REPLAYED over SESSION_EXPIRED when combined", () => {
    expectDenied({ checkReplay: () => "REPLAYED", now: 9_999 }, "SESSION_REPLAYED");
  });

  it("prefers SESSION_EXPIRED over CAPABILITY_DENIED when combined", () => {
    expectDenied({ now: 9_999, projectId: "proj-9" }, "SESSION_EXPIRED");
  });
});

describe("scope faults are CAPABILITY_DENIED", () => {
  it.each([
    [{ projectId: "proj-9" }, "wrong project"],
    [{ envelope: { ...ENVELOPE, commandKind: "goal.close" } }, "wrong command kind"],
    [{ envelope: { ...ENVELOPE, targetAggregateId: "agg-9" } }, "wrong target"],
    [{ capabilities: canonicalizeCapabilities([]) }, "no capability at all"],
    [{ transportId: "public-http" }, "transport outside the session"],
  ] as [Partial<AuthenticateCommandInput>, string][])("rejects %o (%s)", (overrides) => {
    expectDenied(overrides, "CAPABILITY_DENIED");
  });

  it("denies a capability granted to another principal", () => {
    const foreign = canonicalizeCapabilities([{
      ...RECOVERY,
      capabilityId: "c-2", principalId: "p-9", projectId: "proj-1", commandKind: "goal.create",
      targetAggregateId: "agg-1", transportId: "local-ipc", requiresRecentStepUp: false,
    }]);
    expectDenied({ capabilities: foreign }, "CAPABILITY_DENIED");
  });

  describe("required step-up", () => {
    const stepUp = canonicalizeCapabilities([{
      ...RECOVERY,
      capabilityId: "c-1", principalId: "p-1", projectId: "proj-1", commandKind: "goal.create",
      targetAggregateId: "agg-1", transportId: "local-ipc", requiresRecentStepUp: true,
    }])!;

    it.each([
      [null, "absent"],
      [0, "at the freshness boundary"],
    ] as [number | null, string][])("denies when step-up is %s", (recentStepUpAt) => {
      expectDenied({ capabilities: stepUp, recentStepUpAt }, "CAPABILITY_DENIED");
    });

    it("allows a recent step-up", () => {
      expect(authenticateCommand(input({ capabilities: stepUp, recentStepUpAt: 499 })).ok).toBe(true);
    });

    it.each([
      ["c-0", "sorts before"],
      ["c-2", "sorts after"],
    ])("cannot be waived by a relaxed grant whose id %s the strict one (%s)", (capabilityId) => {
      const relaxed = {
        ...RECOVERY,
        capabilityId, principalId: "p-1", projectId: "proj-1", commandKind: "goal.create" as const,
        targetAggregateId: "agg-1", transportId: "local-ipc", requiresRecentStepUp: false,
      };
      expectDenied({ capabilities: [...stepUp, relaxed], recentStepUpAt: null }, "AUTHENTICATION_FAILED");
      expectDenied({ capabilities: [relaxed, ...stepUp], recentStepUpAt: null }, "AUTHENTICATION_FAILED");
    });
  });
});

describe("failures carry no business authority", () => {
  it("returns a registry-shaped error with no effect, event, or outbox data", () => {
    const result = authenticateCommand(input({ projectId: "proj-9" }));
    if (result.ok) throw new Error("expected denial");
    expect(Object.keys(result)).toEqual(["ok", "error", "layer"]);
    expect(result.layer).toBe("CAPABILITY");
    const serialized = JSON.stringify(result.error).toLowerCase();
    for (const forbidden of ["outbox", "event", "effect", "authorization", "capabilityid"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("exposes no context on any denial", () => {
    const result = authenticateCommand(input({ now: 9_999 }));
    expect("context" in result).toBe(false);
  });
});
