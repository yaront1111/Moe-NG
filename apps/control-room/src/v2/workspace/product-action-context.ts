import { sameProductContract, sameProductScope } from "@moe/control-room-model";
import type { ProductArtifact } from "@moe/control-room-model";
import { productArtifactPayloadMatches } from "./product-artifact-identity.js";
import type { ProductWorkspaceInput, ProductWorkspaceModel } from "./product-model-contracts.js";

/** Presentation scope only; child controls still require their exact daemon grants and review bodies. */
export function productActionContext(input: ProductWorkspaceInput, model: ProductWorkspaceModel, historical: boolean) {
  const read = input.criteria;
  const compiled = input.scope.plane === "V1" && read?.status === "CRITERION_EVIDENCE"
    && read.view.goalRef === input.goalRef && read.view.planningRunRef === input.planningRunRef ? read.view : null;
  const ref = compiled === null ? null : { ...compiled.contractRef, plane: "V1" as const };
  const current = (artifact: ProductArtifact): boolean => {
    if (!sameProductScope(artifact.scope, input.scope) || artifact.availability !== "PRESENT") return false;
    // PRD/definition are product review contexts. Their records explicitly identify the current plan/candidate.
    if (artifact.kind === "SOURCE" || artifact.kind === "DEFINITION") return true;
    if (artifact.kind === "DESIGN") return input.planningRunRef !== null
      && productArtifactPayloadMatches(artifact, input)
      && (compiled === null || sameProductContract(artifact.contractRef, ref));
    return compiled !== null && compiled.integratedArtifact !== null
      && artifact.sha === compiled.integratedArtifact.sha && artifact.planningRunRef === compiled.planningRunRef
      && sameProductContract(artifact.contractRef, ref);
  };
  const selected = model.selection.artifact;
  const allowCurrentControls = !historical && input.scope.goalId === input.goalRef
    && model.selection.status !== "UNAVAILABLE" && (selected === null || current(selected));
  const candidates = model.artifacts.filter(current);
  const target = candidates.find((item) => item.kind === "BUILD") ?? candidates.find((item) => item.kind === "DESIGN")
    ?? candidates.find((item) => item.kind === "DEFINITION") ?? candidates.find((item) => item.kind === "SOURCE") ?? null;
  const criteria = read?.status === "CRITERION_EVIDENCE" && compiled === null
    ? { status: "ERROR", code: "PRODUCT_CRITERIA_SUBJECT_MISMATCH", layer: "CONTROL_ROOM_PRODUCT" } as const : read;
  return { allowCurrentControls, currentArtifactId: target?.id ?? null, planningRunRef: input.planningRunRef,
    candidateSha: compiled?.integratedArtifact?.sha ?? null, contractRef: ref, criteria,
    note: allowCurrentControls ? null : "This artifact is not bound to the current plan and candidate. Current work controls are unavailable in this view.",
  };
}
