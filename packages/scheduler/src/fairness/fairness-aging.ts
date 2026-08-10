/**
 * Compatible-opportunity aging: the rule that turns "eventually served" into the
 * numeric starvation bound DoD 1 requires. A work item passed over while a
 * COMPATIBLE opportunity was dispatched gains standing, one class per proven
 * quantum, and is forced once it can gain no more.
 *
 * Derived from the landed contract, which delegates aging to this consumer by
 * name (./fairness-ring.ts:12-20). The DEVELOPMENT_ONLY reference is not, and
 * cannot be, imported: @moe/scheduler declares no @moe/testkit dependency and
 * DoD 3 forbids one, so the two policy constants below are REDECLARED with their
 * source cited and pinned by test against drift.
 *
 * AGING IS NOT A SECOND AUTHORITY. It changes SELECTION ORDER only. It never
 * raises a capacity, never relaxes a cap revision, never edits a dimension
 * identity, and never invents evidence: a promotion that would sit above a
 * capacity or a revised cap REFUSES instead, and an unverifiable attestation
 * stays UNKNOWN. Every refusal reuses ./fairness-contract.ts's closed vocabulary
 * — that tuple lives in a module this task does not own, so no code can be
 * minted here even in principle.
 */
import { exactRecord } from "../authority/authority-kernel.js";
import { validateCapRevision } from "./fairness-cap-revision.js";
import {
  acceptFairness, isFairnessIdentity, isFairnessRefusal,
} from "./fairness-contract.js";
import type {
  FairnessContractRefusal, FairnessContractResult, FairnessPriorityClass,
} from "./fairness-contract.js";
import { validateBypassClaim } from "./fairness-evidence.js";
import { refuseRotation, validateResourceCapacity } from "./fairness-rotation-input.js";
import type { FairnessResourceCapacity } from "./fairness-rotation-input.js";
import { validateWorkItem } from "./fairness-work-item.js";
import type { FairnessWorkItem } from "./fairness-work-item.js";

/**
 * Bypasses required to advance one class. Mirrors BYPASSES_PER_LEVEL = 8 at
 * packages/testkit/src/scheduler-fairness/fairness-policy.ts:25.
 */
export const FAIRNESS_BYPASSES_PER_LEVEL = 8;

/**
 * Highest standing first. Mirrors PRIORITY_LADDER at fairness-policy.ts:17-22.
 * FAIRNESS_PRIORITY_CLASSES lists the same members but attaches no ordering
 * meaning (fairness-contract.ts:80-83); this constant supplies the ORDER, and
 * only the order — a test asserts the two sets stay identical.
 */
export const FAIRNESS_PRIORITY_LADDER = Object.freeze([
  "P0", "P1", "P2", "P3",
] as const satisfies readonly FairnessPriorityClass[]);

/**
 * Proven bypasses after which the lowest class is forced: four quanta, matching
 * bucketsToForced("P3", false) = 4 at fairness-policy.ts:35-49. This is the
 * starvation bound — no item waits longer than this many compatible
 * opportunities before it must be served.
 */
export const FAIRNESS_FORCED_BYPASS_BOUND =
  FAIRNESS_PRIORITY_LADDER.length * FAIRNESS_BYPASSES_PER_LEVEL;

export interface FairnessAgedStanding {
  readonly workItemId: string;
  readonly basePriority: FairnessPriorityClass;
  readonly effectivePriority: FairnessPriorityClass;
  readonly provenBypasses: number;
  readonly levelsPromoted: number;
  readonly forced: boolean;
  /** True when forcing was EARNED but withheld because another head holds it. */
  readonly forcedWithheld: boolean;
}

const REQUEST_KEYS = Object.freeze([
  "workItem", "bypassClaim", "capacity", "capRevision", "forcedHead",
] as const);

interface AgingInputs {
  readonly workItem: FairnessWorkItem;
  readonly provenBypasses: number;
  readonly capacity: FairnessResourceCapacity;
  readonly revisedCapUnits: number | null;
  readonly forcedHead: string | null;
}

/**
 * Bypasses needed to force an item currently in `priority`, counting the current
 * partial bucket as a whole one. Mirrors bucketsToForced (fairness-policy.ts:35-49)
 * scaled by the quantum: P0 needs one bucket, P3 needs four.
 */
export function bypassesToForced(priority: FairnessPriorityClass): number {
  const rank = FAIRNESS_PRIORITY_LADDER.indexOf(priority);
  // A class outside the ladder is unreachable through ageWorkItem, because
  // validateWorkItem constrains priority to the contract's closed set. But this
  // is exported from the package root, so an untyped caller can reach it, and
  // `indexOf` would answer -1 -> ZERO bypasses -> forced for free. An unknown
  // class demands the MAXIMUM evidence instead: unknown never buys standing.
  if (rank < 0) return FAIRNESS_FORCED_BYPASS_BOUND;
  return (rank + 1) * FAIRNESS_BYPASSES_PER_LEVEL;
}

function readCapRevision(
  value: unknown, workItem: FairnessWorkItem,
): number | null | FairnessContractRefusal {
  if (value === null) return null;
  const revision = validateCapRevision(value);
  if (!revision.ok) return revision;
  if (revision.value.dimensionId !== workItem.dimensionId) {
    return refuseRotation("FAIRNESS_CONTRACT_DIMENSION_MISMATCH", "CAP_REVISION",
      "the revision names a different compatibility dimension", [revision.value.revisionRef]);
  }
  if (revision.value.drainedWorkItemIds.includes(workItem.workItemId)) {
    return refuseRotation("FAIRNESS_CONTRACT_MIGRATION_TARGET_DRAINED", "CAP_REVISION",
      "the revision has drained this work item", [workItem.workItemId]);
  }
  return revision.value.toCapUnits;
}

/**
 * The claim must be raised BY the work item being aged. A claim naming another
 * claimant would import a stranger's evidence, which is the same fail-open the
 * evidence contract closes by counting attestations rather than copying a count.
 */
function readProvenBypasses(
  value: unknown, workItem: FairnessWorkItem,
): number | FairnessContractRefusal {
  const proven = validateBypassClaim(value);
  if (!proven.ok) return proven;
  if (proven.value.workItemId !== workItem.workItemId) {
    return refuseRotation("FAIRNESS_CONTRACT_INVALID_IDENTITY", "OPPORTUNITY_EVIDENCE",
      "the bypass claim names a different claimant", [proven.value.workItemId]);
  }
  return proven.value.provenBypasses;
}

function readCapacity(
  value: unknown, workItem: FairnessWorkItem,
): FairnessResourceCapacity | FairnessContractRefusal {
  const capacity = validateResourceCapacity(value);
  if (!capacity.ok) return capacity;
  if (capacity.value.resourceId !== workItem.resourceId) {
    return refuseRotation("FAIRNESS_CONTRACT_UNDECLARED_RESOURCE", "RESOURCE",
      "the capacity record names a different resource than the work item",
      [workItem.workItemId, capacity.value.resourceId]);
  }
  return capacity.value;
}

function validateAgingRequest(value: unknown): FairnessContractResult<AgingInputs> {
  const parsed = exactRecord(value, REQUEST_KEYS);
  if (parsed === null) {
    return refuseRotation("FAIRNESS_CONTRACT_MALFORMED_INPUT", "WORK_ITEM",
      "input is not an aging request record");
  }
  const item = validateWorkItem(parsed["workItem"]);
  if (!item.ok) return item;
  const workItem = item.value;
  const provenBypasses = readProvenBypasses(parsed["bypassClaim"], workItem);
  if (isFairnessRefusal(provenBypasses)) return provenBypasses;
  const capacity = readCapacity(parsed["capacity"], workItem);
  if (isFairnessRefusal(capacity)) return capacity;
  const revisedCapUnits = readCapRevision(parsed["capRevision"], workItem);
  if (isFairnessRefusal(revisedCapUnits)) return revisedCapUnits;
  const forcedHead = parsed["forcedHead"];
  if (forcedHead !== null && !isFairnessIdentity(forcedHead)) {
    return refuseRotation("FAIRNESS_CONTRACT_INVALID_IDENTITY", "WORK_ITEM",
      "forcedHead is not a safe fairness identity");
  }
  return acceptFairness({
    workItem, provenBypasses, capacity, revisedCapUnits, forcedHead,
  });
}

/**
 * Capacity outranks aging, and the check is tied to the PROMOTION rather than
 * applied unconditionally: an item that earned nothing is reported unpromoted at
 * a full resource rather than refused. Refusing unconditionally would look
 * identical in a single test while severing the precedence it claims to prove.
 */
function checkPromotionHeadroom(
  inputs: AgingInputs, promoted: boolean,
): FairnessContractRefusal | null {
  if (!promoted) return null;
  const { capacity, revisedCapUnits, workItem } = inputs;
  if (capacity.inFlightUnits >= capacity.capacityUnits) {
    return refuseRotation("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "RESOURCE",
      "aging cannot promote into a resource that is at capacity",
      [workItem.workItemId, capacity.resourceId]);
  }
  if (revisedCapUnits !== null && capacity.inFlightUnits >= revisedCapUnits) {
    return refuseRotation("FAIRNESS_CONTRACT_CARDINALITY_EXCEEDED", "CAP_REVISION",
      "aging cannot promote past the revised cap", [workItem.workItemId]);
  }
  return null;
}

/**
 * Pure over validated inputs. `provenBypasses` is bounded by the attestation
 * cardinality the evidence contract enforces, so the ladder arithmetic here
 * cannot leave the safe-integer range and needs no separate guard — unlike the
 * rotation deficits, which accumulate across calls.
 */
export function ageWorkItem(value: unknown): FairnessContractResult<FairnessAgedStanding> {
  const validated = validateAgingRequest(value);
  if (!validated.ok) return validated;
  const inputs = validated.value;
  const { workItem, provenBypasses, forcedHead } = inputs;
  const basePriority = workItem.priority;
  const baseRank = FAIRNESS_PRIORITY_LADDER.indexOf(basePriority);
  const earned = Math.floor(provenBypasses / FAIRNESS_BYPASSES_PER_LEVEL);
  const levelsPromoted = Math.min(earned, baseRank);
  const effectivePriority =
    FAIRNESS_PRIORITY_LADDER[baseRank - levelsPromoted] as FairnessPriorityClass;
  const earnsForcing = provenBypasses >= bypassesToForced(basePriority);
  const withheld = earnsForcing && forcedHead !== null && forcedHead !== workItem.workItemId;
  const headroom = checkPromotionHeadroom(inputs, levelsPromoted > 0 || earnsForcing);
  if (headroom !== null) return headroom;
  return acceptFairness({
    workItemId: workItem.workItemId,
    basePriority,
    effectivePriority,
    provenBypasses,
    levelsPromoted,
    forced: earnsForcing && !withheld,
    forcedWithheld: withheld,
  });
}
