import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";
import { readPublicationCandidate } from "../../live/live-publication-candidate.js";
import type { PublicationApproval, PublicationPreparation } from "../../live/live-publication-candidate.js";

/** Prepares a daemon-observed candidate, then spends the human approval with that immutable tuple. */
export const PUBLISH_COMMAND_KIND = "repository.publish" as const;
const PUBLISH_LAYER = "CONTROL_ROOM_PUBLISH" as const;

export interface PublishPort {
  prepare(goalId: string, remoteUrl: string | null): Promise<PublicationPreparation>;
  submit(affordance: Readonly<Record<string, unknown>>, goalId: string, remoteUrl: string | null, approval: PublicationApproval): Promise<OfferOutcome>;
}

export function createPublishPort(wire: OfferWire & { readonly headers?: Readonly<Record<string, string>> },
  prepare?: PublishPort["prepare"]): PublishPort {
  return Object.freeze({
    prepare: prepare ?? ((goalId, remoteUrl) => readPublicationCandidate(wire.headers ?? {}, goalId, remoteUrl)),
    submit: (affordance: Readonly<Record<string, unknown>>, goalId: string, remoteUrl: string | null, approval: PublicationApproval): Promise<OfferOutcome> =>
      spendOffer(wire, PUBLISH_COMMAND_KIND, affordance, { approval, goalId, remoteUrl }, "ui-publish", PUBLISH_LAYER),
  });
}
