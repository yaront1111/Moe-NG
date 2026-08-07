import { describe, expect, it } from "vitest";

import {
  RENEWAL_WINDOW_SECONDS,
  RENEW_AFTER_SECONDS,
  confirmRevoke,
  extend,
  fencedRenew,
  markSuspect,
  restartReconstruct,
  type AuthorityErrorCode,
  type AuthorityOutcome,
  type AuthorityProof,
  type LeaseRecord,
  type LeaseState,
} from "./lease-state.js";
import { releaseWork } from "./lease-drain.js";
import { OTHER_HASH, clock, lease, proof, release } from "./test-fixtures.js";

type Mutation = (record: LeaseRecord, authority: AuthorityProof) => AuthorityOutcome<unknown>;
const MUTATIONS: readonly (readonly [string, Mutation])[] = [
  ["fencedRenew", (l, p) => fencedRenew(l, p, clock())],
  ["markSuspect", (l, p) => markSuspect(l, p, clock({ serverWallSeconds: 1_200 }))],
  ["extend", (l, p) => extend(l, p, clock(), "HUMAN_WAIT")],
  ["confirmRevoke", (l, p) => confirmRevoke(l, p, "URGENT_REVOKE")],
  ["releaseWork", (l, p) => releaseWork(l, p, release())],
];

const TAMPERS: readonly (readonly [string, Partial<AuthorityProof>, AuthorityErrorCode])[] = [
  ["wrong leaseToken", { leaseToken: "token-stale" }, "AUTHORITY_STALE_LEASE"],
  ["stale epoch", { epoch: 2 }, "AUTHORITY_STALE_EPOCH"],
  ["wrong authorityHashRef", { authorityHashRef: OTHER_HASH }, "AUTHORITY_STALE_LEASE"],
  ["mismatched ownerSessionRef", { ownerSessionRef: "session-attacker" }, "AUTHORITY_STALE_LEASE"],
  ["stale record version", { expectedVersion: 6 }, "AUTHORITY_STALE_LEASE"],
];

describe("fencing matrix (design 749: token, epoch, authority hash, session, version, state)", () => {
  for (const [mutationName, mutate] of MUTATIONS) {
    for (const [tamperName, tamper, expected] of TAMPERS) {
      it(`${mutationName} refuses ${tamperName} with zero business effect`, () => {
        const record = lease();
        const before = structuredClone(record);
        const result = mutate(record, proof(tamper));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues.map((issue) => issue.code)).toEqual([expected]);
        expect(record).toEqual(before);
        expect(result.securityRecord).not.toBeNull();
        expect(result.securityRecord?.code).toBe(expected);
        expect(result.securityRecord?.aggregateKind).toBe("LEASE");
        expect(result.securityRecord?.commandKind).toBe(mutationName);
        expect(result.securityRecord?.sourceState).toBe("ACTIVE");
        expect(result.securityRecord?.expectedEpoch).toBe(3);
        expect(result.securityRecord?.observedEpoch).toBe(tamper.epoch ?? 3);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("token-current");
        expect(serialized).not.toContain("token-stale");
      });
    }
  }

  it("reports successor-epoch revocation as superseded authority, not a stale epoch", () => {
    const record = lease({ epoch: 4, state: "REVOKED" });
    const result = fencedRenew(record, proof({ epoch: 3 }), clock());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_SUPERSEDED_AUTHORITY"]);
    expect(result.securityRecord?.expectedEpoch).toBe(4);
    expect(result.securityRecord?.observedEpoch).toBe(3);
  });
});

describe("malformed input is not a security event (design 749 scopes it to valid attempts)", () => {
  const cases: readonly (readonly [string, () => AuthorityOutcome<unknown>])[] = [
    ["missing ownerSessionRef", () => {
      const { ownerSessionRef: _omitted, ...rest } = proof();
      return fencedRenew(lease(), rest as unknown as AuthorityProof, clock());
    }],
    ["empty ownerSessionRef", () => fencedRenew(lease(), proof({ ownerSessionRef: "" }), clock())],
    ["non-string leaseToken", () =>
      fencedRenew(lease(), { ...proof(), leaseToken: 7 } as unknown as AuthorityProof, clock())],
    ["uppercase authorityHashRef", () =>
      fencedRenew(lease(), proof({ authorityHashRef: "A".repeat(64) }), clock())],
    ["extra proof key", () =>
      fencedRenew(lease(), { ...proof(), principalId: "p" } as unknown as AuthorityProof, clock())],
    ["negative epoch", () => fencedRenew(lease(), proof({ epoch: -1 }), clock())],
    ["malformed lease record", () =>
      fencedRenew({ ...lease(), version: 1.5 }, proof(), clock())],
    ["malformed clock observation", () =>
      fencedRenew(lease(), proof(), { ...clock(), bootId: "" })],
  ];
  for (const [name, run] of cases) {
    it(`refuses ${name} without a security record`, () => {
      const result = run();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
      expect(result.securityRecord).toBeNull();
    });
  }
});

describe("lease state machine (design 743-745)", () => {
  it("renews an ACTIVE lease and stores deadline, boot id, and monotonic observation", () => {
    const result = fencedRenew(lease(), proof(), clock());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("ACTIVE");
    expect(result.value.lease.serverWallDeadline).toBe(960 + RENEWAL_WINDOW_SECONDS);
    expect(result.value.lease.bootId).toBe("boot-1");
    expect(result.value.lease.monotonicObservation).toBe(600);
    expect(result.value.lease.epoch).toBe(3);
    expect(result.value.lease.version).toBe(8);
    expect(result.value.renewAfterSeconds).toBe(RENEW_AFTER_SECONDS);
    expect(Object.isFrozen(result.value.lease)).toBe(true);
  });

  it("restores SUSPECT to ACTIVE through the owner's fenced renew path", () => {
    const result = fencedRenew(lease({ state: "SUSPECT" }), proof(), clock());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("ACTIVE");
    expect(result.value.lease.epoch).toBe(3);
  });

  it("marks a due ACTIVE lease SUSPECT and emits the durable observation event", () => {
    const result = markSuspect(lease(), proof(), clock({ serverWallSeconds: 1_200 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("SUSPECT");
    expect(result.value.lease.epoch).toBe(3);
    expect(result.value.lease.version).toBe(8);
    expect(result.value.event).toEqual({
      leaseId: "lease-1", kind: "ASSIGNMENT", observedAtSeconds: 1_200, bootId: "boot-1",
      monotonicObservation: 600, dueDeadlineSeconds: 1_000,
    });
  });

  it("refuses to mark a lease SUSPECT before its deadline is due", () => {
    const result = markSuspect(lease(), proof(), clock({ serverWallSeconds: 999 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
    expect(result.securityRecord).toBeNull();
  });

  it("extends a SUSPECT lease back to ACTIVE without touching the epoch", () => {
    const result = extend(lease({ state: "SUSPECT" }), proof(), clock(), "HUMAN_WAIT");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("ACTIVE");
    expect(result.value.lease.epoch).toBe(3);
    expect(result.value.lease.version).toBe(8);
    expect(result.value.reason).toBe("HUMAN_WAIT");
  });

  it("revokes with a drain reason and increments the epoch exactly once", () => {
    const result = confirmRevoke(lease({ state: "DRAINING" }), proof(), "URGENT_REVOKE");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("REVOKED");
    expect(result.value.lease.epoch).toBe(4);
    expect(result.value.lease.version).toBe(8);
    expect(result.value.reason).toBe("URGENT_REVOKE");
  });

  it("refuses a revocation reason outside the frozen drain vocabulary", () => {
    const result = confirmRevoke(lease(), proof(), "NOT_A_REASON" as never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  });

  const WRONG_STATES: readonly (readonly [string, Mutation, readonly LeaseState[]])[] = [
    ["fencedRenew", (l, p) => fencedRenew(l, p, clock()), ["DRAINING", "RELEASED", "REVOKED"]],
    ["markSuspect", (l, p) => markSuspect(l, p, clock({ serverWallSeconds: 1_200 })),
      ["SUSPECT", "DRAINING", "RELEASED", "REVOKED"]],
    ["extend", (l, p) => extend(l, p, clock(), "HUMAN_WAIT"), ["DRAINING", "RELEASED", "REVOKED"]],
    ["confirmRevoke", (l, p) => confirmRevoke(l, p, "URGENT_REVOKE"), ["RELEASED", "REVOKED"]],
  ];
  for (const [name, mutate, states] of WRONG_STATES) {
    for (const state of states) {
      it(`${name} refuses a ${state} lease as a stale lease`, () => {
        const record = lease({ state });
        const result = mutate(record, proof());
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_LEASE"]);
        expect(result.securityRecord?.sourceState).toBe(state);
      });
    }
  }
});

describe("renewal policy constants (design 751)", () => {
  it("uses a 90 second window renewed at one third, by integer arithmetic", () => {
    expect(RENEWAL_WINDOW_SECONDS).toBe(90);
    expect(RENEW_AFTER_SECONDS).toBe(30);
    expect(RENEWAL_WINDOW_SECONDS / 3).toBe(RENEW_AFTER_SECONDS);
    expect(Number.isSafeInteger(RENEW_AFTER_SECONDS)).toBe(true);
  });
});

describe("restart reconstruction (design 751: a timer has no authority)", () => {
  it("returns overdue suspect events sorted by lease id and mutates nothing", () => {
    const records = [
      lease({ leaseId: "lease-b", serverWallDeadline: 100 }),
      lease({ leaseId: "lease-a", serverWallDeadline: 100 }),
      lease({ leaseId: "lease-c", serverWallDeadline: 5_000 }),
      lease({ leaseId: "lease-d", serverWallDeadline: 100, state: "RELEASED" }),
    ];
    const before = structuredClone(records);
    const result = restartReconstruct(records, clock({ serverWallSeconds: 2_000, bootId: "boot-2" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overdue.map((event) => event.leaseId)).toEqual(["lease-a", "lease-b"]);
    expect(result.value.bootId).toBe("boot-2");
    expect(result.value.observedAtSeconds).toBe(2_000);
    expect(records).toEqual(before);
    expect(Object.isFrozen(result.value.overdue)).toBe(true);
  });

  it("does not make a live lease due merely because the daemon boot id changed", () => {
    const result = restartReconstruct(
      [lease({ serverWallDeadline: 9_000 })],
      clock({ serverWallSeconds: 2_000, bootId: "boot-2" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.overdue).toEqual([]);
    expect(result.value.bootId).toBe("boot-2");
  });

  it("refuses a malformed lease list", () => {
    const result = restartReconstruct([lease(), { bogus: true }], clock());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  });
});
