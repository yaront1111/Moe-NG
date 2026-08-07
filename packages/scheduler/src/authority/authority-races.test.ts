import { describe, expect, it } from "vitest";

import {
  DRAIN_REASONS, confirmRevoke, extend, fencedRenew, markSuspect, restartReconstruct,
  type AuthorityProof, type DrainReason, type LeaseRecord,
} from "./lease-state.js";
import { applyDrainReason, releaseWork, type DrainDisposition } from "./lease-drain.js";
import { adapterConfirm, adapterFail, reserveAll, type ResourceRow } from "./lease-resource.js";
import { clock, lease, release } from "./test-fixtures.js";

interface World {
  readonly record: LeaseRecord;
  readonly disposition: DrainDisposition | null;
  readonly rows: readonly ResourceRow[];
}

function currentProof(record: LeaseRecord): AuthorityProof {
  return {
    leaseToken: record.leaseToken, epoch: record.epoch,
    authorityHashRef: record.authorityHashRef, ownerSessionRef: record.ownerSessionRef,
    expectedVersion: record.version,
  };
}

const TAMPERS: readonly ((record: LeaseRecord) => AuthorityProof)[] = [
  (record) => ({ ...currentProof(record), leaseToken: "token-stale" }),
  (record) => ({ ...currentProof(record), epoch: record.epoch === 0 ? 1 : record.epoch - 1 }),
  (record) => ({ ...currentProof(record), authorityHashRef: "b".repeat(64) }),
  (record) => ({ ...currentProof(record), ownerSessionRef: "session-attacker" }),
  (record) => ({ ...currentProof(record), expectedVersion: record.version + 1 }),
];

const RESERVE_REQUEST = {
  requestId: "req-1",
  declaredResources: [
    { resourceId: "res-a", capacityUnits: 1, external: false, fenceable: true },
    { resourceId: "res-b", capacityUnits: 2, external: true, fenceable: true },
  ],
  capacitySnapshot: { "res-a": 4, "res-b": 2 },
  epoch: 5, eligibilityEventSequenceRef: "seq-11", continuouslyEligibleSinceRef: "seq-9",
  callerObservation: "observation-1",
};

/**
 * Seeded pools, not a pure random walk: a uniform walk over a machine with
 * absorbing terminal states never reaches the deep branches, so every invariant
 * asserted about them would pass vacuously (`mem:gotcha-property-test-vacuity`).
 * Each member is produced by an asserted-good command sequence, so a reducer
 * change that breaks the setup fails loudly instead of quietly shrinking
 * coverage.
 */
function statePool(): readonly LeaseRecord[] {
  const active = lease();
  const authority = currentProof(active);
  const suspect = markSuspect(active, authority, clock({ serverWallSeconds: 2_000 }));
  const draining = releaseWork(active, authority, release({ safeBoundaryObserved: false }));
  const released = releaseWork(active, authority, release());
  const revoked = confirmRevoke(active, authority, "URGENT_REVOKE");
  expect(suspect.ok && draining.ok && released.ok && revoked.ok).toBe(true);
  if (!suspect.ok || !draining.ok || !released.ok || !revoked.ok) throw new Error("pool seed");
  const members = [
    active, suspect.value.lease, draining.value.lease, released.value.lease, revoked.value.lease,
  ];
  expect(members.map((member) => member.state))
    .toEqual(["ACTIVE", "SUSPECT", "DRAINING", "RELEASED", "REVOKED"]);
  return members;
}

const COMMANDS = [
  "fencedRenew", "markSuspect", "extend", "confirmRevoke", "releaseWork", "restartReconstruct",
  "applyDrainReason", "reserveAll", "adapterConfirm", "adapterFail",
] as const;

function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function apply(
  world: World,
  command: (typeof COMMANDS)[number],
  authority: AuthorityProof,
  reason: DrainReason,
  coin: boolean,
): { readonly outcome: string; readonly world: World } {
  const { record } = world;
  const keep = (next: Partial<World>): World => ({ ...world, ...next });
  switch (command) {
    case "fencedRenew": {
      const result = fencedRenew(record, authority, clock({ serverWallSeconds: 960 }));
      return result.ok
        ? { outcome: `ACCEPT:${result.value.lease.state}`, world: keep({ record: result.value.lease }) }
        : { outcome: result.issues[0]?.code ?? "NONE", world };
    }
    case "markSuspect": {
      const at = record.serverWallDeadline + (coin ? 1 : -1);
      const result = markSuspect(record, authority, clock({ serverWallSeconds: at }));
      return result.ok
        ? { outcome: "ACCEPT:SUSPECT", world: keep({ record: result.value.lease }) }
        : { outcome: result.issues[0]?.code ?? "NONE", world };
    }
    case "extend": {
      const result = extend(record, authority, clock(), "HUMAN_WAIT");
      return result.ok
        ? { outcome: "ACCEPT:ACTIVE", world: keep({ record: result.value.lease }) }
        : { outcome: result.issues[0]?.code ?? "NONE", world };
    }
    case "confirmRevoke": {
      const result = confirmRevoke(record, authority, reason);
      return result.ok
        ? { outcome: "ACCEPT:REVOKED", world: keep({ record: result.value.lease }) }
        : { outcome: result.issues[0]?.code ?? "NONE", world };
    }
    case "releaseWork": {
      const result = releaseWork(record, authority, release({
        reason, safeBoundaryObserved: coin, disposition: world.disposition,
      }));
      if (!result.ok) return { outcome: result.issues[0]?.code ?? "NONE", world };
      const disposition = result.value.outcome === "NO_OP"
        ? world.disposition : result.value.disposition;
      return {
        outcome: `ACCEPT:${result.value.outcome}`,
        world: keep({ record: result.value.lease, disposition }),
      };
    }
    case "restartReconstruct": {
      const result = restartReconstruct([record], clock({ serverWallSeconds: 5_000 }));
      return result.ok
        ? { outcome: `RESTART:${result.value.overdue.length}`, world }
        : { outcome: result.issues[0]?.code ?? "NONE", world };
    }
    case "applyDrainReason": {
      const result = applyDrainReason(world.disposition, reason);
      return result.ok
        ? { outcome: `ACCEPT:DRAIN:${result.value.terminalTarget}`, world: keep({ disposition: result.value }) }
        : { outcome: result.issues[0]?.code ?? "NONE", world };
    }
    case "reserveAll": {
      const snapshot = coin ? RESERVE_REQUEST.capacitySnapshot : { "res-a": 0, "res-b": 0 };
      const result = reserveAll({ ...RESERVE_REQUEST, capacitySnapshot: snapshot });
      if (!result.ok) return { outcome: result.issues[0]?.code ?? "NONE", world };
      const rows = result.value.outcome === "RESERVED" ? result.value.rows : world.rows;
      return { outcome: `ACCEPT:${result.value.outcome}`, world: keep({ rows }) };
    }
    case "adapterConfirm": {
      const result = adapterConfirm(world.rows, "res-b", 5);
      return result.ok
        ? { outcome: "ACCEPT:RESOURCE_ACTIVE", world: keep({ rows: result.value.rows }) }
        : { outcome: result.issues[0]?.code ?? "NONE", world };
    }
    default: {
      const result = adapterFail(world.rows, "res-b", 5, coin ? "FAILED" : "UNKNOWN");
      return result.ok
        ? { outcome: "ACCEPT:RESOURCE_HELD", world: keep({ rows: result.value.rows }) }
        : { outcome: result.issues[0]?.code ?? "NONE", world };
    }
  }
}

function runTrace(seed: number, steps: number): readonly string[] {
  const pool = statePool();
  const next = seeded(seed);
  let world: World = { record: pool[next() % pool.length]!, disposition: null, rows: [] };
  const trace: string[] = [];
  for (let index = 0; index < steps; index += 1) {
    const command = COMMANDS[next() % COMMANDS.length]!;
    // 70/30 bias toward legal authority so deep branches are actually reached,
    // while illegal transitions still get exercised every few steps.
    const honest = next() % 10 < 7;
    const authority = honest
      ? currentProof(world.record)
      : TAMPERS[next() % TAMPERS.length]!(world.record);
    const reason = DRAIN_REASONS[next() % DRAIN_REASONS.length]!;
    const coin = next() % 2 === 0;
    const before = structuredClone(world.record);
    const stepped = apply(world, command, authority, reason, coin);
    expect(world.record).toEqual(before);
    // A step either has zero business effect or advances the version by exactly
    // one; the epoch only ever moves forward, and only by one.
    const versionDelta = stepped.world.record.version - world.record.version;
    const epochDelta = stepped.world.record.epoch - world.record.epoch;
    expect([0, 1]).toContain(versionDelta);
    expect([0, 1]).toContain(epochDelta);
    if (stepped.world.record.state !== world.record.state) expect(versionDelta).toBe(1);
    if (epochDelta === 1) expect(stepped.world.record.state).toBe("REVOKED");
    trace.push(`${command}=>${stepped.outcome}`);
    world = stepped.world;
    const terminal = world.record.state === "RELEASED" || world.record.state === "REVOKED";
    if (terminal && next() % 2 === 0) {
      world = { ...world, record: pool[next() % pool.length]! };
    }
  }
  return trace;
}

const EXPECTED_OUTCOMES = [
  "ACCEPT:ACTIVE", "ACCEPT:DRAIN:RELEASED", "ACCEPT:DRAIN:REVOKED", "ACCEPT:DRAINING",
  "ACCEPT:NO_OP", "ACCEPT:RELEASED", "ACCEPT:RESERVED", "ACCEPT:RESOURCE_ACTIVE",
  "ACCEPT:RESOURCE_HELD", "ACCEPT:REVOKED", "ACCEPT:SUSPECT", "ACCEPT:WAITING",
  "AUTHORITY_MALFORMED_INPUT", "AUTHORITY_STALE_EPOCH", "AUTHORITY_STALE_LEASE",
  "AUTHORITY_SUPERSEDED_AUTHORITY", "RESTART:0", "RESTART:1",
];

describe("authority races end in one legal deterministic state (DoD 3)", () => {
  it("observes every outcome kind across the seed set, so no branch is vacuous", () => {
    const tally = new Map<string, number>();
    for (const seed of [1, 5, 9, 17, 33]) {
      for (const entry of runTrace(seed, 240)) {
        const outcome = entry.slice(entry.indexOf("=>") + 2);
        tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
      }
    }
    expect([...tally.keys()].sort()).toEqual(EXPECTED_OUTCOMES);
    for (const [outcome, count] of tally) expect([outcome, count > 0]).toEqual([outcome, true]);
  });

  it("replays a seed to a bit-identical trace", () => {
    expect(runTrace(11, 120)).toEqual(runTrace(11, 120));
    expect(runTrace(11, 120)).not.toEqual(runTrace(12, 120));
  });
});
