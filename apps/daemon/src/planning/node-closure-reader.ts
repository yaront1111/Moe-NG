/**
 * "What is the node-authority closure of the project's current graph?" — answered from the
 * durable graph body, or refused.
 *
 * THIS READER MINTS NO AUTHORITY. Since v3 the closure IS the graph body:
 * `GraphRevisionContent.nodeAuthority` is mandatory (`graph-content-fields.ts:82`) and carries
 * every node's `NodeDefinition` — `criterionBindings`, `directHardDependencies`,
 * `monotonicPredicateProofs`, `planExecutionContentDigest`. So this module composes
 * `readCurrentActiveGraph` and PROJECTS what the codec already sealed. It reads no spec file,
 * takes no closure from its caller, and derives nothing.
 *
 * WHY IT DOES NOT RE-DERIVE, which is the tempting mistake. Integrity here belongs to two
 * gates that already exist: `bindAuthority` RE-DERIVES the authority set at encode time and
 * refuses `GRAPH_CONTENT_AUTHORITY_DISAGREEMENT` on any stated set that is not the derived
 * one, and `readGraphBody` refuses `GRAPH_BODY_IDENTITY_MISMATCH` when stored bytes are filed
 * under a key they do not hash to. A re-derivation here would be a SECOND copy of the first
 * gate — free to drift from it, and its refusals would shadow the codec's own vocabulary in a
 * place no codec test looks. The reader's whole job is to not become an authority.
 *
 * REFUSALS ARE PASSED THROUGH, NEVER RESTAMPED. A projection refusal keeps its own code, and
 * `upstream` carries that code, the projection's layer, and — when the projection was itself
 * wrapping the graph-body record — that third layer's code and layer too. Flattening any of
 * those would tell a caller which module answered but not which one actually refused.
 *
 * UNKNOWN NEVER BECOMES EMPTY. Every refusal path returns an `outcome: "UNKNOWN"` shell with
 * no closure fields at all — never an empty `authorities`/`definitions` pair, which a caller
 * would read as "this graph has no nodes".
 *
 * CONSUMER: task-c320c34a's Foundation context matrix, DoD-1 row "node closure" — satisfiable
 * by grep on `readCurrentNodeClosure`. The BUDGETS/COVERAGE half of the original row is split
 * out to task-1b0a8477, behind its own durable-producer lane; nothing here answers a budget.
 */

import type { SqliteEventStore } from "@moe/store";
import type { NodeAuthorityEntry, NodeDefinition } from "@moe/scheduler";

import { readCurrentActiveGraph } from "./active-graph-projection.js";
import type { ActiveGraphRefusal } from "./active-graph-projection.js";

/**
 * The one refusal this module ORIGINATES. Everything else is a passthrough that keeps the
 * refusing layer's own spelling, so this roster stays closed: a projection code merged in
 * here would let an upstream change silently widen this module's contract.
 */
export const NODE_CLOSURE_READER_CODES = Object.freeze([
  "NODE_CLOSURE_NODE_UNKNOWN",
] as const);

/** Module-private, travelling as a closed TYPE. Same decision as every seam in this family. */
const NODE_CLOSURE_READER_LAYER = "NODE_CLOSURE_READER";

export type NodeClosureReaderLayer = typeof NODE_CLOSURE_READER_LAYER;
export type NodeClosureReaderCode = (typeof NODE_CLOSURE_READER_CODES)[number];
export type NodeClosureCode = NodeClosureReaderCode | ActiveGraphRefusal["code"];

/**
 * The refusal as it arrived, three fields deep where the stack is three deep:
 * `code`/`layer` name the projection, `sourceCode`/`sourceLayer` the module it was wrapping.
 */
export interface NodeClosureUpstream {
  readonly code: string;
  readonly layer: string;
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
}

export interface NodeClosureUnknown {
  readonly authority: "NONE";
  readonly code: NodeClosureCode;
  /** Names the project or node key asked for, so a caller can act without a second read. */
  readonly detail: string;
  readonly layer: NodeClosureReaderLayer;
  readonly ok: false;
  readonly outcome: "UNKNOWN";
  /** `null` when this module minted the refusal itself. */
  readonly upstream: NodeClosureUpstream | null;
}

/** The sealed closure, index-aligned exactly as the codec stored it. */
export interface NodeClosure {
  readonly authorities: readonly NodeAuthorityEntry[];
  readonly definitions: readonly NodeDefinition[];
  readonly graphContentHash: string;
  readonly ok: true;
  readonly revisionId: string;
}

export interface NodeClosureEntry {
  readonly definition: NodeDefinition;
  readonly nodeAuthorityHash: string;
  readonly ok: true;
}

export type NodeClosureResult = NodeClosure | NodeClosureUnknown;
export type NodeClosureEntryResult = NodeClosureEntry | NodeClosureUnknown;

function refuse(
  code: NodeClosureCode,
  detail: string,
  upstream: NodeClosureUpstream | null,
): NodeClosureUnknown {
  return Object.freeze({
    authority: "NONE" as const,
    code,
    detail,
    layer: NODE_CLOSURE_READER_LAYER,
    ok: false as const,
    outcome: "UNKNOWN" as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

/**
 * Freezes the answer all the way down. The caller holds a view of sealed durable content;
 * a mutable one would let a consumer edit a closure and hand it on as authority.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

/**
 * Read the node-authority closure of the project's current ACTIVE graph, or refuse with the
 * code of whichever layer actually refused. Never appends; every path is a read.
 */
export function readCurrentNodeClosure(
  store: SqliteEventStore,
  projectId: string,
): NodeClosureResult {
  const active = readCurrentActiveGraph(store, projectId);
  if (!active.ok) {
    return refuse(active.code, `no readable active graph for project ${projectId}`, {
      code: active.code,
      layer: active.layer,
      sourceCode: active.sourceCode,
      sourceLayer: active.sourceLayer,
    });
  }
  const section = active.content.nodeAuthority;
  return deepFreeze({
    authorities: section.authorities,
    definitions: section.definitions,
    graphContentHash: active.graphContentHash,
    ok: true as const,
    revisionId: active.revisionId,
  });
}

/**
 * The definition and authority hash for one node key. Both halves are looked up BY KEY rather
 * than by a shared index: the codec keeps the two arrays aligned, and a reader that assumed
 * the alignment instead of using the key would answer a neighbouring node's hash if it ever
 * broke — the one failure a per-node accessor must not have.
 */
export function nodeClosureOf(closure: NodeClosure, nodeKey: string): NodeClosureEntryResult {
  const definition = closure.definitions.find((entry) => entry.nodeKey === nodeKey);
  const authority = closure.authorities.find((entry) => entry.nodeKey === nodeKey);
  if (definition === undefined || authority === undefined) {
    return refuse(
      "NODE_CLOSURE_NODE_UNKNOWN",
      `no node authority for node key ${nodeKey}`,
      null,
    );
  }
  return Object.freeze({
    definition,
    nodeAuthorityHash: authority.nodeAuthorityHash,
    ok: true as const,
  });
}
