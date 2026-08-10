/**
 * Rotation INPUT validation — the boundary in front of ./fairness-rotation.ts.
 *
 * Split from the engine so each source stays inside the per-file line target.
 * Everything here is a total validator; nothing selects, charges or ages.
 *
 * The landed contracts own every check they already make: this module calls
 * `validateRing`, `validateWorkItemSet` and `validateCapRevision` and refuses on
 * their result rather than re-deriving them, which would fork the authority. It
 * adds only what a CONSUMER needs and a structural contract cannot see —
 * ring-to-work-item placement agreement, per-resource capacity, and whether a
 * revision applies to THIS ring. No issue code is minted, and none can be:
 * `FairnessContractIssueCode` is a closed union over a frozen tuple in
 * ./fairness-contract.ts, which this task does not own, so every refusal maps
 * onto an existing member and the two non-obvious mappings say why in place.
 */
import { MAX_AUTHORITY_COUNT, exactRecord, isCount } from "../authority/authority-kernel.js";
import { validateCapRevision } from "./fairness-cap-revision.js";
import {
  acceptFairness, isFairnessIdentity, isFairnessRefusal, makeFairnessIssue,
  readFairnessItems, refuseFairness, unknownFairness,
} from "./fairness-contract.js";
import type {
  FairnessContractIssueCode, FairnessContractLayer, FairnessContractRefusal,
  FairnessContractResult,
} from "./fairness-contract.js";
import { validateRing } from "./fairness-ring.js";
import type { FairnessRing } from "./fairness-ring.js";
import { validateWorkItemSet } from "./fairness-work-item.js";
import type { FairnessWorkItem } from "./fairness-work-item.js";

/** One selection spends one unit of service credit. */
export const FAIRNESS_SERVICE_COST = 1;

/**
 * Per-dimension ceiling on simultaneously in-flight units. Mirrors DEFAULT_M_D
 * = 10_000 at packages/testkit/src/scheduler-fairness/fairness-policy.ts:8
 * (design §8.4). REDECLARED, never imported: @moe/scheduler declares no
 * @moe/testkit dependency and DoD 3 forbids one, so duplication is the only
 * legal path — and the value must not drift from its cited source.
 */
export const FAIRNESS_DIMENSION_CEILING = 10_000;

export interface FairnessResourceCapacity {
  readonly resourceId: string;
  readonly capacityUnits: number;
  readonly inFlightUnits: number;
}

/** Everything the engine may read, already validated. */
export interface FairnessRotationInputs {
  readonly ring: FairnessRing;
  readonly items: ReadonlyMap<string, FairnessWorkItem>;
  readonly capacities: ReadonlyMap<string, FairnessResourceCapacity>;
  readonly forcedHead: string | null;
  readonly totalInFlight: number;
}

const CAPACITY_KEYS = Object.freeze(["resourceId", "capacityUnits", "inFlightUnits"] as const);
const REQUEST_KEYS = Object.freeze([
  "ring", "workItems", "capacities", "forcedHead", "capRevision",
] as const);

export function refuseRotation(
  code: FairnessContractIssueCode, layer: FairnessContractLayer,
  message: string, subjects: readonly string[] = [],
): FairnessContractRefusal {
  return refuseFairness(makeFairnessIssue(code, layer, message, null, subjects));
}

/**
 * Bounded addition, ceilinged at MAX_AUTHORITY_COUNT rather than
 * Number.MAX_SAFE_INTEGER: every counter this package emits must survive a round
 * trip through `isCount` (authority-kernel.ts:150), which stops there. A sum
 * above it would pass a MAX_SAFE_INTEGER guard and then be refused by the very
 * contract that produced it, bricking the ring.
 */
export function safeAdd(left: number, right: number): number | null {
  const sum = left + right;
  return Number.isSafeInteger(sum) && sum <= MAX_AUTHORITY_COUNT ? sum : null;
}

export function validateResourceCapacity(
  value: unknown,
): FairnessContractResult<FairnessResourceCapacity> {
  const parsed = exactRecord(value, CAPACITY_KEYS);
  if (parsed === null) {
    return refuseRotation("FAIRNESS_CONTRACT_MALFORMED_INPUT", "RESOURCE", "input is not a capacity record");
  }
  const resourceId = parsed["resourceId"];
  if (!isFairnessIdentity(resourceId)) {
    return refuseRotation("FAIRNESS_CONTRACT_INVALID_IDENTITY", "RESOURCE",
      "resourceId is not a safe fairness identity");
  }
  const capacityUnits = parsed["capacityUnits"];
  const inFlightUnits = parsed["inFlightUnits"];
  if (!isCount(capacityUnits) || !isCount(inFlightUnits)) {
    return refuseRotation("FAIRNESS_CONTRACT_INVALID_COUNTER", "RESOURCE",
      "a capacity unit count is not a non-negative safe integer", [resourceId]);
  }
  if (inFlightUnits > capacityUnits) {
    return refuseRotation("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "RESOURCE",
      "in-flight units exceed the declared capacity", [resourceId]);
  }
  return acceptFairness({ resourceId, capacityUnits, inFlightUnits });
}

/**
 * A ring resource with no capacity record yields UNKNOWN naming the exact
 * missing input, never an assumed capacity. UNDECLARED_RESOURCE is the closest
 * member of the closed tuple — the resource is undeclared in the CAPACITIES
 * input — and the UNKNOWN disposition is what distinguishes it from the
 * RING-layer REFUSED that fairness-ring.ts raises under the same code.
 */
function readCapacities(
  value: unknown, ring: FairnessRing,
): ReadonlyMap<string, FairnessResourceCapacity> | FairnessContractRefusal {
  const items = readFairnessItems(value, "RESOURCE", "capacities");
  if (isFairnessRefusal(items)) return items;
  const byResource = new Map<string, FairnessResourceCapacity>();
  for (const raw of items) {
    const capacity = validateResourceCapacity(raw);
    if (!capacity.ok) return capacity;
    if (byResource.has(capacity.value.resourceId)) {
      return refuseRotation("FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "RESOURCE",
        "a capacity record repeats a resource", [capacity.value.resourceId]);
    }
    byResource.set(capacity.value.resourceId, capacity.value);
  }
  for (const declared of ring.resources) {
    if (!byResource.has(declared.resourceId)) {
      return unknownFairness("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", "RESOURCE",
        `capacities[${declared.resourceId}]`, [declared.resourceId]);
    }
  }
  return byResource;
}

/**
 * Ring-to-work-item agreement, plus the weight floor. A resource weighted below
 * one service unit can never accrue enough credit to serve its queue, so that
 * queue would starve without bound; refusing is the only fail-closed answer and
 * is what keeps the starvation bound arithmetic rather than conditional.
 * INVALID_COUNTER because the weight as a datum is unserviceable; the RESOURCE
 * layer names who declared it.
 */
function checkPlacements(
  ring: FairnessRing, items: ReadonlyMap<string, FairnessWorkItem>,
): FairnessContractRefusal | null {
  for (const entry of ring.entries) {
    const workItem = items.get(entry.workItemId);
    if (workItem === undefined) {
      return refuseRotation("FAIRNESS_CONTRACT_INVALID_IDENTITY", "RING",
        "a queue entry names a work item absent from the validated set", [entry.workItemId]);
    }
    if (workItem.resourceId !== entry.resourceId) {
      return refuseRotation("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", "RING",
        "a queue entry places a work item on a resource the item does not name",
        [entry.workItemId, entry.resourceId, workItem.resourceId]);
    }
  }
  const queued = new Set(ring.entries.map((each) => each.resourceId));
  for (const declared of ring.resources) {
    if (declared.weight < FAIRNESS_SERVICE_COST && queued.has(declared.resourceId)) {
      return refuseRotation("FAIRNESS_CONTRACT_INVALID_COUNTER", "RESOURCE",
        "a resource below one service unit of weight can never serve its queue",
        [declared.resourceId]);
    }
  }
  return null;
}

/**
 * Applicability of a revision to THIS ring. validateCapRevision already owns the
 * revision's internal structure, including equal-or-tighter migrations, so only
 * the cross-checks it cannot see are made here.
 */
function checkCapRevision(
  value: unknown, ring: FairnessRing, totalInFlight: number,
): FairnessContractRefusal | null {
  if (value === null) return null;
  const revision = validateCapRevision(value);
  if (!revision.ok) return revision;
  if (revision.value.dimensionId !== ring.dimensionId) {
    return refuseRotation("FAIRNESS_CONTRACT_DIMENSION_MISMATCH", "CAP_REVISION",
      "the revision names a different compatibility dimension", [revision.value.revisionRef]);
  }
  const queued = new Set(ring.entries.map((each) => each.workItemId));
  for (const drained of revision.value.drainedWorkItemIds) {
    if (queued.has(drained)) {
      return refuseRotation("FAIRNESS_CONTRACT_MIGRATION_TARGET_DRAINED", "CAP_REVISION",
        "a drained work item is still queued on the ring", [drained]);
    }
  }
  if (totalInFlight > revision.value.toCapUnits) {
    return refuseRotation("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "CAP_REVISION",
      "in-flight units already exceed the revised cap", [revision.value.revisionRef]);
  }
  return null;
}

function sumInFlight(
  capacities: ReadonlyMap<string, FairnessResourceCapacity>,
): number | FairnessContractRefusal {
  let total = 0;
  for (const capacity of capacities.values()) {
    const next = safeAdd(total, capacity.inFlightUnits);
    if (next === null) {
      return refuseRotation("FAIRNESS_CONTRACT_INVALID_COUNTER", "RESOURCE",
        "summed in-flight units leave the safe counter range", [capacity.resourceId]);
    }
    total = next;
  }
  return total;
}

/** Total validator for a whole rotation request. Decides nothing. */
export function validateRotationRequest(
  value: unknown,
): FairnessContractResult<FairnessRotationInputs> {
  const parsed = exactRecord(value, REQUEST_KEYS);
  if (parsed === null) {
    return refuseRotation("FAIRNESS_CONTRACT_MALFORMED_INPUT", "RING", "input is not a rotation request record");
  }
  const ring = validateRing(parsed["ring"]);
  if (!ring.ok) return ring;
  const workItems = validateWorkItemSet(parsed["workItems"], ring.value.dimensionId);
  if (!workItems.ok) return workItems;
  const items = new Map(workItems.value.map((each) => [each.workItemId, each]));
  const placement = checkPlacements(ring.value, items);
  if (placement !== null) return placement;
  const capacities = readCapacities(parsed["capacities"], ring.value);
  if (isFairnessRefusal(capacities)) return capacities;
  const totalInFlight = sumInFlight(capacities);
  if (isFairnessRefusal(totalInFlight)) return totalInFlight;
  const revision = checkCapRevision(parsed["capRevision"], ring.value, totalInFlight);
  if (revision !== null) return revision;
  const forcedHead = parsed["forcedHead"];
  if (forcedHead !== null && !isFairnessIdentity(forcedHead)) {
    return refuseRotation("FAIRNESS_CONTRACT_INVALID_IDENTITY", "RING", "forcedHead is not a safe fairness identity");
  }
  return acceptFairness({ ring: ring.value, items, capacities, forcedHead, totalInFlight });
}
