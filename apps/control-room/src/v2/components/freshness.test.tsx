import { cleanup, render, screen } from "@testing-library/react";
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

describe("Freshness", () => {
  it("renders a status that only announces when the daemon has gone quiet", () => {
    render(<Freshness lastAnswerMs={NOW - 3_000} nowMs={NOW} testId="cr.test.fresh" />);
    const fresh = screen.getByTestId("cr.test.fresh");
    expect(fresh.textContent).toBe("updated 3 s ago");
    expect(fresh.getAttribute("data-quiet")).toBeNull();
    expect(fresh.getAttribute("aria-live")).toBe("off");
    cleanup();
    render(<Freshness lastAnswerMs={NOW - 45_000} nowMs={NOW} />);
    const quiet = screen.getByTestId("cr.freshness");
    expect(quiet.textContent).toBe("no answer from the daemon for 45 s");
    expect(quiet.getAttribute("data-quiet")).toBe("true");
    expect(quiet.getAttribute("aria-live")).toBe("polite");
  });
});
