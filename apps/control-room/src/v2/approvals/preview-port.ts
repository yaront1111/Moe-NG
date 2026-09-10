import { spendOffer } from "./offer-wire.js";
import type { OfferOutcome, OfferWire } from "./offer-wire.js";

/**
 * GATE 2: the operator has looked at their running product and says whether it is good enough.
 *
 * The daemon offers `preview.decide` for exactly the goals whose preview actually STARTED
 * (affordance-planning-offers.ts), and this port spends that offer verbatim: the affordance is
 * the daemon's — kind, target, expected version, schema — and the browser adds only the payload
 * members the kind admits. One wire, `spendOffer`, shared with every other inline decision; a
 * second decision path would keep its own offer accounting and drift from the daemon's.
 *
 * THE TWO PAYLOAD SHAPES ARE THE DAEMON'S, NOT THIS FILE'S OPINION. `decodePreviewDecidePayload`
 * (preview-contracts.ts) enforces EXACT arity per decision: APPROVE is `{decision, previewRef}`
 * and a `findings` member on it is an unknown key, not an empty roster; REJECT is
 * `{decision, findings, previewRef}` with at least one finding, each finding exactly
 * `{detail, nodeRef}`. Sending an empty `findings` array, or sending `findings: []` alongside
 * APPROVE "for symmetry", is refused PREVIEW_DECISION_INVALID at REQUEST.
 */

export const PREVIEW_COMMAND_KIND = "preview.decide" as const;
const PREVIEW_LAYER = "CONTROL_ROOM_PREVIEW" as const;

export type PreviewWire = OfferWire;
export type PreviewOutcome = OfferOutcome;

/** The human's two answers to a running preview; the daemon refuses any other word. */
export type PreviewDecision = "APPROVE" | "REJECT";

/** One node to rework, and what to rework about it. Exactly the daemon's finding arity. */
export interface PreviewFinding {
  readonly detail: string;
  readonly nodeRef: string;
}

/** A rejection with no finding is REFUSED by the daemon, so the port refuses to build one at
 *  all: the operator gets this code from the layer they are standing in rather than a
 *  round trip that dies at REQUEST with a code about a decode. */
export const PREVIEW_FINDINGS_REQUIRED = "PREVIEW_FINDINGS_REQUIRED" as const;

/**
 * THE RECEIPT ID IS THE CALLER'S TO SUPPLY, and it is NOT the affordance's target.
 *
 * `preview.decide` resolves `previewRef` as the preview RECEIPT id, while the offer's
 * `targetAggregateId` is the preview AGGREGATE `preview:<goalId>` (previewAggregateId,
 * preview-receipt-contracts.ts:88). This port used to derive `previewRef` from that target, so
 * every Approve sent the aggregate id and the daemon answered 422 PREVIEW_GOAL_NOT_LANDED @
 * GOAL_AUTHORITY. Nothing on the affordance carries the receipt id, so it cannot be derived here
 * at all — the caller reads it from `/preview/read` and passes it in.
 *
 * The id sits SECOND, matching the neighbours: `goal-close-port.submit(affordance, goalId)` and
 * `escalation-port.submit(affordance, nodeKey, decision)`.
 */
export interface PreviewPort {
  submit(
    affordance: Readonly<Record<string, unknown>>,
    receiptId: string,
    decision: PreviewDecision,
    findings?: readonly PreviewFinding[],
  ): Promise<PreviewOutcome>;
}

export function createPreviewPort(wire: PreviewWire): PreviewPort {
  return Object.freeze({
    submit: (
      affordance: Readonly<Record<string, unknown>>,
      previewRef: string,
      decision: PreviewDecision,
      findings: readonly PreviewFinding[] = [],
    ): Promise<PreviewOutcome> => {
      if (decision === "REJECT" && findings.length === 0) {
        return Promise.resolve({
          code: PREVIEW_FINDINGS_REQUIRED, layer: PREVIEW_LAYER, ok: false as const,
        });
      }
      const payload = decision === "APPROVE"
        ? { decision, previewRef }
        : { decision, findings: findings.map(({ detail, nodeRef }) => ({ detail, nodeRef })), previewRef };
      return spendOffer(wire, PREVIEW_COMMAND_KIND, affordance, payload, "ui-preview", PREVIEW_LAYER);
    },
  });
}
