import type { CriterionCheckInput, CriterionEvidenceRow, CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";
export interface CriterionEvidencePort {
  approve(view: CriterionEvidenceView, criterion: CriterionEvidenceRow, check: CriterionCheckInput): Promise<OfferOutcome>;
  verify(view: CriterionEvidenceView): Promise<OfferOutcome>;
}
export function createCriterionEvidencePort(wire: OfferWire): CriterionEvidencePort {
  const refuse = (code: string): OfferOutcome => ({ ok: false, code, layer: "CONTROL_ROOM_CRITERIA" });
  return Object.freeze({
    approve: async (view: CriterionEvidenceView, criterion: CriterionEvidenceRow, check: CriterionCheckInput) => {
      if (!view.criteria.includes(criterion) || criterion.approveOffer === null) return refuse("CRITERION_APPROVAL_NOT_OFFERED");
      return spendOffer(wire, "criterion_check.approve", criterion.approveOffer, {
        goalRef: view.goalRef, planningRunRef: view.planningRunRef, contractRef: view.contractRef, criterionId: criterion.criterionId, check,
      }, "ui-criterion-approve", "CONTROL_ROOM_CRITERIA");
    },
    verify: async (view: CriterionEvidenceView) => {
      if (view.verifyOffer === null || view.integratedArtifact === null || view.criteria.length === 0
        || view.criteria.some((criterion) => criterion.approval === null)) return refuse("CRITERION_VERIFICATION_NOT_OFFERED");
      return spendOffer(wire, "criterion_check.verify", view.verifyOffer, {
        goalRef: view.goalRef, planningRunRef: view.planningRunRef, contractRef: view.contractRef,
        integratedSha: view.integratedArtifact.sha,
        approvals: view.criteria.map((criterion) => ({ criterionId: criterion.criterionId, approvalId: criterion.approval!.approvalId })),
      }, "ui-criterion-verify", "CONTROL_ROOM_CRITERIA");
    },
  });
}
