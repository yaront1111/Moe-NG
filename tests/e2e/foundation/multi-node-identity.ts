/**
 * THE IDENTITY the multi-node journey travels under, as ONE record with ONE default.
 *
 * Every name here was a module-level `const` in `multi-node-graph-harness.ts` or
 * `multi-node-world.ts` until this file existed. Nothing about the journey changed: the
 * default carries THE SAME LITERALS, the harness re-exports them under their old names, and
 * every function that used to close over them now takes this record as a trailing argument
 * DEFAULTED to the same values. The only new capability is that a caller MAY pass another.
 *
 * WHY ITS OWN MODULE. The harness is at its per-file ceiling and turning its three closures
 * into functions of the identity adds to it. The dependency also runs ONE WAY ONLY — this
 * module imports nothing from the harness, so the harness may import and re-export it without
 * a cycle.
 *
 * NO WALL CLOCK AND NO RANDOM SOURCE. `e2e-harness.test.ts:112` scans every non-test module in
 * this directory for four such needles by plain substring, and this file is in its corpus —
 * which is also why the needles are not spelled anywhere in it. A minted credential would be a
 * random source, so a caller wanting a distinct identity SPELLS one, as the default is spelled.
 */
import { CSRF_TOKEN } from "./j1-loop-harness.js";

/** One criterion: the check a single node's work has to satisfy. */
export interface MultiNodeCriterion {
  readonly criterionId: string;
  readonly nodeKey: string;
  readonly statement: string;
}

export interface MultiNodeIdentity {
  readonly agentSecret: string;
  readonly agentSession: string;
  /** The first independent producer. */
  readonly alpha: string;
  /** The second independent producer, unrelated to `alpha`. */
  readonly beta: string;
  readonly contractId: string;
  readonly correlationId: string;
  /** One criterion per node, so the coverage read's denominator is exactly `nodeKeys.length`. */
  readonly criteria: readonly MultiNodeCriterion[];
  /**
   * The token the daemon under test was STARTED with. `j1-loop-harness.ts` spawns every
   * throwaway daemon with `--csrf-token=${CSRF_TOKEN}`, so the default is that same import
   * rather than a second literal that would agree only by luck.
   */
  readonly csrfToken: string;
  readonly goalCreateCommandId: string;
  /** Derived, never independently set: production mints `goal-${commandId}`. */
  readonly goalId: string;
  readonly humanSecret: string;
  readonly humanSession: string;
  /** The sealed node keys, in the order the graph binds them. */
  readonly nodeKeys: readonly string[];
  /** The consumer that depends on BOTH producers. */
  readonly omega: string;
  readonly operatorCredential: string;
  readonly operatorPrincipal: string;
  readonly projectId: string;
  readonly revisionId: string;
}

/**
 * `goalId` is absent ON PURPOSE. It is minted by production as `goal-${commandId}`
 * (`multi-node-graph-harness.ts` stated the two as a pair for that reason), so letting a
 * caller set it apart from the command id would let the two silently disagree and the
 * `goal.create_with_source` would land under an aggregate no later leg addresses.
 */
export type MultiNodeIdentityOverrides = Partial<Omit<MultiNodeIdentity, "goalId">>;

const ALPHA = "node-alpha";
const BETA = "node-beta";
const OMEGA = "node-omega";
const GOAL_CREATE_COMMAND_ID = "multi-1";

/**
 * TODAY'S EXACT VALUES. Changing any literal here changes the foundation journey, which is
 * the one suite that proves this refactor preserved behaviour.
 */
export const DEFAULT_MULTI_NODE_IDENTITY: MultiNodeIdentity = Object.freeze({
  // Fixed, not minted: a random credential would be a random source in a scanned module.
  agentSecret: "secret-multi-node-agent",
  agentSession: "sess-multi-node-agent",
  alpha: ALPHA,
  beta: BETA,
  contractId: "multi-node-contract-1",
  correlationId: "corr-multi-node-journey",
  criteria: Object.freeze([
    Object.freeze({
      criterionId: "crit-alpha", nodeKey: ALPHA,
      statement: "node-alpha/math.mjs exports add and multiply and its own test passes.",
    }),
    Object.freeze({
      criterionId: "crit-beta", nodeKey: BETA,
      statement: "node-beta/math.mjs exports add and multiply and its own test passes.",
    }),
    Object.freeze({
      criterionId: "crit-omega", nodeKey: OMEGA,
      statement: "node-omega/math.mjs integrates alpha and beta and its own test passes.",
    }),
  ]),
  csrfToken: CSRF_TOKEN,
  goalCreateCommandId: GOAL_CREATE_COMMAND_ID,
  goalId: `goal-${GOAL_CREATE_COMMAND_ID}`,
  humanSecret: "secret-multi-node-human",
  humanSession: "sess-multi-node-human",
  nodeKeys: Object.freeze([ALPHA, BETA, OMEGA]),
  omega: OMEGA,
  operatorCredential: "moe-e2e-multi-node-operator-credential",
  operatorPrincipal: "operator-local",
  projectId: "moe-e2e-multi-node",
  revisionId: "multi-node-revision-1",
});

/**
 * A coherent identity built from the default. `multiNodeIdentity()` with no argument is the
 * default itself, value for value, which is what keeps every existing caller unchanged.
 */
export function multiNodeIdentity(
  overrides: MultiNodeIdentityOverrides = {},
): MultiNodeIdentity {
  const merged = { ...DEFAULT_MULTI_NODE_IDENTITY, ...overrides };
  return Object.freeze({
    ...merged,
    criteria: Object.freeze(merged.criteria.map((criterion) => Object.freeze({ ...criterion }))),
    goalId: `goal-${merged.goalCreateCommandId}`,
    nodeKeys: Object.freeze([...merged.nodeKeys]),
  });
}
