/**
 * The node BRIEF, answered server-side for one node key: the exact four-key record
 * `produceLaunchTemplateFields` demands as its `mission` input, or a refusal naming the layer
 * that could not fill it.
 *
 * WHERE EACH MEMBER COMES FROM, and nowhere else:
 * - `title` / `instructions` — the node's durable `objective`, from the project's current ACTIVE
 *   graph, read through `readCurrentNodeClosure` + `nodeClosureOf`. Those are already the
 *   production key-addressed readers, so this module COMPOSES them and re-derives nothing.
 * - `test` — the host-scoped verification catalog, keyed by (projectId, the node's own durable
 *   `capability`), mapped onto the single string by the catalog's OWN published
 *   `verificationTestField`; this module does not restate that join.
 * - `workspace` — the repository-scope authority's `sourceRepositoryRoot`, as a PROPOSAL.
 *
 * THE STATED MAPPING FROM `objective`, because a mapping nobody wrote down is a mapping nobody
 * can audit, and the row that commissioned this module named "a mapping nobody has stated" as
 * precisely what was missing:
 *   instructions := the objective VERBATIM. Every byte the planner sealed reaches the agent; no
 *                   arm trims, wraps, renumbers or summarises it.
 *   title        := that same objective's FIRST LINE, with a trailing carriage return removed.
 * The first line is a LABEL OVER TEXT THAT ALSO TRAVELS WHOLE, which is why this is a view and
 * not the truncation the brief's no-default rule forbids: nothing sealed is dropped, it is
 * carried twice in two roles, and a single-line objective gives `title === instructions` as the
 * correct degenerate case. When the first line is empty — a leading newline, or an objective of
 * only blank space — this REFUSES rather than emitting a blank title: the consumer admits four
 * empty strings, so a defaulting arm here would be invisible downstream.
 *
 * DISQUALIFIED SOURCES. Nothing here opens a path, reads the worktree, or accepts a brief from a
 * dispatch payload. The operator-authored brief living in the shared tree is writable by any
 * agent holding that tree, so it is not durable authority and may not be consulted — not as a
 * source and not as a fallback. The verification catalog is NOT in that class: daemon PROCESS
 * configuration, outside the worktree, and only its own reader touches a path.
 *
 * REFUSALS ARE FORWARDED, NEVER RESTAMPED. Four vocabularies can answer for one brief — this
 * one, the closure reader's, the catalog's and the repository-scope authority's — so an upstream
 * code and layer ride out under `upstream` instead of being reprinted as ours.
 *
 * CONSUMER: task-fc9660b0a4f24891908a11e303a7c347 and task-933605a5.
 */

import type { SqliteEventStore } from "@moe/store";

import { verificationTestField } from "../evidence/verification-catalog-contracts.js";
import type { VerificationCatalogReader } from "../evidence/verification-catalog-reader.js";
import type {
  FoundationRepositoryScopeResult,
} from "../work/foundation-repository-scope-contracts.js";
import { nodeClosureOf, readCurrentNodeClosure } from "./node-closure-reader.js";

/** Module-private, travelling as a closed TYPE — the decision every seam in this family made. */
const LAYER = "NODE_MISSION_PRODUCER";
export type NodeBriefProducerLayer = typeof LAYER;
/**
 * CLOSED, and every member names a DIFFERENT operator repair. The three the brief's contract
 * demands stay separate ALL THE WAY DOWN — collapsing them would tell an operator nothing:
 *   REQUEST_MALFORMED  — you named no node (or no project). Name one.
 *   GRAPH_UNAVAILABLE  — this project has no readable ACTIVE graph at all. Activate one.
 *   NODE_ABSENT        — the graph is readable and your key is not in it. Check the key.
 */
export const NODE_BRIEF_PRODUCER_CODES = Object.freeze([
  "NODE_MISSION_GRAPH_UNAVAILABLE",
  "NODE_MISSION_NODE_ABSENT",
  "NODE_MISSION_OBJECTIVE_UNUSABLE",
  "NODE_MISSION_REQUEST_MALFORMED",
  "NODE_MISSION_TEST_UNAVAILABLE",
  "NODE_MISSION_WORKSPACE_DISAGREEMENT",
  "NODE_MISSION_WORKSPACE_UNAVAILABLE",
] as const);
export type NodeBriefProducerCode = (typeof NODE_BRIEF_PRODUCER_CODES)[number];
/** The refusing layer as it arrived, two deep where the stack is two deep. */
export interface NodeBriefUpstream {
  readonly code: string;
  readonly layer: string;
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
}
export interface NodeBriefRefusal {
  readonly code: NodeBriefProducerCode;
  /** Names the key asked for, so a caller can act without a second read. */
  readonly detail: string;
  readonly layer: NodeBriefProducerLayer;
  readonly ok: false;
  /** `null` when this module minted the refusal itself. */
  readonly upstream: NodeBriefUpstream | null;
}
/** The two prose members, paired because one rule produces both from one durable field. */
export interface NodeBriefProse {
  readonly instructions: string;
  readonly title: string;
}
/** EXACTLY the four keys the launch-template producer admits, in its own spelling. */
export interface NodeBrief {
  readonly instructions: string;
  readonly test: string;
  readonly title: string;
  readonly workspace: string;
}
/** The brief plus what it was derived FROM, so a consumer can trace it without a second read. */
export interface NodeBriefAccepted {
  readonly brief: NodeBrief;
  readonly capability: string;
  readonly graphContentHash: string;
  readonly nodeKey: string;
  readonly ok: true;
  readonly revisionId: string;
}
export type NodeBriefResult = NodeBriefAccepted | NodeBriefRefusal;
export interface NodeBriefWorkspaceAdmitted {
  readonly ok: true;
  readonly workspace: string;
}
export type NodeBriefWorkspaceResult = NodeBriefWorkspaceAdmitted | NodeBriefRefusal;
export interface NodeBriefDeps {
  /** Host-scoped process configuration. Only ITS reader opens a path; this module never does. */
  readonly catalog: VerificationCatalogReader;
  /**
   * The repository-scope authority's answer, read lazily per call exactly as the catalog is. A
   * THUNK is a dependency, not a proposal channel: the value it returns is
   * `resolveFoundationRepositoryScope`'s, which re-validates against durable project state.
   */
  readonly repositoryScope: () => FoundationRepositoryScopeResult;
  readonly store: SqliteEventStore;
}
export interface NodeBriefRequest {
  readonly nodeKey: string;
  readonly projectId: string;
}

/** Bounded to the same 256 the sibling catalogs bound their refs to. */
const MAX_REF_CHARS = 256;
const isRef = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_REF_CHARS;

function refuse(
  code: NodeBriefProducerCode,
  detail: string,
  upstream: NodeBriefUpstream | null = null,
): NodeBriefRefusal {
  return Object.freeze({
    code,
    detail,
    layer: LAYER,
    ok: false as const,
    upstream: upstream === null ? null : Object.freeze({ ...upstream }),
  });
}

/** A one-deep refusal from a layer that reports only `{code, layer}`. */
const upstreamOf = (source: { readonly code: string; readonly layer: string }): NodeBriefUpstream =>
  ({ code: source.code, layer: source.layer, sourceCode: null, sourceLayer: null });

/**
 * THE STATED MAPPING, as one exported function so it has exactly one home and one thing for a
 * drill to mutate. `\r` is stripped because a CRLF-authored objective would put an invisible
 * byte at the end of every title; nothing else is removed and no ellipsis is ever added.
 * `null` means the objective has no first line to title — `readText` admits a leading newline as
 * durable text (`node-authority-fields.ts:29-38` bounds and normalizes it), so that is an
 * admissible durable value the brief cannot honestly carry, and the honest answer is a refusal.
 */
export function briefProseOf(objective: string): NodeBriefProse | null {
  const [first] = objective.split("\n");
  const line = first === undefined ? "" : first.replace(/\r$/u, "").trim();
  return line.length === 0 ? null : Object.freeze({ instructions: objective, title: line });
}

/**
 * Answer the four-key brief for one node from committed durable state and host-scoped process
 * configuration, or refuse. Never appends; every path is a read.
 */
export function produceNodeBrief(
  deps: NodeBriefDeps,
  request: NodeBriefRequest,
): NodeBriefResult {
  // Optional-chained though the parameter is typed: a caller arriving with nothing must get the
  // REQUEST_MALFORMED repair, not a thrown TypeError. A crash is not a refusal.
  if (!isRef(request?.projectId) || !isRef(request?.nodeKey)) {
    return refuse("NODE_MISSION_REQUEST_MALFORMED", "a brief needs one project and one node key");
  }
  const { nodeKey, projectId } = request;
  const closure = readCurrentNodeClosure(deps.store, projectId);
  if (!closure.ok) {
    return refuse("NODE_MISSION_GRAPH_UNAVAILABLE", `no readable active graph for ${projectId}`, {
      code: closure.code,
      layer: closure.layer,
      sourceCode: closure.upstream?.code ?? null,
      sourceLayer: closure.upstream?.layer ?? null,
    });
  }
  // BY KEY, and refusing when the key is absent. There is no fallback to a first, nearest or
  // only definition: a plausible brief for the WRONG node is the most dangerous answer this
  // producer could give, because nothing downstream can tell it from a right one.
  const entry = nodeClosureOf(closure, nodeKey);
  if (!entry.ok) {
    return refuse("NODE_MISSION_NODE_ABSENT", `no node authority for ${nodeKey}`,
      { code: entry.code, layer: entry.layer, sourceCode: null, sourceLayer: null });
  }
  const { capability, objective } = entry.definition;
  const prose = briefProseOf(objective);
  if (prose === null) {
    return refuse("NODE_MISSION_OBJECTIVE_UNUSABLE", `node ${nodeKey} states no objective line`);
  }
  const argv = deps.catalog.argvFor(projectId, capability);
  if (!argv.ok) {
    return refuse("NODE_MISSION_TEST_UNAVAILABLE",
      `no verification command for capability ${capability}`, upstreamOf(argv));
  }
  const scope = deps.repositoryScope();
  if (!scope.ok) {
    return refuse("NODE_MISSION_WORKSPACE_UNAVAILABLE",
      `no repository scope for ${projectId}`, upstreamOf(scope));
  }
  return Object.freeze({
    brief: Object.freeze({
      instructions: prose.instructions,
      test: verificationTestField(argv.argv),
      title: prose.title,
      workspace: scope.authority.sourceRepositoryRoot,
    }),
    capability,
    graphContentHash: closure.graphContentHash,
    // The DEFINITION'S key, not the requested one: the durable value, so a future lookup that
    // could disagree would be visible here rather than papered over.
    nodeKey: entry.definition.nodeKey,
    ok: true as const,
    revisionId: closure.revisionId,
  });
}

/**
 * The brief's `workspace` MAY ONLY REFUSE, NEVER SELECT (the workspace ruling's condition 2).
 *
 * At produce time `workspace` is the PROPOSAL the repository-scope authority supplied. The
 * AUTHORITATIVE physical root is the committed capture assignment's, overlaid exactly as the
 * sibling field `cwd` already is in production — so this seam returns the ASSIGNMENT'S value on
 * every accepted path and the proposal's on none. Its only power is to refuse, and a proposal
 * nothing checks is a field asserting nothing, so disagreement is a stable code, not a discard.
 */
export function admitBriefWorkspace(
  proposal: string,
  assignmentRoot: string,
): NodeBriefWorkspaceResult {
  if (!isRef(proposal) || !isRef(assignmentRoot)) {
    return refuse("NODE_MISSION_WORKSPACE_UNAVAILABLE", "a workspace needs both roots named");
  }
  if (proposal !== assignmentRoot) {
    return refuse("NODE_MISSION_WORKSPACE_DISAGREEMENT",
      "the proposed workspace is not the committed assignment root");
  }
  return Object.freeze({ ok: true as const, workspace: assignmentRoot });
}
