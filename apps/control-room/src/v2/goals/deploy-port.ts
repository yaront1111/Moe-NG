import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";

/**
 * DEPLOYING IS THE OPERATOR'S OWN ACT, and this port is the whole wire for it: the daemon
 * offers `deployment.deploy`, the browser spends that offer verbatim through `spendOffer`, and
 * nothing here fetches, retries or interprets. No component dispatches; a second decision wire
 * would keep its own offer accounting and drift from the daemon's.
 *
 * NOTHING IS DEPLOYED HERE. The daemon's async entry builds the image, replaces the container
 * and polls health, and the durable `moe-deploy-receipt/1` says what became of it. This port
 * returns only whether the DECISION was accepted, which is why an ok answer says "recorded",
 * never "deployed".
 *
 * THE ENVIRONMENT IS THE SAFETY-CRITICAL FIELD, so it is an explicit parameter with no default
 * and is never read back out of component state: preview and production sit on the same card,
 * and a defaulted environment is how a production deploy leaves on a preview click. The
 * caller passes the environment it is confirming, and this file has no opinion about which.
 *
 * EVERY KEY THE ROSTER ADMITS IS ALWAYS SENT. `PAYLOAD_KEYS["deployment.deploy"]` is EXACTLY
 * `["environment", "sha"]` and the daemon's decoder is exact-arity, so an omitted key arrives
 * as a missing member and is read as malformed rather than as a default -- the same trap
 * publish-port.ts documents for a null `remoteUrl`. `sha` is therefore always present: the
 * caller sends the landed sha it is deploying, which becomes the image tag verbatim.
 *
 * THERE IS DELIBERATELY NO `setTarget` HERE, and the absence is the considered answer rather
 * than an omission. `spendOffer` spends an OFFER, and at this tree the daemon's affordance
 * surface emits NO deployment kind at all: `git grep -n 'deployment\.' -- apps/daemon/src/http`
 * excluding tests returns zero. So a `deployment.set_target` dispatch has no affordance to
 * spend and could only ever have been called with the DEPLOY offer, which is a different
 * decision. An exported kind wired to nothing is a second decision wire in waiting (rail 2),
 * so it is gone rather than parked. The command itself belongs to task-358b6ec8 on the daemon
 * side; a browser affordance for it belongs to the containerized-deployment parent
 * task-5d309484, which is where the surface that offers it will land. Until then this card
 * NAMES the missing target as a prerequisite and does not pretend to a control it cannot spend.
 */

export const DEPLOY_COMMAND_KIND = "deployment.deploy" as const;
const DEPLOY_LAYER = "CONTROL_ROOM_DEPLOY" as const;

export type DeployOutcome = OfferOutcome;

export interface DeployPort {
  submit(
    affordance: Readonly<Record<string, unknown>>, environment: string, sha: string,
  ): Promise<DeployOutcome>;
}

export function createDeployPort(wire: OfferWire): DeployPort {
  return Object.freeze({
    submit: (
      affordance: Readonly<Record<string, unknown>>, environment: string, sha: string,
    ): Promise<DeployOutcome> =>
      spendOffer(wire, DEPLOY_COMMAND_KIND, affordance, { environment, sha }, "ui-deploy", DEPLOY_LAYER),
  });
}
