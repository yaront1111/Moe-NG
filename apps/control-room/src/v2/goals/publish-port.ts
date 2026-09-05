import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";

/**
 * The human's publish decision: the daemon's `repository.publish` offer on the goal's
 * publish aggregate, spent with the remote the project is bound to. Nothing is pushed here --
 * the wrapper's publisher performs the push as the effect of the recorded decision,
 * and the runs read says what became of it.
 *
 * `remoteUrl` carries two meanings in the one key the daemon's payload roster admits
 * (publish-services.ts:34-41): a STRING BINDS that url to the project and publishes to it;
 * NULL publishes to whatever the project is already bound to, and is refused
 * `PUBLISH_REMOTE_UNBOUND` at `DAEMON_PREREQUISITE` when nothing is. The key is always sent,
 * because a MISSING key arrives as `undefined` and the daemon reads that as malformed, not
 * as "reuse the bound remote".
 */
export const PUBLISH_COMMAND_KIND = "repository.publish" as const;
const PUBLISH_LAYER = "CONTROL_ROOM_PUBLISH" as const;

export interface PublishPort {
  submit(affordance: Readonly<Record<string, unknown>>, goalId: string, remoteUrl: string | null): Promise<OfferOutcome>;
}

export function createPublishPort(wire: OfferWire): PublishPort {
  return Object.freeze({
    submit: (affordance: Readonly<Record<string, unknown>>, goalId: string, remoteUrl: string | null): Promise<OfferOutcome> =>
      spendOffer(wire, PUBLISH_COMMAND_KIND, affordance, { goalId, remoteUrl }, "ui-publish", PUBLISH_LAYER),
  });
}
