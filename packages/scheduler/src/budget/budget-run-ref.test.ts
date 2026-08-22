import { describe, expect, it } from "vitest";

import { decodeProviderRunRefAttempt, encodeProviderRunRef } from "./budget-run-ref.js";

/**
 * THE WIRE IDENTITY OF A PROVIDER RUN, pinned from both ends.
 *
 * The runner encodes every measurement's `providerRunRef` through this format and the settlement
 * reducer decodes the attempt segment back out of it (task-763c24cf). Before this module the two
 * ends were built in different shapes — a length-prefixed composite on the producer side, a bare
 * attemptId on the reservation side — so every production settlement refused
 * BUDGET_SETTLEMENT_UNCORRELATED_MEASUREMENT.
 *
 * THE GOLDEN STRING IS NOT A STYLE CHOICE. Durable `ProviderRunTelemetryCommitted` records already
 * on disk carry exactly this spelling, so a format change orphans them. That is why the first
 * assertion below is a byte-exact literal and not a round-trip.
 */

const IDENTITY = { attemptRef: "attempt-1", epoch: 7, provider: "claude", runRef: "abc" } as const;

describe("the provider-run wire identity is a byte-exact, length-prefixed composite", () => {
  it("encodes the golden string every durable record already carries", () => {
    expect(encodeProviderRunRef(IDENTITY)).toBe("claude:3:abc:9:attempt-1:7");
  });

  it("round-trips the attempt segment for refs that contain the delimiter itself", () => {
    // The prefixes exist precisely so a ref may contain ":" — a split-based decoder would fail
    // here, which is why this sweep carries hostile refs rather than tidy ones.
    const cases = [
      { attemptRef: "attempt-1", epoch: 0, provider: "claude", runRef: "run:with:colons" },
      { attemptRef: "attempt:2", epoch: 1, provider: "claude", runRef: "plain" },
      { attemptRef: "9:9:9", epoch: 12, provider: "claude", runRef: "3:already:prefixed" },
      { attemptRef: "attempt-4", epoch: 3, provider: "claude", runRef: "pipe|and:colon" },
      { attemptRef: "12345", epoch: 4, provider: "claude", runRef: "67890" },
      { attemptRef: "a", epoch: 5, provider: "claude", runRef: "" },
    ] as const;
    // A SWEEP THAT PRODUCED NOTHING WOULD PASS SILENTLY. The count is asserted, not assumed.
    expect(cases.length).toBe(6);
    for (const identity of cases) {
      expect(decodeProviderRunRefAttempt(encodeProviderRunRef(identity))).toBe(identity.attemptRef);
    }
  });

  it("is INJECTIVE where a plain join would collide", () => {
    // Both flatten to the same character sequence under `join(":")`; the length prefixes are the
    // only thing that keeps them apart, so this is the arm that kills a format regression.
    const left = encodeProviderRunRef({ attemptRef: "b:c", epoch: 1, provider: "claude", runRef: "a" });
    const right = encodeProviderRunRef({ attemptRef: "c", epoch: 1, provider: "claude", runRef: "a:b" });
    expect(left).not.toBe(right);
    expect(decodeProviderRunRefAttempt(left)).toBe("b:c");
    expect(decodeProviderRunRefAttempt(right)).toBe("c");
  });
});

describe("the decoder answers NULL rather than a partial string", () => {
  it("refuses a BARE attempt ref — the shape that used to correlate by fixture accident", () => {
    expect(decodeProviderRunRefAttempt("attempt-1")).toBeNull();
  });

  it("refuses every malformed composite, one named shape at a time", () => {
    const malformed: readonly (readonly [string, string])[] = [
      ["empty", ""],
      ["no prefixes at all", "claude:abc:attempt-1:7"],
      ["truncated after the run segment", "claude:3:abc"],
      ["run length overruns the string", "claude:99:abc:9:attempt-1:7"],
      ["attempt length overruns the string", "claude:3:abc:99:attempt-1:7"],
      ["run length too short, delimiter misses", "claude:2:abc:9:attempt-1:7"],
      ["non-numeric run length", "claude:x:abc:9:attempt-1:7"],
      ["non-numeric attempt length", "claude:3:abc:x:attempt-1:7"],
      ["missing trailing epoch", "claude:3:abc:9:attempt-1"],
      ["non-numeric epoch", "claude:3:abc:9:attempt-1:seven"],
      ["negative epoch", "claude:3:abc:9:attempt-1:-1"],
    ];
    expect(malformed.length).toBe(11);
    for (const [label, composite] of malformed) {
      expect(decodeProviderRunRefAttempt(composite), label).toBeNull();
    }
  });

  it("never returns a truncated attempt when the declared length disagrees with the bytes", () => {
    // `attempt-1` is 9 characters; declaring 4 must NOT yield "atte".
    expect(decodeProviderRunRefAttempt("claude:3:abc:4:attempt-1:7")).toBeNull();
  });
});
