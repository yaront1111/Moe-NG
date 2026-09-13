import { sameProductContract } from "@moe/control-room-model";
import type { ProductArtifact, ProductContractRef } from "@moe/control-room-model";
import type { CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
import type { ProductWorkspaceInput } from "./product-model-contracts.js";

/** Receipt existence describes an artifact; it never asserts that its old process is live. */
export function productArtifacts(input: ProductWorkspaceInput, compiled: CriterionEvidenceView | null,
  requestedRef: ProductContractRef | null,
): readonly ProductArtifact[] {
  const artifacts: ProductArtifact[] = [];
  const compiledRef: ProductContractRef | null = compiled === null ? null : { ...compiled.contractRef, plane: "V1" };
  const forSha = (sha: string): ProductContractRef | null => compiled?.integratedArtifact?.sha === sha ? compiledRef : null;
  const add = (item: Omit<ProductArtifact, "scope">): void => {
    artifacts.push(Object.freeze({ ...item, scope: Object.freeze({ ...input.scope }),
      contractRef: item.contractRef === null ? null : Object.freeze({ ...item.contractRef }),
    }));
  };
  const source = input.source?.status === "GOAL_SOURCE" ? input.source : null;
  const binding = input.goal?.binding;
  if (source !== null && (binding == null || binding.contentSha256 === source.contentSha256 && binding.sourceRef === source.sourceRef)) {
    add({ id: `source:${source.contentSha256}`, kind: "SOURCE", title: "Original PRD", contractRef: null,
      planningRunRef: null, sha: null, availability: "PRESENT" });
  }
  const refs = requestedRef === null ? [] : [requestedRef];
  if (compiledRef !== null && !refs.some((ref) => sameProductContract(ref, compiledRef))) refs.push(compiledRef);
  for (const ref of refs) {
    const contract = input.coverage?.status === "COVERAGE"
      ? input.coverage.contracts.find((candidate) => sameProductContract(candidate, ref)) : null;
    add({ id: `definition:${ref.plane}:${ref.contractId}:${ref.revisionId}:${ref.revisionDigest}`,
      kind: "DEFINITION", title: contract?.gate1 === "APPROVED" ? "Product definition" : "Proposed definition",
      contractRef: ref, planningRunRef: sameProductContract(ref, compiledRef) ? compiled?.planningRunRef ?? null : null,
      sha: null, availability: contract != null || sameProductContract(input.availableDefinitionRef ?? null, ref)
        ? "PRESENT" : input.coverage === null ? "LOADING" : "UNREADABLE",
    });
  }
  if (input.design?.status === "DESIGN" && input.design.record.goalRef === input.goalRef
    && input.design.record.projectId === input.scope.projectId && input.scope.plane === "V1") {
    const { record } = input.design;
    add({ id: `design:${record.version}:${record.contractRef.revisionDigest}`, kind: "DESIGN", title: "Design record",
      contractRef: { ...record.contractRef, plane: "V1" }, planningRunRef: null, sha: null, availability: "PRESENT" });
  }
  if (compiled?.integratedArtifact != null) {
    add({ id: `build:${compiled.planningRunRef}:${compiled.graphContentHash}:${compiled.contractRef.revisionDigest}:${compiled.integratedArtifact.sha}`,
      kind: "BUILD", title: "Current implementation", contractRef: compiledRef,
      planningRunRef: compiled.planningRunRef, sha: compiled.integratedArtifact.sha, availability: "PRESENT" });
  }
  if (input.preview?.status === "PREVIEW" && input.preview.preview.goalId === input.goalRef) {
    const { preview } = input.preview;
    add({ id: `preview:${preview.receiptId}`, kind: "PREVIEW", title: "Recorded preview", contractRef: forSha(preview.sha),
      planningRunRef: forSha(preview.sha) === null ? null : compiled?.planningRunRef ?? null,
      sha: preview.sha, availability: preview.outcome === "STARTED" ? "PRESENT" : "REFUSED" });
  }
  if (input.release?.status === "PRESENT" && input.release.evidence.goalId === input.goalRef) {
    const { receipt } = input.release.evidence;
    if (receipt !== null) add({ id: `release:${receipt.receiptId}`, kind: "RELEASE",
      title: receipt.outcome === "RELEASED" ? "Released source" : "Release decision", contractRef: forSha(receipt.sha),
      planningRunRef: forSha(receipt.sha) === null ? null : compiled?.planningRunRef ?? null,
      sha: receipt.sha, availability: receipt.outcome === "RELEASED" ? "PRESENT" : "REFUSED" });
  }
  return Object.freeze(artifacts);
}
