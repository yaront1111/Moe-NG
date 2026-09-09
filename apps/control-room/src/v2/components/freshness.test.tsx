import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Freshness, QUIET_AFTER_MS, freshnessWords } from "./freshness.js";

afterEach(cleanup);

const NOW = Date.parse("2026-09-04T10:00:00.000Z");

describe("freshnessWords", () => {
  it("says how long ago the daemon answered, and when it has gone quiet", () => {
    expect(freshnessWords(null, NOW)).toEqual({ quiet: false, words: "waiting for the daemon's first answer" });
    expect(freshnessWords(NOW - 4_000, NOW)).toEqual({ quiet: false, words: "updated 4 s ago" });
    expect(freshnessWords(NOW - QUIET_AFTER_MS, NOW)).toEqual({ quiet: true, words: "no answer from the daemon for 20 s" });
    expect(freshnessWords(NOW - 5 * 60_000, NOW)).toEqual({ quiet: true, words: "no answer from the daemon for 5 min" });
    expect(freshnessWords(NOW - 2 * 3_600_000, NOW)).toEqual({ quiet: true, words: "no answer from the daemon for 2 h" });
  });
});

const wordsOf = (root: HTMLElement): string | undefined => root.querySelector(".cr2-freshness-words")?.textContent ?? undefined;

describe("Freshness", () => {
  it("shows the ticking words as plain text and announces a quiet daemon in one stable sentence", () => {
    render(<Freshness lastAnswerMs={NOW - 3_000} nowMs={NOW} testId="cr.test.fresh" />);
    const fresh = screen.getByTestId("cr.test.fresh");
    expect(wordsOf(fresh)).toBe("updated 3 s ago");
    expect(fresh.getAttribute("data-quiet")).toBeNull();
    const status = within(fresh).getByRole("status");
    expect(status.textContent).toBe("");
    expect(status.getAttribute("aria-live")).toBe("polite");
    cleanup();
    render(<Freshness lastAnswerMs={NOW - 45_000} nowMs={NOW} />);
    const quiet = screen.getByTestId("cr.freshness");
    expect(wordsOf(quiet)).toBe("no answer from the daemon for 45 s");
    expect(quiet.getAttribute("data-quiet")).toBe("true");
    expect(within(quiet).getByRole("status").textContent).toBe("No answer from the daemon.");
  });

  it("keeps the announced sentence still while the counter ticks, outside any live region", () => {
    const { rerender } = render(<Freshness lastAnswerMs={NOW - 21_000} nowMs={NOW} />);
    const said = within(screen.getByTestId("cr.freshness")).getByRole("status").textContent;
    rerender(<Freshness lastAnswerMs={NOW - 21_000} nowMs={NOW + 1_000} />);
    const ticked = screen.getByTestId("cr.freshness");
    expect(wordsOf(ticked)).toBe("no answer from the daemon for 22 s");
    expect(within(ticked).getByRole("status").textContent).toBe(said);
    expect(ticked.querySelector(".cr2-freshness-words")?.closest("[aria-live], [role=status]")).toBeNull();
  });
});
