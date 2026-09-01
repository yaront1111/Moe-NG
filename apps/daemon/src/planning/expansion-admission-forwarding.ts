/**
 * How each refusing surface's identity crosses into this slice's vocabulary — and how it does
 * NOT change on the way.
 *
 * ONE FUNCTION PER SURFACE, and every one of them copies the upstream `code` and `layer`
 * VERBATIM into the `upstream` face while this slice's own code supplies its own layer from the
 * closed map. Nothing is restamped in either direction. The distinction between "the scheduler
 * refused the proposal" and "core refused the approval" is the entire diagnostic value of the
 * roster, and it is lost the moment one surface's code is spoken in another's layer.
 *
 * THE ATTRIBUTION MEMBERS ARE COPIED, NEVER DERIVED. A refusing surface that names no `origin`,
 * no `component` and no `target` contributes `null` for each; a derived provenance is an
 * invented one. The scheduler's issues carry `origin` plus a `missingInput` that names WHAT was
 * missing, the bridge carries `origin` plus the delegated contract `target`, and core's two
 * kernels carry the `component` that answered.
 *
 * The unwind rides on the admission forwarder alone, because `admitExpansion` is the only
 * surface here that can have taken anything before it refused.
 *
 * Pure: no store, no clock. It mints no authority and holds no state.
 */

import type { ExpansionApprovalRefusal, ExpansionPreparationRefusal } from "@moe/core";
import type {
  ExpansionAdmissionRefusal as SchedulerAdmissionRefusal, ExpansionBindingRefusal,
} from "@moe/scheduler";

import { expansionAdmissionRefusal, upstreamFace } from "./expansion-admission-contracts.js";
import type { ExpansionAdmissionRefusal } from "./expansion-admission-contracts.js";

/**
 * The scheduler admission keeps its own code, layer, origin and missing input — and its
 * `unwind`, forwarded verbatim so a late refusal proves the budget give-back it performed
 * rather than merely asserting one happened.
 */
export function fromAdmission(
  refusal: SchedulerAdmissionRefusal,
): ExpansionAdmissionRefusal {
  const issue = refusal.issues[0];
  return expansionAdmissionRefusal(
    "EXPANSION_ADMISSION_PROPOSAL_REFUSED",
    issue === undefined ? null : upstreamFace(issue.code, issue.layer,
      { origin: issue.origin, target: issue.missingInput }),
    refusal.unwind,
  );
}

/** The admission-to-core bridge keeps its own code, layer, origin and delegated target. */
export function fromBridge(refusal: ExpansionBindingRefusal): ExpansionAdmissionRefusal {
  const issue = refusal.issues[0];
  return expansionAdmissionRefusal(
    "EXPANSION_ADMISSION_PROJECTION_REFUSED",
    issue === undefined ? null : upstreamFace(issue.code, issue.layer,
      { origin: issue.origin, target: issue.target }),
  );
}

/** Core preparation keeps its own code, layer and the component that answered. */
export function fromPreparation(
  refusal: ExpansionPreparationRefusal,
): ExpansionAdmissionRefusal {
  return expansionAdmissionRefusal("EXPANSION_ADMISSION_PREPARATION_REFUSED",
    upstreamFace(refusal.code, refusal.layer, { component: refusal.component }));
}

/** Core approval keeps its own code, layer and the component that answered. */
export function fromApproval(refusal: ExpansionApprovalRefusal): ExpansionAdmissionRefusal {
  return expansionAdmissionRefusal("EXPANSION_ADMISSION_APPROVAL_REFUSED",
    upstreamFace(refusal.code, refusal.layer, { component: refusal.component }));
}

/**
 * This slice's OWN contract refusals. They name the expansion-planning hold contract as their
 * component because that is the contract the comparison is about, and the hold or revision the
 * comparison names as their target.
 */
export function contractMismatch(target: string): ExpansionAdmissionRefusal {
  return expansionAdmissionRefusal("EXPANSION_ADMISSION_CONTRACT_MISMATCH",
    upstreamFace("EXPANSION_HOLD_BINDING_MISMATCH", "BINDING",
      { component: "EXPANSION_PLANNING_HOLD", target }));
}

export function fundingUnderivable(admissionRef: string): ExpansionAdmissionRefusal {
  return expansionAdmissionRefusal("EXPANSION_ADMISSION_FUNDING_UNDERIVABLE",
    upstreamFace("EXPANSION_ADMISSION_BUDGET_MULTI_METER", "BUDGET",
      { origin: "BUDGET", target: admissionRef }));
}
