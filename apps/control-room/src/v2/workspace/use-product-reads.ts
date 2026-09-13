import { useMemo } from "react";
import type { ProductContractRef } from "@moe/control-room-model";
import type { LiveSetup } from "../../live/live-config.js";
import { readGoalSource } from "../../live/live-goal-source.js";
import { readDesign } from "../../live/live-design.js";
import { readDocumentCoverage } from "../../live/live-document-coverage.js";
import { readCriterionEvidence } from "../../live/live-criterion-evidence.js";
import { readPreview } from "../../live/live-preview.js";
import { readRelease } from "../../live/live-release.js";
import { useEffectRead } from "../components/use-effect-read.js";
import { readPendingContract } from "../goals/gate1-approval.js";
import type { Gate1ReadOutcome } from "../goals/gate1-approval.js";
import { readPendingContractV1 } from "../goals/gate1-v1-approval.js";
import type { Gate1ReadOutcomeV1 } from "../goals/gate1-v1-approval.js";

const FAILURE = { status: "ERROR", code: "PRODUCT_READ_FAILED", layer: "CONTROL_ROOM_PRODUCT" } as const;

/** Independent observations, each scoped to this session/goal/run. Never an atomic snapshot. */
export function useProductReads(setup: LiveSetup, goalRef: string, planningRunRef: string) {
  const definitionReader = useMemo(() => (): Promise<Gate1ReadOutcome | Gate1ReadOutcomeV1> =>
    setup.commandAuthorityPlane === "V1" ? readPendingContractV1(setup.headers, goalRef)
      : setup.projectId === null ? Promise.resolve({ status: "ERROR", code: "PROJECT_BINDING_ABSENT", layer: "CONTROL_ROOM_PRODUCT" })
      : readPendingContract(setup.headers, goalRef, setup.projectId), [setup, goalRef]);
  const definition = useEffectRead(definitionReader, FAILURE);
  const definitionRef: ProductContractRef | null = useMemo(() => definition.outcome?.status === "PENDING"
    || definition.outcome?.status === "CURRENT" ? Object.freeze({ plane: setup.commandAuthorityPlane,
      contractId: definition.outcome.contractId, revisionId: definition.outcome.revisionId,
      revisionDigest: definition.outcome.revisionDigest }) : null, [definition.outcome, setup.commandAuthorityPlane]);
  const readers = useMemo(() => ({
    source: () => readGoalSource(setup.headers, goalRef),
    // Authored artifacts exist before compilation. The plan note separately reads its immutable run selection.
    design: () => readDesign(setup.headers, goalRef),
    coverage: () => readDocumentCoverage(setup.headers, goalRef),
    criteria: () => readCriterionEvidence(setup.headers, goalRef),
    preview: () => readPreview(goalRef, setup.headers),
    release: () => readRelease(setup.headers, goalRef),
  }), [setup, goalRef, planningRunRef]);
  const source = useEffectRead(readers.source, FAILURE, 30_000);
  const design = useEffectRead(readers.design, FAILURE);
  const coverage = useEffectRead(readers.coverage, FAILURE);
  const criteria = useEffectRead(readers.criteria, FAILURE);
  const preview = useEffectRead(readers.preview, FAILURE);
  const release = useEffectRead(readers.release, FAILURE);
  return {
    definition: definition.outcome, definitionRef,
    source: source.outcome, design: design.outcome, coverage: coverage.outcome,
    criteria: criteria.outcome, preview: preview.outcome, release: release.outcome,
    refresh: () => {
      definition.refresh();
      source.refresh(); design.refresh(); coverage.refresh(); criteria.refresh(); preview.refresh(); release.refresh();
    },
  };
}
