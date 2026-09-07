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
 * BINDING A TARGET IS THE SECOND DECISION THIS PORT CARRIES, and it goes down the SAME wire.
 * An earlier revision of this file said the daemon's affordance surface emitted no deployment
 * kind at all and that a `setTarget` here would have no offer to spend. THAT IS NO LONGER
 * TRUE and the paragraph is gone rather than left to mislead: task-9aea412b landed
 * `affordance-deploy-target-offers.ts`, which mints ONE `deployment.set_target` OFFER PER
 * ENVIRONMENT. `bindTarget` spends one of those through `spendOffer`, exactly as `submit`
 * spends the deploy offer. There is still only one decision wire.
 */

export const DEPLOY_COMMAND_KIND = "deployment.deploy" as const;
export const SET_TARGET_COMMAND_KIND = "deployment.set_target" as const;
const DEPLOY_LAYER = "CONTROL_ROOM_DEPLOY" as const;

/**
 * THE OFFER THE OPERATOR ACTED ON WAS NOT THE ONE FOR THIS ENVIRONMENT.
 *
 * Refused HERE, before anything reaches the wire, because the two things that must agree --
 * the `environment` in the payload and the aggregate the daemon's `setDeployTarget` fences --
 * would otherwise be able to disagree, and the daemon cannot detect the disagreement: it
 * derives its write key from the PAYLOAD (`deployTargetAggregateId(request.projectId,
 * admitted.environment)`, deploy-target-command.ts:15) while its optimistic fence comes from
 * the OFFER's `expectedVersion`. A mismatched pair therefore does not refuse -- it binds the
 * environment named in the payload against a version belonging to a different one. Fail closed.
 */
export const DEPLOY_TARGET_OFFER_MISMATCH = "DEPLOY_TARGET_OFFER_MISMATCH" as const;

/**
 * The id the daemon's `setDeployTarget` fences, constructed rather than parsed.
 *
 * Restated here rather than imported because `apps/control-room` cannot reach
 * `apps/daemon` (no tsconfig paths, no project references; a deep relative import is TS6059),
 * and no workspace package exports it. This is the CONSTRUCTION the producer asks its consumer
 * for -- `affordance-deploy-target-offers.ts` states the contract in as many words: "The card
 * CONSTRUCTS `deployTargetAggregateId(projectId, environment)` for the row it is rendering and
 * spends THAT offer. It must NOT parse the environment back out of the id."
 *
 * WHY CONSTRUCT AND NOT PARSE, since the last `:` segment would be unambiguous today
 * (`ENVIRONMENT_NAME` is `/^[a-z][a-z0-9-]{0,62}$/u`, so an environment carries no colon):
 * a parser agrees with the daemon by CONVENTION and keeps agreeing silently after the id
 * format changes, sending an environment nobody chose. A constructor agrees by CONSTRUCTION
 * and, when the format moves, simply stops matching -- which is a visible refusal, not a
 * silent wrong bind.
 */
export function deployTargetAggregateId(projectId: string, environment: string): string {
  return `deploy-target:${projectId}:${environment}`;
}

/**
 * The three operator-typed fields, EXACTLY AS TYPED.
 *
 * `sshTarget: null` MEANS A LOCAL DOCKER DAEMON -- it is not a missing value. `DeployTarget.
 * sshTarget` is `string | null` and the daemon reads null as "deploy on this host", so a
 * control that demanded an ssh destination would make every local deploy unreachable. An
 * empty string is NOT the same thing: `admitSshTarget` rejects it, and a caller that sent
 * `""` for "blank" would turn a valid local bind into a refusal. `url: null` likewise means
 * the environment publishes no public url.
 */
export interface DeployTargetFields {
  readonly network: string;
  readonly sshTarget: string | null;
  readonly url: string | null;
}

export type DeployOutcome = OfferOutcome;

export interface DeployPort {
  /**
   * `environment` is the row's own, and it is VERIFIED against the offer rather than trusted:
   * see `DEPLOY_TARGET_OFFER_MISMATCH`. The daemon's roster for this kind is EXACTLY
   * `["environment", "network", "sshTarget", "url"]` (daemon-command-payload-keys.ts:181) and
   * the decoder is exact-arity, so all four keys are always sent and no fifth ever is.
   *
   * NOTHING HERE TOUCHES WHAT THE OPERATOR TYPED. No trim, no lowercase, no normalising, and
   * above all no stripping userinfo out of a url. `admitDeployUrl` refuses
   * `https://user:secret@host` OUTRIGHT rather than cleaning it, deliberately, because the url
   * is copied onto every deploy receipt: stripping would silently change where the operator
   * believes the environment answers, so the daemon tells them instead. A browser that
   * repaired the value first would submit a target nobody typed and report success for it.
   */
  bindTarget(
    affordance: Readonly<Record<string, unknown>>, projectId: string, environment: string,
    fields: DeployTargetFields,
  ): Promise<DeployOutcome>;
  submit(
    affordance: Readonly<Record<string, unknown>>, environment: string, sha: string,
  ): Promise<DeployOutcome>;
}

export function createDeployPort(wire: OfferWire): DeployPort {
  return Object.freeze({
    bindTarget: (
      affordance: Readonly<Record<string, unknown>>, projectId: string, environment: string,
      { network, sshTarget, url }: DeployTargetFields,
    ): Promise<DeployOutcome> => {
      if (affordance["targetAggregateId"] !== deployTargetAggregateId(projectId, environment)) {
        return Promise.resolve({ code: DEPLOY_TARGET_OFFER_MISMATCH, layer: DEPLOY_LAYER, ok: false });
      }
      return spendOffer(
        wire, SET_TARGET_COMMAND_KIND, affordance,
        { environment, network, sshTarget, url }, "ui-set-target", DEPLOY_LAYER,
      );
    },
    submit: (
      affordance: Readonly<Record<string, unknown>>, environment: string, sha: string,
    ): Promise<DeployOutcome> =>
      spendOffer(wire, DEPLOY_COMMAND_KIND, affordance, { environment, sha }, "ui-deploy", DEPLOY_LAYER),
  });
}
