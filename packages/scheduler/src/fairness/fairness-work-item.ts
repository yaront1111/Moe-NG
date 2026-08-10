/**
 * Production scheduler fairness contracts — the WorkItem family.
 *
 * Split from ./fairness-contract.ts so each source stays inside the per-file
 * line target; the shared vocabularies and result plumbing live there.
 *
 * Structure only: this module validates a work item and a dimension-scoped set
 * of them. It never orders, ranks, charges or ages one.
 */
import { exactRecord, oneOf } from "../authority/authority-kernel.js";
import {
  FAIRNESS_DISPATCHABILITY_STATES,
  FAIRNESS_PRIORITY_CLASSES,
  acceptFairness,
  isFairnessIdentity,
  isFairnessRefusal,
  makeFairnessIssue,
  readFairnessItems,
  refuseFairness,
  unknownFairness,
} from "./fairness-contract.js";
import type {
  FairnessContractRefusal,
  FairnessContractResult,
  FairnessDispatchabilityState,
  FairnessPriorityClass,
} from "./fairness-contract.js";

/**
 * A dispatchability claim WITH the observation that backs it. The reference
 * carries a bare `dispatchable: boolean` documented "caller-confirmed", which
 * admits an unbacked assertion as truth. A null `observationRef` is
 * representable here and yields UNKNOWN naming the missing input.
 */
export interface FairnessDispatchabilityFact {
  readonly state: FairnessDispatchabilityState;
  readonly observationRef: string | null;
}

/**
 * One unit of fairness-schedulable work. `resourceId` exists because a WDRR ring
 * cannot place an item without knowing its queue; the reference's ticket has no
 * resource field at all. Aging state (bypass counters, forced flags, eligibility
 * events) is deliberately absent: aging is the consumer's decision.
 */
export interface FairnessWorkItem {
  readonly workItemId: string;
  readonly dimensionId: string;
  readonly priority: FairnessPriorityClass;
  readonly resourceId: string;
  readonly dispatchability: FairnessDispatchabilityFact;
}

const WORK_ITEM_KEYS = Object.freeze([
  "workItemId", "dimensionId", "priority", "resourceId", "dispatchability",
] as const);
const DISPATCHABILITY_KEYS = Object.freeze(["state", "observationRef"] as const);

function malformed(message: string): FairnessContractRefusal {
  return refuseFairness(
    makeFairnessIssue("FAIRNESS_CONTRACT_MALFORMED_INPUT", "WORK_ITEM", message),
  );
}

function invalidIdentity(field: string): FairnessContractRefusal {
  return refuseFairness(makeFairnessIssue(
    "FAIRNESS_CONTRACT_INVALID_IDENTITY", "WORK_ITEM", `${field} is not a safe fairness identity`,
  ));
}

function readDispatchability(
  value: unknown,
): FairnessDispatchabilityFact | FairnessContractRefusal {
  const parsed = exactRecord(value, DISPATCHABILITY_KEYS);
  if (parsed === null) return malformed("dispatchability is not a dispatchability fact");
  const state = parsed["state"];
  if (!oneOf(state, FAIRNESS_DISPATCHABILITY_STATES)) {
    return malformed("dispatchability.state is outside the closed state set");
  }
  const observationRef = parsed["observationRef"];
  if (observationRef === null) {
    return unknownFairness(
      "FAIRNESS_CONTRACT_DISPATCHABILITY_UNOBSERVED", "WORK_ITEM",
      "dispatchability.observationRef",
    );
  }
  if (!isFairnessIdentity(observationRef)) return invalidIdentity("dispatchability.observationRef");
  return { state, observationRef };
}

/**
 * Total: every input yields an accepted value, a REFUSED, or an UNKNOWN. One
 * issue per refusal, the first violation in this fixed field order — shape,
 * identities, priority, then dispatchability. Accumulating issues would impose a
 * presentation order the contracts have no business owning.
 */
export function validateWorkItem(value: unknown): FairnessContractResult<FairnessWorkItem> {
  const parsed = exactRecord(value, WORK_ITEM_KEYS);
  if (parsed === null) return malformed("input is not a work-item record");
  const workItemId = parsed["workItemId"];
  const dimensionId = parsed["dimensionId"];
  const resourceId = parsed["resourceId"];
  if (!isFairnessIdentity(workItemId)) return invalidIdentity("workItemId");
  if (!isFairnessIdentity(dimensionId)) return invalidIdentity("dimensionId");
  if (!isFairnessIdentity(resourceId)) return invalidIdentity("resourceId");
  const priority = parsed["priority"];
  if (!oneOf(priority, FAIRNESS_PRIORITY_CLASSES)) {
    return refuseFairness(makeFairnessIssue(
      "FAIRNESS_CONTRACT_INVALID_PRIORITY", "WORK_ITEM",
      "priority is outside the closed class set", null, [workItemId],
    ));
  }
  const dispatchability = readDispatchability(parsed["dispatchability"]);
  if (isFairnessRefusal(dispatchability)) return dispatchability;
  return acceptFairness({ workItemId, dimensionId, priority, resourceId, dispatchability });
}

/**
 * A set of work items scoped to one declared compatibility dimension. Caller
 * order is preserved verbatim: any ordering is the consumer's decision.
 */
export function validateWorkItemSet(
  value: unknown,
  expectedDimensionId: unknown,
): FairnessContractResult<readonly FairnessWorkItem[]> {
  if (!isFairnessIdentity(expectedDimensionId)) return invalidIdentity("expectedDimensionId");
  const items = readFairnessItems(value, "WORK_ITEM", "work item set");
  if (isFairnessRefusal(items)) return items;
  const validated: FairnessWorkItem[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const item = validateWorkItem(raw);
    if (!item.ok) return item;
    if (item.value.dimensionId !== expectedDimensionId) {
      return refuseFairness(makeFairnessIssue(
        "FAIRNESS_CONTRACT_DIMENSION_MISMATCH", "WORK_ITEM",
        "work item names a different compatibility dimension", null, [item.value.workItemId],
      ));
    }
    if (seen.has(item.value.workItemId)) {
      return refuseFairness(makeFairnessIssue(
        "FAIRNESS_CONTRACT_DUPLICATE_IDENTITY", "WORK_ITEM",
        "workItemId appears twice in the set", null, [item.value.workItemId],
      ));
    }
    seen.add(item.value.workItemId);
    validated.push(item.value);
  }
  return acceptFairness(validated);
}
