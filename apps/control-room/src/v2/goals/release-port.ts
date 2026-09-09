import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";

/**
 * Spends the operator's release decision on the daemon's own offer. ONE wire: `spendOffer`
 * already returns the refusing authority's code, layer and — since the release evidence read
 * landed — its detail, which for this kind is the list of criteria whose evidence is unverified.
 * A second decision path here would be a second set of refusals to render.
 */
export const RELEASE_COMMAND_KIND = "release.decide" as const;
const RELEASE_LAYER = "CONTROL_ROOM_RELEASE" as const;

/** EXACTLY the four keys `daemon-command-payload-keys.ts` declares; the decoder is exact-arity. */
export interface ReleaseDecisionInput {
  readonly base: string;
  readonly decision: string;
  readonly goalId: string;
  readonly sha: string;
}

export interface ReleasePort {
  submit(affordance: Readonly<Record<string, unknown>>, input: ReleaseDecisionInput): Promise<OfferOutcome>;
}

export function createReleasePort(wire: OfferWire): ReleasePort {
  return Object.freeze({
    // `affordance` is the daemon's offer row spent VERBATIM. Reshaping it, or building one
    // here, would put the browser's idea of the target and the expected version on the wire
    // instead of the daemon's — and the command fences on both.
    submit: (affordance: Readonly<Record<string, unknown>>, input: ReleaseDecisionInput): Promise<OfferOutcome> =>
      spendOffer(wire, RELEASE_COMMAND_KIND, affordance, { ...input }, "ui-release", RELEASE_LAYER),
  });
}
