import type { SqliteEventStore } from "@moe/store";
import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import { decodeGoalCatalogEntry } from "../http/goal-catalog-entry.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { compiledContractAggregateId, readCompiledContractBinding } from "../planning/compiled-contract-binding.js";
import { recordOf } from "../planning/planning-authority-reader-witness.js";
import { readApprovedNodeScope } from "./goal-close-prerequisite.js";
import type { ApprovedNodeScope } from "./goal-close-prerequisite.js";

export interface ApprovedExecutionScope extends ApprovedNodeScope {
  /** Old unscoped activation authority must remain visible after scoped review lookup. */
  readonly legacyLocalKeys: readonly string[];
  /** Raw legacy subjects may qualify only through actual Foundation verification receipts. */
  readonly requiresFoundation: boolean;
}

/** The approval stores local keys; current compiled reviews are keyed by immutable execution. */
export function readApprovedExecutionScope(store: SqliteEventStore, projectId: string,
  goalRef: string): ApprovedExecutionScope | null {
  try {
    const approved = readApprovedNodeScope(store, goalRef); if (approved === null) return null;
    const goal = recordOf(stateOf(readDurableLedger(store, projectId), goalRef));
    if (goal?.["goalId"] !== goalRef || goal["projectId"] !== projectId) return null;
    const runRef = goal["planningRunRef"]; if (typeof runRef !== "string") return null;
    const binding = readCompiledContractBinding(store, projectId, runRef);
    if (!binding.ok) {
      // The existing Foundation leg has no Product Contract binding. A damaged or hidden
      // binding cannot enter it; the ordinary acceptance/receipt checks still govern legacy.
      const initial = store.readAggregateEvents(goalRef, 0, 1).items;
      const event = initial.length === 1 ? initial[0] : undefined;
      const catalog = event === undefined ? null : decodeGoalCatalogEntry(event, projectId);
      return binding.code === "COMPILED_CONTRACT_BINDING_ABSENT"
        && store.getAggregateVersion(compiledContractAggregateId(projectId, runRef)) === 0
        && event?.aggregateId === goalRef && event.eventType === "GoalCreated"
        && catalog?.ok === true && catalog.entry.goalId === goalRef
        && catalog.entry.planningRunRef === runRef && catalog.entry.binding === null
        ? { ...approved, legacyLocalKeys: [], requiresFoundation: true } : null;
    }
    // This reader re-proves the activation run witness, folded goal/run, sealed graph body,
    // original contract revision, and their immutable binding. No key-name inference suffices.
    const compiled = readCriterionGoal(store, projectId, goalRef);
    if (!compiled.ok || compiled.binding.planningRunRef !== runRef || compiled.binding.goalRef !== goalRef) return null;
    const local = compiled.graph.content.snapshot.nodes.filter((node) => node.executionBearing)
      .map((node) => node.nodeKey).sort();
    const declared = [...approved.scope].sort();
    if (local.length === 0 || new Set(declared).size !== declared.length
      || local.length !== declared.length || local.some((key, index) => key !== declared[index])) return null;
    return { approvalRef: approved.approvalRef, legacyLocalKeys: local, requiresFoundation: false,
      scope: local.map((key) => compiledExecutionRef(projectId, compiled.graph, key)) };
  } catch { return null; }
}
