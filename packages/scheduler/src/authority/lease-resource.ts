/**
 * All-or-none resource acquisition and provider-slot reservation
 * (design 12.2 final paragraph, lines 753-755, plus 222 and 427).
 *
 * Provider slots deliberately carry their own `RESERVED|ACTIVE|RELEASED`
 * occupancy vocabulary and never enter the lease five-state machine. Slot
 * activation (`effect.activate`) is owned by the external-effect supervisor and
 * is out of scope here: this module only records the reservation.
 */
import {
  accept,
  deepFreeze,
  isCount,
  isRef,
  makeIssue,
  malformed,
  oneOf,
  reject,
  type AuthorityOutcome,
} from "./authority-kernel.js";
import {
  ACQUISITION_FAILURES,
  availableUnits,
  parseProviderSlot,
  parseProviderSlotActivation,
  parseReserveRequest,
  parseRows,
  refuse,
  type AcquisitionSet,
  type AcquisitionState,
  type ProviderSlotReservation,
  type ReserveAllResult,
  type ResourceRow,
} from "./resource-model.js";

export {
  ACQUISITION_FAILURES, ACQUISITION_STATES, SLOT_STATES,
} from "./resource-model.js";
export type {
  AcquisitionFailure, AcquisitionSet, AcquisitionState, DeclaredResource,
  ProviderSlotActivateCommand, ProviderSlotReservation, ReserveAllRequest, ReserveAllResult,
  ResourceRow, ResourceWaitRequest, SlotState,
} from "./resource-model.js";

/**
 * One transaction either reserves capacity for every declared non-provider
 * resource in canonical resource-id order, or reserves none and returns a
 * durable wait request.
 */
export function reserveAll(value: unknown): AuthorityOutcome<ReserveAllResult> {
  const parsed = parseReserveRequest(value);
  if (parsed === null) return malformed("reserveAll received a malformed acquisition request");
  const sufficient = parsed.declaredResources.every((resource) => {
    const available = availableUnits(parsed.capacitySnapshot, resource.resourceId);
    return available !== null && available >= resource.capacityUnits;
  });
  if (!sufficient) {
    return accept({
      outcome: "WAITING" as const,
      waitRequest: deepFreeze({
        requestId: parsed.requestId,
        resourceIds: parsed.declaredResources.map((resource) => resource.resourceId),
        eligibilityEventSequenceRef: parsed.eligibilityEventSequenceRef,
        continuouslyEligibleSinceRef: parsed.continuouslyEligibleSinceRef,
        callerObservation: parsed.callerObservation,
      }),
    });
  }
  const rows = parsed.declaredResources.map((resource) => {
    const state: AcquisitionState = resource.external ? "PENDING_ACQUIRE" : "ACTIVE";
    return {
      resourceId: resource.resourceId, capacityUnits: resource.capacityUnits, epoch: parsed.epoch,
      state, effectIntentRef: `intent:${parsed.requestId}:${resource.resourceId}`,
      external: resource.external, fenceable: resource.fenceable,
    };
  });
  return accept({ outcome: "RESERVED" as const, rows: deepFreeze(rows) });
}

function settled(rows: readonly ResourceRow[], held: boolean): AuthorityOutcome<AcquisitionSet> {
  return accept({
    rows: deepFreeze([...rows]), held,
    allActive: rows.every((row) => row.state === "ACTIVE"),
  });
}

type Located = { readonly rows: readonly ResourceRow[]; readonly row: ResourceRow };

function locate(
  value: unknown,
  resourceId: unknown,
  epoch: unknown,
): Located | AuthorityOutcome<never> {
  const rows = parseRows(value);
  if (rows === null || !isRef(resourceId) || !isCount(epoch)) {
    return malformed("adapter report received a malformed acquisition set");
  }
  const row = rows.find((candidate) => candidate.resourceId === resourceId);
  if (row === undefined) return refuse("resource is not part of this acquisition set");
  if (row.epoch !== epoch) {
    return reject([
      makeIssue("AUTHORITY_STALE_EPOCH", "adapter reported a stale acquisition epoch"),
    ]);
  }
  return { rows, row };
}

function isLocated(value: Located | AuthorityOutcome<never>): value is Located {
  return "row" in value;
}

/** Design 753: an external resource becomes ACTIVE only on a fenced confirmation. */
export function adapterConfirm(
  value: unknown,
  resourceId: unknown,
  epoch: unknown,
): AuthorityOutcome<AcquisitionSet> {
  const located = locate(value, resourceId, epoch);
  if (!isLocated(located)) return located;
  if (!located.row.external) return refuse("only an external resource needs confirmation");
  if (located.row.state !== "PENDING_ACQUIRE") {
    return refuse(`resource state ${located.row.state} cannot accept a confirmation`);
  }
  const rows = located.rows.map((row) => {
    if (row.resourceId !== located.row.resourceId) return row;
    const state: AcquisitionState = "ACTIVE";
    return { ...row, state };
  });
  return settled(rows, false);
}

/**
 * Any failed or unknown acquisition fences/releases the confirmed rows and
 * holds the whole set. A row whose adapter cannot fence stale use, and any
 * uncertain outcome, is quarantined instead: Moe chooses safety over invented
 * liveness and waits for a proven release.
 */
export function adapterFail(
  value: unknown,
  resourceId: unknown,
  epoch: unknown,
  disposition: unknown,
): AuthorityOutcome<AcquisitionSet> {
  const located = locate(value, resourceId, epoch);
  if (!isLocated(located)) return located;
  if (!oneOf(disposition, ACQUISITION_FAILURES)) {
    return malformed("adapterFail requires a FAILED or UNKNOWN disposition");
  }
  if (located.row.state !== "PENDING_ACQUIRE" && located.row.state !== "ACTIVE") {
    return refuse(`resource state ${located.row.state} cannot accept a failure report`);
  }
  const rows = located.rows.map((row) => {
    const uncertain = row.resourceId === located.row.resourceId
      ? disposition === "UNKNOWN"
      : row.state === "ACTIVE" && !row.fenceable;
    const state: AcquisitionState = uncertain ? "QUARANTINED" : "RELEASED";
    return { ...row, state };
  });
  return settled(rows, true);
}

/** Design 427: claim reserves the slot; `activateProviderSlot` below makes it ACTIVE. */
export function reserveProviderSlot(
  value: unknown,
  dimension: unknown,
  slotRef: unknown,
  requestId: unknown,
): AuthorityOutcome<ProviderSlotReservation> {
  const rows = parseRows(value);
  if (rows === null || !isRef(dimension) || !isRef(slotRef) || !isRef(requestId)) {
    return malformed("reserveProviderSlot received a malformed reservation request");
  }
  if (!rows.every((row) => row.state === "ACTIVE")) {
    return refuse("a provider slot requires every declared resource to be ACTIVE");
  }
  return accept(deepFreeze({
    dimension, slotRef, requestId, state: "RESERVED" as const, attemptRef: null,
  }));
}

/**
 * Design 427: `effect.activate` is the ONLY RESERVED -> ACTIVE transition, and
 * it lives here because slot occupancy is scheduler-owned authority. The
 * operation is pure: both inputs are re-parsed from own data properties, the
 * successor is a fresh frozen record, and neither caller record is mutated,
 * frozen, or returned by reference.
 */
export function activateProviderSlot(
  predecessor: unknown,
  command: unknown,
): AuthorityOutcome<ProviderSlotReservation> {
  const slot = parseProviderSlot(predecessor);
  const activation = parseProviderSlotActivation(command);
  if (slot === null || activation === null) {
    return malformed("activateProviderSlot received a malformed slot record or command");
  }
  if (slot.dimension !== activation.dimension || slot.slotRef !== activation.slotRef) {
    return refuse("activation identity does not match the reserved provider slot");
  }
  if (slot.requestId !== activation.requestId) {
    return refuse("activation names a different request than the reserved provider slot");
  }
  if (slot.state !== "RESERVED") {
    return refuse(`a provider slot in state ${slot.state} cannot be activated`);
  }
  if (slot.attemptRef !== null) {
    return refuse("the provider slot is already bound to an attempt");
  }
  return accept(deepFreeze({
    dimension: slot.dimension, slotRef: slot.slotRef, requestId: slot.requestId,
    state: "ACTIVE" as const, attemptRef: activation.attemptRef,
  }));
}

/** A successor receives no capacity until fenceability or reconciliation proves it safe. */
export function grantSuccessorCapacity(
  value: unknown,
  proofRef: unknown,
): AuthorityOutcome<AcquisitionSet> {
  const rows = parseRows(value);
  if (rows === null) return malformed("grantSuccessorCapacity received a malformed set");
  if (!rows.some((row) => row.state === "QUARANTINED")) return settled(rows, false);
  if (!isRef(proofRef)) {
    return refuse("a quarantined resource needs a fenceability or reconciliation proof");
  }
  const cleared = rows.map((row) => {
    if (row.state !== "QUARANTINED") return row;
    const state: AcquisitionState = "RELEASED";
    return { ...row, state };
  });
  return settled(cleared, false);
}
