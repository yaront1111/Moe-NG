import { previewCaptureUrl } from "../../live/live-preview.js";
import type { PreviewReadOutcome } from "../../live/live-preview.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";

/**
 * GATE 2 AS A QUEUE ITEM: the operator looks at their product running, and says whether it is
 * good enough. This module decides WHETHER that decision exists for a goal and what it is
 * called; `preview-card.tsx` renders it and `preview-port.ts` spends it. Nothing here fetches.
 *
 * THE ITEM EXISTS ONLY WHEN ALL FOUR FACTS HOLD, and each one is a different kind of nothing:
 *  - the preview read answered PRESENT (a receipt exists at all);
 *  - its outcome is STARTED (the product is actually running, not a refusal record);
 *  - it carries a url (the receipt decoder couples that to STARTED, and we re-check rather
 *    than assume, because a null url would render a link to nowhere);
 *  - the daemon OFFERS `preview.decide` at this goal's preview aggregate.
 * The fourth is the load-bearing one. The browser never decides that a decision is available:
 * the daemon offers `preview.decide` for exactly the goals whose preview STARTED, and an item
 * built without that offer would show an operator a button whose command would be refused.
 *
 * A GOAL WITH NO RECEIPT PRODUCES NO ITEM, which is DoD 1's absent card. It is not a disabled
 * control and not an empty card: an operator who sees a greyed-out Approve on a goal that was
 * never previewed learns nothing, while a card that is not there says exactly what is true.
 */

/** One node of the active graph a finding can be written against. */
export interface PreviewNodeChoice {
  readonly nodeKey: string;
  readonly nodeRef: string;
  readonly objective: string;
}

/** One capture, already resolved to the daemon's capture route. */
export interface PreviewCaptureView {
  readonly alt: string;
  readonly url: string;
}

export interface PreviewFacts {
  /** The daemon's `preview.decide` offer, spent verbatim by preview-port.ts. */
  readonly affordance: Readonly<Record<string, unknown>>;
  readonly captures: readonly PreviewCaptureView[];
  /** The nodes a rejection may name. Empty means the runs read has not answered yet. */
  readonly nodes: readonly PreviewNodeChoice[];
  readonly receiptId: string;
  /** The loopback url the operator opens. Never null on an item that exists. */
  readonly url: string;
}

/** The words and the facts for one PREVIEW item, or null when there is no decision to take. */
export interface PreviewOffer {
  readonly actionLabel: string;
  readonly detail: string;
  readonly facts: PreviewFacts;
  readonly headline: string;
}

const PREVIEW_COMMAND_KIND = "preview.decide";

/** The aggregate the daemon names for a goal's preview; mirrors `previewAggregateId`. */
export function previewAggregateIdOf(goalId: string): string {
  return `preview:${goalId}`;
}

function offerFor(
  surface: SurfaceFrame | null, goalId: string,
): Readonly<Record<string, unknown>> | null {
  if (surface === null || surface.outcome !== "SURFACE") return null;
  const target = previewAggregateIdOf(goalId);
  return surface.offers.find((offer) =>
    offer["commandKind"] === PREVIEW_COMMAND_KIND && offer["targetAggregateId"] === target) ?? null;
}

/** The goal's nodes, so a rejection names a node of the ACTIVE graph rather than free text. */
function nodesFor(runs: RunsOutcome | null | undefined, goalId: string): readonly PreviewNodeChoice[] {
  if (runs === null || runs === undefined || runs.status !== "RUNS") return Object.freeze([]);
  const goal = runs.goals.find((row) => row.goalId === goalId);
  if (goal === undefined) return Object.freeze([]);
  return Object.freeze(goal.nodes.map((node) => Object.freeze({
    nodeKey: node.nodeKey, nodeRef: node.nodeRef, objective: node.objective,
  })));
}

export function previewOfferFor(
  goalId: string,
  preview: PreviewReadOutcome | undefined,
  surface: SurfaceFrame | null,
  runs: RunsOutcome | null | undefined,
): PreviewOffer | null {
  if (preview === undefined || preview.status !== "PREVIEW") return null;
  const receipt = preview.preview;
  if (receipt.outcome !== "STARTED" || receipt.url === null) return null;
  const affordance = offerFor(surface, goalId);
  if (affordance === null) return null;

  const captures = Object.freeze(receipt.screenshots.flatMap((shot) => {
    const url = previewCaptureUrl(receipt, shot);
    return url === null ? [] : [Object.freeze({ alt: `Screenshot of ${shot.journeyRef}`, url })];
  }));
  const shots = captures.length;
  return Object.freeze({
    actionLabel: "Open the goal",
    detail: `Your product is running at ${receipt.url}.`
      + (shots === 0
        ? " No screenshot was captured, so open it and look before you decide."
        : ` ${String(shots)} screenshot${shots === 1 ? "" : "s"} below.`)
      + " Approve it, or send it back with a finding against the node that has to change.",
    facts: Object.freeze({
      affordance, captures, nodes: nodesFor(runs, goalId), receiptId: receipt.receiptId,
      url: receipt.url,
    }),
    headline: "Your product is running and needs your verdict",
  });
}
