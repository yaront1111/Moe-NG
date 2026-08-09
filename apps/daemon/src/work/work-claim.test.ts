import { describe, expect, it } from "vitest";

import { claimWork } from "./work-claim.js";
import { CLAIM_LEGS } from "./work-kernel.js";
import type { WorkRefused, WorkResult } from "./work-kernel.js";

/**
 * Every fixture below is HAND-WRITTEN against the upstream contracts and is
 * never derived from the exports under test — a fixture built by calling the
 * production surface would agree with it by construction and hide every
 * assertion (mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion).
 */
const DIGEST = "a".repeat(64);

const LEASE_RECORD = {
  authorityHashRef: DIGEST,
  bootId: "boot-1",
  epoch: 3,
  kind: "ASSIGNMENT",
  leaseId: "lease-1",
  leaseToken: "token-1",
  monotonicObservation: 500,
  ownerSessionRef: "session-1",
  serverWallDeadline: 1_000,
  state: "ACTIVE",
  version: 7,
} as const;

const PROOF = {
  authorityHashRef: DIGEST,
  epoch: 3,
  expectedVersion: 7,
  leaseToken: "token-1",
  ownerSessionRef: "session-1",
} as const;

const RESOURCE_ROW = {
  capacityUnits: 1,
  effectIntentRef: "intent-ref-1",
  epoch: 1,
  external: false,
  fenceable: true,
  resourceId: "res-1",
  state: "ACTIVE",
} as const;

const BUDGET_VIEW = {
  accountId: "acct-1",
  meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
  state: "OPEN",
  version: 2,
} as const;

const ADMISSION = {
  admissionRef: "adm-1",
  amounts: [
    { meter: "usd", purpose: "EXECUTION", quantity: 10 },
    { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
    { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
    { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
    { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
  ],
  expectedVersion: 2,
} as const;

const GATE = { allowance: { decisionRef: "dec-1", outcome: "ALLOW" }, approval: null } as const;

const EFFECT_INTENT = {
  aggregateId: "agg-1",
  desiredState: "ACTIVE",
  expectedGraphEpoch: 4,
  idempotencyKey: "idem-1",
  inputBinding: DIGEST,
  intentId: "intent-1",
  leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1",
  protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST,
  state: "PENDING",
  version: 0,
} as const;

function validPayload(): Record<string, unknown> {
  return {
    budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
    effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
    lease: { proof: PROOF, record: LEASE_RECORD },
    liveClaims: [],
    slot: { requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
  };
}

function refusalOf(result: WorkResult): WorkRefused {
  if (result.ok !== false) throw new Error("expected a refusal, received an ok result");
  if (!("failure" in result)) throw new Error("expected a WorkRefused carrying a failure");
  return result;
}

/** Deep clone through JSON so an injection never mutates a shared fixture. */
function withPayload(mutate: (payload: Record<string, unknown>) => void): Record<string, unknown> {
  const payload = JSON.parse(JSON.stringify(validPayload())) as Record<string, unknown>;
  mutate(payload);
  return payload;
}

interface Injection {
  readonly leg: string;
  readonly label: string;
  readonly code: string;
  /**
   * The upstream code this refusal must be derived from. Pinning it is what
   * stops an injection passing for the wrong reason: a fixture broken in some
   * unrelated way also refuses, with the same work-level code, while testing
   * nothing about the leg it claims to cover.
   */
  readonly upstream: string;
  readonly mutate: (payload: Record<string, unknown>) => void;
}

/** Walks a fixture path, failing loudly rather than casting through undefined. */
function at(root: Record<string, unknown>, ...path: readonly string[]): Record<string, unknown> {
  let node: unknown = root;
  for (const key of path) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new Error(`fixture path ${path.join(".")} is not a record`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new Error(`fixture path ${path.join(".")} is not a record`);
  }
  return node as Record<string, unknown>;
}

function listAt(
  root: Record<string, unknown>,
  path: readonly string[],
  key: string,
): Record<string, unknown>[] {
  const value = at(root, ...path)[key];
  if (!Array.isArray(value)) throw new Error(`fixture ${key} is not a list`);
  return value as Record<string, unknown>[];
}

function firstOf(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined) throw new Error("fixture list is empty");
  return row;
}

const INJECTIONS: readonly Injection[] = [
  {
    code: "WORK_STALE_TOKEN",
    upstream: "AUTHORITY_STALE_LEASE",
    label: "lease leg — stale token",
    leg: "lease",
    mutate: (p) => {
      at(p, "lease", "proof")["leaseToken"] = "token-stale";
    },
  },
  {
    code: "WORK_STALE_EPOCH",
    upstream: "AUTHORITY_STALE_EPOCH",
    label: "lease leg — stale epoch",
    leg: "lease",
    mutate: (p) => {
      at(p, "lease", "proof")["epoch"] = 2;
    },
  },
  {
    code: "WORK_AUTHORITY_SUPERSEDED",
    upstream: "AUTHORITY_SUPERSEDED_AUTHORITY",
    label: "lease leg — superseded by a revocation epoch",
    leg: "lease",
    mutate: (p) => {
      at(p, "lease", "proof")["epoch"] = 2;
      at(p, "lease", "record")["state"] = "REVOKED";
    },
  },
  {
    code: "WORK_PAYLOAD_MALFORMED",
    upstream: "AUTHORITY_MALFORMED_INPUT",
    label: "lease leg — unparseable record",
    leg: "lease",
    mutate: (p) => {
      at(p, "lease")["record"] = { nonsense: true };
    },
  },
  {
    code: "WORK_SLOT_RESOURCE_INACTIVE",
    // The scheduler reuses AUTHORITY_STALE_LEASE for an inactive resource; the
    // daemon-level code is what distinguishes this leg from the lease leg.
    upstream: "AUTHORITY_STALE_LEASE",
    label: "provider-slot leg — a declared resource is not ACTIVE",
    leg: "providerSlot",
    mutate: (p) => {
      firstOf(listAt(p, ["slot"], "rows"))["state"] = "PENDING_ACQUIRE";
    },
  },
  {
    code: "WORK_BUDGET_REFUSED",
    upstream: "BUDGET_RESERVATION_INSUFFICIENT_AVAILABLE",
    label: "budget leg — insufficient available",
    leg: "budgetReservation",
    mutate: (p) => {
      firstOf(listAt(p, ["budget", "view"], "meters"))["available"] = 1;
    },
  },
  {
    code: "WORK_BUDGET_REFUSED",
    upstream: "BUDGET_RESERVATION_PROTECTED_PURPOSE_MISSING",
    label: "budget leg — a protected purpose is missing",
    leg: "budgetReservation",
    mutate: (p) => {
      const amounts = listAt(p, ["budget", "admission"], "amounts");
      at(p, "budget", "admission")["amounts"] = amounts.filter(
        (amount) => amount["purpose"] !== "CONTINGENCY",
      );
    },
  },
  {
    code: "WORK_BUDGET_REFUSED",
    upstream: "BUDGET_RESERVATION_STALE_VERSION",
    label: "budget leg — stale expectedVersion",
    leg: "budgetReservation",
    mutate: (p) => {
      at(p, "budget", "admission")["expectedVersion"] = 1;
    },
  },
  {
    code: "WORK_INTENT_REFUSED",
    upstream: "EFFECT_TRANSITION_NOT_ADMITTED",
    label: "effect-intent leg — state does not admit claim",
    leg: "effectIntent",
    mutate: (p) => {
      at(p, "effect", "intent")["state"] = "ARMED";
    },
  },
  {
    code: "WORK_INTENT_REFUSED",
    upstream: "EFFECT_TERMINAL_ABSORBED",
    label: "effect-intent leg — terminal state absorbs the command",
    leg: "effectIntent",
    mutate: (p) => {
      at(p, "effect", "intent")["state"] = "SUCCEEDED";
    },
  },
];

describe("work.claim — the happy path publishes all four successors", () => {
  it("grants a claim carrying every leg's successor record", () => {
    const result = claimWork(validPayload());
    expect(result.ok).toBe(true);
    if (!result.ok || result.outcome !== "WORK_GRANTED") {
      throw new Error(`expected WORK_GRANTED, received ${JSON.stringify(result)}`);
    }
    expect(result.authority).toBe("CLAIM_GRANTED");
    expect(result.command).toBe("claim");
    for (const leg of CLAIM_LEGS) {
      expect(result.successors[leg]).toBeDefined();
      expect(result.successors[leg]).not.toBeNull();
    }
    expect(Object.keys(result.successors).sort()).toStrictEqual([...CLAIM_LEGS].sort());
  });

  it("reserves the provider slot rather than activating it (design 427)", () => {
    const result = claimWork(validPayload());
    if (!result.ok || result.outcome !== "WORK_GRANTED") throw new Error("expected a grant");
    expect(result.successors.providerSlot).toMatchObject({ state: "RESERVED" });
  });

  it("freezes the granted result and its nested successors", () => {
    const result = claimWork(validPayload());
    if (!result.ok || result.outcome !== "WORK_GRANTED") throw new Error("expected a grant");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.successors)).toBe(true);
    expect(Object.isFrozen(result.successors.providerSlot)).toBe(true);
  });

  it("does not mutate the caller's input", () => {
    const payload = validPayload();
    const before = JSON.stringify(payload);
    claimWork(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });
});

describe("work.claim — per-leg failure injection", () => {
  it("covers every declared claim leg, so a dropped leg fails the suite", () => {
    expect(CLAIM_LEGS.length).toBe(4);
    expect(INJECTIONS.length).toBe(10);
    const covered = new Set(INJECTIONS.map((injection) => injection.leg));
    expect([...covered].sort()).toStrictEqual([...CLAIM_LEGS].sort());
  });

  it.each(INJECTIONS.map((injection) => [injection.label, injection] as const))(
    "refuses at the %s",
    (_label, injection) => {
      const refusal = refusalOf(claimWork(withPayload(injection.mutate)));
      expect(refusal.outcome).toBe("WORK_REFUSED");
      expect(refusal.failure.code).toBe(injection.code);
      expect(refusal.failure.leg).toBe(injection.leg);
      expect(refusal.failure.layer).toBe("AUTHORITY");
      expect(refusal.failure.upstreamCode).toBe(injection.upstream);
    },
  );

  it.each(INJECTIONS.map((injection) => [injection.label, injection] as const))(
    "leaves the other three legs structurally unobservable at the %s",
    (_label, injection) => {
      const refusal = refusalOf(claimWork(withPayload(injection.mutate)));
      // Structural, not null-valued: a partially built result must be
      // unrepresentable, so assert the KEY is absent entirely.
      const keys = Object.keys(refusal);
      expect(keys).not.toContain("successors");
      expect(keys).not.toContain("successor");
      for (const leg of CLAIM_LEGS) expect(keys).not.toContain(leg);
      expect(refusal.authority).toBe("NONE");
    },
  );

  it("names exactly one failing leg per refusal", () => {
    for (const injection of INJECTIONS) {
      const refusal = refusalOf(claimWork(withPayload(injection.mutate)));
      expect(typeof refusal.failure.leg).toBe("string");
      expect(refusal.failure.message.length).toBeGreaterThan(0);
    }
  });

  it("preserves the upstream refusal code verbatim alongside its own", () => {
    const refusal = refusalOf(
      claimWork(
        withPayload((p) => {
          firstOf(listAt(p, ["budget", "view"], "meters"))["available"] = 1;
        }),
      ),
    );
    expect(refusal.failure.code).toBe("WORK_BUDGET_REFUSED");
    expect(refusal.failure.upstreamCode).toBe("BUDGET_RESERVATION_INSUFFICIENT_AVAILABLE");
  });

  it("does not mutate the caller's input on a refusal either", () => {
    const payload = withPayload((p) => {
      at(p, "lease", "proof")["leaseToken"] = "token-stale";
    });
    const before = JSON.stringify(payload);
    claimWork(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });
});

describe("work.claim — malformed payload refuses before any leg", () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["an array", []],
    ["a string", "claim"],
    ["an empty object", {}],
    ["a payload missing the slot section", { budget: {}, effect: {}, lease: {} }],
  ];

  it("covers every declared malformed case", () => {
    expect(malformed.length).toBe(5);
  });

  it.each(malformed)("refuses %s with WORK_PAYLOAD_MALFORMED", (_label, payload) => {
    const refusal = refusalOf(claimWork(payload));
    expect(refusal.failure.code).toBe("WORK_PAYLOAD_MALFORMED");
    expect(refusal.failure.layer).toBe("AUTHORITY");
    expect(Object.keys(refusal)).not.toContain("successors");
  });
});

/**
 * DoD 4. The scheduler does NO counting — reserveProviderSlot validates one
 * slot's resources and returns RESERVED, and no ceiling constant exists
 * anywhere in packages/scheduler. Design line 427's "at most four RESERVED|
 * ACTIVE provider slots project-wide" is therefore this daemon's job, counted
 * over the caller-supplied live claim table.
 */
describe("work.claim — the design-427 provider slot ceiling", () => {
  const live = (count: number, state = "RESERVED"): Record<string, unknown>[] =>
    Array.from({ length: count }, (_unused, index) => ({
      dimension: "default",
      slotRef: `slot-live-${index}`,
      state,
    }));

  function claimWithLive(claims: readonly Record<string, unknown>[]): WorkResult {
    return claimWork(withPayload((p) => {
      p["liveClaims"] = claims;
    }));
  }

  it("admits a claim while fewer than four slots are held", () => {
    for (const held of [0, 1, 2, 3]) {
      const result = claimWithLive(live(held));
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("WORK_GRANTED");
    }
  });

  it("refuses the fifth concurrent claim with the slot-exhausted code", () => {
    const refusal = refusalOf(claimWithLive(live(4)));
    expect(refusal.failure.code).toBe("WORK_SLOT_EXHAUSTED");
    expect(refusal.failure.leg).toBe("slotCeiling");
    expect(refusal.failure.layer).toBe("AUTHORITY");
  });

  it("puts the boundary at exactly four — not three, not five", () => {
    expect(claimWithLive(live(3)).ok).toBe(true);
    expect(claimWithLive(live(4)).ok).toBe(false);
    expect(claimWithLive(live(5)).ok).toBe(false);
  });

  it("counts ACTIVE slots against the ceiling, not only RESERVED", () => {
    const mixed = [...live(2, "RESERVED"), ...live(2, "ACTIVE")];
    expect(mixed.length).toBe(4);
    const refusal = refusalOf(claimWithLive(mixed));
    expect(refusal.failure.code).toBe("WORK_SLOT_EXHAUSTED");
  });

  it("frees capacity once a slot is RELEASED", () => {
    const released = [...live(3, "RESERVED"), ...live(1, "RELEASED")];
    expect(released.length).toBe(4);
    const result = claimWithLive(released);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("WORK_GRANTED");
  });

  it("counts only the default dimension", () => {
    const other = live(4).map((claim) => ({ ...claim, dimension: "gpu" }));
    const result = claimWithLive(other);
    expect(result.ok).toBe(true);
  });

  it("refuses outright and offers NO queue, retry, or defer affordance", () => {
    const refusal = refusalOf(claimWithLive(live(4)));
    const keys = Object.keys(refusal);
    for (const forbidden of ["pending", "deferred", "queued", "retryAfter", "retry", "position"]) {
      expect(keys).not.toContain(forbidden);
    }
    // Nothing anywhere in the serialized result may hint at queueing.
    const serialized = JSON.stringify(refusal).toLowerCase();
    for (const hint of ["queue", "retry", "defer", "pending", "backoff", "wait"]) {
      expect(serialized).not.toContain(hint);
    }
    expect(Object.keys(refusal)).not.toContain("successors");
  });

  it("refuses at the ceiling even when the slot leg would accept", () => {
    // Resources are ACTIVE here, so reserveProviderSlot WOULD accept. The
    // ceiling must still refuse and name its own leg. The next case separately
    // pins ordering by making both guards capable of refusing.
    const refusal = refusalOf(claimWithLive(live(4)));
    expect(refusal.failure.leg).toBe("slotCeiling");
    expect(refusal.failure.leg).not.toBe("providerSlot");
    expect(refusal.failure.upstreamCode).toBeNull();
  });

  it("checks the ceiling before the slot leg when both would refuse", () => {
    const refusal = refusalOf(claimWork(withPayload((payload) => {
      payload["liveClaims"] = live(4);
      firstOf(listAt(payload, ["slot"], "rows"))["state"] = "PENDING_ACQUIRE";
    })));

    expect(refusal.failure.code).toBe("WORK_SLOT_EXHAUSTED");
    expect(refusal.failure.leg).toBe("slotCeiling");
    expect(refusal.failure.layer).toBe("AUTHORITY");
    expect(refusal.failure.upstreamCode).toBeNull();
  });

  /**
   * Each entry breaks the table a DIFFERENT way. A mutation drill proved this
   * matters: with only the missing-keys case, changing the non-record guard
   * from `return null` to `continue` left the suite green, because a record
   * missing keys never reaches that branch. A malformed table must fail closed
   * on every shape, since counting it as empty is a free pass through the
   * ceiling.
   */
  const malformedTables: ReadonlyArray<readonly [string, unknown]> = [
    ["an entry missing state and slotRef", [{ dimension: "default" }]],
    ["a null entry", [null]],
    ["a string entry", ["slot-1"]],
    ["a numeric entry", [7]],
    ["a nested array entry", [[]]],
    ["an entry whose state is not a string", [{ dimension: "default", slotRef: "s", state: 1 }]],
    ["an entry whose slotRef is not a string", [{ dimension: "default", slotRef: 2, state: "RESERVED" }]],
    ["one good entry followed by a bad one", [{ dimension: "default", slotRef: "s", state: "RESERVED" }, null]],
  ];

  it("covers every declared malformed-table shape", () => {
    expect(malformedTables.length).toBe(8);
  });

  it.each(malformedTables)(
    "refuses %s rather than counting the table as empty",
    (_label, table) => {
      const refusal = refusalOf(claimWithLive(table as never));
      expect(refusal.failure.code).toBe("WORK_PAYLOAD_MALFORMED");
      expect(refusal.failure.leg).toBe("slotCeiling");
      expect(Object.keys(refusal)).not.toContain("successors");
    },
  );
});
