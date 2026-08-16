/**
 * HOSTILE CASES for `CLAUDE_RUNTIME_PIN_LAYER` — the runtime closure boundary.
 *
 * NOT a `*.security.ts` file: it EXPORTS `describePinBoundary(ledger)` and is called from
 * `runtime-provider-platform.security.ts`, so the suite registers in the CALLER's module graph
 * and its cases count there. Same convention as `runtime-provider-render-cases.ts` and
 * `runtime-provider-supervision-cases.ts`; it is how this slice stays under the 400-line rail
 * without dropping cases.
 *
 * WHY THIS BOUNDARY NEEDED ITS OWN FILE AND ITS OWN CARE. `readQuote`
 * (claude-runtime-pin-closure.ts:105-146) returns `CLAUDE_RUNTIME_QUOTE_INVALID` at the
 * `RUNTIME` layer from SEVEN distinct guards. A case pinning only that code and that layer
 * cannot say which guard answered — so a mutation deleting the drift comparison at :116
 * survives it, because the quote either refuses one guard later or is accepted outright while
 * the assertion still reads "refused with the code I expected". Every case here therefore pins
 * the EXACT message, and the fixtures are built so each reaches exactly one guard.
 */

import { describe, expect, it } from "vitest";

import { prepareClaudeRuntimePin } from "../../packages/runner/src/providers/claude/claude-runtime-pin.js";
import {
  CLAUDE_RUNTIME_PIN_LAYER,
  readQuote,
} from "../../packages/runner/src/providers/claude/claude-runtime-pin-closure.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import { RUNTIME_BOUND as BOUND } from "./runtime-provider-ledger.js";
import type { Ledger } from "./runtime-provider-ledger.js";
import {
  DRIFTED_QUOTE,
  FORGED_PATH,
  PINNED_QUOTE,
  QUOTE_MESSAGES,
  UNCANONICALISABLE_QUOTE,
  pinRequest,
} from "./runtime-provider-platform-fixtures.js";

export function describePinBoundary(ledger: Ledger): void {
  // The runtime closure. Drift is the point: a quote whose digest no longer covers its own
  // fields is a runtime that changed between observation and use.
  describe("CLAUDE_RUNTIME_PIN_LAYER", () => {
    const boundary = "CLAUDE_RUNTIME_PIN_LAYER";
    const invalid = { code: "CLAUDE_RUNTIME_QUOTE_INVALID", layer: CLAUDE_RUNTIME_PIN_LAYER };

    it("BEFORE — a quote that is not a record cannot pin a runtime", async () => {
      const outcome = await probeBefore(
        BOUND,
        async () => readQuote(FORGED_PATH),
        async () => readQuote(null),
      );
      const notARecord = QUOTE_MESSAGES.notARecord;
      ledger.refusedExactly(boundary, "BEFORE", outcome.probe, invalid, notARecord);
      ledger.refusedExactly(boundary, "BEFORE", outcome.effect, invalid, notARecord);
    });

    it("AFTER — a closure that drifted after the digest was taken is refused, not re-derived", async () => {
      // NEGATIVE CONTROL FIRST. The undrifted observation is ACCEPTED and its declared digest
      // is returned, so the refusals below are the drift being caught rather than a gate that
      // refuses everything — and a gate that refuses everything holds no rule.
      const accepted = readQuote(PINNED_QUOTE);
      expect(accepted).toMatchObject({ digest: PINNED_QUOTE.observationDigest });
      const outcome = await probeAfter(
        BOUND,
        // `probeAfter(bound, effect, probe)` returns `{effect, probe}` where `effect` is the
        // FIRST callback. The drift is the effect; the uncanonicalisable quote is the probe.
        async () => readQuote(DRIFTED_QUOTE),
        async () => readQuote(UNCANONICALISABLE_QUOTE),
      );
      // Both branches answer with the SAME code at the SAME layer. Only the message separates
      // the drift comparison at :116 from the canonicalisation catch at :114, so pinning the
      // message is what makes deleting :116 a red instead of a survivor.
      ledger.refusedExactly(boundary, "AFTER", outcome.effect, invalid, QUOTE_MESSAGES.drifted);
      ledger.refusedExactly(
        boundary,
        "AFTER",
        outcome.probe,
        invalid,
        QUOTE_MESSAGES.notCanonicalisable,
      );
    });

    it("RACE — the pin seam refuses an off-host request and a drifted quote with DISTINCT codes", async () => {
      const outcome = await probeRacing(
        BOUND,
        async () => await prepareClaudeRuntimePin(pinRequest("linux", DRIFTED_QUOTE)),
        async () => await prepareClaudeRuntimePin(pinRequest("win32", DRIFTED_QUOTE)),
      );
      // Same quote on both legs, so the ONLY difference is the host — which is what makes the
      // platform arm provably the one that answered on the left.
      ledger.refusedSide(boundary, outcome.left, {
        code: "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED",
        layer: CLAUDE_RUNTIME_PIN_LAYER,
      });
      ledger.refusedSide(boundary, outcome.right, invalid);
      // The right leg reached the DRIFT guard, not merely "some quote fault": on win32 the
      // platform arm cannot answer, so this pins which of the seven guards did.
      const right = outcome.right.status === "fulfilled" ? outcome.right.value : null;
      expect((right as { message?: string } | null)?.message).toBe(QUOTE_MESSAGES.drifted);
    });
  });
}
