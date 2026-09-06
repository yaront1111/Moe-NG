import type { PreviewReadOutcome } from "../../live/live-preview.js";
import { previewCodeSaid } from "../ops/activity-words.js";
import type { GoalNext, GoalStage } from "./goal-status.js";

/**
 * GATE 2 IN THE STATUS STRIP: while a preview is running, that IS where the goal stands, and
 * it outranks "everything is verified" - a person whose product is up and waiting for a verdict
 * should be told to go look at it, not told to close the goal.
 *
 * DRIVEN BY THE RECEIPT, NEVER BY LOCAL STATE. The stage exists because the daemon's receipt
 * says `outcome: "STARTED"`; nothing here remembers that a button was pressed. A reader that
 * kept its own "is previewing" flag would keep showing the stage after the process died.
 *
 * A REFUSED RECEIPT IS ALSO THIS STAGE, and deliberately. The goal is still at Gate 2 - the
 * operator tried to look at their product and could not - and the refusal CODE is the one
 * thing that tells them what to do next. Sending them to the board instead would hide it.
 * The words come from `previewCodeSaid`, so an unrostered code renders verbatim and never
 * blank; this module states no refusal sentence of its own.
 *
 * A goal with no receipt, an unreadable read, or a transport failure yields NULL: the strip
 * falls through to the stage it would otherwise have shown. "The preview read failed" is not
 * where a goal stands.
 */

export interface PreviewStage {
  readonly headline: string;
  readonly next: GoalNext;
  readonly stage: GoalStage;
}

export function previewStage(preview: PreviewReadOutcome | null | undefined): PreviewStage | null {
  if (preview === null || preview === undefined || preview.status !== "PREVIEW") return null;
  const receipt = preview.preview;
  if (receipt.outcome === "STARTED" && receipt.url !== null) {
    return Object.freeze({
      headline: "Your product is running and waiting for your verdict.",
      next: Object.freeze({
        anchor: "needs-you" as const,
        detail: `It is at ${receipt.url}. Open it, look at it, then approve it or send it back`
          + " with a finding against the node that has to change.",
        label: "Decide the preview",
      }),
      stage: "PREVIEW" as const,
    });
  }
  if (receipt.outcome !== "REFUSED") return null;
  return Object.freeze({
    headline: "The preview could not start.",
    next: Object.freeze({
      anchor: "board" as const,
      detail: receipt.code === null
        ? "The daemon recorded a refusal without a code, so there is nothing to act on yet."
        : previewCodeSaid(receipt.code),
      label: "Read why",
    }),
    stage: "PREVIEW" as const,
  });
}
