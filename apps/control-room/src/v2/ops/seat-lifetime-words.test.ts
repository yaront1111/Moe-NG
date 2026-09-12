/**
 * The words a seat row says about its start and its exit. Every expectation is SPELLED OUT,
 * never built by calling the production formatter: an expectation that called it would pass for
 * whatever it happens to return.
 */
import { describe, expect, it } from "vitest";

import type { SeatExitView } from "../../live/live-sessions.js";
import {
  EXIT_REASON_NOT_RECORDED, START_NOT_RECORDED, seatExitLineWords, seatExitReasonWords, seatStartWords,
} from "./seat-lifetime-words.js";

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const EXIT: SeatExitView = { at: "2026-09-03T09:57:00.000Z", exitCode: 1, kind: "FAILED", lastLine: "Error: spawn claude ENOENT" };

describe("seatStartWords", () => {
  it("says how long ago the seat started, from the daemon's instant and the shell's clock", () => {
    expect(seatStartWords("2026-09-03T09:48:00.000Z", NOW)).toBe("started 12 min ago");
    // It MOVES with the instant: a hard-coded "12 min" could not pass this pair.
    expect(seatStartWords("2026-09-03T08:00:00.000Z", NOW)).toBe("started 2 h ago");
  });

  it("names the absence rather than dating the seat to the browser's clock", () => {
    // A paired browser and every seat older than the start ledger arrive as null. "started just
    // now" here would be a fact nobody measured.
    expect(seatStartWords(null, NOW)).toBe("start not recorded");
    expect(START_NOT_RECORDED).toBe("start not recorded");
  });
});

describe("seatExitReasonWords", () => {
  it("renders the recorded kind and exit code, and nothing inferred from them", () => {
    expect(seatExitReasonWords(EXIT)).toBe("failed, exit code 1");
    expect(seatExitReasonWords({ ...EXIT, exitCode: 0, kind: "COMPLETED" })).toBe("completed, exit code 0");
    expect(seatExitReasonWords({ ...EXIT, kind: "PROVIDER_LIMIT" })).toBe("stopped by a provider limit, exit code 1");
    // The code is rendered as stated, even where it disagrees with the kind: this screen quotes.
    expect(seatExitReasonWords({ ...EXIT, exitCode: 137 })).toBe("failed, exit code 137");
  });

  it("says a null exit code is a signal death - the record's documented meaning - not 0", () => {
    // The hung seat from the finding: killed, so no exit code. Rendering "exit code 0" or
    // "exit code null" here would either claim success or print a word an operator cannot read.
    expect(seatExitReasonWords({ ...EXIT, exitCode: null })).toBe("failed, no exit code (ended on a signal)");
  });

  it("renders an unrostered kind as the daemon spelled it, never blank and never a prototype method", () => {
    expect(seatExitReasonWords({ ...EXIT, kind: "TIMED_OUT" })).toBe("TIMED_OUT, exit code 1");
    // `toString` is the arm that catches a bare index into a plain-object map.
    expect(seatExitReasonWords({ ...EXIT, kind: "toString" })).toBe("toString, exit code 1");
  });

  it("names the absence for a seat no exit record speaks for", () => {
    expect(seatExitReasonWords(null)).toBe("reason not recorded");
    expect(EXIT_REASON_NOT_RECORDED).toBe("reason not recorded");
  });
});

describe("seatExitLineWords", () => {
  it("quotes the last line verbatim, says (no output) for none, and nothing at all without a record", () => {
    expect(seatExitLineWords(EXIT)).toBe("Error: spawn claude ENOENT");
    expect(seatExitLineWords({ ...EXIT, lastLine: null })).toBe("(no output)");
    // Whitespace-only is what a seat that printed a trailing newline leaves behind.
    expect(seatExitLineWords({ ...EXIT, lastLine: "   " })).toBe("(no output)");
    expect(seatExitLineWords(null)).toBeNull();
  });
});
