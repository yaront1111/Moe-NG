import { encodeGraphContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
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

/** The lifecycles whose goal carries an approved, activated plan: the same set `criterion-runner.ts` walks. */
const BOUND_LIFECYCLES: ReadonlySet<string> = new Set(["EXECUTION_ENABLED", "CLOSING", "COMPLETED"]);

const dataRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;

/**
 * ONE CODE PER GOAL STATE, read from the goal aggregate's own lifecycle before the graph walk.
 * `CRITERION_CHECK_GOAL_UNBOUND` is rendered by the board as "no checks yet", so it names exactly
 * one state - the goal exists and no plan is approved (DRAFT) - and nothing else folds into it:
 * a goalRef no goal carries is ABSENT, a cancelled goal is CANCELLED, and an ENABLED goal whose
 * sealed plan chain does not re-prove through `activeCompiledGraphs` (an unreadable rejection
 * chain, an activation witness naming another run, a body that fails `readGraphBody`) is
 * UNREADABLE: that is a failure on an approved plan, not a goal with no plan.
 */
export function readCriterionGoal(store: SqliteEventStore, projectId: string, goalRef: string): CriterionGoal | CriterionRefused {
  try {
    const ledger = readDurableLedger(store, projectId);
    const goal = dataRecord(stateOf(ledger, goalRef));
    if (goal === null || goal["goalId"] !== goalRef || goal["projectId"] !== projectId) return criterionRefused("CRITERION_CHECK_GOAL_ABSENT");
    if (goal["lifecycle"] === "DRAFT") return criterionRefused("CRITERION_CHECK_GOAL_UNBOUND");
    if (goal["lifecycle"] === "CANCELLED") return criterionRefused("CRITERION_CHECK_GOAL_CANCELLED");
    const graphs = activeCompiledGraphs(store, projectId, BOUND_LIFECYCLES, ledger).filter((graph) => graph.goalRef === goalRef);
    if (graphs.length !== 1 || graphs[0]!.planningRunRef === undefined) return criterionRefused("CRITERION_CHECK_UNREADABLE");
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
