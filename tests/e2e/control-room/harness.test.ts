import { describe, expect, it } from "vitest";

import {
  CONTROL_ROOM_E2E_ERROR_CODES,
  withStaticControlRoom,
} from "./harness.js";
import type { StaticHarnessPorts } from "./harness.js";

/**
 * Node-lane tests for the static harness lifecycle. Deliberately named
 * `*.test.ts`, NOT `*.spec.ts`: the root vitest include is
 * `tests/**\/*.test.ts`, so this file runs inside the existing `pnpm test:e2e`
 * under Node, with no browser and no real process. The browser lane matches
 * `*.spec.ts` only, so the two lanes are disjoint by naming.
 *
 * Every case here drives INJECTED ports. Nothing in this file builds a bundle,
 * binds a port or launches a browser — a lifecycle test that needed a real
 * server could not assert the timeout path without actually waiting for it.
 *
 * Mirrors `tests/e2e/foundation/e2e-harness.ts`'s conventions — frozen code
 * tuple, cleanup in a finally, outcome naming WHICH cleanup failed — and
 * imports nothing from it: task rail 2 and that module's own header forbid it
 * standing in for a system under certification.
 */
const BASE_URL = "http://127.0.0.1:54321";

const ports = (overrides: Partial<StaticHarnessPorts> = {}): StaticHarnessPorts => ({
  buildBundle: () => Promise.resolve(true),
  now: () => 0,
  probe: () => Promise.resolve(true),
  startServer: () => Promise.resolve({ baseUrl: BASE_URL, stop: () => Promise.resolve() }),
  waitTick: () => Promise.resolve(),
  ...overrides,
});

/** A clock that advances one budget-worth per read, so a bounded wait terminates. */
const advancingClock = (stepMs: number) => {
  let ticks = 0;
  return () => {
    ticks += 1;
    return ticks * stepMs;
  };
};

describe("static control-room harness vocabulary", () => {
  it("publishes exactly four frozen codes, one per failure it can name", () => {
    expect([...CONTROL_ROOM_E2E_ERROR_CODES]).toEqual([
      "E2E_BUNDLE_BUILD_FAILED",
      "E2E_SERVER_BIND_FAILED",
      "E2E_READINESS_TIMEOUT",
      "E2E_CLEANUP_FAILED",
    ]);
    expect(Object.isFrozen(CONTROL_ROOM_E2E_ERROR_CODES)).toBe(true);
  });
});

describe("each lifecycle failure returns its OWN code", () => {
  it("refuses E2E_BUNDLE_BUILD_FAILED when the bundle cannot be built", async () => {
    let served = false;
    const outcome = await withStaticControlRoom(
      ports({
        buildBundle: () => Promise.resolve(false),
        startServer: () => {
          served = true;
          return Promise.resolve({ baseUrl: BASE_URL, stop: () => Promise.resolve() });
        },
      }),
      () => Promise.resolve("unreachable"),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("E2E_BUNDLE_BUILD_FAILED");
    // Ordering claim: a failed build never reaches the server.
    expect(served).toBe(false);
  });

  it("refuses E2E_SERVER_BIND_FAILED when the server cannot bind", async () => {
    let probed = false;
    const outcome = await withStaticControlRoom(
      ports({
        probe: () => {
          probed = true;
          return Promise.resolve(true);
        },
        startServer: () => Promise.resolve(null),
      }),
      () => Promise.resolve("unreachable"),
    );
    expect(outcome.ok === false && outcome.code).toBe("E2E_SERVER_BIND_FAILED");
    expect(probed).toBe(false);
  });

  it("refuses E2E_SERVER_BIND_FAILED when starting the server throws", async () => {
    const outcome = await withStaticControlRoom(
      ports({ startServer: () => Promise.reject(new Error("EADDRINUSE")) }),
      () => Promise.resolve("unreachable"),
    );
    expect(outcome.ok === false && outcome.code).toBe("E2E_SERVER_BIND_FAILED");
  });

  it("refuses E2E_READINESS_TIMEOUT rather than polling forever", async () => {
    let polls = 0;
    const outcome = await withStaticControlRoom(
      ports({
        now: advancingClock(1_000),
        probe: () => {
          polls += 1;
          return Promise.resolve(false);
        },
      }),
      () => Promise.resolve("unreachable"),
    );
    expect(outcome.ok === false && outcome.code).toBe("E2E_READINESS_TIMEOUT");
    // It really polled, and it really stopped. A wait that never polled would
    // satisfy the code assertion while proving nothing about readiness.
    expect(polls).toBeGreaterThan(0);
  });

  it("succeeds as soon as the probe answers, without waiting out the budget", async () => {
    let polls = 0;
    const outcome = await withStaticControlRoom(
      ports({
        now: advancingClock(1),
        probe: () => {
          polls += 1;
          return Promise.resolve(polls >= 3);
        },
      }),
      (baseUrl) => Promise.resolve(baseUrl),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.value).toBe(BASE_URL);
    expect(polls).toBe(3);
  });
});

describe("cleanup runs on every exit path", () => {
  it("stops the server when the body succeeds", async () => {
    let stopped = 0;
    const outcome = await withStaticControlRoom(
      ports({
        startServer: () =>
          Promise.resolve({
            baseUrl: BASE_URL,
            stop: () => {
              stopped += 1;
              return Promise.resolve();
            },
          }),
      }),
      () => Promise.resolve("done"),
    );
    expect(outcome.ok).toBe(true);
    expect(stopped).toBe(1);
  });

  it("stops the server when the body THROWS, and lets the failure propagate", async () => {
    let stopped = 0;
    const run = withStaticControlRoom(
      ports({
        startServer: () =>
          Promise.resolve({
            baseUrl: BASE_URL,
            stop: () => {
              stopped += 1;
              return Promise.resolve();
            },
          }),
      }),
      () => Promise.reject(new Error("assertion failed")),
    );
    // The journey's own failure is NOT laundered into a harness reason code —
    // a smoke assertion that failed must fail the run as itself. But the server
    // still comes down: on Windows a surviving child holds file handles and
    // resurfaces later as EBUSY rather than as the assertion that failed.
    await expect(run).rejects.toThrow("assertion failed");
    expect(stopped).toBe(1);
  });

  it("names WHICH cleanup failed under E2E_CLEANUP_FAILED", async () => {
    const outcome = await withStaticControlRoom(
      ports({
        startServer: () =>
          Promise.resolve({
            baseUrl: BASE_URL,
            stop: () => Promise.reject(new Error("stop failed")),
          }),
      }),
      () => Promise.resolve("done"),
    );
    expect(outcome.ok === false && outcome.code).toBe("E2E_CLEANUP_FAILED");
    expect(outcome.ok === false && outcome.failures).toEqual(["server"]);
  });

  it("keeps the body's failure code when cleanup ALSO fails", async () => {
    const outcome = await withStaticControlRoom(
      ports({
        probe: () => Promise.resolve(false),
        now: advancingClock(1_000),
        startServer: () =>
          Promise.resolve({
            baseUrl: BASE_URL,
            stop: () => Promise.reject(new Error("stop failed")),
          }),
      }),
      () => Promise.resolve("unreachable"),
    );
    // The primary failure is what the operator needs; a cleanup failure that
    // overwrote it would hide the reason the run failed at all.
    expect(outcome.ok === false && outcome.code).toBe("E2E_READINESS_TIMEOUT");
  });
});
