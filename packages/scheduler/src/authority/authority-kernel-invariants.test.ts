import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DRAIN_REASONS, DRAIN_REASON_RANKS, LEASE_STATES, MAX_AUTHORITY_COUNT, confirmRevoke,
  fencedRenew, restartReconstruct, type DrainReason,
} from "./lease-state.js";
import { applyDrainReason, type DrainDisposition } from "./lease-drain.js";
import { acceptPing } from "./presence.js";
import { lease, proof } from "./test-fixtures.js";

const authorityDir = fileURLToPath(new URL(".", import.meta.url));
const LEASE_MODULES = [
  "authority-kernel.ts", "lease-drain.ts", "lease-fencing.ts", "lease-resource.ts",
  "lease-state.ts", "provider-slot-release.ts", "resource-model.ts",
];
const AUTHORITY_REACHING = /lease|authority-kernel|resource-model/u;

function specifiers(source: string): readonly string[] {
  return [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1] ?? "");
}
async function productionSources(): Promise<readonly string[]> {
  const entries = await readdir(authorityDir);
  return entries.filter((name) =>
    name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-fixtures.ts").sort();
}

/**
 * DoD 2 is proven here by the module graph, not by behaviour: if no import edge
 * exists in either direction, no code path exists from a ping to lease
 * authority. The ping-storm property below is belt-and-braces only — on its own
 * it is near-vacuous, because a presence function never receives a LeaseRecord.
 */
describe("presence cannot reach lease authority (design 759-761)", () => {
  it("imports nothing from the lease modules", async () => {
    const source = await readFile(join(authorityDir, "presence.ts"), "utf8");
    const imported = specifiers(source);
    expect(imported).toEqual(["../runtime-shape.js"]);
    expect(imported.filter((entry) => AUTHORITY_REACHING.test(entry))).toEqual([]);
  });

  it("is imported by no lease module", async () => {
    for (const name of LEASE_MODULES) {
      const source = await readFile(join(authorityDir, name), "utf8");
      expect([name, ...specifiers(source).filter((entry) => /presence/u.test(entry))])
        .toEqual([name]);
    }
  });

  it("scans every production module, so a new one cannot slip past the ban", async () => {
    const sources = await productionSources();
    expect(sources).toEqual([...LEASE_MODULES, "presence.ts"].sort());
  });

  it("converges a ping storm to one projection without any authority field", () => {
    let projection: unknown = { sessionRef: "session-1", lastSeen: 0, lastPingId: null };
    for (let index = 0; index < 50; index += 1) {
      const result = acceptPing(projection, {
        sessionRef: "session-1", pingId: `ping-${index % 3}`,
        clientObservation: "client", serverReceivedAt: index,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      projection = result.projection;
    }
    expect(projection).toEqual({ sessionRef: "session-1", lastSeen: 49, lastPingId: "ping-1" });
  });
});

describe("the authority kernel mints no ambient state", () => {
  it("uses no clock, randomness, process state, or cross-package import", async () => {
    for (const name of await productionSources()) {
      const source = await readFile(join(authorityDir, name), "utf8");
      for (const forbidden of ["Date.now", "Math.random", "process.", "@moe/", "globalThis"]) {
        expect([name, source.includes(forbidden)]).toEqual([name, false]);
      }
    }
  });
});

describe("counter headroom keeps a lease mutable forever", () => {
  it("refuses a record whose counters leave no room for the kernel's own increments", () => {
    for (const field of ["epoch", "version", "serverWallDeadline", "monotonicObservation"]) {
      const record = { ...lease(), [field]: Number.MAX_SAFE_INTEGER };
      const authority = field === "epoch"
        ? proof({ epoch: Number.MAX_SAFE_INTEGER })
        : field === "version" ? proof({ expectedVersion: Number.MAX_SAFE_INTEGER }) : proof();
      const result = confirmRevoke(record, authority, "URGENT_REVOKE");
      expect([field, result.ok]).toEqual([field, false]);
      if (result.ok) return;
      expect([field, result.issues[0]?.code])
        .toEqual([field, "AUTHORITY_MALFORMED_INPUT"]);
    }
  });

  it("refuses to mutate a record sitting at the counter ceiling", () => {
    const record = lease({ epoch: MAX_AUTHORITY_COUNT, version: MAX_AUTHORITY_COUNT });
    const result = confirmRevoke(record, proof({
      epoch: MAX_AUTHORITY_COUNT, expectedVersion: MAX_AUTHORITY_COUNT,
    }), "URGENT_REVOKE");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("AUTHORITY_MALFORMED_INPUT");
    expect(result.securityRecord).toBeNull();
  });

  it("keeps the last accepted successor parseable rather than bricking the lease", () => {
    const ceiling = MAX_AUTHORITY_COUNT - 1;
    const result = confirmRevoke(
      lease({ epoch: ceiling, version: ceiling }),
      proof({ epoch: ceiling, expectedVersion: ceiling }),
      "URGENT_REVOKE",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.epoch).toBe(MAX_AUTHORITY_COUNT);
    expect(Number.isSafeInteger(result.value.lease.version)).toBe(true);
    // Still readable: a record that no longer parses could never be reconciled.
    const readBack = restartReconstruct([result.value.lease], {
      serverWallSeconds: 5_000, bootId: "boot-2", monotonicObservation: 1,
    });
    expect(readBack.ok).toBe(true);
  });

  it("refuses a renewal whose deadline would leave the safe range", () => {
    const result = fencedRenew(lease(), proof(), {
      serverWallSeconds: Number.MAX_SAFE_INTEGER, bootId: "boot-1", monotonicObservation: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("AUTHORITY_MALFORMED_INPUT");
  });
});

describe("exactly one successor epoch under concurrent revocation", () => {
  it("moves the epoch by exactly one and refuses the losing attempt", () => {
    const record = lease();
    const before = structuredClone(record);
    const first = confirmRevoke(record, proof(), "URGENT_REVOKE");
    const second = confirmRevoke(record, proof(), "GRAPH_REMOVE_OR_SUPERSESSION");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Both are pure computations of the SAME successor, never two successors.
    expect(first.value.lease.epoch).toBe(record.epoch + 1);
    expect(second.value.lease.epoch).toBe(record.epoch + 1);
    expect(record).toEqual(before);
    // Once either is committed, the other command can no longer apply.
    const losing = confirmRevoke(first.value.lease, proof(), "GRAPH_REMOVE_OR_SUPERSESSION");
    expect(losing.ok).toBe(false);
    if (losing.ok) return;
    expect(losing.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_SUPERSEDED_AUTHORITY"]);
  });

  it("does not freeze the caller's record when freezing its own result", () => {
    const record = { ...lease() };
    const result = confirmRevoke(record, proof(), "URGENT_REVOKE");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value.lease)).toBe(true);
    expect(Object.isFrozen(record)).toBe(false);
  });

  it("advances the record version on every accepted revocation", () => {
    const result = confirmRevoke(lease({ state: "DRAINING" }), proof(), "GOAL_CANCEL");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.version).toBe(8);
  });
});

describe("drain precedence is monotonic under any request order", () => {
  function seeded(seed: number): () => number {
    let state = seed | 0;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
  }

  it("never regresses the strongest reason and never removes a reason", () => {
    const seen = new Set<DrainReason>();
    for (const seed of [1, 7, 19, 23, 101]) {
      const next = seeded(seed);
      let current: DrainDisposition | null = null;
      for (let step = 0; step < 40; step += 1) {
        const reason = DRAIN_REASONS[next() % DRAIN_REASONS.length] as DrainReason;
        seen.add(reason);
        const result = applyDrainReason(current, reason);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        if (current !== null) {
          expect(DRAIN_REASON_RANKS[result.value.strongestReason])
            .toBeGreaterThanOrEqual(DRAIN_REASON_RANKS[current.strongestReason]);
          for (const previous of current.reasons) {
            expect(result.value.reasons).toContain(previous);
          }
        }
        expect(result.value.reasons).toContain(reason);
        expect(result.value.reasons).toContain(result.value.strongestReason);
        current = result.value;
      }
      expect(current?.reasons.length).toBeGreaterThan(1);
    }
    // Non-vacuity: the walk actually exercised the whole published vocabulary.
    expect([...seen].sort()).toEqual([...DRAIN_REASONS].sort());
  });

  it("keeps the local vocabularies string-identical to the contract registry", () => {
    expect([...LEASE_STATES]).toEqual(["ACTIVE", "SUSPECT", "DRAINING", "RELEASED", "REVOKED"]);
    expect([...DRAIN_REASONS]).toEqual([
      "URGENT_REVOKE", "GRAPH_REMOVE_OR_SUPERSESSION", "GOAL_CANCEL", "WORK_CANCEL",
      "DEPENDENCY_INVALIDATED", "WORK_RELEASE_OR_PAUSE", "SUBMISSION_FINALIZE",
    ]);
    expect(Object.values(DRAIN_REASON_RANKS).sort((a, b) => b - a))
      .toEqual([70, 60, 50, 40, 30, 20, 10]);
  });
});
