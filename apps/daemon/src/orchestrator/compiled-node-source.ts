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
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { createCompilerLanePort } from "../http/affordance-compiler-lane.js";
import type { NodeSpec } from "../http/affordance-contract.js";
import { readGraphBody } from "../planning/graph-body-record.js";
import { currentPlanningRun } from "../planning/current-planning-run.js";
import { readApprovedRunWitness } from "../planning/planning-authority-reader-witness.js";
import { legacyCompiledNodeKeys, nodesBlockedByIdentity } from "./compiled-node-identity.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";
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
  /** Present on durable reads; fixtures may supply only the sealed graph. */
  readonly planningRunRef?: string;
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
 * folded goal names its initial run; rejection history resolves its successor and the
 * activation witness must approve that successor. The run names the sealed content hash core's
 * own submission fold wrote; `readGraphBody` re-proves the bytes. A goal whose
 * chain does not re-prove contributes NOTHING (an unreadable plan is never
 * staffed), it does not take the listing down.
 */
export function activeCompiledGraphs(
  store: SqliteEventStore, projectId: string,
  lifecycles: ReadonlySet<string> = ENABLED_LIFECYCLES,
  /** A ledger the caller already folded; absent, this walk folds its own. */
  folded?: DurableLedger,
): readonly ActiveCompiledGraph[] {
  const ledger = folded ?? readDurableLedger(store, projectId);
  const active: ActiveCompiledGraph[] = [];
  for (const [aggregateId] of ledger.aggregates) {
    const goal = dataRecord(stateOf(ledger, aggregateId));
    if (goal?.["goalId"] !== aggregateId || goal["projectId"] !== projectId) continue;
    if (!lifecycles.has(String(goal["lifecycle"]))) continue;
    const initialRunRef = goal["planningRunRef"];
    if (typeof initialRunRef !== "string") continue;
    const current = currentPlanningRun(store, initialRunRef);
    if (current.unreadable) continue;
    const planningRunRef = current.runId;
    // A rejection's successor is only executable once the goal's activation names it.
    // Following the latest chain alone would also admit a compiled, unapproved successor.
    if (current.hops > 0) {
      const approval = readApprovedRunWitness(store, aggregateId);
      if ("ok" in approval || approval.runId !== planningRunRef) continue;
    }
    const run = dataRecord(stateOf(ledger, planningRunRef));
    const runState = dataRecord(run?.["state"]);
    if (runState?.["goalRef"] !== aggregateId) continue;
    const sealed = dataRecord(runState?.["sealedHashes"]);
    const graphContentHash = sealed?.["graphContentHash"];
    if (typeof graphContentHash !== "string" || !HEX_64.test(graphContentHash)) continue;
    const body = readGraphBody(store, projectId, graphContentHash);
    if (!body.ok) continue;
    active.push(Object.freeze({ content: body.content, goalRef: aggregateId, planningRunRef }));
  }
  return active;
}

interface SealedNode {
  readonly criterionIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly goalRef: string;
  readonly nodeKey: string;
  readonly nodeRef: string;
  readonly objective: string;
}

function sealedNodesOf(projectId: string, graphs: readonly ActiveCompiledGraph[]): readonly SealedNode[] {
  const nodes: SealedNode[] = [];
  const listed = new Set<string>();
  for (const graph of graphs) {
    const { edges, nodes: snapshotNodes } = graph.content.snapshot;
    const bearing = new Set(snapshotNodes
      .filter((node) => node.executionBearing).map((node) => node.nodeKey));
    for (const definition of graph.content.nodeAuthority.definitions) {
      const nodeRef = compiledExecutionRef(projectId, graph, definition.nodeKey);
      if (!bearing.has(definition.nodeKey) || listed.has(nodeRef)) continue;
      listed.add(nodeRef);
      nodes.push(Object.freeze({
        criterionIds: definition.criterionBindings.map((binding) => binding.criterionId),
        // The SAME derivation the runs projection uses (runs-read.ts), read off
        // this node's sealed graph: two spellings of build order are how
        // the board and the affordance surface come to disagree about it.
        dependsOn: edges.filter((edge) => edge.consumerNodeKey === definition.nodeKey)
          .map((edge) => compiledExecutionRef(projectId, graph, edge.producerNodeKey)),
        goalRef: graph.goalRef,
        nodeKey: definition.nodeKey,
        nodeRef,
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
      const graphs = readActive(options.store, options.projectId);
      const ambiguous = legacyCompiledNodeKeys(options.store, options.projectId, graphs);
      const blocked = nodesBlockedByIdentity(graphs, ambiguous);
      return sealedNodesOf(options.projectId, graphs).filter((node) => !blocked.has(node.nodeKey));
    } catch {
      // A degraded read lists nothing rather than throwing the surface down.
      return [];
    }
  };
  const nodes = (): readonly NodeSpec[] => sealed().map((node) => Object.freeze({
    dependsOn: Object.freeze([...node.dependsOn]), nodeRef: node.nodeRef, title: node.objective,
  }));
  const mission = (nodeRef: string): CompiledNodeMission | null => {
    if (options.workspace === null || options.testCommand === null) return null;
    const node = sealed().find((candidate) => candidate.nodeRef === nodeRef);
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
