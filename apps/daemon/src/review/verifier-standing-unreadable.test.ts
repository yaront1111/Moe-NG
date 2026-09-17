import { describe, expect, it } from "vitest";

import type { SqliteEventStore } from "@moe/store";

import { readVerifierStandingAuthority } from "./verifier-authority-provider.js";

/**
 * "I COULD NOT READ THE SLICES" IS NOT "THE SEED NEVER INSTALLED THEM".
 *
 * This reader exists for one purpose, stated in its own doc comment: a project whose seed never
 * installed the two standing slices sits with every delivered node "awaiting verification"
 * forever, and the board must name that cause. Its catch then answered
 * `{calibration: false, policy: false}` — byte for byte the shape that means NOT INSTALLED.
 *
 * So a store fault made the board tell the operator to install slices that are already there.
 * They install them again, the write succeeds, the stall persists, because the READ is what is
 * failing. `health-read` published the same pair under outcome HEALTH, and its own
 * HEALTH_READ_UNREADABLE could never fire for this read because the inner catch swallowed the
 * throw first.
 */

const STORE_FAULT = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

const unreadableStore = (): SqliteEventStore => ({
  readEvents: (): never => { throw STORE_FAULT; },
  readEventsByTypeAfter: (): never => { throw STORE_FAULT; },
}) as unknown as SqliteEventStore;

const emptyStore = (): SqliteEventStore => ({
  getAggregateVersion: () => 0,
  readCommandDecisionCacheVersion: () => 1,
  readCommandDecisionsAfter: () => ({ items: [], nextCursor: null }),
  readEventHorizon: () => 0n,
  readEvents: () => [],
  readEventsAfter: () => ({ items: [], nextCursor: null }),
  readEventsByTypeAfter: () => ({ items: [], nextCursor: null }),
}) as unknown as SqliteEventStore;

describe("readVerifierStandingAuthority", () => {
  it("says it could not read, instead of reporting both slices as absent", () => {
    const standing = readVerifierStandingAuthority(unreadableStore(), "project-1");

    expect(standing.readable).toBe(false);
  });

  it("still reports an unseeded project as readable with both slices absent", () => {
    const standing = readVerifierStandingAuthority(emptyStore(), "project-1");

    expect(standing.readable).toBe(true);
    expect(standing.calibration).toBe(false);
    expect(standing.policy).toBe(false);
  });

  it("confers no authority when unreadable, exactly as the absent answer confers none", () => {
    const standing = readVerifierStandingAuthority(unreadableStore(), "project-1");

    expect(standing.calibration).toBe(false);
    expect(standing.policy).toBe(false);
  });
});
