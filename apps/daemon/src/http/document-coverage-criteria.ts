import { encodeGraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { readCompiledContractBinding } from "../planning/compiled-contract-binding.js";
import { locateSealedAuthority } from "../planning/planning-authority-reader-seal.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import { currentCriterionReceipts } from "../criterion-evidence/criterion-read.js";

export const coverageContractKey = (ref: Readonly<{ plane: "V1" | "V2"; contractId: string; revisionId: string; revisionDigest: string }>): string =>
  JSON.stringify([ref.plane, ref.contractId, ref.revisionId, ref.revisionDigest]);

/** Full compiler-written scope is mandatory. Legacy IDs and matching statements confer no criterion authority. */
export function readCoverageCriterionAuthority(store: SqliteEventStore, projectId: string, graphs: readonly ActiveCompiledGraph[]) {
  const associations = new Map<string, string>();
  const verified = new Set<string>();
  for (const graph of graphs) {
    if (graph.planningRunRef === undefined) continue;
    const binding = readCompiledContractBinding(store, projectId, graph.planningRunRef);
    const sealed = locateSealedAuthority(store, projectId, graph.goalRef);
    const encoded = encodeGraphContent(graph.content);
    if (!binding.ok || "ok" in sealed || !encoded.ok || binding.binding.goalRef !== graph.goalRef
      || sealed.runId !== graph.planningRunRef || sealed.revision.graphBinding.graphContentHash !== encoded.value.graphContentHash
      || binding.binding.graphContentHash !== encoded.value.graphContentHash) continue;
    associations.set(graph.goalRef, coverageContractKey({ ...binding.binding.contractRef, plane: "V1" }));
    const goal = readCriterionGoal(store, projectId, graph.goalRef);
    if (!goal.ok) continue;
    for (const criterionId of currentCriterionReceipts(store, goal).keys()) verified.add(JSON.stringify([graph.goalRef, criterionId]));
  }
  return { associations, verified };
}
