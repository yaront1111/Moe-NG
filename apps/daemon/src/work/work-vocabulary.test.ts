import { describe, expect, it } from "vitest";

import { claimWork } from "./work-claim.js";
import { parseWorkRequest } from "./work-ingress.js";
import { WORK_ERROR_CODES, WORK_LAYERS, WORK_LEGS } from "./work-kernel.js";
import { applyWorkLifecycle } from "./work-lifecycle.js";
import type { WorkResult } from "./work-kernel.js";

/**
 * The closed-vocabulary sweep.
 *
 * Every code in WORK_ERROR_CODES must be reachable from a REAL production
 * surface, and the observed set must equal the declared set. Set equality in
 * both directions is the point: a subset check would let dead vocabulary
 * accumulate, and a superset check would let an undeclared code leak out.
 */
const DIGEST = "c".repeat(64);
const encoder = new TextEncoder();

const LEASE = {
  authorityHashRef: DIGEST,
  bootId: "boot-1",
  epoch: 5,
  kind: "ASSIGNMENT",
  leaseId: "lease-v",
  leaseToken: "token-v",
  monotonicObservation: 900,
  ownerSessionRef: "session-v",
  serverWallDeadline: 2_000,
  state: "ACTIVE",
  version: 11,
} as const;

const PROOF = {
  authorityHashRef: DIGEST,
  epoch: 5,
  expectedVersion: 11,
  leaseToken: "token-v",
  ownerSessionRef: "session-v",
} as const;

const INTENT = {
  aggregateId: "agg-v",
  desiredState: "ACTIVE",
  expectedGraphEpoch: 2,
  idempotencyKey: "idem-v",
  inputBinding: DIGEST,
  intentId: "intent-v",
  leaseBinding: LEASE,
  predecessorCursor: "cursor-v",
  protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST,
  state: "PENDING",
  version: 0,
} as const;

const CLAIM_PAYLOAD = {
  budget: {
    admission: {
      admissionRef: "adm-v",
      amounts: [
        { meter: "usd", purpose: "EXECUTION", quantity: 10 },
        { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
        { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
        { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
        { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
      ],
      expectedVersion: 2,
    },
    gate: { allowance: { decisionRef: "dec-v", outcome: "ALLOW" }, approval: null },
    view: {
      accountId: "acct-v",
      meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
      state: "OPEN",
      version: 2,
    },
  },
  effect: { command: { kind: "claim" }, intent: INTENT },
  lease: { proof: PROOF, record: LEASE },
  liveClaims: [] as unknown[],
  slot: {
    dimension: "default",
    requestId: "req-v",
    rows: [
      {
        capacityUnits: 1,
        effectIntentRef: "intent-ref-v",
        epoch: 1,
        external: false,
        fenceable: true,
        resourceId: "res-v",
        state: "ACTIVE",
      },
    ],
    slotRef: "slot-v",
  },
};

type Payload = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function claimWith(mutate: (payload: Payload) => void): WorkResult {
  const payload = clone(CLAIM_PAYLOAD) as unknown as Payload;
  mutate(payload);
  return claimWork(payload);
}

function lifecycleWith(command: string, mutate: (payload: Payload) => void = () => {}): WorkResult {
  const payload = clone({
    effect: { intent: INTENT },
    lease: { proof: PROOF, record: LEASE },
  }) as unknown as Payload;
  mutate(payload);
  return applyWorkLifecycle(command, payload);
}

function at(root: Payload, ...path: readonly string[]): Payload {
  let node: unknown = root;
  for (const key of path) {
    if (typeof node !== "object" || node === null) throw new Error("bad fixture path");
    node = (node as Payload)[key];
  }
  if (typeof node !== "object" || node === null) throw new Error("bad fixture path");
  return node as Payload;
}

/** One producer per declared code, each exercising a real entry point. */
const PRODUCERS: Readonly<Record<string, () => WorkResult>> = {
  WORK_AUTHORITY_SUPERSEDED: () =>
    claimWith((p) => {
      at(p, "lease", "proof")["epoch"] = 4;
      at(p, "lease", "record")["state"] = "REVOKED";
    }),
  WORK_BUDGET_REFUSED: () =>
    claimWith((p) => {
      at(p, "budget", "admission")["expectedVersion"] = 1;
    }),
  WORK_INTENT_REFUSED: () =>
    claimWith((p) => {
      at(p, "effect", "intent")["state"] = "SUCCEEDED";
    }),
  WORK_LEASE_NOT_CURRENT: () =>
    lifecycleWith("renew", (p) => {
      at(p, "lease", "record")["version"] = 12;
    }),
  WORK_PAYLOAD_MALFORMED: () => claimWork(null),
  WORK_REQUEST_INVALID: () => {
    const parsed = parseWorkRequest(encoder.encode(JSON.stringify({ nope: true })));
    if (parsed.ok) throw new Error("expected an ingress refusal");
    return parsed.result;
  },
  WORK_SLOT_EXHAUSTED: () =>
    claimWith((p) => {
      p["liveClaims"] = Array.from({ length: 4 }, (_unused, index) => ({
        dimension: "default",
        slotRef: `held-${index}`,
        state: "RESERVED",
      }));
    }),
  WORK_SLOT_RESOURCE_INACTIVE: () =>
    claimWith((p) => {
      at(p, "slot", "rows", "0")["state"] = "PENDING_ACQUIRE";
    }),
  WORK_STALE_EPOCH: () =>
    lifecycleWith("renew", (p) => {
      at(p, "lease", "proof")["epoch"] = 4;
    }),
  WORK_STALE_TOKEN: () =>
    lifecycleWith("renew", (p) => {
      at(p, "lease", "proof")["leaseToken"] = "token-stale";
    }),
  /** Design 13.1: an ACTIVE effect must drain, so cancel is a state conflict. */
  WORK_STATE_CONFLICT: () =>
    lifecycleWith("cancel", (p) => {
      at(p, "effect", "intent")["state"] = "ACTIVE";
    }),
};

describe("work vocabulary — the closed reason set is exactly reachable", () => {
  it("declares a producer for every code, with no producer left over", () => {
    expect([...Object.keys(PRODUCERS)].sort()).toStrictEqual([...WORK_ERROR_CODES].sort());
  });

  it("observes every declared code from a real production surface", () => {
    const observed = new Set<string>();
    for (const [expected, produce] of Object.entries(PRODUCERS)) {
      const result = produce();
      if (result.ok !== false || !("failure" in result)) {
        throw new Error(`producer for ${expected} did not refuse`);
      }
      expect(result.failure.code).toBe(expected);
      observed.add(result.failure.code);
    }
    // Both directions: no unreachable code, no undeclared code.
    expect([...observed].sort()).toStrictEqual([...WORK_ERROR_CODES].sort());
    expect(observed.size).toBe(WORK_ERROR_CODES.length);
  });

  it("keeps the declared vocabularies frozen and duplicate-free", () => {
    for (const vocabulary of [WORK_ERROR_CODES, WORK_LAYERS, WORK_LEGS]) {
      expect(Object.isFrozen(vocabulary)).toBe(true);
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });

  it("names a declared layer and a declared leg on every refusal", () => {
    for (const produce of Object.values(PRODUCERS)) {
      const result = produce();
      if (result.ok !== false || !("failure" in result)) throw new Error("expected a refusal");
      expect(WORK_LAYERS as readonly string[]).toContain(result.failure.layer);
      if (result.failure.leg !== null) {
        expect(WORK_LEGS as readonly string[]).toContain(result.failure.leg);
      }
    }
  });
});
