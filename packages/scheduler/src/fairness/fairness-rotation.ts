/**
 * Bounded, work-conserving weighted deficit round-robin over a validated ring.
 *
 * Derived from the LANDED CONTRACT, not from the DEVELOPMENT_ONLY reference in
 * packages/testkit/src/scheduler-fairness — that source contains no ring, no
 * deficit and no resource queue, so there is nothing there to derive from.
 * ./fairness-ring.ts:12-20 delegates rotation, deficit accounting and aging to
 * this consumer by name; this module is that consumer.
 *
 * FOUR PROPERTIES, each resting on one decision made here.
 * DETERMINISTIC: order derives from `resourceId`, never array position —
 * ./fairness-ring.ts:54-58 gives `entries` no implied order BETWEEN queues, so a
 * re-serialized ring still selects identically; order WITHIN a queue is its FIFO
 * order and is honoured. WORK CONSERVING: a round credits only non-empty queues
 * and selection skips to the next resource, so an empty or blocked turn never
 * idles a ring still holding a servable head — the property a textbook deficit
 * loop misses. CAPACITY BOUNDED: a resource at capacity, or a dimension at its
 * ceiling, is not selected, and a forced head overrides neither, or forcing
 * would silently become a cap-raising mechanism. STARVATION BOUNDED: one round
 * serves sum(weights) items and credits every non-empty queue, so a queue of
 * weight w is served w times per round — arithmetic, not eventual.
 */
import { compareStrings } from "../authority/authority-kernel.js";
import { acceptFairness, isFairnessRefusal } from "./fairness-contract.js";
import type { FairnessContractRefusal, FairnessContractResult } from "./fairness-contract.js";
import { validateRing } from "./fairness-ring.js";
import type { FairnessRing, FairnessRingQueueEntry } from "./fairness-ring.js";
import {
  FAIRNESS_DIMENSION_CEILING, FAIRNESS_SERVICE_COST, refuseRotation, safeAdd,
  validateRotationRequest,
} from "./fairness-rotation-input.js";
import type { FairnessRotationInputs } from "./fairness-rotation-input.js";

export {
  FAIRNESS_DIMENSION_CEILING, FAIRNESS_SERVICE_COST, validateResourceCapacity,
  validateRotationRequest,
} from "./fairness-rotation-input.js";
export type { FairnessResourceCapacity, FairnessRotationInputs }
  from "./fairness-rotation-input.js";

export const FAIRNESS_ROTATION_DISPOSITIONS = Object.freeze([
  "SELECTED", "IDLE_CAPACITY_BOUND", "IDLE_NO_SERVABLE_HEAD",
] as const);
export type FairnessRotationDisposition = (typeof FAIRNESS_ROTATION_DISPOSITIONS)[number];

export interface FairnessRotationSelection {
  readonly workItemId: string;
  readonly resourceId: string;
}

export interface FairnessRotationOutcome {
  readonly disposition: FairnessRotationDisposition;
  readonly selection: FairnessRotationSelection | null;
  /** The ring to carry into the next call: dequeued, credited, never reordered. */
  readonly ring: FairnessRing;
  readonly roundsAdvanced: number;
}

interface QueueHead {
  readonly resourceId: string;
  readonly weight: number;
  readonly index: number;
  readonly entry: FairnessRingQueueEntry;
}

function outcome(
  disposition: FairnessRotationDisposition, selection: FairnessRotationSelection | null,
  ring: FairnessRing, entries: readonly FairnessRingQueueEntry[], roundsAdvanced: number,
): FairnessContractResult<FairnessRotationOutcome> {
  const next = {
    ringId: ring.ringId, dimensionId: ring.dimensionId, resources: ring.resources, entries,
  };
  return acceptFairness({ disposition, selection, roundsAdvanced, ring: next });
}

/**
 * Declared resources in the total order derived from `resourceId`. Exported so a
 * consumer — and the determinism test — asserts against the production order
 * rather than a re-implementation of it.
 */
export function resourceRotationOrder(value: unknown): FairnessContractResult<readonly string[]> {
  const ring = validateRing(value);
  if (!ring.ok) return ring;
  return acceptFairness(orderedResourceIds(ring.value));
}

function orderedResourceIds(ring: FairnessRing): readonly string[] {
  return [...ring.resources.map((each) => each.resourceId)].sort(compareStrings);
}

/** Head of each non-empty queue, in derived resource order, FIFO within a queue. */
function queueHeads(
  ring: FairnessRing, entries: readonly FairnessRingQueueEntry[],
): readonly QueueHead[] {
  const heads: QueueHead[] = [];
  for (const resourceId of orderedResourceIds(ring)) {
    const index = entries.findIndex((each) => each.resourceId === resourceId);
    if (index < 0) continue;
    const weight = ring.resources.find((each) => each.resourceId === resourceId)?.weight ?? 0;
    heads.push({ resourceId, weight, index, entry: entries[index] as FairnessRingQueueEntry });
  }
  return heads;
}

type HeadState = "SERVABLE" | "CAPACITY_BLOCKED" | "NOT_DISPATCHABLE";

function headState(head: QueueHead, inputs: FairnessRotationInputs): HeadState {
  const capacity = inputs.capacities.get(head.resourceId);
  if (capacity === undefined || capacity.inFlightUnits >= capacity.capacityUnits) {
    return "CAPACITY_BLOCKED";
  }
  const item = inputs.items.get(head.entry.workItemId);
  return item?.dispatchability.state === "DISPATCHABLE" ? "SERVABLE" : "NOT_DISPATCHABLE";
}

/** First servable head, in derived order, whose credit covers one service unit. */
function pick(heads: readonly QueueHead[], inputs: FairnessRotationInputs): QueueHead | null {
  for (const head of heads) {
    if (headState(head, inputs) !== "SERVABLE") continue;
    if (head.entry.deficitCounter >= FAIRNESS_SERVICE_COST) return head;
  }
  return null;
}

/**
 * Credits every non-empty queue by its resource's weight, INCLUDING one blocked
 * by capacity: blocking is transient and dropping its credit would turn a short
 * block into lost share. That is also the only reason this add can overflow at
 * all, and why it is guarded.
 */
function advanceRound(
  heads: readonly QueueHead[], entries: readonly FairnessRingQueueEntry[],
): readonly FairnessRingQueueEntry[] | FairnessContractRefusal {
  const credited = [...entries];
  for (const head of heads) {
    const next = safeAdd(head.entry.deficitCounter, head.weight);
    if (next === null) {
      return refuseRotation("FAIRNESS_CONTRACT_INVALID_COUNTER", "RING",
        "advancing a round would push a deficit past the safe counter range",
        [head.entry.workItemId, head.resourceId]);
    }
    credited[head.index] = { ...head.entry, deficitCounter: next };
  }
  return credited;
}

/**
 * Removes the selected head and carries its residual credit to the queue's next
 * head. An emptied queue drops the residual — the classic deficit-round-robin
 * reset, which stops an intermittent queue banking share it never used.
 */
function dequeue(
  entries: readonly FairnessRingQueueEntry[], head: QueueHead,
): readonly FairnessRingQueueEntry[] | FairnessContractRefusal {
  const residual = head.entry.deficitCounter - FAIRNESS_SERVICE_COST;
  const remaining = entries.filter((_, index) => index !== head.index);
  const nextIndex = remaining.findIndex((each) => each.resourceId === head.resourceId);
  if (nextIndex < 0 || residual === 0) return remaining;
  const successor = remaining[nextIndex] as FairnessRingQueueEntry;
  const carried = safeAdd(successor.deficitCounter, residual);
  if (carried === null) {
    return refuseRotation("FAIRNESS_CONTRACT_INVALID_COUNTER", "RING",
      "carrying a residual deficit onto the next head would leave the safe counter range",
      [successor.workItemId, head.resourceId]);
  }
  const carriedEntries = [...remaining];
  carriedEntries[nextIndex] = { ...successor, deficitCounter: carried };
  return carriedEntries;
}

/**
 * A forced head bypasses the derived order but NOT the bounds: it must be
 * queued, within capacity and dispatchable, or the call refuses rather than
 * quietly falling back to normal rotation. Its credit is spent, not carried, so
 * forcing cannot bank share for the queue behind it. DISPATCHABILITY_UNOBSERVED
 * is the only dispatchability member of the closed code tuple, so it carries
 * "not dispatchable" too; the message distinguishes them.
 */
function forcedSelection(
  inputs: FairnessRotationInputs, forcedHead: string,
): FairnessContractResult<FairnessRotationOutcome> {
  const { ring } = inputs;
  const index = ring.entries.findIndex((each) => each.workItemId === forcedHead);
  if (index < 0) {
    return refuseRotation("FAIRNESS_CONTRACT_INVALID_IDENTITY", "RING",
      "the forced head is not queued on the ring", [forcedHead]);
  }
  const entry = ring.entries[index] as FairnessRingQueueEntry;
  const capacity = inputs.capacities.get(entry.resourceId);
  if (capacity === undefined || capacity.inFlightUnits >= capacity.capacityUnits) {
    return refuseRotation("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "RING",
      "the forced head's resource is at capacity", [forcedHead, entry.resourceId]);
  }
  if (inputs.items.get(forcedHead)?.dispatchability.state !== "DISPATCHABLE") {
    return refuseRotation("FAIRNESS_CONTRACT_DISPATCHABILITY_UNOBSERVED", "RING",
      "the forced head is not dispatchable", [forcedHead]);
  }
  return outcome(
    "SELECTED", { workItemId: forcedHead, resourceId: entry.resourceId },
    ring, ring.entries.filter((_, position) => position !== index), 0);
}

function idleDisposition(
  heads: readonly QueueHead[], inputs: FairnessRotationInputs,
): FairnessRotationDisposition {
  return heads.some((head) => headState(head, inputs) === "CAPACITY_BLOCKED")
    ? "IDLE_CAPACITY_BOUND" : "IDLE_NO_SERVABLE_HEAD";
}

/**
 * One selection. At most one round is advanced per call: after a round every
 * non-empty queue holds at least its weight, which the input boundary already
 * refused below one service unit, so a second advance could only mean every head
 * is blocked — an idle, not a stall.
 */
export function rotateOnce(value: unknown): FairnessContractResult<FairnessRotationOutcome> {
  const validated = validateRotationRequest(value);
  if (!validated.ok) return validated;
  const inputs = validated.value;
  const { ring, forcedHead } = inputs;
  if (inputs.totalInFlight >= FAIRNESS_DIMENSION_CEILING) {
    if (forcedHead !== null) {
      return refuseRotation("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "RING",
        "a forced head cannot be admitted at the per-dimension ceiling", [forcedHead]);
    }
    return outcome("IDLE_CAPACITY_BOUND", null, ring, ring.entries, 0);
  }
  if (forcedHead !== null) return forcedSelection(inputs, forcedHead);
  let entries = ring.entries;
  let heads = queueHeads(ring, entries);
  let chosen = pick(heads, inputs);
  let roundsAdvanced = 0;
  if (chosen === null && heads.length > 0) {
    const credited = advanceRound(heads, entries);
    if (isFairnessRefusal(credited)) return credited;
    entries = credited;
    roundsAdvanced = 1;
    heads = queueHeads(ring, entries);
    chosen = pick(heads, inputs);
  }
  if (chosen === null) {
    return outcome(idleDisposition(heads, inputs), null, ring, entries, roundsAdvanced);
  }
  const served = dequeue(entries, chosen);
  if (isFairnessRefusal(served)) return served;
  const selection = { workItemId: chosen.entry.workItemId, resourceId: chosen.resourceId };
  return outcome("SELECTED", selection, ring, served, roundsAdvanced);
}
