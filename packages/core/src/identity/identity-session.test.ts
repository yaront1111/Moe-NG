import { describe, expect, it } from "vitest";

import {
  canonicalizeCapabilities,
  matchCapability,
} from "./identity-capability.js";
import {
  createCredential,
  createPrincipal,
  createSession,
  isSessionUsableAt,
  rotateCredential,
} from "./identity-session.js";

const PRINCIPAL = { principalId: "p-1", kind: "HUMAN", profileRevisionId: "pr-1" };
const RECOVERY = { recoveryIncarnationRef: "a".repeat(64), keyEpochRef: "b".repeat(64) };
const SESSION = {
  ...RECOVERY,
  sessionId: "s-1", principalId: "p-1", profileRevisionId: "pr-1", clientKeyId: "k-1",
  transportIds: ["local-ipc"], status: "ACTIVE", expiresAt: 1_000, generation: 1,
};
const GRANT = {
  ...RECOVERY,
  capabilityId: "c-1", principalId: "p-1", projectId: "proj-1", commandKind: "goal.create",
  targetAggregateId: "agg-1", transportId: "local-ipc", requiresRecentStepUp: false,
};

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({ ...PRINCIPAL }, {});
  revoke();
  return proxy;
}

function throwingGetter(): object {
  const get = (): never => {
    throw new Error("hostile getter");
  };
  return Object.defineProperty({ ...PRINCIPAL }, "principalId", { get, enumerable: true });
}

describe("principal snapshots", () => {
  it.each(["HUMAN", "SYSTEM", "AGENT"])("accepts a daemon-issued %s principal", (kind) => {
    const result = createPrincipal({ ...PRINCIPAL, kind });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(kind);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    [{ ...PRINCIPAL, kind: "ROOT" }, "unknown kind"],
    [{ ...PRINCIPAL, extra: true }, "extra key"],
    [{ principalId: "p-1", kind: "HUMAN" }, "missing key"],
    [{ ...PRINCIPAL, principalId: "" }, "empty id"],
    [{ ...PRINCIPAL, principalId: 7 }, "non-string id"],
    [null, "null"],
    [[PRINCIPAL], "array"],
  ] as [unknown, string][])("rejects %o (%s)", (input) => {
    expect(createPrincipal(input)).toBeNull();
  });

  it.each([
    ["throwing getter", throwingGetter],
    ["revoked proxy", revokedProxy],
  ])("fails closed on a %s instead of propagating", (_label, build) => {
    expect(() => createPrincipal(build())).not.toThrow();
    expect(createPrincipal(build())).toBeNull();
  });

  it("copies defensively so later source mutation cannot alter the snapshot", () => {
    const source = { ...PRINCIPAL };
    const snapshot = createPrincipal(source);
    source.principalId = "p-hijack";
    expect(snapshot?.principalId).toBe("p-1");
  });
});

describe("session snapshots", () => {
  it("freezes the record and its transport list", () => {
    const session = createSession(SESSION);
    expect(session).not.toBeNull();
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session?.transportIds)).toBe(true);
  });

  it("copies the transport array so source mutation cannot widen it", () => {
    const transportIds = ["local-ipc"];
    const session = createSession({ ...SESSION, transportIds });
    transportIds.push("public-http");
    expect(session?.transportIds).toEqual(["local-ipc"]);
  });

  it("sorts and deduplicates transports deterministically", () => {
    const a = createSession({ ...SESSION, transportIds: ["z-net", "local-ipc", "z-net"] });
    const b = createSession({ ...SESSION, transportIds: ["local-ipc", "z-net"] });
    expect(a?.transportIds).toEqual(["local-ipc", "z-net"]);
    expect(a?.transportIds).toEqual(b?.transportIds);
  });

  it.each([
    [{ ...SESSION, status: "PENDING" }, "unknown status"],
    [{ ...SESSION, transportIds: [] }, "no transport"],
    [{ ...SESSION, transportIds: ["ok", 1] }, "non-string transport"],
    [{ ...SESSION, expiresAt: Number.NaN }, "NaN expiry"],
    [{ ...SESSION, expiresAt: 1.5 }, "fractional expiry"],
    [{ ...SESSION, expiresAt: -1 }, "negative expiry"],
    [{ ...SESSION, generation: 0 }, "generation below one"],
    [{ ...SESSION, extra: true }, "extra key"],
  ] as [unknown, string][])("rejects %o (%s)", (input) => {
    expect(createSession(input)).toBeNull();
  });
});

describe("session usability boundaries", () => {
  const session = createSession(SESSION)!;

  it.each([
    [999, true],
    [1_000, false],
    [1_001, false],
  ])("at now=%i usable=%s (expiry is exclusive)", (now, usable) => {
    expect(isSessionUsableAt(session, now)).toBe(usable);
  });

  it("treats a closed session as unusable well before expiry", () => {
    const closed = createSession({ ...SESSION, status: "CLOSED" })!;
    expect(isSessionUsableAt(closed, 0)).toBe(false);
  });
});

describe("credential rotation", () => {
  const session = createSession(SESSION)!;
  const credential = createCredential({
    ...RECOVERY,
    credentialId: "cr-1",
    sessionId: "s-1",
    generation: 1,
    revoked: false,
  })!;

  it("stores no raw bearer or key material", () => {
    const keys = Object.keys(credential).join(",").toLowerCase();
    expect(keys).not.toContain("bearer");
    expect(keys).not.toContain("secret");
    expect(keys).not.toContain("privatekey");
  });

  it("increments exactly once and revokes only the prior generation", () => {
    const rotated = rotateCredential(session, credential, "cr-2");
    expect(rotated).not.toBeNull();
    expect(rotated?.current.generation).toBe(2);
    expect(rotated?.current.revoked).toBe(false);
    expect(rotated?.previous.revoked).toBe(true);
    expect(rotated?.previous.generation).toBe(1);
    expect(rotated?.session.generation).toBe(2);
  });

  it("preserves principal, profile, and transport scope across rotation", () => {
    const rotated = rotateCredential(session, credential, "cr-2")!;
    expect(rotated.session.principalId).toBe(session.principalId);
    expect(rotated.session.profileRevisionId).toBe(session.profileRevisionId);
    expect(rotated.session.transportIds).toEqual(session.transportIds);
    expect(rotated.session.expiresAt).toBe(session.expiresAt);
  });

  it("refuses to replay a stale generation after rotation", () => {
    const rotated = rotateCredential(session, credential, "cr-2")!;
    // `credential` is now generation 1 against a generation 2 session.
    expect(rotateCredential(rotated.session, credential, "cr-3")).toBeNull();
  });

  it.each([
    [{ revoked: true }, "cr-2", "already revoked"],
    [{ sessionId: "s-other" }, "cr-2", "bound to another session"],
    [{}, "cr-1", "reusing the current credential id"],
  ] as [Record<string, unknown>, string, string][])(
    "refuses rotation when %o with next id %s (%s)",
    (overrides, nextId) => {
      const base = { ...RECOVERY, credentialId: "cr-1", sessionId: "s-1", generation: 1, revoked: false };
      const subject = createCredential({ ...base, ...overrides })!;
      expect(rotateCredential(session, subject, nextId)).toBeNull();
    },
  );
});

describe("capability canonicalization", () => {
  it("sorts deterministically regardless of input order", () => {
    const second = { ...GRANT, capabilityId: "c-2", commandKind: "goal.close" };
    const forward = canonicalizeCapabilities([GRANT, second]);
    const reverse = canonicalizeCapabilities([second, GRANT]);
    expect(forward).not.toBeNull();
    expect(forward?.map((g) => g.capabilityId)).toEqual(["c-1", "c-2"]);
    expect(reverse).toEqual(forward);
  });

  it("collapses an exactly duplicated grant", () => {
    expect(canonicalizeCapabilities([GRANT, { ...GRANT }])).toHaveLength(1);
  });

  it("freezes the list and every grant", () => {
    const grants = canonicalizeCapabilities([GRANT])!;
    expect(Object.isFrozen(grants)).toBe(true);
    expect(Object.isFrozen(grants[0])).toBe(true);
  });

  it.each([
    [{ ...GRANT, projectId: "*" }, "wildcard project"],
    [{ ...GRANT, targetAggregateId: "agg-*" }, "prefix target"],
    [{ ...GRANT, commandKind: "goal.*" }, "wildcard command"],
    [{ ...GRANT, commandKind: "not.a.real.command" }, "unknown command kind"],
    [{ ...GRANT, transportId: "" }, "empty transport"],
    [{ ...GRANT, extra: true }, "extra key"],
  ] as [unknown, string][])("rejects %o (%s)", (grant) => {
    expect(canonicalizeCapabilities([grant])).toBeNull();
  });

  it("rejects two grants sharing a capabilityId with different tuples", () => {
    expect(canonicalizeCapabilities([GRANT, { ...GRANT, projectId: "proj-2" }])).toBeNull();
  });

  it("rejects two capabilityIds granting one tuple that disagree on step-up, in either order", () => {
    const relaxed = { ...GRANT, capabilityId: "c-0", requiresRecentStepUp: false };
    const strict = { ...GRANT, capabilityId: "c-9", requiresRecentStepUp: true };
    expect(canonicalizeCapabilities([relaxed, strict])).toBeNull();
    expect(canonicalizeCapabilities([strict, relaxed])).toBeNull();
  });

  it("rejects two capabilityIds granting one identical tuple", () => {
    expect(canonicalizeCapabilities([GRANT, { ...GRANT, capabilityId: "c-2" }])).toBeNull();
  });
});

describe("capability matching is exact", () => {
  const grants = canonicalizeCapabilities([GRANT])!;
  const query = {
    ...RECOVERY,
    principalId: "p-1",
    projectId: "proj-1",
    commandKind: "goal.create",
    targetAggregateId: "agg-1",
    transportId: "local-ipc",
  } as const;

  it("matches only on full tuple equality", () => {
    expect(matchCapability(grants, query)).not.toBeNull();
  });

  it.each([
    ["principalId", "p-2"],
    ["projectId", "proj-2"],
    ["commandKind", "goal.close"],
    ["targetAggregateId", "agg-2"],
    ["transportId", "public-http"],
    ["recoveryIncarnationRef", "c".repeat(64)],
    ["keyEpochRef", "d".repeat(64)],
  ])("denies when %s differs", (field, value) => {
    expect(matchCapability(grants, { ...query, [field]: value })).toBeNull();
  });

  it("denies a prefix of a granted target rather than matching loosely", () => {
    expect(matchCapability(grants, { ...query, targetAggregateId: "agg" })).toBeNull();
  });

  it("denies against an empty grant list", () => {
    expect(matchCapability(canonicalizeCapabilities([])!, query)).toBeNull();
  });

  it("fails closed when a non-canonical list holds two distinct grants on the tuple", () => {
    const strict = canonicalizeCapabilities([
      { ...GRANT, capabilityId: "c-9", requiresRecentStepUp: true },
    ])!;
    expect(matchCapability([...grants, ...strict], query)).toBeNull();
    expect(matchCapability([...strict, ...grants], query)).toBeNull();
  });

  it("still matches when the same grant is merely listed twice", () => {
    expect(matchCapability([...grants, ...grants], query)).not.toBeNull();
  });
});
