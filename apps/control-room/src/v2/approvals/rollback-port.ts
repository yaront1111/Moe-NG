import { spendOffer } from "./offer-wire.js";
import type { OfferOutcome, OfferWire } from "./offer-wire.js";
import type { IncidentRollbackFacts } from "./needs-you-incident.js";

/**
 * ROLLING BACK A DEPLOY from the incident card, spent from the daemon's own
 * `deployment.rollback` offer. The offer is project-scoped and the ENVIRONMENT travels in the
 * payload, exactly as `deployment.deploy` does - the handler fences the PROJECT aggregate, so
 * there is no per-environment offer to pick from (`affordance-rollback-offers.ts`).
 *
 * THE RECEIPT REF IS THE AUTHORITY, NOT THE SHA. `toReceiptRef` is the daemon's immutable
 * receipt id and its handler gate is `/^[0-9a-f]{64}$/u`; a sha would refuse
 * DEPLOY_ROLLBACK_REQUEST_INVALID at ingress. The sha exists on the health frame so the operator
 * can be TOLD what they are rolling back to; this port never derives one from the other.
 *
 * restoreDatabase IS FALSE, DELIBERATELY, and it is the only value this surface sends. Restoring
 * a database is destructive and irreversible in a way redeploying an image is not: it discards
 * every write since the backup, including the ones made during the outage. An incident card is
 * the WORST place to make that implicit - the operator is under time pressure and reaching for
 * the fastest button. Rolling the IMAGE back is recoverable; rolling the DATA back is not. A
 * database restore belongs behind its own deliberate decision, with its own words.
 *
 * THE THREE KEYS ARE EXACT. `exactRequest` in rollback-command.ts refuses any payload whose key
 * set is not exactly {environment, toReceiptRef, restoreDatabase}, and requires
 * `restoreDatabase` to be a boolean, so an omitted key is a refusal rather than a default.
 */

export const DEPLOY_ROLLBACK_COMMAND_KIND = "deployment.rollback" as const;
const DEPLOY_ROLLBACK_LAYER = "CONTROL_ROOM_DEPLOY_ROLLBACK" as const;

export type RollbackOutcome = OfferOutcome;

export interface RollbackPort {
  submit(facts: IncidentRollbackFacts, environment: string): Promise<RollbackOutcome>;
}

export function createRollbackPort(wire: OfferWire): RollbackPort {
  return Object.freeze({
    submit: (facts: IncidentRollbackFacts, environment: string): Promise<RollbackOutcome> =>
      spendOffer(
        wire, DEPLOY_ROLLBACK_COMMAND_KIND, facts.affordance,
        { environment, restoreDatabase: false, toReceiptRef: facts.target.toReceiptRef },
        "ui-rollback", DEPLOY_ROLLBACK_LAYER,
      ),
  });
}
