import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";

/**
 * The human's publish decision: the daemon's `repository.publish` offer on the goal's
 * publish aggregate, spent with the remote the human typed. Nothing is pushed here —
 * the wrapper's publisher performs the push as the effect of the recorded decision,
 * and the runs read says what became of it.
 */
export const PUBLISH_COMMAND_KIND = "repository.publish" as const;
const PUBLISH_LAYER = "CONTROL_ROOM_PUBLISH" as const;

export interface PublishPort {
  submit(affordance: Readonly<Record<string, unknown>>, goalId: string, remoteUrl: string): Promise<OfferOutcome>;
}

export function createPublishPort(wire: OfferWire): PublishPort {
  return Object.freeze({
    submit: (affordance: Readonly<Record<string, unknown>>, goalId: string, remoteUrl: string): Promise<OfferOutcome> =>
      spendOffer(wire, PUBLISH_COMMAND_KIND, affordance, { goalId, remoteUrl }, "ui-publish", PUBLISH_LAYER),
  });
}
