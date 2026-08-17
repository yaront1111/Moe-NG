import { describe, expect, it } from "vitest";

import { LEASE_STATES } from "./authority-kernel.js";
import type { AuthorityErrorCode, AuthorityOutcome } from "./authority-kernel.js";
import {
  activateProviderSlot,
  releaseProviderSlot as reExportedRelease,
  reserveAll,
  reserveProviderSlot,
  type ProviderSlotReservation,
  type ResourceRow,
} from "./lease-resource.js";
// The frozen vocabulary is imported from its owning module, never retyped here:
// a local `["RESERVED","ACTIVE","RELEASED"]` copy is the second source of truth
// this sweep exists to prevent.
import { ACQUISITION_STATES, SLOT_STATES, type SlotState } from "./resource-model.js";
import { releaseProviderSlot } from "./provider-slot-release.js";

const DIMENSION = "default";
const SLOT_REF = "slot:host-1";
const SLOT_REQUEST = "req-1";
const ATTEMPT = "attempt:7";

/**
 * `refuse` emits one code for every identity, binding, and state guard, so the
 * message is the ONLY discriminator this package makes available. Each arm pins
 * both; a test pinning the code alone is one added guard away from vacuous.
 */
const MALFORMED_MESSAGE = "releaseProviderSlot received a malformed slot record or command";
const IDENTITY_MESSAGE = "release identity does not match the reserved provider slot";
const REQUEST_MESSAGE = "release names a different request than the reserved provider slot";
const ATTEMPT_MESSAGE = "release names a different attempt than the provider slot binding";
const stateMessage = (state: string): string =>
  `a provider slot in state ${state} cannot be released`;

function activeRows(): readonly ResourceRow[] {
  const result = reserveAll({
    requestId: SLOT_REQUEST,
    declaredResources: [
      { resourceId: "res-a", capacityUnits: 1, external: false, fenceable: true },
    ],
    capacitySnapshot: { "res-a": 4 },
    epoch: 5,
    eligibilityEventSequenceRef: "seq-11",
    continuouslyEligibleSinceRef: "seq-9",
    callerObservation: "observation-1",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("seed acquisition rejected");
  if (result.value.outcome !== "RESERVED") throw new Error("seed did not reserve");
  return result.value.rows;
}

/** The release command carries the same fact set as the activation command. */
function releaseCommand(): Record<string, unknown> {
  return { dimension: DIMENSION, slotRef: SLOT_REF, requestId: SLOT_REQUEST, attemptRef: ATTEMPT };
}

/** Seeded from the production reducers, never hand-transcribed, so drift cannot hide here. */
function reservedSlot(): ProviderSlotReservation {
  const result = reserveProviderSlot(activeRows(), DIMENSION, SLOT_REF, SLOT_REQUEST);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("seed slot reservation rejected");
  return result.value;
}

function activeSlot(): ProviderSlotReservation {
  const result = activateProviderSlot(reservedSlot(), releaseCommand());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("seed slot activation rejected");
  return result.value;
}

function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

/** An accessor answers a valid value to a naive read; the strict parser must still refuse. */
function accessor(source: Record<string, unknown>, key: string, value: unknown): unknown {
  const target = omit(source, key);
  Object.defineProperty(target, key, {
    configurable: true, enumerable: true, get: () => value,
  });
  return target;
}

function expectRefusal(
  outcome: AuthorityOutcome<ProviderSlotReservation>,
  code: AuthorityErrorCode,
  message: string,
  label: string,
): void {
  expect(outcome.ok, label).toBe(false);
  if (outcome.ok) return;
  expect(outcome.issues.map((issue) => issue.code), label).toEqual([code]);
  expect(outcome.issues.map((issue) => issue.message), label).toEqual([message]);
  expect(outcome, label).not.toHaveProperty("value");
}

describe("provider slot release refuses malformed and drifted input", () => {
  it("refuses every malformed predecessor or command with AUTHORITY_MALFORMED_INPUT", () => {
    const record: Record<string, unknown> = { ...activeSlot() };
    const cmd = releaseCommand();
    const cases: readonly (readonly [string, unknown, unknown])[] = [
      ["predecessor null", null, cmd],
      ["predecessor array", [record], cmd],
      ["predecessor missing state", omit(record, "state"), cmd],
      ["predecessor extra key", { ...record, extra: 1 }, cmd],
      ["predecessor symbol key", { ...record, [Symbol("hostile")]: 1 }, cmd],
      ["predecessor accessor state", accessor(record, "state", "ACTIVE"), cmd],
      ["predecessor proxy", new Proxy(record, {}), cmd],
      ["predecessor prototype-borrowed", Object.create(record), cmd],
      ["predecessor empty dimension", { ...record, dimension: "" }, cmd],
      ["predecessor numeric slotRef", { ...record, slotRef: 5 }, cmd],
      ["predecessor empty requestId", { ...record, requestId: "" }, cmd],
      ["predecessor state outside SLOT_STATES", { ...record, state: "DRAINING" }, cmd],
      ["predecessor numeric attemptRef", { ...record, attemptRef: 5 }, cmd],
      ["predecessor empty attemptRef", { ...record, attemptRef: "" }, cmd],
      ["command null", record, null],
      ["command string", record, "release"],
      ["command missing attemptRef", record, omit(cmd, "attemptRef")],
      ["command extra key", record, { ...cmd, extra: 1 }],
      ["command smuggling a state key", record, { ...cmd, state: "RELEASED" }],
      ["command symbol key", record, { ...cmd, [Symbol("hostile")]: 1 }],
      ["command accessor attemptRef", record, accessor(cmd, "attemptRef", ATTEMPT)],
      ["command proxy", record, new Proxy(cmd, {})],
      ["command null attemptRef", record, { ...cmd, attemptRef: null }],
      ["command empty attemptRef", record, { ...cmd, attemptRef: "" }],
      ["command numeric dimension", record, { ...cmd, dimension: 5 }],
    ];
    expect(cases.length).toBe(25);
    for (const [label, predecessor, command] of cases) {
      expectRefusal(
        releaseProviderSlot(predecessor, command), "AUTHORITY_MALFORMED_INPUT",
        MALFORMED_MESSAGE, label,
      );
    }
  });

  it("refuses identity drift between the reservation and the release command", () => {
    const predecessor = activeSlot();
    const cmd = releaseCommand();
    const cases: readonly (readonly [string, unknown])[] = [
      ["dimension drift", { ...cmd, dimension: "gpu" }],
      ["slotRef drift", { ...cmd, slotRef: "slot:host-2" }],
    ];
    expect(cases.length).toBe(2);
    for (const [label, command] of cases) {
      expectRefusal(
        releaseProviderSlot(predecessor, command), "AUTHORITY_STALE_LEASE",
        IDENTITY_MESSAGE, label,
      );
    }
  });

  it("refuses a release naming a different request with its own message", () => {
    // Dimension and slotRef match, so ONLY the requestId guard can refuse here.
    expectRefusal(
      releaseProviderSlot(activeSlot(), { ...releaseCommand(), requestId: "req-2" }),
      "AUTHORITY_STALE_LEASE", REQUEST_MESSAGE, "requestId drift",
    );
  });

  it("is reachable from the module that already owns the slot family", () => {
    // A consumer imports reserve/activate/release from one place; a dropped
    // re-export would otherwise only surface in the consuming task.
    expect(reExportedRelease).toBe(releaseProviderSlot);
  });

  it("keeps every refusal message distinct so no two guards are interchangeable", () => {
    const messages = [
      MALFORMED_MESSAGE, IDENTITY_MESSAGE, REQUEST_MESSAGE, ATTEMPT_MESSAGE,
      stateMessage("RESERVED"),
    ];
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("provider slot release is bound to the attempt the slot carries", () => {
  it("refuses a release naming a different attempt than the slot binding", () => {
    // Every identity matches, so ONLY the attempt-binding guard can refuse here.
    expectRefusal(
      releaseProviderSlot(activeSlot(), { ...releaseCommand(), attemptRef: "attempt:other" }),
      "AUTHORITY_STALE_LEASE", ATTEMPT_MESSAGE, "attempt drift",
    );
  });

  it("refuses a release against an unbound slot rather than treating null as a wildcard", () => {
    // `reserveProviderSlot` returns `attemptRef: null`, so a RESERVED slot has no
    // attempt to release against; null must never match a named attempt.
    const predecessor = reservedSlot();
    expect(predecessor.attemptRef).toBeNull();
    expectRefusal(
      releaseProviderSlot(predecessor, releaseCommand()),
      "AUTHORITY_STALE_LEASE", ATTEMPT_MESSAGE, "unbound attemptRef",
    );
  });

  it("refuses releasing a RESERVED slot even when its attempt binding matches", () => {
    // Identity and attempt both match, so ONLY the state guard can refuse here:
    // a reserved slot was never activated and must not silently release.
    const predecessor = { ...reservedSlot(), attemptRef: ATTEMPT };
    expectRefusal(
      releaseProviderSlot(predecessor, releaseCommand()),
      "AUTHORITY_STALE_LEASE", stateMessage("RESERVED"), "reserved slot",
    );
  });
});

describe("provider slot release is the only path to the RELEASED member of SLOT_STATES", () => {
  it("releases an ACTIVE slot, a value no code path in the repo could previously produce", () => {
    const predecessor = activeSlot();
    expect(predecessor.state).toBe("ACTIVE");
    const result = releaseProviderSlot(predecessor, releaseCommand());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      dimension: "default", slotRef: "slot:host-1", requestId: "req-1",
      state: "RELEASED", attemptRef: "attempt:7",
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("treats an already-RELEASED slot as an accepted no-op carrying it unchanged", () => {
    // Mirrors `releaseWork` (lease-drain.ts:199-201): a settled record replays as
    // an acceptance, never as an error. The successor keeps its `attemptRef`, so
    // the very same command reaches this arm instead of the attempt guard.
    const first = releaseProviderSlot(activeSlot(), releaseCommand());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = releaseProviderSlot(first.value, releaseCommand());
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value).toEqual(first.value);
    expect(replay.value.state).toBe("RELEASED");
    expect(replay.value.attemptRef).toBe(ATTEMPT);
  });

  it("accepts an already-frozen caller record without throwing on it", () => {
    // The successor is built field by field, so nothing is ever written back
    // into the caller's record; a frozen input must therefore be ordinary input.
    const predecessor = Object.freeze({ ...activeSlot() });
    const command = Object.freeze(releaseCommand());
    const result = releaseProviderSlot(predecessor, command);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe("RELEASED");
    expect(result.value).not.toBe(predecessor);
  });

  it("never mutates, freezes, or returns the caller's record by reference", () => {
    const predecessor: Record<string, unknown> = { ...activeSlot() };
    const command = releaseCommand();
    const before = JSON.stringify({ command, predecessor });
    const result = releaseProviderSlot(predecessor, command);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(predecessor);
    expect(result.value).not.toBe(command);
    expect(Object.isFrozen(predecessor)).toBe(false);
    expect(Object.isFrozen(command)).toBe(false);
    expect(JSON.stringify({ command, predecessor })).toBe(before);
    // A later caller mutation cannot reach back into an already-returned successor.
    predecessor["attemptRef"] = "attempt:mutated";
    predecessor["state"] = "RESERVED";
    expect(result.value.attemptRef).toBe(ATTEMPT);
    expect(result.value.state).toBe("RELEASED");
  });
});

type Disposition = "REFUSES" | "RELEASES" | "NO_OP";

/**
 * Exhaustive over `SlotState`, so a fourth member added upstream fails the
 * sweep loudly instead of being silently skipped.
 */
const EXPECTED: Readonly<Record<SlotState, Disposition>> = Object.freeze({
  RESERVED: "REFUSES", ACTIVE: "RELEASES", RELEASED: "NO_OP",
});

describe("provider slot release covers the frozen SLOT_STATES vocabulary", () => {
  it("drives one release per frozen member and pins each member's disposition", () => {
    expect(SLOT_STATES.length).toBe(3);
    expect(Object.keys(EXPECTED).length).toBe(SLOT_STATES.length);
    // Every case carries the matching attempt binding, so `state` is the sole decider.
    const cases = SLOT_STATES.map((state) => ({
      state, disposition: EXPECTED[state], predecessor: { ...activeSlot(), state },
    }));
    // Non-vacuity: a sweep that silently generated zero cases would otherwise pass.
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.length).toBe(SLOT_STATES.length);
    expect(cases.map((entry) => entry.state)).toEqual([...SLOT_STATES]);
    for (const { state, disposition, predecessor } of cases) {
      const result = releaseProviderSlot(predecessor, releaseCommand());
      if (disposition === "REFUSES") {
        expectRefusal(result, "AUTHORITY_STALE_LEASE", stateMessage(state), state);
        continue;
      }
      expect(result.ok, state).toBe(true);
      if (!result.ok) continue;
      expect(result.value.state, state).toBe("RELEASED");
      expect(result.value.attemptRef, state).toBe(ATTEMPT);
      if (disposition === "NO_OP") expect(result.value, state).toEqual(predecessor);
      else expect(predecessor.state, state).toBe("ACTIVE");
    }
  });

  it("refuses every neighbouring vocabulary member that SLOT_STATES does not carry", () => {
    // Generated from the sibling frozen vocabularies, so "accepted inputs are
    // exactly the frozen members" cannot drift into a hand-picked list.
    const members: readonly string[] = SLOT_STATES;
    const outsiders = [...LEASE_STATES, ...ACQUISITION_STATES]
      .filter((state) => !members.includes(state));
    expect(outsiders.length).toBeGreaterThan(0);
    expect(new Set(outsiders).size).toBe(outsiders.length);
    for (const state of outsiders) {
      expectRefusal(
        releaseProviderSlot({ ...activeSlot(), state }, releaseCommand()),
        "AUTHORITY_MALFORMED_INPUT", MALFORMED_MESSAGE, state,
      );
    }
  });
});
