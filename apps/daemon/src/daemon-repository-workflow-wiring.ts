import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { SqliteEventStore } from "@moe/store";
import { createCriterionEvidenceService } from "./criterion-evidence/criterion-service.js";
import type { RepositoryWorkflowReadPort } from "./http/repository-workflow-read.js";
import { createWrapperNodeMissions } from "./orchestrator/wrapper-node-missions.js";
import { createPublicationCandidateReader } from "./repository/publication-candidate.js";
import { createRepositoryRecoveryService } from "./repository/repository-recovery-service.js";
/** Command/read processes only expose queueing. The wrapper owns advance and child shutdown. */
export function createRepositoryWorkflowWiring(options: { readonly store: SqliteEventStore; readonly projectId: string;
  readonly storePath: string; readonly workspace: string | null; readonly nodeSpecsDir?: string | undefined; readonly clock: () => string }) {
  const storeId = realpathSync.native(options.storePath);
  const criterionEvidence = createCriterionEvidenceService({ store: options.store, projectId: options.projectId,
    storeId, workspace: options.workspace, clock: options.clock });
  const missions = createWrapperNodeMissions({ nodeSpecsDir: options.nodeSpecsDir, compiled: () => null, log: () => undefined });
  const repositoryRecovery = createRepositoryRecoveryService({ store: options.store, projectId: options.projectId,
    storeId, clock: options.clock, mintId: randomUUID, workspaces: () => [...new Set([
      ...(options.workspace === null ? [] : [options.workspace]),
      ...missions.listNodes().flatMap(({ nodeRef }) => { const brief = missions.nodeMission(nodeRef); return brief === null ? [] : [brief.workspace]; }),
    ])] });
  const repositoryWorkflows = (): RepositoryWorkflowReadPort => Object.freeze({ boundProjectId: options.projectId,
    readCriteria: criterionEvidence.read, readRecovery: repositoryRecovery.readRecovery });
  return Object.freeze({ criterionEvidence, repositoryRecovery, repositoryWorkflows,
    readPublicationCandidate: createPublicationCandidateReader(options.workspace) });
}
