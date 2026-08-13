import { describe, expect, it } from "vitest";

import { claimWork } from "./work-claim.js";
import { CLAIM_LEGS } from "./work-kernel.js";
import type { WorkGranted, WorkRefused, WorkResult } from "./work-kernel.js";

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
    slot: {
      dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1",
    },
  };
}

/**
 * The five successor records a grant publishes. Hand-written, NOT read off
 * `ClaimSuccessors`: a list derived from the type under test agrees with it by
 * construction and would keep passing after a field was silently dropped.
 */
const SUCCESSOR_KEYS = [
  "budgetReservation",
  "budgetView",
  "effectIntent",
  "lease",
  "providerSlot",
] as const;

const EXPECTED_LEASE = { ...LEASE_RECORD };

const EXPECTED_SLOT = {
  attemptRef: null,
  dimension: "default",
  requestId: "req-1",
  slotRef: "slot-1",
  state: "RESERVED",
};

const EXPECTED_RESERVATION = {
  accountId: "acct-1",
  admissionRef: "adm-1",
  attemptRef: null,
  lines: [...ADMISSION.amounts],
  neverStartedProofRef: null,
  // `reservation:${accountId.length}:${accountId}:${admissionRef}` transcribed
  // from deriveReservationId rather than called, so a change to the derivation
  // reddens here instead of agreeing with itself.
  reservationId: "reservation:6:acct-1:adm-1",
  state: "RESERVED",
  version: 0,
};

/**
 * The SHIFTED view `reserveForAdmission` actually returned: version 2 -> 3 and
 * 30 usd moved available -> reserved (10 + 5 + 5 + 5 + 5). Pinning the moved
 * units is what proves the retained view is the post-reservation one rather
 * than the caller's input view echoed back or a locally recomputed guess.
 */
const EXPECTED_VIEW = {
  accountId: "acct-1",
  meters: [{ available: 70, committed: 0, meter: "usd", quarantined: 0, reserved: 30 }],
  state: "OPEN",
  version: 3,
};

const EXPECTED_INTENT = { ...EFFECT_INTENT, state: "CLAIMED", version: 1 };

function refusalOf(result: WorkResult): WorkRefused {
  if (result.ok !== false) throw new Error("expected a refusal, received an ok result");
  if (!("failure" in result)) throw new Error("expected a WorkRefused carrying a failure");
  return result;
}

function grantOf(result: WorkResult): WorkGranted {
  if (!result.ok || result.outcome !== "WORK_GRANTED") {
    throw new Error(`expected WORK_GRANTED, received ${JSON.stringify(result)}`);
  }
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
    code: "WORK_PAYLOAD_MALFORMED",
    // The dimension the ceiling counts by must be carried on the payload; the
    // scheduler refuses an absent one rather than assuming the default.
    upstream: "AUTHORITY_MALFORMED_INPUT",
    label: "provider-slot leg — the slot section carries no dimension",
    leg: "providerSlot",
    mutate: (p) => {
      delete at(p, "slot")["dimension"];
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
    expect(Object.keys(result.successors).sort()).toStrictEqual([...SUCCESSOR_KEYS]);
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
    expect(INJECTIONS.length).toBe(11);
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

describe("work.claim — the granted successor closure", () => {
  it("publishes exactly the five successor records and no sixth", () => {
    expect(SUCCESSOR_KEYS.length).toBe(5);
    const grant = grantOf(claimWork(validPayload()));
    expect(Object.keys(grant.successors).sort()).toStrictEqual([...SUCCESSOR_KEYS]);
  });

  it("carries the fenced ACTIVE lease record", () => {
    const grant = grantOf(claimWork(validPayload()));
    expect(grant.successors.lease).toStrictEqual(EXPECTED_LEASE);
    expect(grant.successors.lease.state).toBe("ACTIVE");
  });

  it("carries a RESERVED provider slot bound to the payload's own dimension", () => {
    const grant = grantOf(claimWork(validPayload()));
    expect(grant.successors.providerSlot).toStrictEqual(EXPECTED_SLOT);
    expect(grant.successors.providerSlot.attemptRef).toBeNull();
  });

  it("passes a non-default slot dimension through to the reservation", () => {
    // A defaulted dimension would still read RESERVED here, so the ceiling and
    // the reservation would silently disagree about which pool was consumed.
    const grant = grantOf(claimWork(withPayload((p) => {
      at(p, "slot")["dimension"] = "gpu";
    })));
    expect(grant.successors.providerSlot).toStrictEqual({ ...EXPECTED_SLOT, dimension: "gpu" });
  });

  it("carries the RESERVED budget reservation", () => {
    const grant = grantOf(claimWork(validPayload()));
    expect(grant.successors.budgetReservation).toStrictEqual(EXPECTED_RESERVATION);
  });

  it("retains the post-reservation budget view, not the caller's input view", () => {
    const grant = grantOf(claimWork(validPayload()));
    expect(grant.successors.budgetView).toStrictEqual(EXPECTED_VIEW);
    expect(grant.successors.budgetView.version).toBe(BUDGET_VIEW.version + 1);
    const bucket = grant.successors.budgetView.meters[0];
    expect(bucket?.available).toBe(70);
    expect(bucket?.reserved).toBe(30);
    expect(grant.successors.budgetView).not.toStrictEqual(BUDGET_VIEW);
  });

  it("carries the CLAIMED effect intent one version on", () => {
    const grant = grantOf(claimWork(validPayload()));
    expect(grant.successors.effectIntent).toStrictEqual(EXPECTED_INTENT);
    expect(grant.successors.effectIntent.state).toBe("CLAIMED");
    expect(grant.successors.effectIntent.version).toBe(EFFECT_INTENT.version + 1);
  });

  it("freezes every published record and its nested collections", () => {
    const grant = grantOf(claimWork(validPayload()));
    expect(Object.isFrozen(grant.successors)).toBe(true);
    for (const key of SUCCESSOR_KEYS) expect(Object.isFrozen(grant.successors[key])).toBe(true);
    expect(Object.isFrozen(grant.successors.budgetView.meters)).toBe(true);
    expect(Object.isFrozen(grant.successors.budgetView.meters[0])).toBe(true);
    expect(Object.isFrozen(grant.successors.budgetReservation.lines)).toBe(true);
    expect(Object.isFrozen(grant.successors.budgetReservation.lines[0])).toBe(true);
  });

  it("publishes copies, never the caller's own section objects", () => {
    const payload = validPayload();
    const grant = grantOf(claimWork(payload));
    expect(grant.successors.lease).not.toBe(at(payload, "lease")["record"]);
    expect(grant.successors.budgetView).not.toBe(at(payload, "budget")["view"]);
    expect(grant.successors.budgetReservation).not.toBe(at(payload, "budget")["admission"]);
    expect(grant.successors.effectIntent).not.toBe(at(payload, "effect")["intent"]);
    expect(grant.successors.providerSlot).not.toBe(at(payload, "slot"));
  });
});

/**
 * Hostile-shape parsing. Every case is generated, so the count is asserted
 * against a HAND-WRITTEN number: a generator that quietly produced nothing
 * would otherwise pass as full coverage.
 */
interface Probe { hits: number }

interface PoisonSpec {
  readonly label: string;
  readonly apply: (value: Record<string, unknown>, probe: Probe) => unknown;
  /** `true` when the case is only real if the hostile trap actually fired. */
  readonly trapsFire: boolean;
}

function firstKeyOf(value: Record<string, unknown>): string {
  const key = Reflect.ownKeys(value)[0];
  if (typeof key !== "string") throw new Error("fixture record has no leading string key");
  return key;
}

const POISONS: readonly PoisonSpec[] = [
  {
    apply: (value) => ({ ...value, borrowedKey: 1 }),
    label: "an extra own string key",
    trapsFire: false,
  },
  {
    apply: (value) => ({ ...value, [Symbol("hostile")]: 1 }),
    label: "an own symbol key",
    trapsFire: false,
  },
  {
    // The getter must never run: the parser reads descriptors, not properties.
    apply: (value, probe) => {
      const key = firstKeyOf(value);
      const clone: Record<string, unknown> = { ...value };
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          probe.hits += 1;
          return value[key];
        },
      });
      return clone;
    },
    label: "an accessor where a data property belongs",
    trapsFire: false,
  },
  {
    apply: (value) => Object.create({ inherited: true }, Object.getOwnPropertyDescriptors(value)),
    label: "a borrowed prototype",
    trapsFire: false,
  },
  {
    apply: (value, probe) => new Proxy(value, {
      getOwnPropertyDescriptor: (target, key) => key === "smuggledKey"
        ? { configurable: true, enumerable: true, value: 1, writable: true }
        : Reflect.getOwnPropertyDescriptor(target, key),
      ownKeys: (target) => {
        probe.hits += 1;
        return [...Reflect.ownKeys(target), "smuggledKey"];
      },
    }),
    label: "a proxy whose ownKeys trap smuggles a key in",
    trapsFire: true,
  },
  {
    apply: (value, probe) => new Proxy(value, {
      getOwnPropertyDescriptor: (target, key) => {
        probe.hits += 1;
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        return own === undefined
          ? own
          : { configurable: true, enumerable: true, get: () => own.value };
      },
    }),
    label: "a proxy whose descriptor trap yields an accessor",
    trapsFire: true,
  },
  {
    // The target must be the REAL record: a descriptor trap over a foreign or
    // empty target is refused by the key check first and never fires, so the
    // case silently degrades into an ordinary malformed record. Caught here by
    // the trap counter, which is the whole reason it is asserted.
    apply: (value, probe) => new Proxy(value, {
      getOwnPropertyDescriptor: () => {
        probe.hits += 1;
        throw new Error("hostile descriptor trap");
      },
    }),
    label: "a proxy whose descriptor trap throws",
    trapsFire: true,
  },
  {
    apply: (value, probe) => new Proxy(value, {
      getPrototypeOf: () => {
        probe.hits += 1;
        return { inherited: true };
      },
    }),
    label: "a proxy whose getPrototypeOf trap lies",
    trapsFire: true,
  },
];

interface HostileTarget {
  readonly label: string;
  readonly leg: string;
  readonly path: readonly string[];
}

/** Each target names the leg that OWNS it, so a fault cannot drift legs. */
const HOSTILE_TARGETS: readonly HostileTarget[] = [
  { label: "the outer payload", leg: "lease", path: [] },
  { label: "the lease section", leg: "lease", path: ["lease"] },
  { label: "the slot section", leg: "providerSlot", path: ["slot"] },
  { label: "the budget section", leg: "budgetReservation", path: ["budget"] },
  { label: "the effect section", leg: "effectIntent", path: ["effect"] },
  { label: "the effect command", leg: "effectIntent", path: ["effect", "command"] },
];

interface HostileCase {
  readonly label: string;
  readonly leg: string;
  readonly trapsFire: boolean;
  readonly build: (probe: Probe) => unknown;
}

const HOSTILE_CASES: readonly HostileCase[] = HOSTILE_TARGETS.flatMap((target) =>
  POISONS.map((poison): HostileCase => ({
    build: (probe) => {
      const payload = validPayload();
      if (target.path.length === 0) return poison.apply(payload, probe);
      const leaf = target.path[target.path.length - 1];
      if (leaf === undefined) throw new Error("hostile target path is empty");
      const parent = at(payload, ...target.path.slice(0, -1));
      parent[leaf] = poison.apply(at(payload, ...target.path), probe);
      return payload;
    },
    label: `${target.label} carrying ${poison.label}`,
    leg: target.leg,
    trapsFire: poison.trapsFire,
  })),
);

const LIVE_CLAIM_CASES: ReadonlyArray<readonly [string, (probe: Probe) => unknown, boolean]> = [
  ["a live claim table that is not an array", () => ({ dimension: "default" }), false],
  ["a sparse live claim table with a hole", () => {
    const rows: unknown[] = [{ dimension: "default", slotRef: "s", state: "RELEASED" }];
    rows.length = 3;
    return rows;
  }, false],
  ["a live claim table carrying an extra own key", () => {
    const rows: unknown[] = [];
    (rows as unknown as Record<string, unknown>)["smuggledKey"] = 1;
    return rows;
  }, false],
  ["a live claim table whose element is an accessor", (probe) => {
    const rows: unknown[] = [];
    Object.defineProperty(rows, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        probe.hits += 1;
        return null;
      },
    });
    return rows;
  }, false],
  ["a live claim table with a borrowed prototype", () => Object.setPrototypeOf([], {
    inherited: true,
  }), false],
  ["a proxy live claim table whose descriptor trap throws", (probe) => new Proxy(
    [{ dimension: "default", slotRef: "s", state: "RELEASED" }],
    {
      getOwnPropertyDescriptor: () => {
        probe.hits += 1;
        throw new Error("hostile descriptor trap");
      },
    },
  ), true],
];

describe("work.claim — hostile shapes refuse before any successor exists", () => {
  it("generated a positive, hand-counted case matrix", () => {
    expect(POISONS.length).toBe(8);
    expect(HOSTILE_TARGETS.length).toBe(6);
    expect(HOSTILE_CASES.length).toBe(48);
    expect(LIVE_CLAIM_CASES.length).toBe(6);
    expect(new Set(HOSTILE_CASES.map((hostile) => hostile.label)).size).toBe(48);
  });

  it.each(HOSTILE_CASES.map((hostile) => [hostile.label, hostile] as const))(
    "refuses %s at its owning leg",
    (_label, hostile) => {
      const probe: Probe = { hits: 0 };
      const refusal = refusalOf(claimWork(hostile.build(probe)));
      expect(refusal.failure.code).toBe("WORK_PAYLOAD_MALFORMED");
      expect(refusal.failure.leg).toBe(hostile.leg);
      expect(refusal.failure.layer).toBe("AUTHORITY");
      expect(refusal.failure.upstreamCode).toBeNull();
      const keys = Object.keys(refusal);
      expect(keys).not.toContain("successors");
      for (const key of SUCCESSOR_KEYS) expect(keys).not.toContain(key);
      // A trap that never fired is a case that tested nothing; a getter that
      // DID fire is attacker code the parser was supposed to never invoke.
      if (hostile.trapsFire) expect(probe.hits).toBeGreaterThan(0);
      else expect(probe.hits).toBe(0);
    },
  );

  it.each(LIVE_CLAIM_CASES)("refuses %s on the outer record", (_label, build, trapsFire) => {
    const probe: Probe = { hits: 0 };
    const refusal = refusalOf(claimWork(withPayload((payload) => {
      payload["liveClaims"] = build(probe) as never;
    })));
    expect(refusal.failure.code).toBe("WORK_PAYLOAD_MALFORMED");
    expect(refusal.failure.leg).toBe("lease");
    expect(refusal.failure.layer).toBe("AUTHORITY");
    expect(refusal.failure.upstreamCode).toBeNull();
    expect(Object.keys(refusal)).not.toContain("successors");
    if (trapsFire) expect(probe.hits).toBeGreaterThan(0);
    else expect(probe.hits).toBe(0);
  });

  it("mirrors a section through descriptors, never through a get trap", () => {
    let gets = 0;
    const payload = validPayload();
    payload["budget"] = new Proxy(at(payload, "budget"), {
      get: (target, key, receiver) => {
        gets += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const grant = grantOf(claimWork(payload));
    expect(gets).toBe(0);
    expect(grant.successors.budgetView).toStrictEqual(EXPECTED_VIEW);
  });

  it("refuses an outer payload missing any one of its five sections", () => {
    const outerKeys = ["budget", "effect", "lease", "liveClaims", "slot"];
    expect(outerKeys.length).toBe(5);
    for (const key of outerKeys) {
      const refusal = refusalOf(claimWork(withPayload((payload) => {
        delete payload[key];
      })));
      expect(refusal.failure.code).toBe("WORK_PAYLOAD_MALFORMED");
      expect(refusal.failure.leg).toBe("lease");
      expect(refusal.failure.upstreamCode).toBeNull();
    }
  });
});

/**
 * `work.claim` owns its transition. Forwarding a caller-selected effect command
 * let a `requestCancel` ride in on a claim and publish CANCEL_REQUESTED under a
 * CLAIM_GRANTED authority label.
 */
describe("work.claim — the effect command is server-owned", () => {
  const NON_CLAIM_COMMANDS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["arm", { kind: "arm" }],
    ["activate", { kind: "activate" }],
    ["requestCancel", { kind: "requestCancel" }],
    ["consumeGrant", { kind: "consumeGrant" }],
    ["settle", { adoptedAt: "2026-08-05T00:00:00.000Z", kind: "settle", target: "SUCCEEDED" }],
  ];

  const MALFORMED_COMMANDS: ReadonlyArray<readonly [string, unknown]> = [
    ["a claim command carrying an extra key", { extra: 1, kind: "claim" }],
    ["a command that is not a record", "claim"],
    ["a null command", null],
    ["a command carrying no kind", {}],
    ["a command whose kind is not a string", { kind: 7 }],
  ];

  it("covers every declared command case and names no claim among them", () => {
    expect(NON_CLAIM_COMMANDS.length).toBe(5);
    expect(MALFORMED_COMMANDS.length).toBe(5);
    expect(NON_CLAIM_COMMANDS.map(([kind]) => kind)).not.toContain("claim");
  });

  it.each(NON_CLAIM_COMMANDS)("refuses the %s command as a command mismatch", (_kind, command) => {
    const refusal = refusalOf(claimWork(withPayload((payload) => {
      at(payload, "effect")["command"] = command;
    })));
    expect(refusal.failure.code).toBe("WORK_INTENT_COMMAND_MISMATCH");
    expect(refusal.failure.leg).toBe("effectIntent");
    expect(refusal.failure.layer).toBe("AUTHORITY");
    expect(refusal.failure.upstreamCode).toBeNull();
    const keys = Object.keys(refusal);
    expect(keys).not.toContain("successors");
    for (const key of SUCCESSOR_KEYS) expect(keys).not.toContain(key);
  });

  it.each(MALFORMED_COMMANDS)("refuses %s as a malformed payload", (_label, command) => {
    const refusal = refusalOf(claimWork(withPayload((payload) => {
      at(payload, "effect")["command"] = command as never;
    })));
    expect(refusal.failure.code).toBe("WORK_PAYLOAD_MALFORMED");
    expect(refusal.failure.leg).toBe("effectIntent");
    expect(refusal.failure.layer).toBe("AUTHORITY");
    expect(refusal.failure.upstreamCode).toBeNull();
    expect(Object.keys(refusal)).not.toContain("successors");
  });

  it("never publishes a cancellation authority for a requestCancel command", () => {
    const result = claimWork(withPayload((payload) => {
      at(payload, "effect")["command"] = { kind: "requestCancel" };
    }));
    expect(result.ok).toBe(false);
    expect(result.authority).toBe("NONE");
    expect(JSON.stringify(result)).not.toContain("CANCEL_REQUESTED");
  });

  it("truncates the caller's command kind rather than echoing it whole", () => {
    // The kind is caller-controlled and unbounded; without the bound a 20k
    // command produced a 20k refusal message, so the refusal amplified the
    // request. The exact cut is pinned in both directions.
    const refusal = refusalOf(claimWork(withPayload((payload) => {
      at(payload, "effect")["command"] = { kind: "X".repeat(20_000) };
    })));
    expect(refusal.failure.code).toBe("WORK_INTENT_COMMAND_MISMATCH");
    expect(refusal.failure.message.length).toBeLessThan(128);
    expect(refusal.failure.message).toContain("X".repeat(32));
    expect(refusal.failure.message).not.toContain("X".repeat(33));
  });

  it("lets an earlier leg's refusal win over a non-claim command", () => {
    const refusal = refusalOf(claimWork(withPayload((payload) => {
      at(payload, "lease", "proof")["leaseToken"] = "token-stale";
      at(payload, "effect")["command"] = { kind: "requestCancel" };
    })));
    expect(refusal.failure.code).toBe("WORK_STALE_TOKEN");
    expect(refusal.failure.leg).toBe("lease");
    expect(refusal.failure.upstreamCode).toBe("AUTHORITY_STALE_LEASE");
  });

  it("still refuses at the ceiling when a non-claim command would also refuse", () => {
    const refusal = refusalOf(claimWork(withPayload((payload) => {
      payload["liveClaims"] = Array.from({ length: 4 }, (_unused, index) => ({
        dimension: "default",
        slotRef: `held-${index}`,
        state: "RESERVED",
      }));
      at(payload, "effect")["command"] = { kind: "requestCancel" };
    })));
    expect(refusal.failure.code).toBe("WORK_SLOT_EXHAUSTED");
    expect(refusal.failure.leg).toBe("slotCeiling");
    expect(refusal.failure.upstreamCode).toBeNull();
  });
});
