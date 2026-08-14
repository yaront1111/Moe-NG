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
 * THIS FILE COMPOSES, IT DOES NOT PROJECT. The hold replay, the current-authority parse, the
 * hold-backed comparisons and the sole `PlanningExpansionHoldBinding` projection all live in
 * `expansion-current-hold.ts`, which this file CALLS. A second mapper here would be free to
 * drift from that one, and a drifting mapper is how a forged hold survives; so the refusal it
 * returns is propagated unchanged and the binding it returns is used verbatim. What stays here
 * is only what needs `preparation.bound`, which the standalone binder is never given: the
 * goalVersion equality fence, and the second graphEpoch operand.
 *
 * WHAT A CALLER MAY SUPPLY. Raw evidence for validation — one opportunity attestation, one
 * reducer-produced hold, the daemon's own current authority — and never a verdict.
 * `DAEMON_VERIFIED` is set by the current-hold binder, after the hold replays through the core
 * reducer and every comparable current value matches; `opportunityRef` comes from the validated
 * attestation and is never synthesised from a work item id. Missing or unreadable current
 * authority stays UNKNOWN rather than being read as agreement.
 *
 * Production consumer: task-c4171c1cfe854cb78dd233794b342025 (daemon persistence of the
 * prepared/approved binding). No child run, lease, effect, slot or graph activation is minted.
 */
import type {
  ExpansionAdmittedFacts, ExpansionPlanningHoldState, PlanningExpansionHoldBinding,
} from "@moe/core";

import { exactRecord, deepFreeze, isRef } from "../authority/authority-kernel.js";
import { isFairnessRefusal } from "../fairness/fairness-contract.js";
import type { FairnessContractRefusal } from "../fairness/fairness-contract.js";
import { validateOpportunityAttestation } from "../fairness/fairness-evidence.js";
import { admittedOf, boundSnapshot } from "./expansion-binding-facts.js";
import {
  bindCurrentExpansionHold, isBindingRefusal, localRefusal, refusalOf,
} from "./expansion-current-hold.js";
import type {
  ExpansionBindingRefusal, ExpansionCurrentAuthority,
} from "./expansion-current-hold.js";
import { digestOf } from "./expansion-preparation.js";
import type { ExpansionPreparation } from "./expansion-preparation.js";

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

/** A fairness refusal keeps that contract's own code, layer, missing input and disposition. */
function fromFairness(source: FairnessContractRefusal): ExpansionBindingRefusal {
  return refusalOf(source.issues.map((issue) => ({
    code: issue.code, layer: issue.layer, message: issue.message,
    missingInput: issue.missingInput, origin: "FAIRNESS" as const,
    // The fairness contract names no planning-expansion contract, so none is invented for it.
    target: null,
  })), source.disposition);
}

/**
 * Bind ONE scheduler admission to the exact core inputs it earns. Deterministic,
 * side-effect-free, deeply frozen, and total: every path returns an accepted binding or a
 * refusal naming its code, its layer and which surface spoke.
 */
export function bindExpansionAdmission(value: unknown): ExpansionBindingResult {
  const request = exactRecord(value, REQUEST_KEYS);
  if (request === null) {
    return localRefusal("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the expansion binding request is malformed");
  }
  const preparation = exactRecord(request["preparation"], PREPARATION_KEYS);
  const bound = preparation === null ? null : boundSnapshot(preparation["bound"]);
  if (preparation === null || bound === null) {
    return localRefusal("EXPANSION_BINDING_REQUEST_MALFORMED", "REQUEST",
      "the scheduler preparation is not a readable admission preparation");
  }
  const identity = preparation["identity"];
  if (!isRef(identity) || digestOf(bound) !== identity) {
    return localRefusal("EXPANSION_BINDING_PREPARATION_IDENTITY_MISMATCH", "PREPARATION",
      "the preparation identity does not cover its own bound facts");
  }
  const opportunity = validateOpportunityAttestation(request["opportunity"]);
  if (isFairnessRefusal(opportunity)) return fromFairness(opportunity);
  if (opportunity.value.winnerWorkItemId !== bound.fairness.workItemId) {
    return localRefusal("EXPANSION_BINDING_OPPORTUNITY_WINNER_MISMATCH", "FAIRNESS",
      "the attested opportunity was won by another work item");
  }
  const held = bindCurrentExpansionHold({
    currentAuthority: request["currentAuthority"], hold: request["hold"],
  });
  if (isBindingRefusal(held)) return held;
  const planningHoldBinding = held.binding;
  /*
   * The two comparisons the standalone binder CANNOT make, because `preparation.bound` is not one
   * of its inputs. `binding.goalVersion` is the daemon's current value; `binding.graphEpoch` is
   * the hold's own, already proven equal to the daemon's — so this is the SECOND graph operand,
   * not a repeat of the first.
   */
  if (planningHoldBinding.goalVersion !== bound.goalVersion) {
    return localRefusal("EXPANSION_BINDING_GOAL_VERSION_MISMATCH", "CURRENT_AUTHORITY",
      "the daemon's current authority is not the bound one");
  }
  if (planningHoldBinding.graphEpoch !== bound.graphEpoch) {
    return localRefusal("EXPANSION_BINDING_GRAPH_EPOCH_MISMATCH", "CURRENT_AUTHORITY",
      "the daemon's current authority is not the bound one");
  }
  const admitted = admittedOf(bound, opportunity.value.opportunityRef);
  return deepFreeze({
    binding: { admitted, planningHoldBinding }, ok: true as const,
    schedulerPreparationIdentity: identity,
  });
}
