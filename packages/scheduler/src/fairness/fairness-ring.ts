/**
 * Production scheduler fairness contracts — the RING and RESOURCE families.
 *
 * These two families share a file because a weighted deficit round-robin ring
 * HOLDS per-resource queues; separating them would force a circular import.
 *
 * Designed from a measured void, not from the DEVELOPMENT_ONLY reference:
 * `grep -rnE 'ring|Ring|resourceQueue|ResourceQueue|WDRR|deficit'` over
 * packages/testkit/src/scheduler-fairness returns nothing outside its tests, so
 * there is no ring vocabulary to copy even in principle.
 *
 * STRUCTURE ONLY. This module can DESCRIBE a ring and VALIDATE that a given ring
 * is well-formed. It cannot say whose turn it is, cannot compute a deficit
 * increment, and never reorders anything — caller order is preserved verbatim,
 * deliberately unlike ../authority/resource-model.ts, which sorts declared
 * resources. Rotation, deficit accounting and aging belong to the consumer,
 * task-10cab3e5 (Fair scheduler production).
 *
 * `weight` and `deficitCounter` are DATA the contract range-checks. Naming them
 * does not grant the contract permission to change them.
 */
import { exactRecord, isCount } from "../authority/authority-kernel.js";
import {
  acceptFairness,
  isFairnessIdentity,
  isFairnessRefusal,
  makeFairnessIssue,
  readFairnessItems,
  refuseFairness,
} from "./fairness-contract.js";
import type {
  FairnessContractIssueCode,
  FairnessContractRefusal,
  FairnessContractResult,
} from "./fairness-contract.js";

/** One resource a ring serves. `weight` is the caller's WDRR share, as data. */
export interface FairnessRingResource {
  readonly resourceId: string;
  readonly weight: number;
}

/**
 * One queued work item and its per-item deficit counter. The counter is carried
 * so a consumer can persist and restore rotation state; this module never reads
 * it as a position and never advances it.
 */
export interface FairnessRingQueueEntry {
  readonly workItemId: string;
  readonly resourceId: string;
  readonly deficitCounter: number;
}

/**
 * A ring scoped to one compatibility dimension. `entries` is the flat union of
 * every per-resource queue: an entry's `resourceId` names the queue it sits in,
 * which keeps the shape free of any implied traversal order between queues.
 */
export interface FairnessRing {
  readonly ringId: string;
  readonly dimensionId: string;
  readonly resources: readonly FairnessRingResource[];
  readonly entries: readonly FairnessRingQueueEntry[];
}

const RESOURCE_KEYS = Object.freeze(["resourceId", "weight"] as const);
const ENTRY_KEYS = Object.freeze(["workItemId", "resourceId", "deficitCounter"] as const);
const RING_KEYS = Object.freeze(["ringId", "dimensionId", "resources", "entries"] as const);

function resourceRefusal(
  code: FairnessContractIssueCode,
  message: string,
  subjects: readonly string[] = [],
): FairnessContractRefusal {
  return refuseFairness(makeFairnessIssue(code, "RESOURCE", message, null, subjects));
}

function ringRefusal(
  code: FairnessContractIssueCode,
  message: string,
  subjects: readonly string[] = [],
): FairnessContractRefusal {
  return refuseFairness(makeFairnessIssue(code, "RING", message, null, subjects));
}

/**
 * Total validator for one declared resource. Refuses under the RESOURCE layer,
 * so a caller can tell a bad resource declaration from a bad ring invariant.
 */
export function validateRingResource(
  value: unknown,
): FairnessContractResult<FairnessRingResource> {
  const parsed = exactRecord(value, RESOURCE_KEYS);
  if (parsed === null) {
    return resourceRefusal("FAIRNESS_CONTRACT_MALFORMED_INPUT", "input is not a resource record");
  }
  const resourceId = parsed["resourceId"];
  if (!isFairnessIdentity(resourceId)) {
    return resourceRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "resourceId is not a safe fairness identity",
    );
  }
  const weight = parsed["weight"];
  if (!isCount(weight)) {
    return resourceRefusal(
      "FAIRNESS_CONTRACT_INVALID_COUNTER", "weight is not a non-negative safe integer", [resourceId],
    );
  }
  return acceptFairness({ resourceId, weight });
}

function readEntry(
  value: unknown,
): FairnessRingQueueEntry | FairnessContractRefusal {
  const parsed = exactRecord(value, ENTRY_KEYS);
  if (parsed === null) {
    return ringRefusal("FAIRNESS_CONTRACT_MALFORMED_INPUT", "a queue entry is not an entry record");
  }
  const workItemId = parsed["workItemId"];
  const resourceId = parsed["resourceId"];
  if (!isFairnessIdentity(workItemId)) {
    return ringRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "workItemId is not a safe fairness identity",
    );
  }
  if (!isFairnessIdentity(resourceId)) {
    return ringRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "resourceId is not a safe fairness identity",
      [workItemId],
    );
  }
  const deficitCounter = parsed["deficitCounter"];
  if (!isCount(deficitCounter)) {
    return ringRefusal(
      "FAIRNESS_CONTRACT_INVALID_COUNTER", "deficitCounter is not a non-negative safe integer",
      [workItemId],
    );
  }
  return { workItemId, resourceId, deficitCounter };
}

function readResources(
  value: unknown,
): readonly FairnessRingResource[] | FairnessContractRefusal {
  const items = readFairnessItems(value, "RING", "resources");
  if (isFairnessRefusal(items)) return items;
  const declared: FairnessRingResource[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const resource = validateRingResource(raw);
    if (!resource.ok) return resource;
    if (seen.has(resource.value.resourceId)) {
      return ringRefusal(
        "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "resourceId is declared twice",
        [resource.value.resourceId],
      );
    }
    seen.add(resource.value.resourceId);
    declared.push(resource.value);
  }
  return declared;
}

/**
 * Structural invariants checked in this fixed order: every entry is well-formed;
 * a non-empty queue requires a declared resource set; every entry names a
 * declared resource; no (workItemId, resourceId) pair repeats; and no work item
 * sits in two different resource queues. Each violation refuses with its own
 * code, so a consumer never has to guess which invariant failed.
 */
function checkEntries(
  entries: readonly FairnessRingQueueEntry[],
  declared: ReadonlySet<string>,
): FairnessContractRefusal | null {
  if (entries.length > 0 && declared.size === 0) {
    return ringRefusal(
      "FAIRNESS_CONTRACT_EMPTY_RESOURCE_SET", "a queue holds items but no resource is declared",
    );
  }
  const placements = new Map<string, string>();
  for (const entry of entries) {
    if (!declared.has(entry.resourceId)) {
      return ringRefusal(
        "FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", "a queue entry names an undeclared resource",
        [entry.workItemId, entry.resourceId],
      );
    }
    const placed = placements.get(entry.workItemId);
    if (placed === entry.resourceId) {
      return ringRefusal(
        "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "a work item is queued twice on one resource",
        [entry.workItemId, entry.resourceId],
      );
    }
    if (placed !== undefined) {
      return ringRefusal(
        "FAIRNESS_CONTRACT_ITEM_IN_MULTIPLE_QUEUES", "a work item is queued on two resources",
        [entry.workItemId, placed, entry.resourceId],
      );
    }
    placements.set(entry.workItemId, entry.resourceId);
  }
  return null;
}

/** Total validator for a whole ring. Never orders, never charges, never ages. */
export function validateRing(value: unknown): FairnessContractResult<FairnessRing> {
  const parsed = exactRecord(value, RING_KEYS);
  if (parsed === null) {
    return ringRefusal("FAIRNESS_CONTRACT_MALFORMED_INPUT", "input is not a ring record");
  }
  const ringId = parsed["ringId"];
  const dimensionId = parsed["dimensionId"];
  if (!isFairnessIdentity(ringId)) {
    return ringRefusal("FAIRNESS_CONTRACT_INVALID_IDENTITY", "ringId is not a safe fairness identity");
  }
  if (!isFairnessIdentity(dimensionId)) {
    return ringRefusal(
      "FAIRNESS_CONTRACT_INVALID_IDENTITY", "dimensionId is not a safe fairness identity",
    );
  }
  const resources = readResources(parsed["resources"]);
  if (isFairnessRefusal(resources)) return resources;
  const rawEntries = readFairnessItems(parsed["entries"], "RING", "entries");
  if (isFairnessRefusal(rawEntries)) return rawEntries;
  const entries: FairnessRingQueueEntry[] = [];
  for (const raw of rawEntries) {
    const entry = readEntry(raw);
    if (isFairnessRefusal(entry)) return entry;
    entries.push(entry);
  }
  const invariant = checkEntries(entries, new Set(resources.map((each) => each.resourceId)));
  if (invariant !== null) return invariant;
  return acceptFairness({ ringId, dimensionId, resources, entries });
}
