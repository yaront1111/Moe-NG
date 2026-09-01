/**
 * The closed node-property fact-id vocabulary (design ruling comment-c86c35cb, task-cb0d65ff).
 *
 * A policy slice classifies risk BY FACT ID, so something has to say which fact ids a node
 * yields. That is this module, and its whole authority claim is a negative one: it reports the
 * ids an ADMITTED definition already states, and asserts nothing about them.
 *
 * Three deliberate withholdings, each closing a way risk could be fabricated:
 *
 * 1. IT RE-ADMITS. `deriveNodePropertyFactIds` calls the production `admitNodeDefinition`
 *    before it reads one field, and forwards that codec's issues UNCHANGED. Deriving from a
 *    projection the caller supplied would let a planner state `{capability, tier}` and have the
 *    tier travel; re-admission refuses the record instead, under the codec's own code and layer.
 *
 * 2. IT RETURNS IDS, NEVER FACTS. No `PolicyFactInput`, no tier, no truth class. Structural
 *    admission proves a definition is WELL FORMED; it does not observe anything, so it cannot
 *    honestly stamp `DAEMON_VERIFIED`. Only the daemon consumer that read the sealed graph may
 *    do that (task-a888038d), and only it may persist a run tier.
 *
 * 3. IT CLASSIFIES NOTHING. The tier for each id comes from `PolicySlice.riskClassifications`
 *    in @moe/core, which is policy DATA covered by the slice digest. An id no slice classifies
 *    stays unclassifiable and the evaluator refuses, rather than defaulting to the lowest tier.
 */
import { admitNodeDefinition } from "./node-authority-codec.js";
import type { NodeAuthorityRefusal, NodeDefinition } from "./node-authority-contract.js";

/**
 * The advertised roster, alphabetical. Every kind here MUST be emitted by the projection below
 * and vice versa; the root surface test asserts that set equality in both directions, reading
 * the served set from the emitted prefixes rather than from this tuple.
 */
export const NODE_PROPERTY_FACT_KINDS = Object.freeze([
  "node.capability", "node.read_scope", "node.resource", "node.write_scope",
] as const);
export type NodePropertyFactKind = (typeof NODE_PROPERTY_FACT_KINDS)[number];

export interface NodePropertyFactIdsAccepted {
  readonly factIds: readonly string[];
  readonly ok: true;
}
export type NodePropertyFactIdsResult = NodePropertyFactIdsAccepted | NodeAuthorityRefusal;

/**
 * The projection, declared in DESCENDING kind order on purpose.
 *
 * `readList` already sorts and dedupes each scope list at admission, and the four kind prefixes
 * happen to be ascending in the order above, so emitting in roster order would produce sorted
 * output whether or not the sort below ran — the canonical order would be incidental and
 * deleting the sort would stay green. Declaring the table descending makes the sort the ONLY
 * thing that can produce the emitted order, so a dropped sort reverses the result and reds.
 */
const PROJECTION: readonly (readonly [NodePropertyFactKind,
  (definition: NodeDefinition) => readonly string[]])[] = Object.freeze([
  ["node.write_scope", (definition) => definition.writeScopes],
  ["node.resource", (definition) => definition.resources],
  ["node.read_scope", (definition) => definition.readScopes],
  ["node.capability", (definition) => [definition.capability]],
]);

/**
 * Derives the fact ids one sealed node states. Pure: no clock, no I/O, no mutation of the input
 * and none of the returned value, which is frozen. Repeated calls on one definition are equal.
 */
export function deriveNodePropertyFactIds(value: unknown): NodePropertyFactIdsResult {
  const admitted = admitNodeDefinition(value);
  if (!admitted.ok) return admitted;
  const factIds = new Set<string>();
  for (const [kind, read] of PROJECTION) {
    for (const stated of read(admitted.value.definition)) factIds.add(`${kind}:${stated}`);
  }
  return Object.freeze({
    factIds: Object.freeze([...factIds].sort((left, right) => left < right ? -1 : 1)),
    ok: true as const,
  });
}
