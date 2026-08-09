/**
 * The tamper alphabet for the seeded work schedule.
 *
 * Each arm corrupts exactly one thing, so a refusal names the leg that caught
 * it rather than a fixture that was broken several ways at once. Nothing here
 * asserts; the expectations live in `work-race-orderings.test.ts`.
 */

export type Payload = Record<string, unknown>;

export interface Tamper {
  readonly name: string;
  readonly mutate: (payload: Payload) => void;
  /**
   * Only `work.claim` reads the slot, budget and live-claim sections, so an arm
   * that corrupts one of them is a no-op for every other command. Drawing them
   * uniformly across the whole alphabet dilutes the claim legs six-fold and
   * leaves `WORK_SLOT_EXHAUSTED` and `WORK_BUDGET_REFUSED` to seed luck; the
   * schedule stratifies instead, the way the runner harness stratifies its
   * drain and restart pools.
   */
  readonly claimOnly?: true;
}

function lease(payload: Payload): Record<string, unknown> {
  return payload["lease"] as Record<string, unknown>;
}

function proofOf(payload: Payload): Record<string, unknown> {
  return lease(payload)["proof"] as Record<string, unknown>;
}

function part(payload: Payload, key: string, section: string): Record<string, unknown> {
  return (payload[key] as Record<string, unknown>)[section] as Record<string, unknown>;
}

function heldClaim(index: number): Record<string, unknown> {
  return { dimension: "default", slotRef: `slot-${String(index)}`, state: "RESERVED" };
}

export const RACE_TAMPERS: readonly Tamper[] = Object.freeze([
  { mutate: () => undefined, name: "honest" },
  {
    mutate: (p) => {
      proofOf(p)["leaseToken"] = "token-stale";
    },
    name: "staleToken",
  },
  {
    mutate: (p) => {
      const proof = proofOf(p);
      proof["epoch"] = (proof["epoch"] as number) + 1;
    },
    name: "staleEpoch",
  },
  {
    mutate: (p) => {
      const record = lease(p)["record"] as Record<string, unknown>;
      record["state"] = "REVOKED";
      proofOf(p)["epoch"] = (record["epoch"] as number) - 1;
    },
    name: "supersededEpoch",
  },
  {
    mutate: (p) => {
      proofOf(p)["ownerSessionRef"] = "session-2";
    },
    name: "wrongSession",
  },
  {
    mutate: (p) => {
      const proof = proofOf(p);
      proof["expectedVersion"] = (proof["expectedVersion"] as number) + 1;
    },
    name: "staleVersion",
  },
  {
    mutate: (p) => {
      lease(p)["record"] = { nonsense: true };
    },
    name: "malformedRecord",
  },
  {
    mutate: (p) => {
      delete p["lease"];
    },
    name: "dropLease",
  },
  {
    claimOnly: true,
    mutate: (p) => {
      p["liveClaims"] = [heldClaim(1), heldClaim(2), heldClaim(3), heldClaim(4)];
    },
    name: "slotCeilingHeld",
  },
  {
    claimOnly: true,
    mutate: (p) => {
      p["liveClaims"] = [5];
    },
    name: "unreadableClaimTable",
  },
  {
    claimOnly: true,
    mutate: (p) => {
      const rows = (p["slot"] as Record<string, unknown>)["rows"] as Record<string, unknown>[];
      const row = rows[0];
      if (row !== undefined) row["state"] = "PENDING_ACQUIRE";
    },
    name: "inactiveResource",
  },
  {
    claimOnly: true,
    mutate: (p) => {
      part(p, "budget", "admission")["expectedVersion"] = 1;
    },
    name: "staleBudgetVersion",
  },
  {
    mutate: (p) => {
      part(p, "effect", "intent")["state"] = "SUCCEEDED";
    },
    name: "terminalIntent",
  },
]);
