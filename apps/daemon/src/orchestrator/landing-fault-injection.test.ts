import { describe, expect, it } from "vitest";

import {
  LANDING_FAULT_POINTS,
  createLandingFaultInjector,
  readLandingFaultArming,
} from "./landing-fault-injection.js";
import type { LandingFaultPoint } from "./landing-fault-injection.js";

/**
 * THE KNOB IS A CRASH SWITCH, so every arm here is about REFUSING to arm.
 *
 * The interesting assertions are not "it kills when armed" — that is one line. They are
 * (a) that the default is disarmed, (b) that naming a point outside development mode is
 * refused, and (c) WHICH LAYER refuses when two could: an unknown point name outside
 * development must answer NOT_DEVELOPMENT, never POINT_UNKNOWN, because a knob that
 * validates its argument before its fence has already read attacker input into a branch.
 */

const DEV = "MOE_DEVELOPMENT_ONLY";
const POINT = "MOE_FAULT_INJECT_LANDING";

/** Never `process.env`: a test that mutates the real environment leaks into its neighbours. */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values };
}

describe("landing fault injection — arming", () => {
  it("is disarmed when the environment names nothing, and says why", () => {
    expect(readLandingFaultArming(env({}))).toEqual({
      point: null,
      refusal: "FAULT_INJECTION_DISARMED",
    });
  });

  it("stays disarmed when development mode is on but no point is named", () => {
    expect(readLandingFaultArming(env({ [DEV]: "1" }))).toEqual({
      point: null,
      refusal: "FAULT_INJECTION_DISARMED",
    });
  });

  it("treats a blank point name as unnamed rather than as an unknown point", () => {
    expect(readLandingFaultArming(env({ [DEV]: "1", [POINT]: "   " }))).toEqual({
      point: null,
      refusal: "FAULT_INJECTION_DISARMED",
    });
  });

  it("refuses to arm a real point when development mode is not on", () => {
    expect(readLandingFaultArming(env({ [POINT]: "after-commit" }))).toEqual({
      point: null,
      refusal: "FAULT_INJECTION_NOT_DEVELOPMENT",
    });
  });

  it("refuses any development flag value other than exactly \"1\"", () => {
    for (const value of ["0", "true", "yes", "TRUE", " 1", "1 "]) {
      expect(readLandingFaultArming(env({ [DEV]: value, [POINT]: "after-commit" }))).toEqual({
        point: null,
        refusal: "FAULT_INJECTION_NOT_DEVELOPMENT",
      });
    }
  });

  it("answers NOT_DEVELOPMENT — not POINT_UNKNOWN — when both fences would refuse", () => {
    // The order is the assertion. If the roster check ran first this would read
    // POINT_UNKNOWN, and the knob would be telling an unarmed caller which names exist.
    expect(readLandingFaultArming(env({ [POINT]: "no-such-point" }))).toEqual({
      point: null,
      refusal: "FAULT_INJECTION_NOT_DEVELOPMENT",
    });
  });

  it("refuses an unknown point name once development mode is on", () => {
    expect(readLandingFaultArming(env({ [DEV]: "1", [POINT]: "after-push" }))).toEqual({
      point: null,
      refusal: "FAULT_INJECTION_POINT_UNKNOWN",
    });
  });

  it("arms every point in the roster, and the sweep really generated cases", () => {
    const armed: LandingFaultPoint[] = [];
    for (const point of LANDING_FAULT_POINTS) {
      expect(readLandingFaultArming(env({ [DEV]: "1", [POINT]: point }))).toEqual({
        point,
        refusal: null,
      });
      armed.push(point);
    }
    // A sweep that silently yields zero cases passes; this is the denominator.
    expect(armed).toEqual([...LANDING_FAULT_POINTS]);
    expect(armed.length).toBeGreaterThanOrEqual(4);
  });
});

describe("landing fault injection — tripping", () => {
  function recording(values: Record<string, string>) {
    const killed: string[] = [];
    const injector = createLandingFaultInjector({
      env: env(values),
      kill: (note) => { killed.push(note); },
      now: () => "2026-09-08T20:00:00.000Z",
    });
    return { injector, killed };
  }

  it("kills at the armed point", () => {
    const { injector, killed } = recording({ [DEV]: "1", [POINT]: "after-commit" });
    injector.trip("after-commit");
    expect(killed).toHaveLength(1);
  });

  it("does not kill at any point other than the armed one", () => {
    const { injector, killed } = recording({ [DEV]: "1", [POINT]: "after-commit" });
    for (const point of LANDING_FAULT_POINTS.filter((name) => name !== "after-commit")) {
      injector.trip(point);
    }
    expect(killed).toEqual([]);
  });

  it("never kills when disarmed, at any point in the roster", () => {
    const { injector, killed } = recording({});
    for (const point of LANDING_FAULT_POINTS) injector.trip(point);
    expect(killed).toEqual([]);
    expect(injector.armedPoint).toBeNull();
    expect(injector.refusal).toBe("FAULT_INJECTION_DISARMED");
  });

  it("never kills when a point is named outside development mode", () => {
    const { injector, killed } = recording({ [POINT]: "after-commit" });
    for (const point of LANDING_FAULT_POINTS) injector.trip(point);
    expect(killed).toEqual([]);
    expect(injector.refusal).toBe("FAULT_INJECTION_NOT_DEVELOPMENT");
  });

  it("records the knob name, the point and the timestamp in the death note", () => {
    // DoD 2 wants "knob name + timestamp recorded"; the note is written synchronously to
    // stderr before the process dies, so it survives a SIGKILL that flushes nothing.
    const { injector, killed } = recording({ [DEV]: "1", [POINT]: "after-intent" });
    injector.trip("after-intent");
    expect(killed[0]).toContain("MOE_FAULT_INJECT_LANDING");
    expect(killed[0]).toContain("point=after-intent");
    expect(killed[0]).toContain("at=2026-09-08T20:00:00.000Z");
    expect(killed[0]).toContain(`pid=${String(process.pid)}`);
  });

  it("exposes the armed point so a caller can log what it armed", () => {
    const { injector } = recording({ [DEV]: "1", [POINT]: "after-completion" });
    expect(injector.armedPoint).toBe("after-completion");
    expect(injector.refusal).toBeNull();
  });
});
