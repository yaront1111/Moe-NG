import {
  computeGraphIdentity,
  deepFreeze,
  makeIssue,
  sortIssues,
} from "./graph-internal.js";
import { resolveGraphPolicy } from "./graph-policy.js";
import { registerValidatedGraph } from "./graph-provenance.js";
import { parseGraphInput } from "./validate-graph-input.js";
import { validateGraphStructure } from "./validate-graph-structure.js";
import type {
  GraphIssue,
  GraphValidationResult,
  TraversalCounter,
  ValidatedGraph,
} from "./graph-model.js";

/**
 * Fail-closed structural validation. Returns `{ ok: true, graph }` only when the
 * snapshot is well-formed AND acyclic (on HARD edges) AND completion-closed;
 * otherwise returns `{ ok: false, issues }` with stable reason codes and NO
 * partial analysis. Integrity issues (malformed/duplicate/self/missing/limit)
 * are collected together; cycle and completion-closure are only evaluated once
 * integrity holds, because they presuppose resolvable endpoints.
 *
 * This module is the stable public boundary only. Bounded hostile-safe reading
 * of the caller snapshot lives in `./validate-graph-input.ts`; graph-wide
 * integrity and topology live in `./validate-graph-structure.ts`. Canonical
 * issue ordering, deep freezing, graph identity, and provenance registration
 * happen here and nowhere else, so no partially validated state can escape.
 *
 * Integration precondition: external adapters must reject command bodies over
 * 1 MiB before parsing, then enforce the design's JSON-depth and string-size
 * caps during decode or before calling this kernel. Exact schema checks
 * enumerate own keys; direct calls with attacker-constructed, byte-unbounded
 * objects are outside the bounded-input guarantee.
 */
export function validateGraphSnapshot(
  snapshot: unknown,
  policyOverride?: unknown,
  counter?: TraversalCounter,
): GraphValidationResult {
  // Policy is resolved before the snapshot is read: a malformed limit must not
  // be decided by attacker-controlled input.
  const policy = resolveGraphPolicy(policyOverride);
  if (policy === null) {
    return fail([
      makeIssue(
        "GRAPH_MALFORMED_POLICY",
        "policy override is malformed, has unsupported fields, or exceeds parser ceilings",
        [],
        [],
      ),
    ]);
  }

  const parse = parseGraphInput(snapshot, policy);
  if (!parse.ok) {
    return fail(parse.issues);
  }
  const structure = validateGraphStructure(parse.parsed, policy, counter);
  if (!structure.ok) {
    return fail(structure.issues);
  }

  const view = structure.view;
  const graph = deepFreeze({
    nodes: view.nodes.map((node) => ({ ...node })),
    edges: view.edges.map((edge) => ({ ...edge })),
    completionNodeKey: view.completionNodeKey,
    policy: { ...policy },
    graphIdentity: computeGraphIdentity(view),
  }) as unknown as ValidatedGraph;
  registerValidatedGraph(graph);
  return deepFreeze({ ok: true, graph });
}

function fail(issues: readonly GraphIssue[]): GraphValidationResult {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}
