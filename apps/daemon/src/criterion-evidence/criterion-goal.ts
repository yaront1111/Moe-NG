import { encodeGraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import type { ActiveCompiledGraph } from "../orchestrator/compiled-node-source.js";
import { readCompiledContractBinding } from "../planning/compiled-contract-binding.js";
import type { CompiledContractBinding } from "../planning/compiled-contract-binding.js";
import { readProductContractRevision } from "../product-contract/product-contract-revision-reader.js";
import { locateSealedAuthority } from "../planning/planning-authority-reader-seal.js";
import { criterionRefused } from "./criterion-contracts.js";
import type { CriterionRefused } from "./criterion-contracts.js";
import { criterionHash } from "./criterion-codec.js";

export interface CriterionGoal {
  readonly ok: true;
  readonly binding: CompiledContractBinding;
  readonly graph: ActiveCompiledGraph;
  readonly criteria: readonly Readonly<{ criterionId: string; statement: string; contentDigest: string }>[];
}
export function readCriterionGoal(store: SqliteEventStore, projectId: string, goalRef: string): CriterionGoal | CriterionRefused {
  try {
    const graphs = activeCompiledGraphs(store, projectId, new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]))
      .filter((graph) => graph.goalRef === goalRef);
    if (graphs.length !== 1 || graphs[0]!.planningRunRef === undefined) return criterionRefused("CRITERION_CHECK_GOAL_UNBOUND");
    const graph = graphs[0]!;
    const bound = readCompiledContractBinding(store, projectId, graph.planningRunRef!);
    if (!bound.ok) return criterionRefused(bound.code);
    const encoded = encodeGraphContent(graph.content);
    const sealed = locateSealedAuthority(store, projectId, goalRef);
    if (!encoded.ok || encoded.value.graphContentHash !== bound.binding.graphContentHash || bound.binding.goalRef !== goalRef
      || "ok" in sealed || sealed.runId !== graph.planningRunRef
      || sealed.revision.graphBinding.graphContentHash !== bound.binding.graphContentHash) return criterionRefused("CRITERION_CHECK_SCOPE_MISMATCH");
    const revision = readProductContractRevision(store, { projectId, ref: bound.binding.contractRef });
    if (!revision.ok) return criterionRefused("CRITERION_CHECK_SCOPE_MISMATCH");
    return { ok: true, binding: bound.binding, graph, criteria: revision.revision.criteria.map(({ criterionId, statement }) => ({
      criterionId, statement, contentDigest: criterionHash([criterionId, statement]),
    })) };
  } catch { return criterionRefused("CRITERION_CHECK_UNREADABLE"); }
}
