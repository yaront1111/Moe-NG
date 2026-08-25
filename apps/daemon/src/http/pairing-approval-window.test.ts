import { describe, expect, it } from "vitest";

import {
  PAIRING_APPROVAL_MAX_BODY_BYTES,
} from "./pairing-approval-handshake.js";
import {
  PAIRING_APPROVAL_COLLISION_ATTEMPTS,
  PAIRING_APPROVAL_LAYER,
  PAIRING_APPROVAL_MAX_LIVE_REQUESTS,
  PAIRING_APPROVAL_REFUSAL_CODES,
  PAIRING_APPROVAL_TTL_MS,
  createPairingApprovalWindow,
} from "./pairing-approval-window.js";
const REQUEST_KEYS = ["create", "reserve"] as const;
const OPERATOR_KEYS = ["approve"] as const;
const HOSTILE_REQUEST_IDS: readonly unknown[] = [
  null, Symbol("request"), "", "a".repeat(63), "A".repeat(64), "../pair", "a".repeat(1_025),
];
const HOSTILE_LABELS: readonly unknown[] = [
  null, Symbol("label"), "", "abcd-ef01", "ABCD-EF01-2345", "../approval", "a".repeat(1_025),
];
type EntropyFailureCase = readonly [string, (size: number) => Uint8Array];
const ENTROPY_FAILURE_CASES: readonly EntropyFailureCase[] = Object.freeze([
  ["throws", (_size: number) => { throw new Error("rng unavailable"); }],
  ["returns the wrong length", (size: number) => new Uint8Array(Math.max(0, size - 1))],
]);
const COLLISION_AXES: readonly ("request id" | "confirmation label")[] =
  Object.freeze(["request id", "confirmation label"]);
const INVALID_CLOCK_CASES: readonly string[] =
  Object.freeze(["NaN", "Infinity", "negative", "throw"]);
function entropyFrom(values: readonly number[]): (size: number) => Uint8Array {
  let index = 0;
  return (size) => {
    const value = values[index];
    if (value === undefined) throw new Error("entropy fixture exhausted");
    index += 1;
    return new Uint8Array(size).fill(value);
  };
}

function sequenceEntropy(): (size: number) => Uint8Array {
  let value = 1;
  return (size) => {
    const bytes = new Uint8Array(size).fill(value);
    value = (value + 1) & 0xff;
    return bytes;
  };
}

function collidingEntropy(axis: "request id" | "confirmation label"): (size: number) => Uint8Array {
  let requestValue = 0x10;
  let labelValue = 0x20;
  return (size) => {
    const value = size === 32
      ? (axis === "request id" ? 0x11 : requestValue++)
      : (axis === "confirmation label" ? 0x22 : labelValue++);
    return new Uint8Array(size).fill(value);
  };
}

function createdRequest(window: ReturnType<typeof createPairingApprovalWindow>) {
  const created = window.requests.create();
  if (!created.ok) throw new Error(`request creation refused: ${created.code}`);
  return created;
}

function expectRefusal(actual: unknown, code: string): void {
  expect(actual).toEqual({ code, layer: PAIRING_APPROVAL_LAYER, ok: false });
  expect(typeof actual).toBe("object");
  expect(Object.isFrozen(actual as object)).toBe(true);
}

describe("pairing approval public contract", () => {
  it("pins the bounded constants and closed refusal roster", () => {
    expect(PAIRING_APPROVAL_LAYER).toBe("CONTROL_ROOM_PAIRING_APPROVAL");
    expect(PAIRING_APPROVAL_TTL_MS).toBe(60_000);
    expect(PAIRING_APPROVAL_MAX_LIVE_REQUESTS).toBe(8);
    expect(PAIRING_APPROVAL_COLLISION_ATTEMPTS).toBe(4);
    expect(PAIRING_APPROVAL_MAX_BODY_BYTES).toBe(96);
    expect(PAIRING_APPROVAL_REFUSAL_CODES).toEqual([
      "PAIRING_APPROVAL_CAPACITY_EXHAUSTED",
      "PAIRING_APPROVAL_CLOCK_UNAVAILABLE",
      "PAIRING_APPROVAL_ENTROPY_UNAVAILABLE",
      "PAIRING_APPROVAL_IDENTITY_EXHAUSTED",
      "PAIRING_APPROVAL_REQUIRED",
      "PAIRING_APPROVAL_UNAVAILABLE",
      "PAIRING_CLAIM_REQUEST_INVALID",
      "PAIRING_CONFIRMATION_INVALID",
      "PAIRING_CONFIRMATION_UNKNOWN",
      "PAIRING_CREATE_REQUEST_INVALID",
      "PAIRING_REQUEST_ALREADY_CLAIMED",
      "PAIRING_REQUEST_BUSY",
      "PAIRING_REQUEST_EXPIRED",
      "PAIRING_REQUEST_INVALID",
      "PAIRING_REQUEST_UNKNOWN",
      "PAIRING_SESSION_MINT_FAILED",
      "PAIRING_SESSION_MINT_OUTCOME_UNKNOWN",
    ]);
    expect(Object.isFrozen(PAIRING_APPROVAL_REFUSAL_CODES)).toBe(true);
  });

  it("separates and freezes requester and operator capabilities", () => {
    const window = createPairingApprovalWindow({ now: () => 100, randomBytes: sequenceEntropy() });

    expect(REQUEST_KEYS.length).toBeGreaterThan(0);
    expect(OPERATOR_KEYS.length).toBeGreaterThan(0);
    expect(Object.keys(window).sort()).toEqual(["close", "operator", "requests"]);
    expect(Object.keys(window.requests).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(Object.keys(window.operator).sort()).toEqual([...OPERATOR_KEYS].sort());
    expect(Object.isFrozen(window)).toBe(true);
    expect(Object.isFrozen(window.requests)).toBe(true);
    expect(Object.isFrozen(window.operator)).toBe(true);
    expect(window.requests).not.toHaveProperty("approve");
    expect(window.operator).not.toHaveProperty("create");
    expect(window.operator).not.toHaveProperty("reserve");
    expect(Reflect.set(window.requests, "approve", () => true)).toBe(false);
    expect(Object.keys(window.requests).sort()).toEqual([...REQUEST_KEYS].sort());
  });

  it("creates frozen non-authoritative identifiers in the exact formats", () => {
    const window = createPairingApprovalWindow({
      now: () => 100,
      randomBytes: entropyFrom([0xab, 0xcd]),
    });
    const created = createdRequest(window);

    expect(created.requestId).toMatch(/^[0-9a-f]{64}$/);
    expect(created.confirmationLabel).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){2}$/);
    expect(created.requestId).toBe("ab".repeat(32));
    expect(created.confirmationLabel).toBe("cdcd-cdcd-cdcd");
    expect(Object.keys(created).sort()).toEqual(["confirmationLabel", "ok", "requestId"]);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Reflect.set(created, "requestId", "00".repeat(32))).toBe(false);
    expect(created.requestId).toBe("ab".repeat(32));
  });
});

describe("pairing approval lifecycle", () => {
  it("synchronously revokes every requester and operator capability on close", () => {
    const window = createPairingApprovalWindow({ now: () => 100, randomBytes: sequenceEntropy() });
    const created = createdRequest(window);
    expect(window.operator.approve(created.confirmationLabel).ok).toBe(true);

    window.close();
    window.close();
    expectRefusal(window.requests.create(), "PAIRING_APPROVAL_UNAVAILABLE");
    expectRefusal(window.requests.reserve(created.requestId), "PAIRING_APPROVAL_UNAVAILABLE");
    expectRefusal(window.operator.approve(created.confirmationLabel), "PAIRING_APPROVAL_UNAVAILABLE");
  });
});

describe("pairing approval transitions", () => {
  it("keeps one pending request closed while approving only the matching label", () => {
    const window = createPairingApprovalWindow({ now: () => 100, randomBytes: sequenceEntropy() });
    const first = createdRequest(window);
    const second = createdRequest(window);

    expectRefusal(window.requests.reserve(first.requestId), "PAIRING_APPROVAL_REQUIRED");
    const approved = window.operator.approve(first.confirmationLabel);
    expect(approved).toEqual({ ok: true, state: "APPROVED" });
    expect(Object.isFrozen(approved)).toBe(true);
    expectRefusal(window.requests.reserve(second.requestId), "PAIRING_APPROVAL_REQUIRED");

    const reserved = window.requests.reserve(first.requestId);
    if (!reserved.ok) throw new Error(`approved request refused: ${reserved.code}`);
    expect(reserved.state).toBe("CLAIMING");
    expect(Object.isFrozen(reserved)).toBe(true);
    expect(Object.isFrozen(reserved.reservation)).toBe(true);
    expectRefusal(window.requests.reserve(first.requestId), "PAIRING_REQUEST_BUSY");
  });

  it("releases only the same reservation and commits the request exactly once", () => {
    const window = createPairingApprovalWindow({ now: () => 100, randomBytes: sequenceEntropy() });
    const created = createdRequest(window);
    expect(window.operator.approve(created.confirmationLabel).ok).toBe(true);

    const first = window.requests.reserve(created.requestId);
    if (!first.ok) throw new Error(`first reserve refused: ${first.code}`);
    first.reservation.release();
    first.reservation.release();
    const second = window.requests.reserve(created.requestId);
    if (!second.ok) throw new Error(`second reserve refused: ${second.code}`);
    first.reservation.commit();
    second.reservation.release();
    const final = window.requests.reserve(created.requestId);
    if (!final.ok) throw new Error(`final reserve refused: ${final.code}`);
    final.reservation.commit();
    final.reservation.commit();
    final.reservation.release();

    expectRefusal(window.requests.reserve(created.requestId), "PAIRING_REQUEST_ALREADY_CLAIMED");
    expectRefusal(window.operator.approve(created.confirmationLabel), "PAIRING_REQUEST_ALREADY_CLAIMED");
  });
});

describe("pairing approval input and dependency failures", () => {
  it("pins every generated failure roster to a positive denominator", () => {
    expect(ENTROPY_FAILURE_CASES).toHaveLength(2); expect(ENTROPY_FAILURE_CASES.length).toBeGreaterThan(0);
    expect(COLLISION_AXES).toHaveLength(2); expect(COLLISION_AXES.length).toBeGreaterThan(0);
    expect(INVALID_CLOCK_CASES).toHaveLength(4); expect(INVALID_CLOCK_CASES.length).toBeGreaterThan(0);
  });

  it("refuses every malformed request id and confirmation label exactly", () => {
    const window = createPairingApprovalWindow({ now: () => 100, randomBytes: sequenceEntropy() });

    expect(HOSTILE_REQUEST_IDS.length).toBeGreaterThan(0);
    expect(HOSTILE_LABELS.length).toBeGreaterThan(0);
    for (const requestId of HOSTILE_REQUEST_IDS) {
      expectRefusal(window.requests.reserve(requestId as string), "PAIRING_REQUEST_INVALID");
    }
    for (const label of HOSTILE_LABELS) {
      expectRefusal(window.operator.approve(label as string), "PAIRING_CONFIRMATION_INVALID");
    }
  });

  it("distinguishes well-formed unknown request and label identities", () => {
    const window = createPairingApprovalWindow({ now: () => 100, randomBytes: sequenceEntropy() });

    expectRefusal(window.requests.reserve("ab".repeat(32)), "PAIRING_REQUEST_UNKNOWN");
    expectRefusal(window.operator.approve("abcd-ef01-2345"), "PAIRING_CONFIRMATION_UNKNOWN");
  });

  it.each(ENTROPY_FAILURE_CASES)("fails closed when entropy %s", (_name, randomBytes) => {
    const window = createPairingApprovalWindow({ now: () => 100, randomBytes });
    expectRefusal(window.requests.create(), "PAIRING_APPROVAL_ENTROPY_UNAVAILABLE");
  });

  it.each(COLLISION_AXES)(
    "bounds %s collision retries",
    (axis) => {
      const window = createPairingApprovalWindow({
        now: () => 100, randomBytes: collidingEntropy(axis),
      });
      createdRequest(window);

      expectRefusal(window.requests.create(), "PAIRING_APPROVAL_IDENTITY_EXHAUSTED");
    },
  );
});

describe("pairing approval bounds and monotonic expiry", () => {
  it("caps live requests at eight and reclaims capacity only after expiry", () => {
    let now = 100;
    const window = createPairingApprovalWindow({ now: () => now, randomBytes: sequenceEntropy() });
    const requests = Array.from(
      { length: PAIRING_APPROVAL_MAX_LIVE_REQUESTS },
      () => createdRequest(window),
    );

    expect(requests).toHaveLength(8);
    expectRefusal(window.requests.create(), "PAIRING_APPROVAL_CAPACITY_EXHAUSTED");
    now += PAIRING_APPROVAL_TTL_MS;
    expectRefusal(window.requests.reserve(requests[0]!.requestId), "PAIRING_REQUEST_EXPIRED");
    expect(window.requests.create().ok).toBe(true);
  });

  it("expires at the exclusive deadline but remains claimable one tick before", () => {
    let now = 1_000;
    const window = createPairingApprovalWindow({ now: () => now, randomBytes: sequenceEntropy() });
    const created = createdRequest(window);
    expect(window.operator.approve(created.confirmationLabel).ok).toBe(true);

    now += PAIRING_APPROVAL_TTL_MS - 1;
    const reserved = window.requests.reserve(created.requestId);
    if (!reserved.ok) throw new Error(`pre-deadline reserve refused: ${reserved.code}`);
    reserved.reservation.release();
    now += 1;
    expectRefusal(window.requests.reserve(created.requestId), "PAIRING_REQUEST_EXPIRED");
    expectRefusal(window.operator.approve(created.confirmationLabel), "PAIRING_REQUEST_EXPIRED");
  });

  it("latches a backward clock and never revives the request", () => {
    let now = 100;
    const window = createPairingApprovalWindow({ now: () => now, randomBytes: sequenceEntropy() });
    const created = createdRequest(window);
    now = 99;
    expectRefusal(window.requests.reserve(created.requestId), "PAIRING_APPROVAL_CLOCK_UNAVAILABLE");
    now = 101;
    expectRefusal(window.operator.approve(created.confirmationLabel), "PAIRING_APPROVAL_CLOCK_UNAVAILABLE");
  });

  it.each(INVALID_CLOCK_CASES)(
    "latches an invalid or throwing %s clock",
    (kind) => {
      let first = true;
      const now = (): number => {
        if (!first) return 100;
        first = false;
        if (kind === "throw") throw new Error("clock unavailable");
        if (kind === "Infinity") return Number.POSITIVE_INFINITY;
        if (kind === "negative") return -1;
        return Number.NaN;
      };
      const window = createPairingApprovalWindow({ now, randomBytes: sequenceEntropy() });

      expectRefusal(window.requests.create(), "PAIRING_APPROVAL_CLOCK_UNAVAILABLE");
      expectRefusal(window.requests.create(), "PAIRING_APPROVAL_CLOCK_UNAVAILABLE");
    },
  );
});
