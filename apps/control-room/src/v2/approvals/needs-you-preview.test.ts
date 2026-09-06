import { describe, expect, it } from "vitest";

import type { PreviewReadOutcome } from "../../live/live-preview.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import type { RunsOutcome } from "../../live/live-runs.js";
import { previewAggregateIdOf, previewOfferFor } from "./needs-you-preview.js";

const GOAL = "goal-1";
const SHA = "a".repeat(40);

const receipt = (over: Record<string, unknown> = {}): PreviewReadOutcome => ({
  preview: {
    code: null,
    decidedAt: "2026-09-06T09:00:00.000Z",
    goalId: GOAL,
    outcome: "STARTED",
    receiptId: "preview-receipt/abc",
    screenshots: [
      { journeyRef: "Read orders", path: `.moe-next/previews/${GOAL}/${SHA}/orders.png` },
    ],
    sha: SHA,
    url: "http://127.0.0.1:4173/",
    ...over,
  },
  status: "PREVIEW",
} as PreviewReadOutcome);

const surfaceWith = (offers: readonly Readonly<Record<string, unknown>>[]): SurfaceFrame =>
  ({ connection: "LIVE", offers, outcome: "SURFACE" } as unknown as SurfaceFrame);

const OFFER = Object.freeze({
  commandKind: "preview.decide", expectedVersion: 3,
  targetAggregateId: previewAggregateIdOf(GOAL),
});
const SURFACE = surfaceWith([OFFER]);

const RUNS = {
  goals: [{
    goalId: GOAL,
    nodes: [
      { nodeKey: "n1", nodeRef: "node-1", objective: "Serve the orders route" },
      { nodeKey: "n2", nodeRef: "node-2", objective: "" },
    ],
  }],
  status: "RUNS",
} as unknown as RunsOutcome;

describe("previewOfferFor", () => {
  it("offers Gate 2 when the receipt STARTED and the daemon offers preview.decide", () => {
    const offer = previewOfferFor(GOAL, receipt(), SURFACE, RUNS);

    expect(offer).not.toBeNull();
    expect(offer?.headline).toBe("Your product is running and needs your verdict");
    expect(offer?.facts.url).toBe("http://127.0.0.1:4173/");
    expect(offer?.facts.affordance).toBe(OFFER);
    expect(offer?.facts.captures).toStrictEqual([
      { alt: "Screenshot of Read orders", url: `/preview/capture/${GOAL}/${SHA}/orders.png` },
    ]);
    expect(offer?.facts.nodes.map((node) => node.nodeRef)).toStrictEqual(["node-1", "node-2"]);
    expect(offer?.detail).toContain("http://127.0.0.1:4173/");
    expect(offer?.detail).toContain("1 screenshot");
  });

  it("is ABSENT - null, not an empty card - when the goal has no receipt at all", () => {
    expect(previewOfferFor(GOAL, undefined, SURFACE, RUNS)).toBeNull();
    expect(previewOfferFor(GOAL, { goalId: GOAL, status: "ABSENT" }, SURFACE, RUNS)).toBeNull();
  });

  it("is null for a read that FAILED, which is a different nothing from ABSENT", () => {
    for (const status of ["REFUSED", "ERROR"] as const) {
      expect(previewOfferFor(GOAL, {
        code: "PREVIEW_READ_RECEIPT_UNREADABLE", layer: "PREVIEW_READ", status,
      }, SURFACE, RUNS), status).toBeNull();
    }
  });

  it("is null for a REFUSED receipt: a refusal record is not a running product", () => {
    expect(previewOfferFor(
      GOAL, receipt({ code: "PREVIEW_START_TIMEOUT", outcome: "REFUSED", url: null }), SURFACE, RUNS,
    )).toBeNull();
  });

  it("is null when the receipt STARTED but carries no url to open", () => {
    expect(previewOfferFor(GOAL, receipt({ url: null }), SURFACE, RUNS)).toBeNull();
  });

  it("REFUSES TO INVENT THE DECISION: no daemon offer means no card, however good the receipt", () => {
    expect(previewOfferFor(GOAL, receipt(), null, RUNS)).toBeNull();
    expect(previewOfferFor(GOAL, receipt(), surfaceWith([]), RUNS)).toBeNull();
    expect(previewOfferFor(GOAL, receipt(), surfaceWith([
      { ...OFFER, targetAggregateId: previewAggregateIdOf("other-goal") },
    ]), RUNS)).toBeNull();
    expect(previewOfferFor(GOAL, receipt(), surfaceWith([
      { ...OFFER, commandKind: "goal.close" },
    ]), RUNS)).toBeNull();
    expect(previewOfferFor(GOAL, receipt(), {
      connection: "LIVE", detail: "offline", outcome: "OFFLINE",
    } as unknown as SurfaceFrame, RUNS)).toBeNull();
  });

  it("drops a capture whose served path escapes this receipt's own directory", () => {
    const offer = previewOfferFor(GOAL, receipt({
      screenshots: [
        { journeyRef: "escape", path: ".moe-next/store/daemon.sqlite" },
        { journeyRef: "traversal", path: `.moe-next/previews/${GOAL}/${SHA}/../x.png` },
        { journeyRef: "kept", path: `.moe-next/previews/${GOAL}/${SHA}/kept.png` },
      ],
    }), SURFACE, RUNS);

    expect(offer?.facts.captures).toStrictEqual([
      { alt: "Screenshot of kept", url: `/preview/capture/${GOAL}/${SHA}/kept.png` },
    ]);
  });

  it("still offers the decision with no captures, and says to go look", () => {
    const offer = previewOfferFor(GOAL, receipt({ screenshots: [] }), SURFACE, RUNS);

    expect(offer?.facts.captures).toStrictEqual([]);
    expect(offer?.detail).toContain("No screenshot was captured");
  });

  it("carries no nodes when the runs read has not answered, rather than guessing one", () => {
    for (const runs of [null, undefined, { code: "X", layer: "Y", status: "ERROR" }] as const) {
      const offer = previewOfferFor(GOAL, receipt(), SURFACE, runs as RunsOutcome | null);
      expect(offer?.facts.nodes, String(runs)).toStrictEqual([]);
    }
  });
});
