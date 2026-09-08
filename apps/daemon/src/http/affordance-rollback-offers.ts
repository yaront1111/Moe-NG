import type { SqliteEventStore } from "@moe/store";

import { readDeployLedger } from "../deployment/deploy-ledger.js";
import { resolveRollbackTarget } from "../deployment/rollback-target.js";

/**
 * The `deployment.rollback` affordance, resolved once per project per surface read.
 *
 * WHY THIS MODULE EXISTS. The kind was landed at every OTHER seam — vocabulary entry, capability
 * (`BOOTSTRAP_FAMILY["deployment.rollback"]`), async registry row, human-only exclusion, MCP
 * exclusion (daemon-command-vocabulary.ts:415) and a fully fenced handler — and at none of them
 * does a BROWSER learn the kind exists. It learns that from ONE place: an offer on
 * `/affordances/read`. Measured at HEAD: `git grep -n 'deployment.rollback' -- apps/daemon/src/http`
 * returned NOTHING, so the incident card had no daemon offer to spend and would have had to
 * fabricate a commandId, an expectedVersion and a target aggregate to dispatch at all.
 *
 * ONE PROJECT-SCOPED OFFER, NOT ONE PER ENVIRONMENT, and the shape forces it.
 * `NextAllowedCommand` (runtime-affordance.ts) has NO environment member, and the handler fences
 * the PROJECT aggregate: rollback-command.ts:85 refuses DEPLOY_ROLLBACK_TARGET_INVALID unless
 * `targetAggregateId === projectId`, and :160 commits its empty leg against `projectId` at
 * `envelope.expectedVersion`. N per-environment offers would therefore be N IDENTICAL tuples
 * differing only by `commandId` — indistinguishable to a card and impossible to match back to an
 * environment. The per-environment authority lives where it can actually be read: `rollbackTarget`
 * on the `/deployments/health/read` frame, null for an environment with nothing to roll back to.
 * The environment travels in the PAYLOAD, chosen at dispatch, exactly as `deployment.deploy` does.
 *
 * AND IT MINTS NO `ChainStep`. The wrapper staffs agents from `surface.steps`
 * (agent-wrapper.ts), and `daemon-command-vocabulary.ts:279` already answers null — never
 * staffable — for this kind. A step here would present an operator-only incident decision as
 * staffable work. `escalation.decide` and `review.submit` offer without a same-kind step, so this
 * is the established shape.
 */

/** Opaque to every consumer (runtime-affordance.ts checks only `isNonEmptyString`; the generated
 *  client documents it as opaque), so this is a LOCAL constant and NOT a shared-contract
 *  rotation: no new kind is published and no `GENERATED_CONTRACT_DIGEST` mirror moves. */
export const DEPLOY_ROLLBACK_SCHEMA_VERSION = "deployment.rollback/1";

/** Fail-closed disclosure when the deploy ledger cannot be walked, so "nothing to roll back to"
 *  and "we could not tell" stay distinguishable. Shaped after AGENT_PROVIDER_STORE_UNREADABLE. */
export const DEPLOY_ROLLBACK_LEDGER_UNREADABLE = "DEPLOY_ROLLBACK_LEDGER_UNREADABLE";

export interface RollbackOffer {
  /** The PROJECT aggregate, because rollback-command.ts:85 refuses anything else. */
  readonly aggregateId: string;
  readonly inputSchemaVersion: string;
  readonly kind: "deployment.rollback";
  /** READ off the project aggregate, never fabricated: the handler commits its empty leg at
   *  exactly this version, so any other number refuses EXPECTED_VERSION_CONFLICT at dispatch. */
  readonly version: number;
}

export interface RollbackOfferInput {
  readonly projectId: string;
  readonly store: SqliteEventStore;
}

export interface RollbackOfferResult {
  readonly offers: readonly RollbackOffer[];
  readonly refused: string | null;
}

function withheld(refused: string | null): RollbackOfferResult {
  return Object.freeze({ offers: Object.freeze([]), refused });
}

/**
 * AT MOST ONE OFFER, and only when SOME environment holds a receipt the handler would admit.
 *
 * ONE `readDeployLedger` call answers every environment — the walk pages the whole decision
 * ledger, so a per-environment `readPreviousDeployReceipt` would re-walk it once per environment
 * on every affordance poll. The admission test is the shared resolver, not a second reading of
 * the rule, so the control this offers and the receipt the health frame names can never disagree.
 *
 * NO TARGET ANYWHERE MEANS NO OFFER: that is DoD 1's "missing/unverifiable receipt yields no
 * rollback control authority", expressed at the only granularity the offer shape has.
 */
export function resolveRollbackOffers(input: RollbackOfferInput): RollbackOfferResult {
  const { projectId, store } = input;
  let version: number;
  let spendable: boolean;
  try {
    spendable = [...readDeployLedger(store, projectId).values()]
      .some((state) => resolveRollbackTarget(state) !== null);
    version = store.getAggregateVersion(projectId);
  } catch {
    // FAIL CLOSED on the store. An invented version refuses EXPECTED_VERSION_CONFLICT in front
    // of an operator mid-incident, which is strictly worse than offering nothing.
    return withheld(DEPLOY_ROLLBACK_LEDGER_UNREADABLE);
  }
  if (!spendable) return withheld(null);
  return Object.freeze({
    offers: Object.freeze([Object.freeze({
      aggregateId: projectId,
      inputSchemaVersion: DEPLOY_ROLLBACK_SCHEMA_VERSION,
      kind: "deployment.rollback" as const,
      version,
    })]),
    refused: null,
  });
}
