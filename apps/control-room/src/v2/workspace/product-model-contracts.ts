import type {
  ProductArtifact, ProductArtifactSelection, ProductContractRef, ProductReadAvailability, ProductReadiness, ProductRequirementModel, ProductScope,
} from "@moe/control-room-model";
import type { CriterionEvidenceOutcome } from "../../live/live-criterion-evidence-contracts.js";
import type { DesignOutcome } from "../../live/live-design.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { LiveGoalCatalogEntry } from "../../live/live-goal-catalog.js";
import type { GoalSourceOutcome } from "../../live/live-goal-source.js";
import type { PreviewReadOutcome } from "../../live/live-preview.js";
import type { ReleaseOutcome } from "../../live/live-release.js";

/** Outcomes must already be fenced by the app coordinator's authenticated request scope. */
export interface ProductWorkspaceInput {
  readonly scope: ProductScope;
  readonly goalRef: string;
  readonly planningRunRef: string | null;
  readonly goal?: LiveGoalCatalogEntry | null;
  readonly source: GoalSourceOutcome | null;
  /** Authored goal observation; the plan's pinned design is read separately and is never inferred here. */
  readonly design: DesignOutcome | null;
  readonly coverage: DocumentCoverageOutcome | null;
  readonly criteria: CriterionEvidenceOutcome | null;
  readonly preview: PreviewReadOutcome | null;
  readonly release: ReleaseOutcome | null;
  readonly viewedContractRef?: ProductContractRef | null;
  /** Exact reference from a successful pending/current definition read, independent of coverage. */
  readonly availableDefinitionRef?: ProductContractRef | null;
  readonly selectedArtifactId?: string | null;
}

export interface ProductWorkspaceModel {
  readonly advisoryOnly: true;
  readonly artifacts: readonly ProductArtifact[];
  readonly selection: ProductArtifactSelection;
  readonly requirements: readonly ProductRequirementModel[];
  readonly readiness: ProductReadiness;
  readonly contractRef: ProductContractRef | null;
  readonly scopeNote: string | null;
  readonly currentWork: ProductArtifact | null;
  readonly delivered: ProductArtifact | null;
  readonly deliveryState: ProductReadAvailability;
  readonly deliveryNote: string;
}
