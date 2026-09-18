import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AffordancePort, AffordanceSurfaceResult, ChainStep } from "../http/affordance-contract.js";
import { createClaimRenewal, renewalCadenceMs } from "./agent-claim-renewal.js";
import type { ClaimRenewalOutcome } from "./agent-claim-renewal.js";

/**
 * The renewal in isolation: a stub surface whose claim the test moves, a recording dispatch, a
 * mutable clock and fake timers. The durable arms (a real store, the real claim ledger, the real
 * exit path) live in `agent-wrapper.test.ts`; these pin the DECISIONS — cadence, the clock as
 * the authority, the named no-ops, the once-per-code log, and that nothing here can ever
 * dispatch `work.claim`.
 */

const ITEM = "review.submit@node-renew";
const SEAT = "sess-wrap-renew";
const SECRET = "seat-secret";
const TTL = 60_000;
const CADENCE = renewalCadenceMs(TTL);
const START = 1_700_000_000_000;

interface Dispatched {
  readonly credential: string;
  readonly expectedVersion: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly target: string;
  readonly commandId: string | undefined;
}

function harness(overrides: {
  answer?: (call: Dispatched) => ClaimRenewalOutcome;
  surface?: () => AffordanceSurfaceResult;
} = {}) {
  let now = START;
  let version = 3;
  let claim: ChainStep["claim"] = { claimedBy: SEAT, expiresAt: new Date(START + TTL).toISOString(), version };
  const calls: Dispatched[] = [];
  const lines: string[] = [];
  const step = (): ChainStep => ({
    aggregateId: "node-renew", claim, claimAggregateVersion: version, kind: "review.submit",
    missing: [], status: "READY", version: 1,
  });
  const surface: AffordancePort = {
    boundProjectId: "proj",
    readSurface: overrides.surface ?? (() => ({
      nextAllowedCommands: [], outcome: "SURFACE", planningAuthorityByRun: {},
      planningGoalRef: null, planningGoalRefs: {}, steps: [step()],
    })),
  };
  const renewal = createClaimRenewal({
    affordances: surface,
    claimTtlMs: TTL,
    clock: () => now,
    dispatch: (credential, kind, payload, target, expectedVersion, commandId) => {
      const call = { commandId, credential, expectedVersion, kind, payload, target };
      calls.push(call);
      if (overrides.answer !== undefined) return overrides.answer(call);
      // The real service: a committed renew bumps the aggregate and moves the horizon.
      version += 1;
      claim = { claimedBy: SEAT, expiresAt: String(payload["expiresAt"]), version };
      return { code: "EFFECTS_COMMITTED", ok: true };
    },
    log: (line) => { lines.push(line); },
    secret: SECRET,
    sessionId: SEAT,
    workItemId: ITEM,
  });
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  return {
    advance, calls, lines, renewal,
    release: (): void => { claim = null; version += 1; },
    stealClaim: (): void => { claim = { claimedBy: "sess-other", expiresAt: "2099-01-01T00:00:00.000Z", version }; },
  };
}

describe("createClaimRenewal", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("renews every third of the TTL, starting after the first third, under the seat's own bearer", async () => {
    const h = harness();
    h.renewal.start();
    await h.advance(CADENCE - 1);
    expect(h.calls).toHaveLength(0);

    await h.advance(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      credential: SECRET, expectedVersion: 3, kind: "work.renew",
      payload: { expiresAt: new Date(START + CADENCE + TTL).toISOString(), workItemId: ITEM },
      target: `work/${ITEM}`,
    });
    expect(h.calls[0]?.commandId).toMatch(/^wrap-[0-9a-f]{32}$/u);

    await h.advance(CADENCE);
    await h.advance(CADENCE);
    expect(h.calls).toHaveLength(3);
    // Each renewal reads the CURRENT version off the surface and mints a LATER horizon.
    expect(h.calls.map((call) => call.expectedVersion)).toEqual([3, 4, 5]);
    expect(h.calls.map((call) => call.payload["expiresAt"])).toEqual([
      new Date(START + CADENCE + TTL).toISOString(),
      new Date(START + 2 * CADENCE + TTL).toISOString(),
      new Date(START + 3 * CADENCE + TTL).toISOString(),
    ]);
    // Distinct command ids per attempt: a replayed id would be answered from the earlier decision.
    expect(new Set(h.calls.map((call) => call.commandId)).size).toBe(3);
    expect(h.renewal.renewed()).toBe(3);
    expect(h.lines).toEqual([]);
    h.renewal.stop();
  });

  it("stops renewing the instant it is told the seat exited, and a start after stop is a no-op", async () => {
    const h = harness();
    h.renewal.start();
    await h.advance(CADENCE);
    expect(h.calls).toHaveLength(1);

    h.renewal.stop();
    await h.advance(10 * CADENCE);
    expect(h.calls).toHaveLength(1);

    // The exit handler can run before the staffing report reaches its caller.
    h.renewal.start();
    await h.advance(10 * CADENCE);
    expect(h.calls).toHaveLength(1);
  });

  it("treats the timer as a wake-up and the clock as the authority", async () => {
    const h = harness();
    h.renewal.start();
    // The timer fires but the clock has not moved: nothing is due, nothing is dispatched.
    await vi.advanceTimersByTimeAsync(5 * CADENCE);
    expect(h.calls).toHaveLength(0);
    // The clock jumps past the due instant, then the timer fires once: exactly one renewal.
    await h.advance(CADENCE);
    expect(h.calls).toHaveLength(1);
    h.renewal.stop();
  });

  it("logs a refused renew ONCE per code with the authority's detail and keeps ticking", async () => {
    const h = harness({
      answer: () => ({
        code: "WORK_CLAIM_NOT_CLAIMANT", ok: false,
        detail: `work.renew: "${ITEM}" is held by sess-other until 2099-01-01T00:00:00.000Z, not by ${SEAT}; only the holder renews its own claim`,
      }),
    });
    h.renewal.start();
    await h.advance(CADENCE);
    await h.advance(CADENCE);
    await h.advance(CADENCE);
    expect(h.calls).toHaveLength(3);
    expect(h.renewal.renewed()).toBe(0);
    expect(h.lines).toEqual([
      `[wrapper] ${ITEM} claim renew refused WORK_CLAIM_NOT_CLAIMANT: work.renew: "${ITEM}" is held by `
      + `sess-other until 2099-01-01T00:00:00.000Z, not by ${SEAT}; only the holder renews its own claim`,
    ]);
    h.renewal.stop();
  });

  it("names a refusal without detail by its code alone, and a throwing dispatch by its own name", async () => {
    let throwing = false;
    const h = harness({
      answer: () => {
        if (throwing) throw new Error("socket closed");
        return { code: "EXPECTED_VERSION_CONFLICT", ok: true };
      },
    });
    h.renewal.start();
    await h.advance(CADENCE);
    throwing = true;
    await h.advance(CADENCE);
    await h.advance(CADENCE);
    expect(h.lines).toEqual([
      `[wrapper] ${ITEM} claim renew refused EXPECTED_VERSION_CONFLICT: EXPECTED_VERSION_CONFLICT`,
      `[wrapper] ${ITEM} claim renew refused COMMAND_DISPATCH_FAILED: the renew dispatch threw; the next tick tries again`,
    ]);
    expect(h.calls).toHaveLength(3);
    h.renewal.stop();
  });

  it("is a NAMED no-op on a released claim: nothing dispatched, never a work.claim", async () => {
    const h = harness();
    h.renewal.start();
    await h.advance(CADENCE);
    expect(h.calls).toHaveLength(1);

    // The seat released on its own at the end of its work.
    h.release();
    await h.advance(CADENCE);
    await h.advance(CADENCE);
    expect(h.calls).toHaveLength(1);
    expect(h.calls.map((call) => call.kind)).toEqual(["work.renew"]);
    expect(h.lines).toEqual([
      `[wrapper] ${ITEM} claim renew skipped CLAIM_NOT_HELD: no open claim on the item: the seat released it, or it expired`,
    ]);
    h.renewal.stop();
  });

  it("is a named no-op when another seat holds the item, when it is off the surface, and when the surface cannot be read", async () => {
    const held = harness();
    held.renewal.start();
    held.stealClaim();
    await held.advance(CADENCE);
    expect(held.calls).toHaveLength(0);
    expect(held.lines).toEqual([
      `[wrapper] ${ITEM} claim renew skipped CLAIM_HELD_BY_OTHER: the claim is held by sess-other, not this seat`,
    ]);
    held.renewal.stop();

    const gone = harness({
      surface: () => ({
        nextAllowedCommands: [], outcome: "SURFACE", planningAuthorityByRun: {},
        planningGoalRef: null, planningGoalRefs: {}, steps: [],
      }),
    });
    gone.renewal.start();
    await gone.advance(CADENCE);
    await gone.advance(CADENCE);
    expect(gone.calls).toHaveLength(0);
    expect(gone.lines).toEqual([
      `[wrapper] ${ITEM} claim renew skipped WORK_ITEM_NOT_VISIBLE: the item is off the offer surface `
      + "(an accepted submit moves it there); nothing to renew",
    ]);
    gone.renewal.stop();

    const unreadable = harness({ surface: () => { throw new Error("STORE_BUSY"); } });
    unreadable.renewal.start();
    await unreadable.advance(CADENCE);
    expect(unreadable.calls).toHaveLength(0);
    expect(unreadable.lines).toEqual([
      `[wrapper] ${ITEM} claim renew skipped SURFACE_READ_FAILED: the offer surface could not be read; the next tick reads again`,
    ]);
    unreadable.renewal.stop();

    const refused = harness({
      surface: () => ({ code: "AFFORDANCE_PROJECT_MISMATCH", detail: "x", layer: "AFFORDANCE_SURFACE", outcome: "REFUSED" }),
    });
    refused.renewal.start();
    await refused.advance(CADENCE);
    expect(refused.lines).toEqual([
      `[wrapper] ${ITEM} claim renew skipped AFFORDANCE_PROJECT_MISMATCH: the offer surface answered no surface; the next tick reads again`,
    ]);
    refused.renewal.stop();
  });

  it("derives the cadence as a third of the TTL, never below one millisecond", () => {
    expect(renewalCadenceMs(30 * 60 * 1000)).toBe(10 * 60 * 1000);
    expect(renewalCadenceMs(60_000)).toBe(20_000);
    expect(renewalCadenceMs(2)).toBe(1);
    expect(renewalCadenceMs(0)).toBe(1);
  });
});
