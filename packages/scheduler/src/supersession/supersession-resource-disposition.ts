/**
 * The RESOURCE family producer, split out so neither production source passes
 * the epic's 250-line bar. It is the largest family because a supersession
 * touches three separate landed authorities: the slot vocabulary, the drain
 * reducer, and the successor capacity grant.
 *
 * NOTHING here reimplements any of them. `SLOT_STATES` comes from the resource
 * model, drain runs through `parseDisposition` / `applyDrainReason` /
 * `releaseWork`, and successor capacity runs through `grantSuccessorCapacity`.
 * Each of those parses its own hostile input, which is why the caller's facts
 * are handed over whole rather than pre-validated here.
 */
import { exactRecord, oneOf } from "../authority/authority-kernel.js";
import { applyDrainReason, parseDisposition, releaseWork } from "../authority/lease-drain.js";
import { grantSuccessorCapacity } from "../authority/lease-resource.js";
import { SLOT_STATES } from "../authority/resource-model.js";
import {
  classOfKind, disposeFamily, refuseFamily,
  type FamilyOutcome, type SupersessionCarryRefusal, type SupersessionKindClass,
  type SupersessionNodeFacts,
} from "./supersession-disposition-contract.js";

/** Design 348: a supersession release is the graph-remove drain reason. */
export const SUPERSESSION_DRAIN_REASON = "GRAPH_REMOVE_OR_SUPERSESSION";
const RESOURCE_KEYS = ["drainDisposition", "release", "slotState", "successorCapacity"] as const;
const RELEASE_KEYS = ["authority", "lease", "request"] as const;
const CAPACITY_KEYS = ["proofRef", "rows"] as const;

function releaseDisposition(
  node: SupersessionNodeFacts,
  release: unknown,
  klass: SupersessionKindClass,
): FamilyOutcome {
  const parts = exactRecord(release, RELEASE_KEYS);
  if (parts === null) return refuseFamily("INPUT_INVALID", "RESOURCE");
  const released = releaseWork(parts["lease"], parts["authority"], parts["request"]);
  if (!released.ok) {
    return refuseFamily(
      released.issues[0]?.code === "AUTHORITY_MALFORMED_INPUT" ? "INPUT_INVALID" : "STALE_LEASE",
      "RESOURCE",
    );
  }
  const result = released.value;
  if (result.outcome === "NO_OP") return disposeFamily(node, "RESOURCE", "SLOT_ALREADY_TERMINAL", klass);
  // The caller's own release must be the supersession one, not an unrelated drain.
  if (!result.disposition.reasons.includes(SUPERSESSION_DRAIN_REASON)) {
    return refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "RESOURCE");
  }
  return disposeFamily(node, "RESOURCE", `SLOT_RELEASED_${result.outcome}`, klass);
}

/**
 * The successor takes the predecessor's capacity only where `lease-resource`
 * says it is safe to: a quarantined acquisition needs a fenceability or
 * reconciliation proof, and a still-held set is not free for the successor.
 * None of that judgement is restated here.
 */
function capacityRefusal(capacity: unknown): SupersessionCarryRefusal | null {
  if (capacity === null) return null;
  const parts = exactRecord(capacity, CAPACITY_KEYS);
  if (parts === null) return refuseFamily("INPUT_INVALID", "RESOURCE");
  const granted = grantSuccessorCapacity(parts["rows"], parts["proofRef"]);
  if (!granted.ok) {
    return refuseFamily(
      granted.issues[0]?.code === "AUTHORITY_MALFORMED_INPUT" ? "INPUT_INVALID" : "STALE_LEASE",
      "RESOURCE",
    );
  }
  return granted.value.held ? refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "RESOURCE") : null;
}

function carriedSlot(
  node: SupersessionNodeFacts,
  facts: Readonly<Record<string, unknown>>,
  slot: unknown,
  klass: SupersessionKindClass,
): FamilyOutcome {
  if (slot === "RELEASED") return refuseFamily("STALE_LEASE", "RESOURCE");
  if (facts["drainDisposition"] === null) return disposeFamily(node, "RESOURCE", "SLOT_HELD", klass);
  // A slot already draining is on its way out; carrying it would outlive it.
  return refuseFamily(parseDisposition(facts["drainDisposition"]) === null
    ? "INPUT_INVALID" : "SUPERSESSION_CONSEQUENCE_CHANGED", "RESOURCE");
}

export function resourceDisposition(node: SupersessionNodeFacts): FamilyOutcome {
  const klass = classOfKind(node.kind);
  if (klass === null) return refuseFamily("PLANNING_DISPOSITION_UNKNOWN", "RESOURCE");
  const facts = exactRecord(node.resource, RESOURCE_KEYS);
  if (facts === null) return refuseFamily("INPUT_INVALID", "RESOURCE");
  const slot = facts["slotState"];
  if (slot !== null && !oneOf(slot, SLOT_STATES)) return refuseFamily("INPUT_INVALID", "RESOURCE");
  if (klass === "ADD" || klass === "CARRY") {
    // Neither kind takes new capacity: ADD has no predecessor, CARRY keeps its slot.
    if (facts["successorCapacity"] !== null) {
      return refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "RESOURCE");
    }
  } else {
    const refused = capacityRefusal(facts["successorCapacity"]);
    if (refused !== null) return refused;
  }
  if (klass === "ADD") {
    return slot === null ? disposeFamily(node, "RESOURCE", "SLOT_ABSENT", klass)
      : refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "RESOURCE");
  }
  if (slot === null) return refuseFamily("SUPERSESSION_CONSEQUENCE_CHANGED", "RESOURCE");
  if (klass === "CARRY") return carriedSlot(node, facts, slot, klass);
  if (klass === "REMOVE") return releaseDisposition(node, facts["release"], klass);
  const drained = applyDrainReason(facts["drainDisposition"], SUPERSESSION_DRAIN_REASON);
  if (!drained.ok) return refuseFamily("INPUT_INVALID", "RESOURCE");
  return disposeFamily(node, "RESOURCE", `SLOT_DRAINED_${drained.value.terminalTarget}`, klass);
}
