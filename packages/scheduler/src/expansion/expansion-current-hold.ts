/**
 * The SOLE producer of a core `PlanningExpansionHoldBinding` from an ACTIVE durable hold plus the
 * daemon's own current authority. Nothing else may build that projection or mint its truth class.
 *
 * WHY A SEPARATE MODULE. `bindExpansionAdmission` needs this binding, and so does the daemon's
 * atomic expansion-request path, which has no scheduler preparation and no fairness attestation
 * to offer. Leaving the projection inside the admission composer forced every other consumer to
 * fabricate a preparation or hand-roll a second mapper — and a second mapper is exactly the
 * drift that lets a forged hold survive. This module therefore owns the shared refusal
 * vocabulary too, and `expansion-binding.ts` imports FROM here: the edge runs one way.
 *
 * WHAT IT WILL NOT CLAIM. `ExpansionPlanningHoldState` carries no `goalVersion`, so there is no
 * hold-side operand to compare `currentAuthority.goalVersion` against and this module does not
 * pretend otherwise: it validates that value's domain and hands it to core's own HOLD_BINDING
 * inspector, while the load-bearing EQUALITY fence against the scheduler's admitted goal version
 * stays with the composer that actually holds `preparation.bound`. A bridge implying it had
 * authenticated a fact it never compared is worse than one that has not — the next reader would
 * trust it.
 *
 * ONE STATED LIMIT, MEASURED NOT ASSUMED. A hold whose terminal receipt has been stripped is
 * byte-identical to a live one and replays into an ACTIVE state, so inspecting the VALUE cannot
 * separate the two. `currentAuthority.holdVersion` is what does, which is why all five current
 * values are required rather than optional. Missing or unreadable authority stays UNKNOWN.
 *
 * Consumers: `bindExpansionAdmission` here today; task-738a12a816e8421a96edd84648565a38 (under
 * task-c4171c1cfe854cb78dd233794b342025) is the eventual durable daemon consumer. No run, lease,
 * effect, slot, persistence or graph activation is minted on any path.
 */
import { inspectPlanningExpansionContract, reduceExpansionPlanningHold } from "@moe/core";
import type { ExpansionPlanningHoldState, PlanningExpansionHoldBinding } from "@moe/core";

import { deepFreeze, exactRecord, isCount, isRef } from "../authority/authority-kernel.js";
import { matchesTrusted } from "./expansion-binding-facts.js";

/** Which surface answered. `BRIDGE` is the only one the scheduler speaks for. */
export const EXPANSION_BINDING_ORIGINS = Object.freeze([
  "BRIDGE", "EXPANSION_HOLD", "FAIRNESS", "PLANNING_CONTRACT",
] as const);
export type ExpansionBindingOrigin = (typeof EXPANSION_BINDING_ORIGINS)[number];

/** The complete set of codes the scheduler bridge mints. Everything else is delegated verbatim. */
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
  /** Verbatim from the delegated surface, or one of the bridge's own codes. */
  readonly code: string;
  /** The surface's own layer where it has one; otherwise the bridge's layer. */
  readonly layer: string;
  readonly message: string; readonly missingInput: string | null;
  readonly origin: ExpansionBindingOrigin;
  /**
   * The delegated contract the refusal is about, COPIED from the answering surface — today only
   * the core planning-expansion inspector's own `target`, such as `HOLD_BINDING`. Null whenever
   * no delegated surface named one, and never derived from the code or layer: a derived
   * provenance is an invented one.
   */
  readonly target: string | null;
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

/** Exactly two keys: the reducer-produced hold, and the daemon's five current values. */
export interface ExpansionCurrentHoldRequest {
  readonly currentAuthority: ExpansionCurrentAuthority;
  readonly hold: ExpansionPlanningHoldState;
}

export type ExpansionCurrentHoldResult =
  | { readonly binding: PlanningExpansionHoldBinding; readonly ok: true }
  | ExpansionBindingRefusal;

const CURRENT_HOLD_KEYS = Object.freeze(["currentAuthority", "hold"] as const);
const CURRENT_KEYS = Object.freeze([
  "goalVersion", "graphEpoch", "holdId", "holdVersion", "planningRunRef"] as const);
const HOLD_KEYS = Object.freeze([
  "creationReceipt", "deadline", "generation", "graphEpoch", "holdId", "holdKind", "lifecycle",
  "parentNodeRef", "parentRevisionRef", "parentRunRef", "planningRunRef", "proposalBaseHash",
  "rationale", "release", "sourceFingerprint", "terminalReceipt", "version", "workerHandoff",
] as const);

export function refusalOf(
  issues: readonly ExpansionBindingIssue[], disposition: "REFUSED" | "UNKNOWN",
): ExpansionBindingRefusal {
  return deepFreeze({ disposition, issues, ok: false as const });
}

/** A refusal the bridge mints itself: no delegated provenance to carry. */
export function localRefusal(
  code: ExpansionBindingIssueCode, layer: ExpansionBindingLayer, message: string,
): ExpansionBindingRefusal {
  return refusalOf(
    [{ code, layer, message, missingInput: null, origin: "BRIDGE", target: null }], "REFUSED",
  );
}

export function isBindingRefusal(value: unknown): value is ExpansionBindingRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/** An UNKNOWN must name the input it is missing; an unnamed one is a silent pass. */
function unknownAuthority(missingInput: string): ExpansionBindingRefusal {
  return refusalOf([{
    code: "EXPANSION_BINDING_CURRENT_AUTHORITY_UNKNOWN", layer: "CURRENT_AUTHORITY",
    message: `cannot compare without ${missingInput}`, missingInput, origin: "BRIDGE",
    target: null,
  }], "UNKNOWN");
}

/** A delegated refusal keeps the answering surface's own code, layer and target. */
function delegated(
  code: string, layer: string, origin: ExpansionBindingOrigin, message: string,
  target: string | null,
): ExpansionBindingRefusal {
  return refusalOf([{ code, layer, message, missingInput: null, origin, target }], "REFUSED");
}

/**
 * An ACTIVE hold, PROVEN by replaying its own creation command through the core reducer. Three
 * gates, in this order and for three different reasons.
 *
 * The outer lifecycle/version/receipt gate runs FIRST, because a terminated hold's creation
 * command still replays into an active state and accepting the replay alone would resurrect it.
 * The replay runs SECOND, and it proves only that an active hold CAN exist — it says nothing
 * about the value actually presented.
 * So the presented value is compared against the replayed state THIRD, field for field and
 * nested value for nested value. Returning the replayed state and discarding the presented bytes
 * reads as safe, since the output is reducer-produced either way; it is not. A forged field
 * would be accepted in silence. What is bound must be what was presented AND what the reducer
 * produces.
 */
function activeHoldOf(value: unknown): ExpansionPlanningHoldState | ExpansionBindingRefusal {
  const raw = exactRecord(value, HOLD_KEYS);
  if (raw === null) {
    return localRefusal("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the hold is not an expansion planning hold record");
  }
  if (raw["lifecycle"] !== "ACTIVE" || raw["version"] !== 1 || raw["terminalReceipt"] !== null) {
    return localRefusal("EXPANSION_BINDING_HOLD_INACTIVE", "HOLD",
      "only an ACTIVE version-1 hold with no terminal receipt can be bound");
  }
  const receipt = exactRecord(raw["creationReceipt"], ["command"]);
  if (receipt === null) {
    return localRefusal("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the hold carries no readable creation command");
  }
  const replayed = reduceExpansionPlanningHold(undefined, receipt["command"]);
  if (!replayed.ok) {
    return delegated(replayed.code, replayed.layer, "EXPANSION_HOLD",
      "the core hold reducer refused the hold's own creation command", null);
  }
  if (!matchesTrusted(value, replayed.state)) {
    return localRefusal("EXPANSION_BINDING_HOLD_STATE_MISMATCH", "HOLD",
      "the presented hold differs from the state its own creation command produces");
  }
  return replayed.state;
}

/** Five own data values, each in its own domain. Anything else is UNKNOWN, never false. */
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

/**
 * Proven disagreement, one code per compared value; absence was already answered UNKNOWN.
 * `goalVersion` is absent by design — the hold carries no such field to compare against.
 */
function holdMismatch(
  current: ExpansionCurrentAuthority, hold: ExpansionPlanningHoldState,
): ExpansionBindingIssueCode | null {
  if (current.graphEpoch !== hold.graphEpoch) return "EXPANSION_BINDING_GRAPH_EPOCH_MISMATCH";
  if (current.holdId !== hold.holdId) return "EXPANSION_BINDING_HOLD_ID_MISMATCH";
  if (current.holdVersion !== hold.version) return "EXPANSION_BINDING_HOLD_VERSION_MISMATCH";
  if (current.planningRunRef !== hold.planningRunRef) {
    return "EXPANSION_BINDING_PLANNING_RUN_MISMATCH";
  }
  return null;
}

/** Built here from the validated hold, then RE-INSPECTED by core's own predicate. */
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
  return inspection.ok ? binding
    : delegated(inspection.code, inspection.layer, "PLANNING_CONTRACT",
      "the derived hold binding is not a valid planning expansion contract", inspection.target);
}

/**
 * Bind ONE reducer-produced ACTIVE hold to the daemon's current authority. Deterministic,
 * side-effect-free, deeply frozen, detached from every caller record, and total: each path
 * returns one validated binding or a refusal naming its code, its layer, which surface spoke
 * and — for a delegated one — which contract it spoke about.
 */
export function bindCurrentExpansionHold(value: unknown): ExpansionCurrentHoldResult {
  const request = exactRecord(value, CURRENT_HOLD_KEYS);
  if (request === null) {
    return localRefusal("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the current expansion hold request is malformed");
  }
  const hold = activeHoldOf(request["hold"]);
  if (isBindingRefusal(hold)) return hold;
  const current = currentOf(request["currentAuthority"]);
  if (isBindingRefusal(current)) return current;
  const stale = holdMismatch(current, hold);
  if (stale !== null) {
    return localRefusal(stale, "CURRENT_AUTHORITY",
      "the daemon's current authority is not the held one");
  }
  const binding = holdBindingOf(hold, current.goalVersion);
  if (isBindingRefusal(binding)) return binding;
  return deepFreeze({ binding, ok: true as const });
}
