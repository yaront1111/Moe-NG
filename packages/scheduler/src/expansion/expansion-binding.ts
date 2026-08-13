/**
 * The production bridge from scheduler ADMISSION to core PREPARATION.
 *
 * WHY HERE. `@moe/core` declares only `@moe/contracts`; `@moe/scheduler` already declares
 * `@moe/core`. A bridge on the core side would reverse that edge, so it sits here and consumes
 * the public `@moe/core` ROOT — never a subpath. It is a separate source from
 * `expansion-preparation.ts` (which owns the admission REQUEST envelope and the identity bytes)
 * because holding both would put one file over the 400-line cap.
 *
 * THE PARTITION IS THE WHOLE DESIGN. The scheduler's bound facts carry twenty-four leaves.
 * Fifteen are carried into a NAMED core field; the remaining nine — scheduler-only facts core
 * has no field for — go into ONE canonical projection digested into `admitted.evidenceDigest`.
 * Nothing appears in both. Binding a fact twice is not extra safety but the opposite: an
 * aggregate digest beside an individually bound field makes DROPPING the field undetectable,
 * because perturbing it still moves the digest. That defect was measured on this board. The
 * partition itself, and the leaf-by-leaf reader that feeds it, live in `expansion-binding-facts`
 * — split out under the per-file cap along the seam that was already there: this file owns the
 * ORDER the gates run in and the words a refusal is spoken in, that one owns the bytes.
 *
 * WHAT A CALLER MAY SUPPLY. Raw evidence for validation — one opportunity attestation, one
 * reducer-produced hold, the daemon's own current authority — and never a verdict.
 * `DAEMON_VERIFIED` is set HERE, after the hold replays through the core reducer and all five
 * current-authority values match; `opportunityRef` comes from the validated attestation and is
 * never synthesised from a work item id. Missing or unreadable current authority stays UNKNOWN
 * rather than being read as agreement.
 *
 * ONE STATED LIMIT, MEASURED NOT ASSUMED. A hold whose terminal receipt has been stripped is
 * byte-identical to a live one and replays into an ACTIVE state, so no amount of inspecting the
 * VALUE can tell the two apart. `currentAuthority.holdVersion` is what separates them, which is
 * why all five values are required rather than optional: the bridge is only as honest as the
 * daemon-current authority it is handed, and it says so instead of implying more.
 *
 * Production consumer: task-c4171c1cfe854cb78dd233794b342025 (daemon persistence of the
 * prepared/approved binding). No child run, lease, effect, slot or graph activation is minted.
 */
import { inspectPlanningExpansionContract, reduceExpansionPlanningHold } from "@moe/core";
import type {
  ExpansionAdmittedFacts, ExpansionPlanningHoldState, PlanningExpansionHoldBinding,
} from "@moe/core";

import { deepFreeze, exactRecord, isCount, isRef } from "../authority/authority-kernel.js";
import { isFairnessRefusal } from "../fairness/fairness-contract.js";
import type { FairnessContractRefusal } from "../fairness/fairness-contract.js";
import { validateOpportunityAttestation } from "../fairness/fairness-evidence.js";
import { admittedOf, boundSnapshot, matchesTrusted } from "./expansion-binding-facts.js";
import { digestOf } from "./expansion-preparation.js";
import type { ExpansionBoundFacts, ExpansionPreparation } from "./expansion-preparation.js";

/** Which surface answered. `BRIDGE` is the only one this module speaks for. */
export const EXPANSION_BINDING_ORIGINS = Object.freeze([
  "BRIDGE", "EXPANSION_HOLD", "FAIRNESS", "PLANNING_CONTRACT",
] as const);
export type ExpansionBindingOrigin = (typeof EXPANSION_BINDING_ORIGINS)[number];

/** The complete set of codes this module mints. Everything else is delegated verbatim. */
export const EXPANSION_BINDING_ISSUE_CODES = Object.freeze([
  "EXPANSION_BINDING_CURRENT_AUTHORITY_UNKNOWN", "EXPANSION_BINDING_GOAL_VERSION_MISMATCH",
  "EXPANSION_BINDING_GRAPH_EPOCH_MISMATCH", "EXPANSION_BINDING_HOLD_ID_MISMATCH",
  "EXPANSION_BINDING_HOLD_INACTIVE", "EXPANSION_BINDING_HOLD_STATE_MISMATCH",
  "EXPANSION_BINDING_HOLD_VERSION_MISMATCH",
  "EXPANSION_BINDING_OPPORTUNITY_WINNER_MISMATCH", "EXPANSION_BINDING_PLANNING_RUN_MISMATCH",
  "EXPANSION_BINDING_PREPARATION_IDENTITY_MISMATCH", "EXPANSION_BINDING_REQUEST_MALFORMED",
] as const);
export type ExpansionBindingIssueCode = (typeof EXPANSION_BINDING_ISSUE_CODES)[number];

export const EXPANSION_BINDING_LAYERS = Object.freeze([
  "CURRENT_AUTHORITY", "FAIRNESS", "HOLD", "PREPARATION", "REQUEST",
] as const);
export type ExpansionBindingLayer = (typeof EXPANSION_BINDING_LAYERS)[number];

export interface ExpansionBindingIssue {
  /** Verbatim from the delegated surface, or one of this module's own codes. */
  readonly code: string;
  /** The surface's own layer where it has one; otherwise this module's layer. */
  readonly layer: string;
  readonly message: string; readonly missingInput: string | null;
  readonly origin: ExpansionBindingOrigin;
}

export interface ExpansionBindingRefusal {
  readonly disposition: "REFUSED" | "UNKNOWN";
  readonly issues: readonly ExpansionBindingIssue[]; readonly ok: false;
}

/** What the DAEMON currently holds. An input to compare against, never a verdict. */
export interface ExpansionCurrentAuthority {
  readonly goalVersion: number; readonly graphEpoch: number; readonly holdId: string;
  readonly holdVersion: number; readonly planningRunRef: string;
}

export interface ExpansionBindingRequest {
  readonly currentAuthority: ExpansionCurrentAuthority;
  readonly hold: ExpansionPlanningHoldState; readonly opportunity: unknown;
  readonly preparation: ExpansionPreparation;
}

export interface ExpansionAdmissionBinding {
  readonly admitted: ExpansionAdmittedFacts;
  readonly planningHoldBinding: PlanningExpansionHoldBinding;
}

export type ExpansionBindingResult =
  | {
    readonly binding: ExpansionAdmissionBinding; readonly ok: true;
    /** Verified source provenance, kept BESIDE the binding and never folded into it. */
    readonly schedulerPreparationIdentity: string;
  }
  | ExpansionBindingRefusal;

const REQUEST_KEYS =
  Object.freeze(["currentAuthority", "hold", "opportunity", "preparation"] as const);
const PREPARATION_KEYS = Object.freeze(["identity", "bound"] as const);
const CURRENT_KEYS = Object.freeze([
  "goalVersion", "graphEpoch", "holdId", "holdVersion", "planningRunRef"] as const);
const HOLD_KEYS = Object.freeze([
  "creationReceipt", "deadline", "generation", "graphEpoch", "holdId", "holdKind", "lifecycle",
  "parentNodeRef", "parentRevisionRef", "parentRunRef", "planningRunRef", "proposalBaseHash",
  "rationale", "release", "sourceFingerprint", "terminalReceipt", "version", "workerHandoff",
] as const);

function refusal(
  issues: readonly ExpansionBindingIssue[], disposition: "REFUSED" | "UNKNOWN",
): ExpansionBindingRefusal {
  return deepFreeze({ disposition, issues, ok: false as const });
}

function local(
  code: ExpansionBindingIssueCode, layer: ExpansionBindingLayer, message: string,
): ExpansionBindingRefusal {
  return refusal([{ code, layer, message, missingInput: null, origin: "BRIDGE" }], "REFUSED");
}

/** An UNKNOWN must name the input it is missing; an unnamed one is a silent pass. */
function unknownAuthority(missingInput: string): ExpansionBindingRefusal {
  return refusal([{
    code: "EXPANSION_BINDING_CURRENT_AUTHORITY_UNKNOWN", layer: "CURRENT_AUTHORITY",
    message: `cannot compare without ${missingInput}`, missingInput, origin: "BRIDGE",
  }], "UNKNOWN");
}

/** A delegated refusal keeps the answering surface's own code, layer and disposition. */
function delegated(
  code: string, layer: string, origin: ExpansionBindingOrigin, message: string,
): ExpansionBindingRefusal {
  return refusal([{ code, layer, message, missingInput: null, origin }], "REFUSED");
}

function fromFairness(source: FairnessContractRefusal): ExpansionBindingRefusal {
  return refusal(source.issues.map((issue) => ({
    code: issue.code, layer: issue.layer, message: issue.message,
    missingInput: issue.missingInput, origin: "FAIRNESS" as const,
  })), source.disposition);
}

function isBindingRefusal(value: unknown): value is ExpansionBindingRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/**
 * An ACTIVE hold, PROVEN by replaying its own creation command through the core reducer. Three
 * gates, in this order and for three different reasons.
 *
 * The outer lifecycle/version/receipt gate runs FIRST, because a terminated hold's creation
 * command still replays into an active state and accepting the replay alone would resurrect it.
 *
 * The replay runs SECOND, and it proves only that an active hold CAN exist — it says nothing
 * about the value actually presented.
 *
 * So the presented value is compared against the replayed state THIRD, field for field and
 * nested value for nested value. Returning the replayed state and discarding the presented bytes
 * reads as safe, since the output is reducer-produced either way; it is not. A forged field
 * would be accepted in silence, and every later reader would believe the daemon verified the
 * value it was handed. What is bound must be what was presented AND what the reducer produces.
 */
function activeHoldOf(value: unknown): ExpansionPlanningHoldState | ExpansionBindingRefusal {
  const raw = exactRecord(value, HOLD_KEYS);
  if (raw === null) {
    return local("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the hold is not an expansion planning hold record");
  }
  if (raw["lifecycle"] !== "ACTIVE" || raw["version"] !== 1 || raw["terminalReceipt"] !== null) {
    return local("EXPANSION_BINDING_HOLD_INACTIVE", "HOLD",
      "only an ACTIVE version-1 hold with no terminal receipt can be bound");
  }
  const receipt = exactRecord(raw["creationReceipt"], ["command"]);
  if (receipt === null) {
    return local("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the hold carries no readable creation command");
  }
  const replayed = reduceExpansionPlanningHold(undefined, receipt["command"]);
  if (!replayed.ok) {
    return delegated(replayed.code, replayed.layer, "EXPANSION_HOLD",
      "the core hold reducer refused the hold's own creation command");
  }
  if (!matchesTrusted(value, replayed.state)) {
    return local("EXPANSION_BINDING_HOLD_STATE_MISMATCH", "HOLD",
      "the presented hold differs from the state its own creation command produces");
  }
  return replayed.state;
}

function currentOf(value: unknown): ExpansionCurrentAuthority | ExpansionBindingRefusal {
  const raw = exactRecord(value, CURRENT_KEYS);
  if (raw === null) return unknownAuthority("currentAuthority");
  const goalVersion = raw["goalVersion"]; const graphEpoch = raw["graphEpoch"];
  const holdId = raw["holdId"]; const holdVersion = raw["holdVersion"];
  const planningRunRef = raw["planningRunRef"];
  if (!isCount(goalVersion) || !isCount(graphEpoch) || !isCount(holdVersion) || !isRef(holdId)
    || !isRef(planningRunRef)) return unknownAuthority("currentAuthority");
  return { goalVersion, graphEpoch, holdId, holdVersion, planningRunRef };
}

/** Proven mismatch, one code per compared value. Absence was already answered UNKNOWN. */
function authorityMismatch(
  current: ExpansionCurrentAuthority, hold: ExpansionPlanningHoldState, bound: ExpansionBoundFacts,
): ExpansionBindingIssueCode | null {
  if (current.goalVersion !== bound.goalVersion) {
    return "EXPANSION_BINDING_GOAL_VERSION_MISMATCH";
  }
  if (current.graphEpoch !== hold.graphEpoch || current.graphEpoch !== bound.graphEpoch) {
    return "EXPANSION_BINDING_GRAPH_EPOCH_MISMATCH";
  }
  if (current.holdId !== hold.holdId) return "EXPANSION_BINDING_HOLD_ID_MISMATCH";
  if (current.holdVersion !== hold.version) return "EXPANSION_BINDING_HOLD_VERSION_MISMATCH";
  if (current.planningRunRef !== hold.planningRunRef) {
    return "EXPANSION_BINDING_PLANNING_RUN_MISMATCH";
  }
  return null;
}

/** Built here from the validated hold, then re-inspected by core's own predicate. */
function holdBindingOf(
  hold: ExpansionPlanningHoldState, goalVersion: number,
): PlanningExpansionHoldBinding | ExpansionBindingRefusal {
  const binding: PlanningExpansionHoldBinding = {
    generation: hold.generation, goalVersion, graphEpoch: hold.graphEpoch, holdId: hold.holdId,
    lifecycle: "ACTIVE", parentNodeRef: hold.parentNodeRef, parentRunRef: hold.parentRunRef,
    proposalBaseHash: hold.proposalBaseHash, sourceFingerprint: hold.sourceFingerprint,
    truthClass: "DAEMON_VERIFIED",
    workerHandoff: { digest: hold.workerHandoff.digest, ref: hold.workerHandoff.ref },
  };
  const inspection = inspectPlanningExpansionContract("HOLD_BINDING", binding);
  return inspection.ok ? binding : delegated(inspection.code, inspection.layer, "PLANNING_CONTRACT",
    "the derived hold binding is not a valid planning expansion contract");
}

/**
 * Bind ONE scheduler admission to the exact core inputs it earns. Deterministic,
 * side-effect-free, deeply frozen, and total: every path returns an accepted binding or a
 * refusal naming its code, its layer and which surface spoke.
 */
export function bindExpansionAdmission(value: unknown): ExpansionBindingResult {
  const request = exactRecord(value, REQUEST_KEYS);
  if (request === null) {
    return local("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the expansion binding request is malformed");
  }
  const preparation = exactRecord(request["preparation"], PREPARATION_KEYS);
  const bound = preparation === null ? null : boundSnapshot(preparation["bound"]);
  if (preparation === null || bound === null) {
    return local("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the scheduler preparation is not a readable admission preparation");
  }
  const identity = preparation["identity"];
  if (!isRef(identity) || digestOf(bound) !== identity) {
    return local("EXPANSION_BINDING_PREPARATION_IDENTITY_MISMATCH", "PREPARATION",
      "the preparation identity does not cover its own bound facts");
  }
  const opportunity = validateOpportunityAttestation(request["opportunity"]);
  if (isFairnessRefusal(opportunity)) return fromFairness(opportunity);
  if (opportunity.value.winnerWorkItemId !== bound.fairness.workItemId) {
    return local("EXPANSION_BINDING_OPPORTUNITY_WINNER_MISMATCH", "FAIRNESS",
      "the attested opportunity was won by another work item");
  }
  const hold = activeHoldOf(request["hold"]);
  if (isBindingRefusal(hold)) return hold;
  const current = currentOf(request["currentAuthority"]);
  if (isBindingRefusal(current)) return current;
  const stale = authorityMismatch(current, hold, bound);
  if (stale !== null) {
    return local(stale, "CURRENT_AUTHORITY", "the daemon's current authority is not the bound one");
  }
  const admitted = admittedOf(bound, opportunity.value.opportunityRef);
  const planningHoldBinding = holdBindingOf(hold, current.goalVersion);
  if (isBindingRefusal(planningHoldBinding)) return planningHoldBinding;
  return deepFreeze({
    binding: { admitted, planningHoldBinding }, ok: true as const,
    schedulerPreparationIdentity: identity,
  });
}
