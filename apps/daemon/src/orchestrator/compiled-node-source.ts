/**
 * Code-node steps and coding briefs derived from the durable ACTIVE graph — the
 * piece that lets a COMPILED plan build itself. The spec-dir loader
 * (`agent-wrapper-main.ts`) serves operator-authored nodes; this source serves
 * the nodes an approved compiled plan sealed, read back through the SAME
 * projection `graph.get` answers from (`readCurrentActiveGraph`), so a node
 * offered here is exactly a node the activated revision carries.
 *
 * THE BRIEF'S AUTHORITY CHAIN, never invention: the objective and criterion ids
 * come from the sealed node definition; the criterion STATEMENTS come from the
 * Gate-1-approved Product Contract revision the goal's own lane resolves
 * (provenance-joined, same detection the offer ladder used); the workspace and
 * test command are HOST facts the operator configured — an agent-submitted
 * structure can never name a host path or a shell command, so they are supplied
 * here or the node is simply not briefable (fail closed: listed on the board,
 * never staffed with an invented workspace).
 */
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { createCompilerLanePort } from "../http/affordance-compiler-lane.js";
import type { NodeSpec } from "../http/affordance-contract.js";
import { readCurrentActiveGraph } from "../planning/active-graph-projection.js";
import type { ActiveGraphResult } from "../planning/active-graph-projection.js";
import { deriveProductContractRevisionAggregateId }
  from "../product-contract/product-contract-revision-store.js";

/** Structurally identical to the wrapper's `NodeMission`; spelled here so the
 *  http-facing consumers of `nodes()` never import the orchestrator wrapper. */
export interface CompiledNodeMission {
  readonly instructions: string;
  readonly test: string;
  readonly title: string;
  readonly workspace: string;
}

export interface CompiledNodeSource {
  mission(nodeRef: string): CompiledNodeMission | null;
  nodes(): readonly NodeSpec[];
}

export interface CompiledNodeSourceOptions {
  readonly projectId: string;
  /** Injectable for tests; production uses the graph.get projection. */
  readonly readGraph?: (store: SqliteEventStore, projectId: string) => ActiveGraphResult;
  readonly store: SqliteEventStore;
  /** Host-scoped verification command (e.g. "pnpm test"). Absent = no briefs. */
  readonly testCommand: string | null;
  /** Host-scoped absolute workspace path. Absent = no briefs. */
  readonly workspace: string | null;
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

interface SealedNode {
  readonly criterionIds: readonly string[];
  readonly nodeKey: string;
  readonly objective: string;
}

function sealedNodesOf(read: ActiveGraphResult): readonly SealedNode[] {
  if (!read.ok) return [];
  const bearing = new Set(
    read.snapshot.nodes.filter((node) => node.executionBearing).map((node) => node.nodeKey),
  );
  return read.content.nodeAuthority.definitions
    .filter((definition) => bearing.has(definition.nodeKey))
    .map((definition) => Object.freeze({
      criterionIds: definition.criterionBindings.map((binding) => binding.criterionId),
      nodeKey: definition.nodeKey,
      objective: definition.objective,
    }));
}

/** The approved revision's statements for the cited criterion ids, resolved
 *  through the goal's own compiler lane — empty when the join does not hold
 *  (a brief with the objective alone is honest; an invented statement is not). */
function criterionStatements(
  options: CompiledNodeSourceOptions, goalRef: string, criterionIds: readonly string[],
): readonly string[] {
  const ledger = readDurableLedger(options.store, options.projectId);
  const facts = createCompilerLanePort({
    ledger, projectId: options.projectId, store: options.store,
  }).factsFor(goalRef);
  if (facts.lane !== "COMPILER" || facts.approvedGateRef === null) return [];
  const revision = dataRecord(stateOf(ledger, deriveProductContractRevisionAggregateId(
    options.projectId, facts.approvedGateRef.contractId, facts.approvedGateRef.revisionId,
  )));
  const criteria = revision?.["criteria"];
  if (!Array.isArray(criteria)) return [];
  const wanted = new Set(criterionIds);
  const lines: string[] = [];
  for (const entry of criteria) {
    const criterion = dataRecord(entry);
    const criterionId = criterion?.["criterionId"];
    const statement = criterion?.["statement"];
    if (typeof criterionId === "string" && typeof statement === "string"
      && wanted.has(criterionId)) {
      lines.push(`- [${criterionId}] ${statement}`);
    }
  }
  return lines;
}

export function createCompiledNodeSource(options: CompiledNodeSourceOptions): CompiledNodeSource {
  const readGraph = options.readGraph ?? readCurrentActiveGraph;
  const nodes = (): readonly NodeSpec[] => {
    try {
      return sealedNodesOf(readGraph(options.store, options.projectId)).map((node) =>
        Object.freeze({ nodeRef: node.nodeKey, title: node.objective }));
    } catch {
      // A degraded projection lists nothing rather than throwing the surface down.
      return [];
    }
  };
  const mission = (nodeRef: string): CompiledNodeMission | null => {
    if (options.workspace === null || options.testCommand === null) return null;
    let read: ActiveGraphResult;
    try {
      read = readGraph(options.store, options.projectId);
    } catch {
      return null;
    }
    if (!read.ok) return null;
    const node = sealedNodesOf(read).find((sealed) => sealed.nodeKey === nodeRef);
    if (node === undefined) return null;
    let statements: readonly string[];
    try {
      statements = criterionStatements(options, read.provenance.goalRef, node.criterionIds);
    } catch {
      statements = [];
    }
    const instructions = [
      node.objective,
      ...(statements.length === 0 ? [] : [
        "",
        "Acceptance criteria from the approved Product Contract"
          + " (every one must hold and stay verifiable):",
        ...statements,
      ]),
    ].join("\n");
    return Object.freeze({
      instructions,
      test: options.testCommand,
      title: node.objective,
      workspace: options.workspace,
    });
  };
  return Object.freeze({ mission, nodes });
}
