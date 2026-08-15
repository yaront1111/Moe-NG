import { describe, expect, it } from "vitest";

import type { AuthorityErrorCode, AuthorityOutcome } from "./authority-kernel.js";
import {
  ACQUISITION_STATES,
  SLOT_STATES,
  activateProviderSlot,
  adapterConfirm,
  adapterFail,
  grantSuccessorCapacity,
  reserveAll,
  reserveProviderSlot,
  type DeclaredResource,
  type ProviderSlotActivateCommand,
  type ProviderSlotReservation,
  type ReserveAllRequest,
  type ResourceRow,
} from "./lease-resource.js";

const DIMENSION = "default";
const SLOT_REF = "slot:host-1";
const SLOT_REQUEST = "req-1";
const ATTEMPT = "attempt:7";

function declared(over: Partial<DeclaredResource> = {}): DeclaredResource {
  return { resourceId: "res-b", capacityUnits: 2, external: true, fenceable: true, ...over };
}

function request(over: Partial<ReserveAllRequest> = {}): ReserveAllRequest {
  return {
    requestId: "req-1",
    declaredResources: [declared(), declared({ resourceId: "res-a", external: false })],
    capacitySnapshot: { "res-a": 4, "res-b": 2 },
    epoch: 5,
    eligibilityEventSequenceRef: "seq-11",
    continuouslyEligibleSinceRef: "seq-9",
    callerObservation: "observation-1",
    ...over,
  };
}

function reservedRows(over: Partial<ReserveAllRequest> = {}): readonly ResourceRow[] {
  const result = reserveAll(request(over));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("seed reservation rejected");
  if (result.value.outcome !== "RESERVED") throw new Error("seed did not reserve");
  return result.value.rows;
}

function activeRows(): readonly ResourceRow[] {
  const confirmed = adapterConfirm(reservedRows(), "res-b", 5);
  expect(confirmed.ok).toBe(true);
  if (!confirmed.ok) throw new Error("seed confirmation rejected");
  return confirmed.value.rows;
}

describe("all-or-none acquisition (design 12.2 final paragraph)", () => {
  it("reserves every declared resource in canonical resource-id order", () => {
    const rows = reservedRows();
    expect(rows.map((row) => row.resourceId)).toEqual(["res-a", "res-b"]);
    expect(rows.map((row) => row.state)).toEqual(["ACTIVE", "PENDING_ACQUIRE"]);
    expect(rows.map((row) => row.epoch)).toEqual([5, 5]);
    expect(rows.map((row) => row.effectIntentRef))
      .toEqual(["intent:req-1:res-a", "intent:req-1:res-b"]);
    expect(Object.isFrozen(rows)).toBe(true);
  });

  it("reserves none and returns a durable wait request when one resource is short", () => {
    const result = reserveAll(request({ capacitySnapshot: { "res-a": 4, "res-b": 1 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("WAITING");
    if (result.value.outcome !== "WAITING") return;
    expect(result.value.waitRequest).toEqual({
      requestId: "req-1", resourceIds: ["res-a", "res-b"],
      eligibilityEventSequenceRef: "seq-11", continuouslyEligibleSinceRef: "seq-9",
      callerObservation: "observation-1",
    });
    expect(JSON.stringify(result.value)).not.toContain("PENDING_ACQUIRE");
  });

  it("waits when a declared resource is absent from the capacity snapshot", () => {
    const result = reserveAll(request({ capacitySnapshot: { "res-a": 4 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("WAITING");
  });

  it("produces a deterministic wait request for identical input", () => {
    const short = { capacitySnapshot: { "res-a": 0, "res-b": 0 } };
    expect(reserveAll(request(short))).toEqual(reserveAll(request(short)));
  });

  it("refuses duplicate resource ids and hostile shapes", () => {
    const duplicate = reserveAll(request({
      declaredResources: [declared(), declared()],
    }));
    expect(duplicate.ok).toBe(false);
    expect(reserveAll({ ...request(), epoch: -1 }).ok).toBe(false);
    expect(reserveAll({ ...request(), requestId: "" }).ok).toBe(false);
    expect(reserveAll(null).ok).toBe(false);
  });
});

describe("adapter fencing before a resource becomes ACTIVE (design 753)", () => {
  it("requires the reservation epoch on every external confirmation", () => {
    const rows = reservedRows();
    const result = adapterConfirm(rows, "res-b", 4);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_EPOCH"]);
    expect(rows.map((row) => row.state)).toEqual(["ACTIVE", "PENDING_ACQUIRE"]);
  });

  it("promotes a pending external row to ACTIVE and reports the set complete", () => {
    const result = adapterConfirm(reservedRows(), "res-b", 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.state)).toEqual(["ACTIVE", "ACTIVE"]);
    expect(result.value.allActive).toBe(true);
    expect(result.value.held).toBe(false);
  });

  it("refuses a confirmation for an unknown or already-active resource", () => {
    expect(adapterConfirm(reservedRows(), "res-z", 5).ok).toBe(false);
    expect(adapterConfirm(activeRows(), "res-b", 5).ok).toBe(false);
  });

  it("releases confirmed fenceable rows and holds the set when one acquisition fails", () => {
    const result = adapterFail(activeRows(), "res-b", 5, "FAILED");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.state)).toEqual(["RELEASED", "RELEASED"]);
    expect(result.value.held).toBe(true);
    expect(result.value.allActive).toBe(false);
  });

  it("quarantines the uncertain row when an acquisition outcome is unknown", () => {
    const result = adapterFail(activeRows(), "res-b", 5, "UNKNOWN");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.state)).toEqual(["RELEASED", "QUARANTINED"]);
  });

  it("quarantines a still-PENDING external non-fenceable sibling rather than releasing it", () => {
    // res-a is external + non-fenceable, so it stays PENDING_ACQUIRE: its
    // physical acquisition may already have happened at the adapter and cannot
    // be fenced. Releasing it on a sibling's failure would free capacity that
    // is still physically held — a fail-open double-acquire. It must QUARANTINE.
    const rows = reservedRows({
      declaredResources: [
        declared({ resourceId: "res-a", external: true, fenceable: false }),
        declared({ resourceId: "res-b", external: true, fenceable: true }),
      ],
      capacitySnapshot: { "res-a": 4, "res-b": 2 },
    });
    expect(rows.map((row) => row.state)).toEqual(["PENDING_ACQUIRE", "PENDING_ACQUIRE"]);
    const result = adapterFail(rows, "res-b", 5, "FAILED");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // res-a QUARANTINED (uncertain, non-fenceable), res-b RELEASED (FAILED).
    expect(result.value.rows.map((row) => row.state)).toEqual(["QUARANTINED", "RELEASED"]);
    expect(result.value.held).toBe(true);
  });

  it("still RELEASES a still-PENDING external FENCEABLE sibling: the fence proves it free", () => {
    const rows = reservedRows({
      declaredResources: [
        declared({ resourceId: "res-a", external: true, fenceable: true }),
        declared({ resourceId: "res-b", external: true, fenceable: true }),
      ],
      capacitySnapshot: { "res-a": 4, "res-b": 2 },
    });
    const result = adapterFail(rows, "res-b", 5, "FAILED");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.state)).toEqual(["RELEASED", "RELEASED"]);
  });

  it("quarantines a confirmed row whose adapter cannot fence stale use", () => {
    const rows = reservedRows({
      declaredResources: [
        declared({ resourceId: "res-a", external: false, fenceable: false }),
        declared({ resourceId: "res-b" }),
      ],
    });
    const result = adapterFail(rows, "res-b", 5, "FAILED");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.state)).toEqual(["QUARANTINED", "RELEASED"]);
  });

  it("refuses a stale epoch on failure reporting too", () => {
    const result = adapterFail(activeRows(), "res-b", 4, "FAILED");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_EPOCH"]);
  });
});

describe("provider slot reservation (design 222 and 427)", () => {
  it("uses the registry provider-slot vocabulary, never the lease five-state machine", () => {
    expect([...SLOT_STATES]).toEqual(["RESERVED", "ACTIVE", "RELEASED"]);
    expect([...ACQUISITION_STATES])
      .toEqual(["PENDING_ACQUIRE", "ACTIVE", "RELEASED", "QUARANTINED"]);
    expect(SLOT_STATES).not.toContain("SUSPECT");
    expect(SLOT_STATES).not.toContain("DRAINING");
    expect(SLOT_STATES).not.toContain("REVOKED");
  });

  it("records a RESERVED slot only once every declared resource is ACTIVE", () => {
    const result = reserveProviderSlot(activeRows(), DIMENSION, SLOT_REF, SLOT_REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      dimension: "default", slotRef: "slot:host-1", requestId: "req-1",
      state: "RESERVED", attemptRef: null,
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("refuses a slot reservation while any resource is still pending", () => {
    const result = reserveProviderSlot(reservedRows(), DIMENSION, SLOT_REF, SLOT_REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_LEASE"]);
  });

  it("refuses a reservation whose dimension is missing or empty", () => {
    const absent = reserveProviderSlot(activeRows(), undefined, SLOT_REF, SLOT_REQUEST);
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(absent.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
    const empty = reserveProviderSlot(activeRows(), "", SLOT_REF, SLOT_REQUEST);
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_MALFORMED_INPUT"]);
  });
});

describe("successor capacity is gated on reconciliation proof (design 12.2)", () => {
  it("grants capacity when nothing is quarantined", () => {
    const result = grantSuccessorCapacity(activeRows(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.state)).toEqual(["ACTIVE", "ACTIVE"]);
  });

  it("refuses a successor while a quarantined row has no proof reference", () => {
    const failed = adapterFail(activeRows(), "res-b", 5, "UNKNOWN");
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    const result = grantSuccessorCapacity(failed.value.rows, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_LEASE"]);
  });

  it("clears quarantine only against an explicit reconciliation proof", () => {
    const failed = adapterFail(activeRows(), "res-b", 5, "UNKNOWN");
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    const result = grantSuccessorCapacity(failed.value.rows, "proof:human-release-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.state)).toEqual(["RELEASED", "RELEASED"]);
    expect(result.value.held).toBe(false);
  });

  it("refuses a malformed row list", () => {
    expect(grantSuccessorCapacity([{ resourceId: "res-a" }], null).ok).toBe(false);
    expect(adapterConfirm("not-a-list", "res-a", 5).ok).toBe(false);
  });
});

/** Seeded from the production reducer, never hand-transcribed, so drift cannot hide here. */
function reservedSlot(): ProviderSlotReservation {
  const result = reserveProviderSlot(activeRows(), DIMENSION, SLOT_REF, SLOT_REQUEST);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("seed slot reservation rejected");
  return result.value;
}

function activateCommand(): Record<string, unknown> {
  return { dimension: DIMENSION, slotRef: SLOT_REF, requestId: SLOT_REQUEST, attemptRef: ATTEMPT };
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
  label: string,
): void {
  expect(outcome.ok, label).toBe(false);
  if (outcome.ok) return;
  expect(outcome.issues.map((issue) => issue.code), label).toEqual([code]);
  expect(outcome, label).not.toHaveProperty("value");
}

describe("provider slot activation is the sole RESERVED->ACTIVE authority (design 427)", () => {
  it("binds the exact attempt and returns a frozen ACTIVE successor without touching inputs", () => {
    const predecessor = reservedSlot();
    const activation: ProviderSlotActivateCommand = {
      dimension: DIMENSION, slotRef: SLOT_REF, requestId: SLOT_REQUEST, attemptRef: ATTEMPT,
    };
    const before = JSON.stringify({ activation, predecessor });
    const result = activateProviderSlot(predecessor, activation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      dimension: "default", slotRef: "slot:host-1", requestId: "req-1",
      state: "ACTIVE", attemptRef: "attempt:7",
    });
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value).not.toBe(predecessor);
    expect(result.value).not.toBe(activation);
    // The caller's own records must survive the call unfrozen and unchanged.
    expect(Object.isFrozen(activation)).toBe(false);
    expect(JSON.stringify({ activation, predecessor })).toBe(before);
  });

  it("refuses every malformed predecessor or command with AUTHORITY_MALFORMED_INPUT", () => {
    const record: Record<string, unknown> = { ...reservedSlot() };
    const cmd = activateCommand();
    const cases: readonly (readonly [string, unknown, unknown])[] = [
      ["predecessor null", null, cmd],
      ["predecessor array", [record], cmd],
      ["predecessor missing attemptRef", omit(record, "attemptRef"), cmd],
      ["predecessor extra key", { ...record, extra: 1 }, cmd],
      ["predecessor symbol key", { ...record, [Symbol("hostile")]: 1 }, cmd],
      ["predecessor accessor state", accessor(record, "state", "RESERVED"), cmd],
      ["predecessor proxy", new Proxy(record, {}), cmd],
      ["predecessor empty slotRef", { ...record, slotRef: "" }, cmd],
      ["predecessor empty dimension", { ...record, dimension: "" }, cmd],
      ["predecessor unknown state", { ...record, state: "SUSPECT" }, cmd],
      ["predecessor numeric attemptRef", { ...record, attemptRef: 5 }, cmd],
      ["predecessor prototype-borrowed", Object.create(record), cmd],
      ["command null", record, null],
      ["command string", record, "activate"],
      ["command missing attemptRef", record, omit(cmd, "attemptRef")],
      ["command smuggling a state key", record, { ...cmd, state: "ACTIVE" }],
      ["command symbol key", record, { ...cmd, [Symbol("hostile")]: 1 }],
      ["command accessor attemptRef", record, accessor(cmd, "attemptRef", ATTEMPT)],
      ["command proxy", record, new Proxy(cmd, {})],
      ["command empty attemptRef", record, { ...cmd, attemptRef: "" }],
      ["command null attemptRef", record, { ...cmd, attemptRef: null }],
      ["command numeric dimension", record, { ...cmd, dimension: 5 }],
    ];
    expect(cases.length).toBe(22);
    for (const [label, predecessor, activation] of cases) {
      expectRefusal(
        activateProviderSlot(predecessor, activation), "AUTHORITY_MALFORMED_INPUT", label,
      );
    }
  });

  it("refuses identity drift between the reservation and the activation command", () => {
    const predecessor = reservedSlot();
    const cmd = activateCommand();
    const cases: readonly (readonly [string, unknown])[] = [
      ["dimension drift", { ...cmd, dimension: "gpu" }],
      ["slotRef drift", { ...cmd, slotRef: "slot:host-2" }],
      ["requestId drift", { ...cmd, requestId: "req-2" }],
    ];
    expect(cases.length).toBe(3);
    for (const [label, activation] of cases) {
      expectRefusal(activateProviderSlot(predecessor, activation), "AUTHORITY_STALE_LEASE", label);
    }
  });

  it("refuses replaying activation onto an ACTIVE predecessor carrying no attempt", () => {
    // Identity matches and no attempt is bound, so ONLY the RESERVED-state guard can refuse.
    const predecessor = { ...reservedSlot(), state: "ACTIVE" };
    expectRefusal(
      activateProviderSlot(predecessor, activateCommand()), "AUTHORITY_STALE_LEASE", "active replay",
    );
  });

  it("refuses activating a RELEASED predecessor", () => {
    const predecessor = { ...reservedSlot(), state: "RELEASED" };
    expectRefusal(
      activateProviderSlot(predecessor, activateCommand()), "AUTHORITY_STALE_LEASE", "released",
    );
  });

  it("refuses a RESERVED predecessor already bound to an earlier attempt", () => {
    // State is RESERVED and identity matches, so ONLY the attempt-binding guard can refuse.
    const predecessor = { ...reservedSlot(), attemptRef: "attempt:prior" };
    expectRefusal(
      activateProviderSlot(predecessor, activateCommand()), "AUTHORITY_STALE_LEASE", "already bound",
    );
  });

  it("refuses re-activating its own ACTIVE successor", () => {
    const first = activateProviderSlot(reservedSlot(), activateCommand());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expectRefusal(
      activateProviderSlot(first.value, activateCommand()), "AUTHORITY_STALE_LEASE", "replay",
    );
  });
});
