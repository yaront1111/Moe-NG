import { describe, expect, it } from "vitest";

import {
  ACQUISITION_STATES,
  SLOT_STATES,
  adapterConfirm,
  adapterFail,
  grantSuccessorCapacity,
  reserveAll,
  reserveProviderSlot,
  type DeclaredResource,
  type ReserveAllRequest,
  type ResourceRow,
} from "./lease-resource.js";

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
    const result = reserveProviderSlot(activeRows(), "slot:host-1", "req-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      slotRef: "slot:host-1", requestId: "req-1", state: "RESERVED",
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("refuses a slot reservation while any resource is still pending", () => {
    const result = reserveProviderSlot(reservedRows(), "slot:host-1", "req-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual(["AUTHORITY_STALE_LEASE"]);
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
