import { describe, expect, it } from "vitest";

import { applyWorkLifecycle } from "./work-lifecycle.js";
import type { WorkRefused, WorkResult } from "./work-kernel.js";

/** Hand-written against the upstream contracts; never derived from the surface under test. */
const DIGEST = "b".repeat(64);

const LEASE = {
  authorityHashRef: DIGEST,
  bootId: "boot-1",
  epoch: 5,
  kind: "ASSIGNMENT",
  leaseId: "lease-9",
  leaseToken: "token-9",
  monotonicObservation: 900,
  ownerSessionRef: "session-9",
  serverWallDeadline: 2_000,
  state: "ACTIVE",
  version: 11,
} as const;

const PROOF = {
  authorityHashRef: DIGEST,
  epoch: 5,
  expectedVersion: 11,
  leaseToken: "token-9",
  ownerSessionRef: "session-9",
} as const;

const INTENT = {
  aggregateId: "agg-9",
  desiredState: "ACTIVE",
  expectedGraphEpoch: 2,
  idempotencyKey: "idem-9",
  inputBinding: DIGEST,
  intentId: "intent-9",
  leaseBinding: LEASE,
  predecessorCursor: "cursor-9",
  protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST,
  state: "CLAIMED",
  version: 3,
} as const;

type Payload = Record<string, unknown>;

/** Structured clone via JSON so a mutation never leaks between cases. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Always returns a FRESH deep copy. Handing back the module-level consts would
 * let one case's injection leak into the next — which it did: the stale-token
 * case mutated the shared PROOF and the stale-epoch case then observed
 * WORK_STALE_TOKEN.
 */
function payloadFor(overrides: Payload = {}): Payload {
  return clone({
    effect: { intent: INTENT },
    lease: { proof: PROOF, record: LEASE },
    ...overrides,
  }) as Payload;
}

function refusalOf(result: WorkResult): WorkRefused {
  if (result.ok !== false) throw new Error("expected a refusal, received an ok result");
  if (!("failure" in result)) throw new Error("expected a WorkRefused carrying a failure");
  return result;
}

/** Every command that mutates authority; get_context is read-only and excluded. */
const MUTATIONS = ["renew", "release", "resume", "cancel"] as const;

/** The lease state each mutation must be applied from. */
const LEASE_STATE_FOR: Readonly<Record<string, string>> = {
  cancel: "ACTIVE",
  release: "ACTIVE",
  renew: "ACTIVE",
  resume: "SUSPECT",
};

function payloadForCommand(command: string, mutate: (payload: Payload) => void = () => {}): Payload {
  const payload = clone(payloadFor());
  const lease = (payload["lease"] as Payload)["record"] as Payload;
  lease["state"] = LEASE_STATE_FOR[command] ?? "ACTIVE";
  mutate(payload);
  return payload;
}

describe("work lifecycle — every mutation revalidates token and epoch", () => {
  it("covers every declared mutating command", () => {
    expect(MUTATIONS.length).toBe(4);
  });

  it.each(MUTATIONS)("%s succeeds on a current token and epoch", (command) => {
    const result = applyWorkLifecycle(command, payloadForCommand(command));
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("WORK_APPLIED");
    expect(result.authority).not.toBe("NONE");
  });

  it.each(MUTATIONS)("%s refuses a stale token with WORK_STALE_TOKEN", (command) => {
    const payload = payloadForCommand(command, (p) => {
      ((p["lease"] as Payload)["proof"] as Payload)["leaseToken"] = "token-stale";
    });
    const refusal = refusalOf(applyWorkLifecycle(command, payload));
    expect(refusal.failure.code).toBe("WORK_STALE_TOKEN");
    expect(refusal.failure.layer).toBe("AUTHORITY");
    expect(refusal.failure.leg).toBe("lease");
  });

  it.each(MUTATIONS)("%s refuses a stale epoch with WORK_STALE_EPOCH", (command) => {
    const payload = payloadForCommand(command, (p) => {
      ((p["lease"] as Payload)["proof"] as Payload)["epoch"] = 4;
    });
    const refusal = refusalOf(applyWorkLifecycle(command, payload));
    expect(refusal.failure.code).toBe("WORK_STALE_EPOCH");
    expect(refusal.failure.layer).toBe("AUTHORITY");
  });

  it("keeps the two failure modes distinct, so neither can be conflated", () => {
    const codes = new Set<string>();
    for (const command of MUTATIONS) {
      const staleToken = payloadForCommand(command, (p) => {
        ((p["lease"] as Payload)["proof"] as Payload)["leaseToken"] = "token-stale";
      });
      const staleEpoch = payloadForCommand(command, (p) => {
        ((p["lease"] as Payload)["proof"] as Payload)["epoch"] = 4;
      });
      codes.add(refusalOf(applyWorkLifecycle(command, staleToken)).failure.code);
      codes.add(refusalOf(applyWorkLifecycle(command, staleEpoch)).failure.code);
    }
    expect([...codes].sort()).toStrictEqual(["WORK_STALE_EPOCH", "WORK_STALE_TOKEN"]);
  });

  it.each(MUTATIONS)("%s carries no successor when it refuses", (command) => {
    const payload = payloadForCommand(command, (p) => {
      ((p["lease"] as Payload)["proof"] as Payload)["leaseToken"] = "token-stale";
    });
    const refusal = refusalOf(applyWorkLifecycle(command, payload));
    expect(Object.keys(refusal)).not.toContain("successor");
    expect(Object.keys(refusal)).not.toContain("successors");
    expect(refusal.authority).toBe("NONE");
  });

  it.each(MUTATIONS)("%s refuses a lease in an illegal state", (command) => {
    const payload = payloadForCommand(command, (p) => {
      ((p["lease"] as Payload)["record"] as Payload)["state"] = "RELEASED";
    });
    const refusal = refusalOf(applyWorkLifecycle(command, payload));
    expect(refusal.failure.layer).toBe("AUTHORITY");
    expect(refusal.failure.code).toBe("WORK_LEASE_NOT_CURRENT");
  });
});

/**
 * DoD 3. Each pair races on the same lease. The winner's successor bumps the
 * lease version, so the loser — still holding the pre-race proof — presents a
 * stale expectedVersion and is refused. Exactly one legal state survives.
 */
describe("work lifecycle — interleavings end in exactly one legal state", () => {
  function raceOutcome(first: string, second: string): {
    readonly winner: WorkResult;
    readonly loser: WorkResult;
  } {
    const payload = payloadForCommand(first);
    const winner = applyWorkLifecycle(first, payload);
    if (!winner.ok || winner.outcome !== "WORK_APPLIED") {
      throw new Error(`${first} was expected to win, got ${JSON.stringify(winner)}`);
    }
    // The loser arrives with the ORIGINAL proof against the winner's successor.
    const successor = winner.successor as Payload;
    const losing = payloadForCommand(second);
    (losing["lease"] as Payload)["record"] = successor["lease"] ?? successor;
    const loser = applyWorkLifecycle(second, losing);
    return { loser, winner };
  }

  /** [winner, loser, the winner's successor lease state, the loser's exact code] */
  const pairs: ReadonlyArray<readonly [string, string, string, string]> = [
    ["cancel", "renew", "DRAINING", "WORK_LEASE_NOT_CURRENT"],
    ["renew", "cancel", "ACTIVE", "WORK_LEASE_NOT_CURRENT"],
    ["release", "renew", "RELEASED", "WORK_LEASE_NOT_CURRENT"],
    ["renew", "release", "ACTIVE", "WORK_LEASE_NOT_CURRENT"],
  ];

  it("covers both orderings of both declared pairs", () => {
    expect(pairs.length).toBe(4);
  });

  it.each(pairs)(
    "%s beating %s ends in exactly one legal state",
    (first, second, winnerState, loserCode) => {
      const { loser, winner } = raceOutcome(first, second);

      // Exactly one winner, and its successor state is pinned by name.
      expect(winner.ok).toBe(true);
      if (!winner.ok || winner.outcome !== "WORK_APPLIED") throw new Error("unreachable");
      const successor = (winner.successor as Payload)["lease"] as Payload;
      expect(successor["state"]).toBe(winnerState);
      expect(successor["version"]).toBe(LEASE.version + 1);

      // Exactly one loser, refused with a specific code, naming its layer.
      const refusal = refusalOf(loser);
      expect(refusal.failure.code).toBe(loserCode);
      expect(refusal.failure.layer).toBe("AUTHORITY");
      expect(refusal.failure.leg).toBe("lease");
      expect(refusal.failure.upstreamCode).toBe("AUTHORITY_STALE_LEASE");
      expect(Object.keys(refusal)).not.toContain("successor");
    },
  );

  it("bumps the lease version exactly once per winning mutation", () => {
    const payload = payloadForCommand("renew");
    const result = applyWorkLifecycle("renew", payload);
    if (!result.ok || result.outcome !== "WORK_APPLIED") throw new Error("expected renew to apply");
    const successor = result.successor as Payload;
    const lease = (successor["lease"] ?? successor) as Payload;
    expect(lease["version"]).toBe(LEASE.version + 1);
  });
});

describe("work lifecycle — get_context is read-only", () => {
  it("returns a frozen view that grants no authority", () => {
    const result = applyWorkLifecycle("get_context", payloadFor());
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("CONTEXT_VIEW");
    expect(result.authority).toBe("NONE");
    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== "CONTEXT_VIEW") throw new Error("unreachable");
    expect(Object.isFrozen(result.view)).toBe(true);
  });

  it("is idempotent — a second call deep-equals the first", () => {
    const first = applyWorkLifecycle("get_context", payloadFor());
    const second = applyWorkLifecycle("get_context", payloadFor());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("mutates nothing in the caller's payload", () => {
    const payload = payloadFor();
    const before = JSON.stringify(payload);
    applyWorkLifecycle("get_context", payload);
    applyWorkLifecycle("get_context", payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  /**
   * Found by adversarial review. The JSON-equality test above CANNOT catch
   * this: freezing changes an object's extensibility, not its serialized
   * content. get_context previously handed the caller's own intent to
   * deepFreeze, so a read-only command left the caller's record permanently
   * immutable.
   */
  it("does not freeze the caller's own objects", () => {
    const payload = payloadFor();
    const effect = payload["effect"] as Payload;
    const lease = payload["lease"] as Payload;
    const result = applyWorkLifecycle("get_context", payload);

    expect(result.ok).toBe(true);
    expect(Object.isFrozen(effect["intent"])).toBe(false);
    expect(Object.isFrozen(lease["record"])).toBe(false);
    expect(Object.isFrozen(lease["proof"])).toBe(false);

    // The published view is still frozen — the caller's copy just is not.
    if (result.outcome !== "CONTEXT_VIEW") throw new Error("unreachable");
    expect(Object.isFrozen(result.view)).toBe(true);
    const view = result.view as Payload;
    expect(Object.isFrozen(view["effectIntent"])).toBe(true);
  });

  it("publishes a view that is a copy, not an alias, of the caller's intent", () => {
    const payload = payloadFor();
    const result = applyWorkLifecycle("get_context", payload);
    if (!result.ok || result.outcome !== "CONTEXT_VIEW") throw new Error("unreachable");
    const view = result.view as Payload;
    expect(view["effectIntent"]).not.toBe((payload["effect"] as Payload)["intent"]);
    expect(view["effectIntent"]).toStrictEqual((payload["effect"] as Payload)["intent"]);
  });

  it("publishes no successor and no claim authority", () => {
    const result = applyWorkLifecycle("get_context", payloadFor());
    const keys = Object.keys(result);
    expect(keys).not.toContain("successor");
    expect(keys).not.toContain("successors");
  });

  it("still revalidates the token, refusing a stale one", () => {
    const payload = payloadFor();
    ((payload["lease"] as Payload)["proof"] as Payload)["leaseToken"] = "token-stale";
    const refusal = refusalOf(applyWorkLifecycle("get_context", payload));
    expect(refusal.failure.code).toBe("WORK_STALE_TOKEN");
  });

  it("still revalidates the epoch, refusing a stale one", () => {
    const payload = payloadFor();
    ((payload["lease"] as Payload)["proof"] as Payload)["epoch"] = 4;
    const refusal = refusalOf(applyWorkLifecycle("get_context", payload));
    expect(refusal.failure.code).toBe("WORK_STALE_EPOCH");
  });
});

describe("work lifecycle — malformed input refuses before any authority path", () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["an array", []],
    ["a payload with no lease section", { effect: {} }],
    ["a payload whose lease is not a record", { effect: {}, lease: "lease-9" }],
  ];

  it("covers every declared malformed case", () => {
    expect(malformed.length).toBe(4);
  });

  it.each(malformed)("refuses %s with WORK_PAYLOAD_MALFORMED", (_label, payload) => {
    const refusal = refusalOf(applyWorkLifecycle("renew", payload));
    expect(refusal.failure.code).toBe("WORK_PAYLOAD_MALFORMED");
    expect(Object.keys(refusal)).not.toContain("successor");
  });

  it("refuses a command outside the lifecycle family", () => {
    const refusal = refusalOf(applyWorkLifecycle("claim", payloadFor()));
    expect(refusal.failure.code).toBe("WORK_REQUEST_INVALID");
    expect(refusal.failure.layer).toBe("INGRESS");
  });

  /**
   * Found by adversarial review, not by a failing test. A bare
   * `LIFECYCLE_COMMANDS[command]` lookup walks the prototype chain, so
   * "constructor" resolved to Object, passed the `spec !== undefined` guard,
   * and was applied as a real command with `authority: undefined` — an ok:true
   * result for a command that does not exist.
   */
  const inheritedNames = [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
    "isPrototypeOf",
    "propertyIsEnumerable",
  ] as const;

  it("covers every declared inherited-member name", () => {
    expect(inheritedNames.length).toBe(7);
    // Each really is reachable through the prototype chain of a plain object.
    for (const name of inheritedNames) {
      expect(name in ({} as Record<string, unknown>)).toBe(true);
    }
  });

  it.each(inheritedNames)("refuses the inherited member %s as a command", (name) => {
    const refusal = refusalOf(applyWorkLifecycle(name, payloadFor()));
    expect(refusal.failure.code).toBe("WORK_REQUEST_INVALID");
    expect(refusal.failure.layer).toBe("INGRESS");
    expect(Object.keys(refusal)).not.toContain("successor");
  });
});
