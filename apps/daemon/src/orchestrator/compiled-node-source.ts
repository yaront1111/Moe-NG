/**
 * Code-node steps and coding briefs derived from durable ACTIVATED plans — the
 * piece that lets a COMPILED plan build itself. The spec-dir loader
 * (`agent-wrapper-main.ts`) serves operator-authored nodes; this source serves
 * the nodes an approved compiled plan sealed.
 *
 * WHERE "ACTIVE" IS READ FROM, and why it is not the graph.get projection: the
 * browser's approve wire (`approval.decide_intent`) activates through
 * `goal.activate_initial_graph` — the GOAL turns EXECUTION_ENABLED with the
 * approved run bound — and never writes a `graph-revision:` aggregate (that is
 * `graph.approve`'s own path). So this source walks the ledger's ENABLED goals,
 * takes each bound run's SEALED `graphContentHash` (written only by core's
 * submission fold), and reads the body through `readGraphBody`, which re-proves
 * the stored bytes decode to their declared digest. A node offered here is
 * exactly a node a human-approved, daemon-sealed plan carries.
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
import type { GraphRevisionContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger, stateOf } from "../bootstrap/bootstrap-ledger.js";
import { createCompilerLanePort } from "../http/affordance-compiler-lane.js";
import type { NodeSpec } from "../http/affordance-contract.js";
import { readGraphBody } from "../planning/graph-body-record.js";
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

/** One activated compiled plan: the sealed body plus the goal it belongs to. */
export interface ActiveCompiledGraph {
  readonly content: GraphRevisionContent;
  readonly goalRef: string;
}

export interface CompiledNodeSource {
  mission(nodeRef: string): CompiledNodeMission | null;
  nodes(): readonly NodeSpec[];
}

export interface CompiledNodeSourceOptions {
  readonly projectId: string;
  /** Injectable for tests; production walks the enabled goals durably. */
  readonly readActive?: (
    store: SqliteEventStore, projectId: string,
  ) => readonly ActiveCompiledGraph[];
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

const HEX_64 = /^[0-9a-f]{64}$/u;
const ENABLED_LIFECYCLES = new Set(["EXECUTION_ENABLED", "CLOSING"]);

/**
 * Every enabled goal's sealed compiled plan, read from durable state alone: the
 * folded goal names its run; the folded run names the sealed content hash core's
 * own submission fold wrote; `readGraphBody` re-proves the bytes. A goal whose
 * chain does not re-prove contributes NOTHING (an unreadable plan is never
 * staffed), it does not take the listing down.
 */
function activeCompiledGraphs(
  store: SqliteEventStore, projectId: string,
): readonly ActiveCompiledGraph[] {
  const ledger = readDurableLedger(store, projectId);
  const active: ActiveCompiledGraph[] = [];
  for (const [aggregateId] of ledger.aggregates) {
    const goal = dataRecord(stateOf(ledger, aggregateId));
    if (goal?.["goalId"] !== aggregateId || goal["projectId"] !== projectId) continue;
    if (!ENABLED_LIFECYCLES.has(String(goal["lifecycle"]))) continue;
    const planningRunRef = goal["planningRunRef"];
    if (typeof planningRunRef !== "string") continue;
    const run = dataRecord(stateOf(ledger, planningRunRef));
    const sealed = dataRecord(dataRecord(run?.["state"])?.["sealedHashes"]);
    const graphContentHash = sealed?.["graphContentHash"];
    if (typeof graphContentHash !== "string" || !HEX_64.test(graphContentHash)) continue;
    const body = readGraphBody(store, projectId, graphContentHash);
    if (!body.ok) continue;
    active.push(Object.freeze({ content: body.content, goalRef: aggregateId }));
  }
  return active;
}

interface SealedNode {
  readonly criterionIds: readonly string[];
  readonly goalRef: string;
  readonly nodeKey: string;
  readonly objective: string;
}

function sealedNodesOf(graphs: readonly ActiveCompiledGraph[]): readonly SealedNode[] {
  const nodes: SealedNode[] = [];
  const listed = new Set<string>();
  for (const graph of graphs) {
    const bearing = new Set(graph.content.snapshot.nodes
      .filter((node) => node.executionBearing).map((node) => node.nodeKey));
    for (const definition of graph.content.nodeAuthority.definitions) {
      if (!bearing.has(definition.nodeKey) || listed.has(definition.nodeKey)) continue;
      listed.add(definition.nodeKey);
      nodes.push(Object.freeze({
        criterionIds: definition.criterionBindings.map((binding) => binding.criterionId),
        goalRef: graph.goalRef,
        nodeKey: definition.nodeKey,
        objective: definition.objective,
      }));
    }
  }
  return nodes;
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
  const readActive = options.readActive ?? activeCompiledGraphs;
  const sealed = (): readonly SealedNode[] => {
    try {
      return sealedNodesOf(readActive(options.store, options.projectId));
    } catch {
      // A degraded read lists nothing rather than throwing the surface down.
      return [];
    }
  };
  const nodes = (): readonly NodeSpec[] => sealed().map((node) =>
    Object.freeze({ nodeRef: node.nodeKey, title: node.objective }));
  const mission = (nodeRef: string): CompiledNodeMission | null => {
    if (options.workspace === null || options.testCommand === null) return null;
    const node = sealed().find((candidate) => candidate.nodeKey === nodeRef);
    if (node === undefined) return null;
    let statements: readonly string[];
    try {
      statements = criterionStatements(options, node.goalRef, node.criterionIds);
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
