import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";
import { readPublicationCandidate } from "../../live/live-publication-candidate.js";
import type { PublicationApproval, PublicationPreparation } from "../../live/live-publication-candidate.js";

/** Prepares a daemon-observed candidate, then spends the human approval with that immutable tuple. */
export const PUBLISH_COMMAND_KIND = "repository.publish" as const;
const PUBLISH_LAYER = "CONTROL_ROOM_PUBLISH" as const;

/** The operator's two answers to an UNKNOWN publish; `publish-resolve-command.ts` admits exactly these. */
export type PublishResolution = "ABANDON" | "NOT_TRANSMITTED";

export interface PublishPort {
  prepare(goalId: string, remoteUrl: string | null): Promise<PublicationPreparation>;
  /** Spends the daemon's resolve offer VERBATIM with exactly the two keys the kind admits. */
  resolve(affordance: Readonly<Record<string, unknown>>, decisionId: string, resolution: PublishResolution): Promise<OfferOutcome>;
  submit(affordance: Readonly<Record<string, unknown>>, goalId: string, remoteUrl: string | null, approval: PublicationApproval): Promise<OfferOutcome>;
}

export function createPublishPort(wire: OfferWire & { readonly headers?: Readonly<Record<string, string>> },
  prepare?: PublishPort["prepare"]): PublishPort {
  return Object.freeze({
    prepare: prepare ?? ((goalId, remoteUrl) => readPublicationCandidate(wire.headers ?? {}, goalId, remoteUrl)),
    resolve: (affordance: Readonly<Record<string, unknown>>, decisionId: string, resolution: PublishResolution): Promise<OfferOutcome> =>
      spendOffer(wire, "repository.publish_resolve", affordance, { decisionId, resolution }, "ui-publish-resolve", PUBLISH_LAYER),
    submit: (affordance: Readonly<Record<string, unknown>>, goalId: string, remoteUrl: string | null, approval: PublicationApproval): Promise<OfferOutcome> =>
      spendOffer(wire, PUBLISH_COMMAND_KIND, affordance, { approval, goalId, remoteUrl }, "ui-publish", PUBLISH_LAYER),
  });
}
