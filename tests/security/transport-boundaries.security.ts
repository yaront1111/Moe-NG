/**
 * HOSTILE COVERAGE — the AUTHORITY TRANSPORT axis of the declared-boundary roster.
 *
 * The cases live in `transport-hostile-cases.ts`, which is deliberately NOT a `*.security.ts`
 * file: the lane collects that suffix, and a second suite would split the whole-slice
 * no-admission invariant across two modules that `isolate: true` keeps from ever seeing each
 * other's outcomes. Every assertion is here, and every case in that table is executed here.
 *
 * WHY THE ROSTER IS READ AS TEXT rather than imported. `boundary-roster.security.ts` is itself
 * a `*.security.ts` file whose suites register at module scope, so importing it would
 * re-register its cases inside this file and this file would inherit its verdicts. Reading its
 * committed bytes takes the roster's authority without its test registration, and the parse
 * asserts a POSITIVE match count so a regex that silently matched nothing reddens rather than
 * making every set assertion below vacuous.
 *
 * EVERY REFUSAL GOES THROUGH `assertRefusedWith(actual, {code, layer})`. The layer is required
 * by the helper's type AND re-checked at its runtime, because several of these boundaries sit
 * behind another: a code-only assertion stays green the moment a different layer answers
 * first. Every expected layer in the table is read off the boundary's OWN exported constant.
 *
 * EVERY RACE IS HOSTILE ON BOTH LEGS, so each asserts ZERO admissions rather than the general
 * "exactly one admitted" shape: with two hostile inputs contending at one admission point a
 * single admission is already the defect. Each side is asserted INDEPENDENTLY, so a
 * double-admit cannot hide inside an aggregate, and no case depends on which leg wins.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { assertRefusedWith, cleanupHostileRoots } from "./hostile-harness.js";
import type { LegOutcome } from "./hostile-harness.js";
import { PROJECT_TRANSPORT_HOSTILE_CASES } from "./project-transport-hostile-cases.js";
import { RECENT_TRANSPORT_HOSTILE_CASES } from "./recent-transport-hostile-cases.js";
import { RECENT_GATE1_TRANSPORT_CASES } from "./recent-v2-cutover-hostile-cases.js";
import {
  DIVERGENCE_TRANSPORT_HOSTILE_CASES, TRANSPORT_HOSTILE_CASES,
} from "./transport-hostile-cases.js";
import type { HostileArm } from "./transport-hostile-cases.js";
import {
  approvalDelivered, budgetShapeValid, pairingAccepted,
} from "./transport-hostile-fixtures.js";

const ROSTER_PATH = fileURLToPath(new URL("./boundary-roster.security.ts", import.meta.url));
const TRANSPORT_ENTRY =
  /constant:\s*"([A-Z0-9_]+)",\s*file:\s*"[^"]+",\s*axis:\s*"transport"/gu;

/** The roster's own committed bytes are the authority on this axis; nothing here re-tags a
 *  boundary, adds one, or drops one. */
function transportRoster(): readonly string[] {
  const source = readFileSync(ROSTER_PATH, "utf8");
  return Object.freeze([...source.matchAll(TRANSPORT_ENTRY)].map((match) => match[1] ?? ""));
}

const ROSTER_TRANSPORT = transportRoster();
const ARMS: readonly HostileArm[] = Object.freeze(["AFTER", "BEFORE", "RACE"]);
const HOSTILE_CASES = Object.freeze([
  ...TRANSPORT_HOSTILE_CASES,
  ...PROJECT_TRANSPORT_HOSTILE_CASES,
  ...RECENT_TRANSPORT_HOSTILE_CASES,
  ...RECENT_GATE1_TRANSPORT_CASES,
]);

interface Recorded {
  readonly admitted: boolean;
  readonly arm: HostileArm;
  readonly boundary: string;
}

/**
 * Every executed case appends here, and BOTH the swept boundary set and the no-admission
 * invariant are computed from this list. A case therefore cannot be counted as coverage
 * without having been asserted, and a case added later cannot escape the invariant.
 */
const RECORDED: Recorded[] = [];

afterAll(() => {
  // The affordance cases open a real SQLite store under a hostile root. `withHostileRoot`
  // already removes each on every exit path; this is the belt-and-braces sweep, because this
  // lane runs `fileParallelism: false` and one leaked root stalls every file after it.
  cleanupHostileRoots();
});

/**
 * Whether production ADMITTED, read off the value it returned rather than assumed from the
 * fact that the case went on to assert a refusal. Recording `false` because a refusal was
 * expected would make the whole-slice invariant true by construction, and a vacuous invariant
 * is worse than none: it would stay green through exactly the regression it exists to catch.
 *
 * The markers are the boundaries' own positive vocabularies — `ok: true` (listener, entry),
 * `delivered: true` (client transport), `known: true` (effort, seam), and an `outcome` that is
 * neither REFUSED nor UNKNOWN (ide adapter, timeline, affordance, coordination, import). A
 * value that is not an object at all counts as an admission, because every refusal on this
 * axis is a structured one.
 */
function isAdmitted(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  const answer = value as Record<string, unknown>;
  if (answer["ok"] === true || answer["delivered"] === true || answer["known"] === true) {
    return true;
  }
  if (answer["admitted"] === true) return true;
  const outcome = answer["outcome"];
  return typeof outcome === "string" && outcome !== "REFUSED" && outcome !== "UNKNOWN";
}

/** Asserted PER SIDE, never on an aggregate: an aggregate assertion over a race can hide the
 *  double admit that is the one defect a race case exists to find. */
function assertSide(side: LegOutcome<unknown>, expected: { code: string; layer: string }): void {
  expect(side.status).toBe("fulfilled");
  assertRefusedWith(side.status === "fulfilled" ? side.value : side.reason, expected);
}

const sideValue = (side: LegOutcome<unknown>): unknown =>
  side.status === "fulfilled" ? side.value : side.reason;

describe("transport axis — hostile before, after and race schedules", () => {
  for (const hostileCase of HOSTILE_CASES) {
    it(`${hostileCase.boundary} ${hostileCase.arm} — ${hostileCase.name}`, async () => {
      // Read through `hostileCase` rather than destructuring up front: destructuring here
      // would fix `expected` to the union before the discriminant narrows it.
      const { arm, boundary } = hostileCase;
      if (hostileCase.arm === "RACE") {
        const outcome = await hostileCase.run();
        // Recorded BEFORE the assertions, so an admission is carried into the whole-slice
        // invariant even when the case's own assertion is what fails first.
        for (const side of [outcome.left, outcome.right]) {
          RECORDED.push({ admitted: isAdmitted(sideValue(side)), arm: "RACE", boundary });
        }
        // Order independence: each side is judged by its own expectation and neither
        // assertion consults `firstSettled`. A case that only passed when one leg won would be
        // a flake, and the usual "fix" — pinning the order — destroys the property under test.
        assertSide(outcome.left, hostileCase.expected.left);
        assertSide(outcome.right, hostileCase.expected.right);
        return;
      }
      const answer = await hostileCase.run();
      RECORDED.push({ admitted: isAdmitted(answer), arm, boundary });
      assertRefusedWith(answer, hostileCase.expected);
    });
  }
});

describe("transport axis — completeness against the roster and the no-admission invariant", () => {
  const sweptKeys = (): ReadonlySet<string> =>
    new Set(RECORDED.map((entry) => `${entry.boundary}#${entry.arm}`));

  it("reads a POSITIVE number of transport entries off the roster's committed bytes", () => {
    expect(ROSTER_TRANSPORT.length).toBeGreaterThan(0);
    // 25 -> 26 on 2026-09-02 for GATE1_LAYER, the Gate 1 card's mapping of a daemon answer,
    // seen once the roster scanner became digit-aware; arms in recent-v2-cutover-hostile-cases.ts.
    expect(ROSTER_TRANSPORT).toHaveLength(26);
    expect(new Set(ROSTER_TRANSPORT).size).toBe(ROSTER_TRANSPORT.length);
  });

  it("executed a POSITIVE number of hostile cases, one outcome per admission point", () => {
    // A table that silently produced zero cases would make every assertion below vacuous.
    expect(HOSTILE_CASES.length).toBeGreaterThanOrEqual(ROSTER_TRANSPORT.length * 3);
    // A race contributes TWO outcomes, one per side, so a case that silently dropped a leg
    // reddens here rather than passing on the half it kept.
    const races = HOSTILE_CASES.filter((entry) => entry.arm === "RACE").length;
    expect(races).toBe(ROSTER_TRANSPORT.length);
    expect(RECORDED).toHaveLength(HOSTILE_CASES.length + races);
  });

  it("sweeps exactly the roster's transport entries, in BOTH directions", () => {
    const covered = new Set(RECORDED.map((entry) => entry.boundary));
    // A case claiming a boundary outside this axis reddens here...
    expect([...covered].filter((name) => !ROSTER_TRANSPORT.includes(name)).sort()).toEqual([]);
    // ...and a roster entry with no case of its own reddens here, naming the constant.
    expect(ROSTER_TRANSPORT.filter((name) => !covered.has(name)).sort()).toEqual([]);
  });

  it("gives every roster boundary at least one BEFORE, one AFTER and one RACE case", () => {
    const keys = sweptKeys();
    expect(ROSTER_TRANSPORT.flatMap((name) => ARMS
      .filter((arm) => !keys.has(`${name}#${arm}`))
      .map((arm) => `${name}#${arm}`))).toEqual([]);
  });

  it("records a POSITIVE case count for every roster boundary", () => {
    for (const name of ROSTER_TRANSPORT) {
      expect(RECORDED.filter((entry) => entry.boundary === name).length).toBeGreaterThan(0);
    }
  });

  it("admits nothing: no case yielded a command, a grant, or a truth class above UNKNOWN", () => {
    // ONE assertion over every outcome collected, rather than one per case.
    expect(RECORDED.length).toBeGreaterThan(0);
    expect(RECORDED.filter((entry) => entry.admitted)).toEqual([]);
  });
});

/**
 * THE DIVERGENCE SLICE — twelve arms over four ALREADY-ROSTERED transport boundaries, executed
 * and counted SEPARATELY from the rostered block above.
 *
 * WHY SEPARATE, MECHANICALLY. `:158` asserts `races === ROSTER_TRANSPORT.length` — exact
 * equality, one race per rostered boundary. These four boundaries already contribute one race
 * each from `RECENT_TRANSPORT_HOSTILE_CASES`, so folding these twelve into `HOSTILE_CASES`
 * would make that count 30 against a roster of 26 and redden it. Nothing below feeds
 * `HOSTILE_CASES`, `RECORDED`, or any assertion above; the slice carries its own recorded array
 * and its own denominator, so neither block can make the other vacuous.
 *
 * WHY THEY EXIST AT ALL. The landed arms for these four are REACHING: `casesFor` in
 * `recent-transport-hostile-cases.ts:51-75` derives BEFORE, AFTER and RACE from ONE thunk, and
 * its build and transport arms assert codes no production module defines. See the header of
 * `transport-hostile-cases.ts` for the full measurement.
 *
 * `isAdmitted` is REUSED from the rostered runner rather than reimplemented, so both blocks
 * judge admission by the same vocabulary and this one cannot drift into a weaker rule.
 */
const DIVERGENCE_CASES = DIVERGENCE_TRANSPORT_HOSTILE_CASES;
const DIVERGENCE_BOUNDARIES: readonly string[] = Object.freeze([
  "LIVE_BUDGET_COMMITMENT_LAYER",
  "PAIRING_OPEN_LAYER",
  "PLAN_APPROVAL_BUILD_LAYER",
  "PLAN_APPROVAL_TRANSPORT_LAYER",
]);
const DIVERGENCE_RECORDED: Recorded[] = [];

describe("transport axis — divergence arms for four rostered boundaries", () => {
  for (const hostileCase of DIVERGENCE_CASES) {
    it(`${hostileCase.boundary} ${hostileCase.arm} — ${hostileCase.name}`, async () => {
      const { arm, boundary } = hostileCase;
      if (hostileCase.arm === "RACE") {
        const outcome = await hostileCase.run();
        for (const side of [outcome.left, outcome.right]) {
          DIVERGENCE_RECORDED.push({
            admitted: isAdmitted(sideValue(side)), arm: "RACE", boundary,
          });
        }
        // Order independence, exactly as above: each side is judged by its own expectation and
        // neither assertion consults `firstSettled`.
        expect(["left", "right"]).toContain(outcome.firstSettled);
        assertSide(outcome.left, hostileCase.expected.left);
        assertSide(outcome.right, hostileCase.expected.right);
        return;
      }
      const answer = await hostileCase.run();
      DIVERGENCE_RECORDED.push({ admitted: isAdmitted(answer), arm, boundary });
      assertRefusedWith(answer, hostileCase.expected);
    });
  }
});

describe("transport axis — the divergence slice's own denominator", () => {
  it("generates exactly twelve divergence cases, three arms over four boundaries", () => {
    // THE LITERAL DENOMINATOR. A table that silently produced zero cases would make every
    // assertion in this block vacuous, and vitest reports no failure for an empty loop.
    expect(DIVERGENCE_CASES).toHaveLength(12);
    expect([...new Set(DIVERGENCE_CASES.map((entry) => entry.boundary))].sort())
      .toEqual([...DIVERGENCE_BOUNDARIES]);
    expect([...new Set(DIVERGENCE_CASES.map((entry) => entry.arm))].sort()).toEqual([...ARMS]);
  });

  it("gives every divergence boundary its own BEFORE, AFTER and RACE, by exact key set", () => {
    // Set EQUALITY on `${boundary}#${arm}`, not a subset check: a case retargeted at another
    // boundary reddens on the surplus key as well as on the one it abandoned.
    const keys = new Set(DIVERGENCE_CASES.map((entry) => `${entry.boundary}#${entry.arm}`));
    expect([...keys].sort()).toEqual(
      DIVERGENCE_BOUNDARIES.flatMap((name) => ARMS.map((arm) => `${name}#${arm}`)).sort(),
    );
  });

  it("records sixteen outcomes: twelve cases, of which four races record two legs each", () => {
    const races = DIVERGENCE_CASES.filter((entry) => entry.arm === "RACE").length;
    expect(races).toBe(4);
    // Derived AND literal. The derived form moves with the table; the literal is what reddens
    // if the table shrinks. A race that silently dropped a leg reddens here rather than
    // passing on the half it kept.
    expect(DIVERGENCE_RECORDED).toHaveLength(DIVERGENCE_CASES.length + races);
    expect(DIVERGENCE_RECORDED).toHaveLength(16);
  });

  it("keeps the divergence slice out of the rostered block's recorded outcomes", () => {
    // Load-bearing separation, pinned rather than left to a comment: the moment these twelve
    // are folded into `RECORDED`, `:158` and `:159` redden. Asserting it here names the reason.
    expect(RECORDED).toHaveLength(HOSTILE_CASES.length
      + HOSTILE_CASES.filter((entry) => entry.arm === "RACE").length);
    expect(RECORDED.filter((entry) => entry.arm === "RACE").length)
      .toBe(ROSTER_TRANSPORT.length * 2);
  });

  it("admits nothing: no divergence case yielded a command, a grant, or a session", () => {
    expect(DIVERGENCE_RECORDED.length).toBeGreaterThan(0);
    expect(DIVERGENCE_RECORDED.filter((entry) => entry.admitted)).toEqual([]);
  });
});

/**
 * THE DIVERGENCE CLAIM ITSELF, asserted rather than described.
 *
 * Every hostile fixture above is "otherwise valid" — identical to an ACCEPTED input except for
 * the one fact its named guard judges. That is what makes each arm a test of THAT guard rather
 * than of the system's general willingness to refuse. These three controls run the same inputs
 * with the hostile fact REMOVED and require ADMISSION, so a fixture that quietly started
 * tripping a neighbouring fence reddens here instead of passing on someone else's refusal.
 *
 * They are expected to SUCCEED, so they never enter `DIVERGENCE_RECORDED` or the no-admission
 * invariant above — a control counted as coverage would invert the very thing it proves.
 */
describe("transport axis — divergence controls: the hostile fact is the only difference", () => {
  it("admits the budget frame once its one surplus key is removed", () => {
    // Proves the AFTER arm is refused by the exact-key check and not by the status gate or by
    // `refusalFrom`: the same 200 frame, minus `extra`, is a COMMITMENT.
    return expect(budgetShapeValid()).resolves.toEqual({
      ref: "commitment-ref-1", status: "COMMITMENT",
    });
  });

  it("delivers the approval once the daemon answers, proving the build layer passed", () => {
    // Proves the two TRANSPORT arms are not silently grading the BUILDER: the same bound offer
    // through the same generated builder reaches a daemon and returns `ok`. It is also the
    // BUILD arms' control, since the foreign-run offer differs from this one only in
    // `commandKind` and `targetAggregateId`.
    return expect(approvalDelivered()).resolves.toEqual({
      commandId: "cmd-approval-1", ok: true,
    });
  });

  it("opens the pairing session once the padding and the surplus key are removed", () => {
    // Proves the byte cap and the exact roster are the only mechanisms refusing the two
    // pairing arms: unpadded and unrostered-key-free, the identical body reaches the authority.
    expect(pairingAccepted()).toEqual({ ok: true, sessionId: "session-1" });
  });
});
