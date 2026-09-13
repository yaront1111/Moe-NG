/** Local presentation identities. connectionId is an opaque binding, never a credential. */
export interface ProductScope {
  readonly connectionId: string;
  readonly projectId: string;
  readonly goalId: string;
  readonly plane: "V1" | "V2";
}

export interface ProductContractRef {
  readonly plane: "V1" | "V2";
  readonly contractId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
}

export type ProductReadAvailability = "LOADING" | "PRESENT" | "ABSENT" | "REFUSED" | "UNREADABLE" | "STALE";
export type ProductArtifactKind = "SOURCE" | "DEFINITION" | "DESIGN" | "BUILD" | "PREVIEW" | "RELEASE";

export interface ProductArtifact {
  readonly id: string;
  readonly scope: ProductScope;
  readonly kind: ProductArtifactKind;
  readonly title: string;
  readonly contractRef: ProductContractRef | null;
  readonly planningRunRef: string | null;
  readonly sha: string | null;
  readonly availability: ProductReadAvailability;
}

export interface ProductArtifactSelectionInput {
  readonly scope: ProductScope;
  readonly artifacts: readonly ProductArtifact[];
  readonly selectedId?: string | null;
  readonly preferredId?: string | null;
}

export interface ProductArtifactSelection {
  readonly status: "SELECTED" | "UNAVAILABLE" | "EMPTY";
  readonly selectedId: string | null;
  readonly artifact: ProductArtifact | null;
}

export interface ProductCriterion { readonly criterionId: string; readonly statement: string }
export interface ProductRequirement {
  readonly requirementId: string;
  readonly statement: string;
  readonly criteria: readonly ProductCriterion[];
}

interface ProductEvidenceBinding {
  readonly scope: ProductScope;
  readonly contractRef: ProductContractRef;
  readonly planningRunRef: string;
  readonly graphContentHash: string;
  readonly criterionId: string;
}

export interface ProductImplementationLink extends ProductEvidenceBinding {
  readonly nodeKey: string;
  readonly state: "PLANNED" | "IMPLEMENTED" | "UNKNOWN";
}

export interface ProductCheck extends ProductEvidenceBinding {
  readonly sha: string;
  readonly receiptId: string;
  readonly status: "PASSED" | "FAILED" | "UNKNOWN";
}

export interface ProductRequirementsInput {
  readonly scope: ProductScope;
  readonly contractRef: ProductContractRef | null;
  readonly planningRunRef: string | null;
  readonly graphContentHash: string | null;
  readonly sha: string | null;
  readonly availability: ProductReadAvailability;
  readonly requirements: readonly ProductRequirement[];
  readonly implementationLinks: readonly ProductImplementationLink[];
  readonly checks: readonly ProductCheck[];
}

export type ProductRequirementState = "NOT_IMPLEMENTED" | "IN_PROGRESS" | "IMPLEMENTED_UNCHECKED"
  | "PASSED" | "FAILED" | "NEEDS_CHECKING_AGAIN" | "UNKNOWN";

export interface ProductCriterionModel extends ProductCriterion {
  readonly state: ProductRequirementState;
  readonly implementationNodes: readonly string[];
  readonly receiptIds: readonly string[];
}

export interface ProductRequirementModel {
  readonly requirementId: string;
  readonly statement: string;
  readonly state: ProductRequirementState;
  readonly criteria: readonly ProductCriterionModel[];
  readonly relationshipNote: string;
}

export interface ProductReadiness {
  readonly state: "PASSED" | "FAILED" | "INCOMPLETE" | "UNKNOWN";
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly label: string;
}

export interface ProductRequirementsModel {
  readonly advisoryOnly: true;
  readonly requirements: readonly ProductRequirementModel[];
  readonly readiness: ProductReadiness;
}
