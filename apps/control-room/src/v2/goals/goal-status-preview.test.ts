import { describe, expect, it } from "vitest";

import type { PreviewReadOutcome } from "../../live/live-preview.js";
import { previewStage } from "./goal-status-preview.js";
import { STAGE_WORDS } from "./goal-status-strip.js";

const receipt = (over: Record<string, unknown> = {}): PreviewReadOutcome => ({
  preview: {
    code: null,
    decidedAt: "2026-09-06T09:00:00.000Z",
    goalId: "goal-1",
    outcome: "STARTED",
    receiptId: "preview-receipt/abc",
    screenshots: [],
    sha: "a".repeat(40),
    url: "http://127.0.0.1:4173/",
    ...over,
  },
  status: "PREVIEW",
} as PreviewReadOutcome);

describe("the PREVIEW stage (DoD 4)", () => {
  it("shows the stage while the receipt says the product is RUNNING", () => {
    const stage = previewStage(receipt());

    expect(stage?.stage).toBe("PREVIEW");
    expect(stage?.headline).toBe("Your product is running and waiting for your verdict.");
    expect(stage?.next.label).toBe("Decide the preview");
    expect(stage?.next.anchor).toBe("needs-you");
    expect(stage?.next.detail).toContain("http://127.0.0.1:4173/");
  });

  it("has a word in the strip roster, so the stage cannot render blank", () => {
    expect(STAGE_WORDS.PREVIEW).toBe("Gate 2: your product is running");
  });

  it("renders a REFUSED receipt's code as OPERATOR WORDS, with the code alongside", () => {
    const stage = previewStage(receipt({
      code: "PREVIEW_COMMAND_MISSING", outcome: "REFUSED", url: null,
    }));

    expect(stage?.stage).toBe("PREVIEW");
    expect(stage?.headline).toBe("The preview could not start.");
    expect(stage?.next.detail).toContain("not installed on this machine");
    expect(stage?.next.detail).toContain("(PREVIEW_COMMAND_MISSING)");
  });

  it("renders an UNKNOWN refusal code verbatim rather than blank", () => {
    const stage = previewStage(receipt({
      code: "PREVIEW_SOMETHING_NEW", outcome: "REFUSED", url: null,
    }));

    expect(stage?.next.detail).toBe("PREVIEW_SOMETHING_NEW");
  });

  it("says so plainly when a refusal carries no code at all", () => {
    const stage = previewStage(receipt({ code: null, outcome: "REFUSED", url: null }));

    expect(stage?.next.detail).toContain("without a code");
  });

  it("is null for every nothing: absent, unread, failed, and a STARTED receipt with no url", () => {
    expect(previewStage(null)).toBeNull();
    expect(previewStage(undefined)).toBeNull();
    expect(previewStage({ goalId: "goal-1", status: "ABSENT" })).toBeNull();
    expect(previewStage({ code: "X", layer: "PREVIEW_READ", status: "REFUSED" })).toBeNull();
    expect(previewStage({ code: "X", layer: "CONTROL_ROOM_LIVE_PREVIEW", status: "ERROR" }))
      .toBeNull();
    expect(previewStage(receipt({ url: null }))).toBeNull();
  });
});
