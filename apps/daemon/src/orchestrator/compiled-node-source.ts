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
import { dataRecord } from "../json-record-shape.js";
import { resolveGoalSourceAggregateId } from "../documents/document-source-full-read.js";
import { graphBodyAggregateId, readGraphBody } from "../planning/graph-body-record.js";
import { foldCurrentRun } from "../planning/current-planning-run.js";
import { readApprovedRunWitness } from "../planning/planning-authority-reader-witness.js";
import { legacyCompiledNodeKeys, nodesBlockedByIdentity } from "./compiled-node-identity.js";
import { compiledExecutionRef } from "./compiled-execution-ref.js";
import { compiledPlanContext } from "./compiled-plan-context.js";
import { durableWalkMemoisable, memoisedDurableWalk } from "./durable-walk-memo.js";
import type { DurableWalkMemos } from "./durable-walk-memo.js";
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

const HEX_64 = /^[0-9a-f]{64}$/u;
const ENABLED_LIFECYCLES = new Set(["EXECUTION_ENABLED", "CLOSING"]);

/**
 * WHY THIS WALK IS MEMOISED. `activeCompiledGraphs` folds the whole decision ledger and then
 * parses every sealed graph body out of its JSON bytes — and it is called once PER NODE: the
 * wrapper's delivery pass asks each node for its mission, each mission builds a fresh compiled
 * source, and each source walks everything. Measured on UnAI 2026-09-17 with a 15 s CPU profile
 * of the live wrapper: 63% on-CPU with nothing to staff, 60% of it under this walk (the ledger
 * fold, `decodeBoundedJsonBytes` and `decodeGraphContent`), one delivery pass running for 25
 * minutes with ~70 node trees, and not one log line in that time — so nothing was staffed and
 * governance never ran. The freshness proof lives in `durable-walk-memo.ts`.
 */
const activeGraphMemos: DurableWalkMemos<readonly ActiveCompiledGraph[]> = new WeakMap();

function memoKeyOf(projectId: string, lifecycles: ReadonlySet<string>): string {
  return `${projectId}|${[...lifecycles].sort().join(",")}`;
}

/**
 * The walk itself: every enabled goal's sealed compiled plan, read from durable state alone.
 * The folded goal names its initial run; rejection history resolves its successor and the
 * activation witness must approve that successor. The run names the sealed content hash core's
 * own submission fold wrote; `readGraphBody` re-proves the bytes. A goal whose chain does not
 * re-prove contributes NOTHING (an unreadable plan is never staffed), it does not take the
 * listing down. `touch` is told every aggregate read, before it is read.
 */
function walkActiveGraphs(
  store: SqliteEventStore, projectId: string, lifecycles: ReadonlySet<string>,
  ledger: DurableLedger, touch: (aggregateId: string) => void,
): readonly ActiveCompiledGraph[] {
  const active: ActiveCompiledGraph[] = [];
  const readRun = (runId: string) => { touch(runId); return store.readEvents(runId); };
  for (const [aggregateId] of ledger.aggregates) {
    const goal = dataRecord(stateOf(ledger, aggregateId));
    if (goal?.["goalId"] !== aggregateId || goal["projectId"] !== projectId) continue;
    if (!lifecycles.has(String(goal["lifecycle"]))) continue;
    const initialRunRef = goal["planningRunRef"];
    if (typeof initialRunRef !== "string") continue;
    const current = foldCurrentRun(readRun, initialRunRef);
    if (current.unreadable) continue;
    const planningRunRef = current.runId;
    // A rejection's successor is only executable once the goal's activation names it.
    // Following the latest chain alone would also admit a compiled, unapproved successor.
    if (current.hops > 0) {
      touch(aggregateId);
      const approval = readApprovedRunWitness(store, aggregateId);
      if ("ok" in approval || approval.runId !== planningRunRef) continue;
    }
    const run = dataRecord(stateOf(ledger, planningRunRef));
    const runState = dataRecord(run?.["state"]);
    if (runState?.["goalRef"] !== aggregateId) continue;
    const sealed = dataRecord(runState?.["sealedHashes"]);
    const graphContentHash = sealed?.["graphContentHash"];
    if (typeof graphContentHash !== "string" || !HEX_64.test(graphContentHash)) continue;
    touch(graphBodyAggregateId(projectId, graphContentHash));
    const body = readGraphBody(store, projectId, graphContentHash);
    if (!body.ok) continue;
    active.push(Object.freeze({ content: body.content, goalRef: aggregateId, planningRunRef }));
  }
  return Object.freeze(active);
}

/**
 * Every enabled goal's sealed compiled plan (see `walkActiveGraphs`), walked once per change to
 * anything it read. A caller that hands in its own folded ledger owns its freshness and always
 * gets a fresh walk against that ledger.
 */
export function activeCompiledGraphs(
  store: SqliteEventStore, projectId: string,
  lifecycles: ReadonlySet<string> = ENABLED_LIFECYCLES,
  /** A ledger the caller already folded; absent, this walk folds its own. */
  folded?: DurableLedger,
): readonly ActiveCompiledGraph[] {
  if (folded !== undefined || !durableWalkMemoisable(store)) {
    return walkActiveGraphs(store, projectId, lifecycles, folded ?? readDurableLedger(store, projectId), () => undefined);
  }
  return memoisedDurableWalk(store, activeGraphMemos, memoKeyOf(projectId, lifecycles), (touch) =>
    walkActiveGraphs(store, projectId, lifecycles, readDurableLedger(store, projectId), touch));
}

interface SealedNode {
  readonly graph: ActiveCompiledGraph;
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
        graph,
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

interface CriterionStatement {
  readonly criterionId: string;
  readonly statement: string;
}

/**
 * WHY THIS WALK IS MEMOISED. It reads the goal's source PRD (up to 128KiB) through the compiler
 * lane and parses the approved contract revision, and the wrapper calls it once PER NODE while
 * building each mission. Measured on UnAI 2026-09-17, after the ledger and identity walks were
 * memoised: the last shape still holding the wrapper at ~28% of a core while nothing staffed,
 * `criterionStatements` 8.8% inclusive with the bounded-JSON parser under it.
 *
 * WHY THE KEY TOUCHES THE SOURCE AGGREGATE. The gate approval and the contract revision are
 * ledger state (the marker covers them), but the goal's source document is INGESTED AS ITS OWN
 * LEG — a raw event on `documentSourceAggregateId`, which need not move the decision marker. So
 * the source's absent-then-present transition is invisible to a marker-only key, which would
 * then serve an empty brief for ever after the PRD landed. The walk records the goal aggregate
 * and its source aggregate by version; `resolveGoalSourceAggregateId` finds the latter from the
 * goal's small immutable first event, without paying for the PRD text the memo exists to avoid.
 */
const criterionMemos: DurableWalkMemos<readonly CriterionStatement[]> = new WeakMap();

function allCriterionStatements(
  options: CompiledNodeSourceOptions, goalRef: string, touch: (aggregateId: string) => void,
): readonly CriterionStatement[] {
  touch(goalRef);
  const sourceAggregateId = resolveGoalSourceAggregateId(options.store, options.projectId, goalRef);
  if (sourceAggregateId !== null) touch(sourceAggregateId);
  const ledger = readDurableLedger(options.store, options.projectId);
  const facts = createCompilerLanePort({
    ledger, projectId: options.projectId, store: options.store,
  }).factsFor(goalRef);
  if (facts.lane !== "COMPILER" || facts.approvedGateRef === null) return [];
  touch(deriveProductContractRevisionAggregateId(
    options.projectId, facts.approvedGateRef.contractId, facts.approvedGateRef.revisionId,
  ));
  const revision = dataRecord(stateOf(ledger, deriveProductContractRevisionAggregateId(
    options.projectId, facts.approvedGateRef.contractId, facts.approvedGateRef.revisionId,
  )));
  const criteria = revision?.["criteria"];
  if (!Array.isArray(criteria)) return [];
  const statements: CriterionStatement[] = [];
  for (const entry of criteria) {
    const criterion = dataRecord(entry);
    const criterionId = criterion?.["criterionId"];
    const statement = criterion?.["statement"];
    if (typeof criterionId === "string" && typeof statement === "string") {
      statements.push(Object.freeze({ criterionId, statement }));
    }
  }
  return Object.freeze(statements);
}

/** The approved revision's statements for the cited criterion ids, resolved
 *  through the goal's own compiler lane — empty when the join does not hold
 *  (a brief with the objective alone is honest; an invented statement is not).
 *  The full per-goal statement set is memoised; the per-node filter is not the cost.
 *  Exported for the memo test; production reaches it through `createCompiledNodeSource`. */
export function criterionStatements(
  options: CompiledNodeSourceOptions, goalRef: string, criterionIds: readonly string[],
): readonly string[] {
  const all = durableWalkMemoisable(options.store)
    ? memoisedDurableWalk(options.store, criterionMemos, goalRef,
      (touch) => allCriterionStatements(options, goalRef, touch))
    : allCriterionStatements(options, goalRef, () => undefined);
  const wanted = new Set(criterionIds);
  return all
    .filter((entry) => wanted.has(entry.criterionId))
    .map((entry) => `- [${entry.criterionId}] ${entry.statement}`);
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
      `Compiled goalRef: ${node.goalRef}`,
      node.objective,
      ...(statements.length === 0 ? [] : [
        "",
        "Acceptance criteria from the approved Product Contract"
          + " (every one must hold and stay verifiable):",
        ...statements,
      ]),
      "",
      "Read-only criterion ownership and dependency context from this node's sealed graph.",
      "COMPLETE describes this graph's map, not implementation or verification success. UNKNOWN means no complete map is available; do not infer missing owners or edges.",
      "These local node keys are scoped by the named goal, planning run and graph hash; they are not command targets or new authority.",
      "BEGIN SEALED PLAN CONTEXT",
      JSON.stringify(compiledPlanContext(node.graph, node.nodeKey)),
      "END SEALED PLAN CONTEXT",
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
