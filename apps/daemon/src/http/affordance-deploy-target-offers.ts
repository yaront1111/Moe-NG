import type { SqliteEventStore } from "@moe/store";

import { versionOf } from "../bootstrap/bootstrap-ledger.js";
import type { DurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { admitEnvironmentName } from "../deployment/deploy-receipt-contracts.js";
import { deployTargetAggregateId } from "../deployment/deploy-target-contracts.js";
import { ENVIRONMENT_NAMES } from "../environment/environment-contracts.js";

/**
 * The `deployment.set_target` affordance, resolved once per project per surface read.
 *
 * THE GRANULARITY DECISION, AND WHY IT IS THIS ONE (task-9aea412b, DoD 2).
 * ONE OFFER PER ENVIRONMENT, not one per goal. `setDeployTarget` fences
 * `deployTargetAggregateId(projectId, environment)` (deploy-target-command.ts:15), and those
 * aggregates move INDEPENDENTLY of each other and of anything goal-scoped. A goal-scoped offer
 * would therefore have to carry a version belonging to a DIFFERENT aggregate than the one the
 * write fences. A live probe settled it rather than an argument (row comment-96a950d1): after a
 * real `preview` binding, `deploy:goal-1` was still at version 0 while `deploy-target:project-1:
 * preview` was at 1, and a rebind dispatched at the goal-scoped version refused
 * EXPECTED_VERSION_CONFLICT @ DURABLE_STORE. A map of environment -> version is not expressible
 * either: `NextAllowedCommand` carries a SINGLE SCALAR `expectedVersion` behind the closed
 * AFFORDANCE_REQUIRED / AFFORDANCE_OPTIONAL key rosters, so widening it is a shared-contract
 * rotation across the four GENERATED_CONTRACT_DIGEST mirrors (epic rail 1) and out of scope here.
 * Per-environment offers make the offered aggregate and the fenced aggregate the SAME OBJECT, so
 * the fence is right by construction instead of by coincidence.
 *
 * THE CONSUMER CONTRACT THAT FOLLOWS. The card CONSTRUCTS `deployTargetAggregateId(projectId,
 * environment)` for the row it is rendering and spends THAT offer. It must NOT parse the
 * environment back out of the id: the payload's `environment` key and the fenced aggregate then
 * agree by construction rather than by convention, which is the whole point of the axis.
 *
 * WHY IT LIVES HERE AND NOT IN `resolvePlanningOffers`. That resolver runs PER GOAL and its
 * results are concatenated without dedupe, so a mint there would emit N identical offers for N
 * goals. Minting once per project per poll IS the dedupe, by construction — there is no set to
 * de-duplicate because only one pass ever runs. Its caller must keep it out of any goal loop:
 * `enumerateAggregateIdsByPrefix` is a payload-free indexed range scan, cheap once per read and
 * a hot-path regression per goal.
 */
export interface DeployTargetOffer {
  /** The environment the operator is binding; travels verbatim in the dispatch payload. */
  readonly environment: string;
  /** The aggregate `setDeployTarget` fences. Offered identity and written identity are one. */
  readonly aggregateId: string;
  /** READ off the durable ledger, never fabricated. 0 on an event-free aggregate. */
  readonly version: number;
}

export interface DeployTargetOfferInput {
  readonly ledger: DurableLedger;
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

/**
 * THE NAME POLICY IS A UNION OF TWO DURABLE SOURCES, and neither leg is decorative.
 *
 * (i) `ENVIRONMENT_NAMES` — the CLOSED roster the deployments read already renders. Without it
 * an operator could never make the FIRST binding from the browser: before any bind the durable
 * union is empty, so an observation-only policy offers nothing and the screen that needs
 * `set_target` most has no affordance to spend. This is not an invented name — it is the same
 * roster this surface already iterates for `deployTargetBound`.
 *
 * (ii) The suffixes of every aggregate already under the `deploy-target:<projectId>:` prefix.
 * `setDeployTarget` admits environments BY REGEX (`admitEnvironmentName`,
 * deploy-receipt-contracts.ts:139), NOT by the closed roster — `isEnvironmentName` is a different
 * function and is not on the setter's path. So an out-of-roster environment is durably bindable,
 * and without this leg its REBIND offer would vanish the moment it was created.
 *
 * A third source the design considered and deliberately omits: the deploy ledger's environment
 * keys. A deploy cannot exist for an environment with no bound target — `deploy-command.ts`
 * refuses DEPLOY_TARGET_MISSING before any docker spawn — so those keys are a subset of (ii).
 *
 * ORDER IS PART OF THE CONTRACT, because consumers compare ordered lists: roster order first,
 * then durable-only extras ascending (`enumerateAggregateIdsByPrefix` already returns sorted
 * ascending). No `Set` iteration order is relied on for the roster half.
 */
export function resolveDeployTargetOffers(
  input: DeployTargetOfferInput,
): { readonly offers: readonly DeployTargetOffer[] } {
  const { ledger, projectId, store } = input;
  // Built from the production helper, never by re-typing the `deploy-target:` literal, so the
  // enumeration prefix and the fenced aggregate can never drift apart.
  const prefix = deployTargetAggregateId(projectId, "");
  // EVERY DURABLE SUFFIX IS RE-ADMITTED THROUGH THE SETTER'S OWN GATE before it becomes an
  // offer, the way runs-read.ts does before rendering a row. The enumeration is a raw prefix
  // scan over aggregate ids, so an id this project never wrote through `setDeployTarget` would
  // otherwise mint an offer the setter refuses at dispatch, in front of an operator — worse
  // than no offer. Roster names pass this gate by construction; it only ever filters junk.
  const bound = store.enumerateAggregateIdsByPrefix(prefix)
    .map((aggregateId) => aggregateId.slice(prefix.length))
    .filter((environment) => admitEnvironmentName(environment) !== null);
  const roster = new Set<string>(ENVIRONMENT_NAMES);
  const environments = [
    ...ENVIRONMENT_NAMES,
    ...bound.filter((environment) => !roster.has(environment)),
  ];
  // VERSION IS READ, NEVER FABRICATED. `versionOf` answers 0 for an aggregate with no events,
  // which is exactly the correct first-bind `expectedVersion`, so the first bind and every
  // rebind take ONE uniform rule with no branch between them. An invented version would refuse
  // at dispatch in front of an operator, which is worse than offering nothing.
  return Object.freeze({
    offers: Object.freeze(environments.map((environment) => {
      const aggregateId = deployTargetAggregateId(projectId, environment);
      return Object.freeze({
        aggregateId, environment, version: versionOf(ledger, aggregateId),
      });
    })),
  });
}
