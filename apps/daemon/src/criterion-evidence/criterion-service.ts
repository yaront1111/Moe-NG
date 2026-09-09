import type { SqliteEventStore } from "@moe/store";
import type { CriterionCommandInput, CriterionCommandResult } from "./criterion-contracts.js";
import { approveCriterionCheck } from "./criterion-approval.js";
import { queueCriterionVerification } from "./criterion-run.js";
import { readIntegratedCriterionArtifact } from "./criterion-artifact.js";
import type { CriterionGoal } from "./criterion-goal.js";
import type { IntegratedCriterionArtifact } from "./criterion-contracts.js";
import { readCriterionEvidence } from "./criterion-read.js";
import { createCriterionRunner } from "./criterion-runner.js";
import type { CriterionRunnerOptions } from "./criterion-runner.js";
export interface CriterionEvidenceOptions {
  readonly store: SqliteEventStore;
  readonly projectId: string;
  readonly storeId: string;
  readonly workspace: string | null;
  readonly clock: () => string;
  /** Test seam; production always measures the full integrated Git candidate. */
  readonly readIntegrated?: (goal: CriterionGoal) => IntegratedCriterionArtifact | null;
  readonly executor?: CriterionRunnerOptions["executor"];
  readonly repository?: CriterionRunnerOptions["repository"];
}
export function createCriterionEvidenceService(options: CriterionEvidenceOptions) {
  const artifactFor = options.readIntegrated ?? ((goal: CriterionGoal) => readIntegratedCriterionArtifact(options.store, goal, options.workspace));
  const runner = createCriterionRunner({ store: options.store, projectId: options.projectId, storeId: options.storeId,
    workspace: options.workspace, clock: options.clock, artifactFor,
    ...(options.executor === undefined ? {} : { executor: options.executor }),
    ...(options.repository === undefined ? {} : { repository: options.repository }),
  });
  return {
    read: (goalRef: string) => readCriterionEvidence(options.store, options.projectId, goalRef, artifactFor),
    approve(input: CriterionCommandInput): CriterionCommandResult {
      return approveCriterionCheck(options.store, options.projectId, input, options.clock());
    },
    verify(input: CriterionCommandInput): CriterionCommandResult {
      return queueCriterionVerification(options.store, options.projectId, input, options.clock(),
        artifactFor);
    },
    advance: runner.advance,
    close: runner.close,
  };
}
