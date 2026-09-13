import { buildProductRequirements, sameProductContract, selectProductArtifact } from "@moe/control-room-model";
import type { ProductArtifact, ProductCheck, ProductContractRef, ProductReadAvailability } from "@moe/control-room-model";
import type { CriterionEvidenceView } from "../../live/live-criterion-evidence-contracts.js";
import { productArtifacts } from "./product-model-artifacts.js";
import type { ProductWorkspaceInput, ProductWorkspaceModel } from "./product-model-contracts.js";
export type { ProductWorkspaceInput, ProductWorkspaceModel } from "./product-model-contracts.js";

function compiledView(input: ProductWorkspaceInput): CriterionEvidenceView | null {
  // This shipped criterion reader reads V1 revisions; its wire ref has no plane discriminator.
  const view = input.criteria?.status === "CRITERION_EVIDENCE" && input.scope.plane === "V1" ? input.criteria.view : null;
  return view !== null && view.goalRef === input.goalRef && view.planningRunRef === input.planningRunRef ? view : null;
}

function checksOf(input: ProductWorkspaceInput, view: CriterionEvidenceView | null): readonly ProductCheck[] {
  if (view === null) return [];
  return view.criteria.flatMap((criterion): ProductCheck[] => {
    const evidence = criterion.evidence;
    if (evidence === null) return [];
    const bound = criterion.approval !== null && view.run?.status === "COMPLETED"
      && view.run.runRef === evidence.runRef && view.run.integratedSha === evidence.sha
      && (view.integratedArtifact?.sha !== evidence.sha || view.integratedArtifact.treeSha === evidence.treeSha);
    return [{ scope: input.scope, contractRef: { ...view.contractRef, plane: "V1" }, planningRunRef: view.planningRunRef,
      graphContentHash: view.graphContentHash, criterionId: criterion.criterionId, sha: evidence.sha,
      receiptId: evidence.receiptId, status: bound ? evidence.status : "UNKNOWN" }];
  });
}

function workingArtifact(artifacts: readonly ProductArtifact[]): ProductArtifact | null {
  const build = artifacts.find((item) => item.kind === "BUILD");
  const preview = artifacts.find((item) => item.kind === "PREVIEW" && item.availability === "PRESENT"
    && (build === undefined || item.sha === build.sha));
  return preview ?? build ?? artifacts.find((item) => item.kind === "DESIGN")
    ?? artifacts.find((item) => item.kind === "DEFINITION") ?? artifacts.find((item) => item.kind === "SOURCE") ?? null;
}

function deliveryStatus(input: ProductWorkspaceInput): Pick<ProductWorkspaceModel, "deliveryState" | "deliveryNote"> {
  const read = input.release;
  if (read === null) return { deliveryState: "LOADING", deliveryNote: "Reading release history." };
  if (read.status === "ERROR") return { deliveryState: "UNREADABLE", deliveryNote: "Release history cannot currently be read." };
  if (read.status === "REFUSED") return { deliveryState: "REFUSED", deliveryNote: "Release history is unavailable." };
  if (read.status !== "PRESENT" && read.status !== "ABSENT") {
    return { deliveryState: "UNREADABLE", deliveryNote: "Release history cannot currently be read." };
  }
  const goalRef = read.status === "ABSENT" ? read.goalId : read.evidence.goalId;
  if (goalRef !== input.goalRef || input.scope.goalId !== input.goalRef) {
    return { deliveryState: "UNREADABLE", deliveryNote: "The release read belongs to a different product." };
  }
  if (read.status === "ABSENT" || read.evidence.receipt === null) {
    return { deliveryState: "ABSENT", deliveryNote: "No released version recorded." };
  }
  return read.evidence.receipt.outcome === "RELEASED"
    ? { deliveryState: "PRESENT", deliveryNote: "A released version is available." }
    : { deliveryState: "REFUSED", deliveryNote: "The latest release attempt was refused; earlier releases are not established by this read." };
}

/** Converts already decoded, request-scoped reads into the shared pure presentation model. */
export function createProductWorkspaceModel(input: ProductWorkspaceInput): ProductWorkspaceModel {
  const validScope = input.scope.goalId === input.goalRef && (input.goal == null || input.goal.goalId === input.goalRef);
  const compiled = validScope ? compiledView(input) : null;
  const compiledRef: ProductContractRef | null = compiled === null ? null : { ...compiled.contractRef, plane: "V1" };
  const explicitRef = input.viewedContractRef?.plane === input.scope.plane ? input.viewedContractRef : null;
  const requestedRef = explicitRef ?? compiledRef;
  const artifacts = validScope ? productArtifacts(input, compiled, requestedRef) : Object.freeze([]);
  const currentWork = workingArtifact(artifacts);
  const delivered = artifacts.find((item) => item.kind === "RELEASE" && item.availability === "PRESENT") ?? null;
  const explicitDefinition = explicitRef !== null && !sameProductContract(explicitRef, compiledRef)
    ? artifacts.find((item) => item.kind === "DEFINITION" && sameProductContract(item.contractRef, explicitRef)) : null;
  const selection = selectProductArtifact({ scope: input.scope, artifacts,
    selectedId: input.selectedArtifactId ?? null, preferredId: explicitDefinition?.id ?? currentWork?.id ?? delivered?.id ?? null });
  const contractRef = selection.artifact?.contractRef ?? (selection.status === "EMPTY" || selection.artifact?.kind === "SOURCE" ? requestedRef : null);
  const coverage = input.coverage?.status === "COVERAGE" ? input.coverage : null;
  const matches = coverage?.contracts.filter((item) => sameProductContract(item, contractRef)) ?? [];
  const contract = matches.length === 1 ? matches[0]! : null;
  const evidenceApplies = sameProductContract(contractRef, compiledRef);
  const availability: ProductReadAvailability = selection.status === "UNAVAILABLE" ? "UNREADABLE"
    : input.coverage === null ? "LOADING" : contract === null ? "UNREADABLE"
    : input.criteria?.status === "REFUSED" ? "REFUSED" : input.criteria?.status === "ERROR" ? "UNREADABLE" : "PRESENT";
  const result = buildProductRequirements({ scope: input.scope, contractRef,
    planningRunRef: evidenceApplies ? compiled?.planningRunRef ?? null : null,
    graphContentHash: evidenceApplies ? compiled?.graphContentHash ?? null : null,
    sha: selection.artifact?.sha ?? null, availability,
    requirements: contract?.requirements.map((row) => ({ requirementId: row.requirementId, statement: row.statement,
      criteria: row.criteria.map((criterion) => ({ criterionId: criterion.criterionId, statement: criterion.statement })),
    })) ?? [],
    // Coverage is document-wide and omits graph/run identities. Local node keys cannot establish this join.
    implementationLinks: [], checks: checksOf(input, compiled),
  });
  const scopeNote = !validScope ? "This read belongs to a different product."
    : contractRef === null ? "The exact definition binding for this product is not available yet."
    : contract === null ? "The selected definition cannot currently be read."
    : !evidenceApplies || compiled === null ? "Candidate checks are not bound to this definition yet."
    : null;
  return Object.freeze({ advisoryOnly: true, artifacts, selection, requirements: result.requirements, readiness: result.readiness,
    contractRef, scopeNote, currentWork, delivered, ...deliveryStatus(input) });
}
