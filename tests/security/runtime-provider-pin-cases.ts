/**
 * Executable hostile cases for the runtime-closure pin boundary.
 *
 * These rows are aggregated into PLATFORM_RUNTIME_HOSTILE_CASES. They do not register Vitest
 * suites themselves, so completeness and the runner consume one shared source of execution.
 */

import { expect } from "vitest";

import { prepareClaudeRuntimePin } from "../../packages/runner/src/providers/claude/claude-runtime-pin.js";
import {
  CLAUDE_RUNTIME_PIN_LAYER,
  readQuote,
} from "../../packages/runner/src/providers/claude/claude-runtime-pin-closure.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import { RUNTIME_BOUND as BOUND } from "./runtime-provider-ledger.js";
import type { Arm, Ledger } from "./runtime-provider-ledger.js";
import {
  DRIFTED_QUOTE,
  FORGED_PATH,
  PINNED_QUOTE,
  QUOTE_MESSAGES,
  UNCANONICALISABLE_QUOTE,
  pinRequest,
} from "./runtime-provider-platform-fixtures.js";

const PIN_BOUNDARY = "CLAUDE_RUNTIME_PIN_LAYER";
const invalidQuote = {
  code: "CLAUDE_RUNTIME_QUOTE_INVALID",
  layer: CLAUDE_RUNTIME_PIN_LAYER,
};

export interface ClaudeRuntimePinHostileCase {
  readonly arm: Arm;
  readonly boundary: typeof PIN_BOUNDARY;
  readonly name: string;
  readonly run: (ledger: Ledger) => Promise<void>;
}

export const CLAUDE_RUNTIME_PIN_HOSTILE_CASES: readonly ClaudeRuntimePinHostileCase[] =
  Object.freeze([
    {
      arm: "BEFORE",
      boundary: PIN_BOUNDARY,
      name: "a quote that is not a record cannot pin a runtime",
      async run(ledger) {
        const outcome = await probeBefore(
          BOUND,
          async () => readQuote(FORGED_PATH),
          async () => readQuote(null),
        );
        const notARecord = QUOTE_MESSAGES.notARecord;
        ledger.refusedExactly(
          PIN_BOUNDARY,
          "BEFORE",
          outcome.probe,
          invalidQuote,
          notARecord,
        );
        ledger.refusedExactly(
          PIN_BOUNDARY,
          "BEFORE",
          outcome.effect,
          invalidQuote,
          notARecord,
        );
      },
    },
    {
      arm: "AFTER",
      boundary: PIN_BOUNDARY,
      name: "a closure that drifted after the digest was taken is refused, not re-derived",
      async run(ledger) {
        const accepted = readQuote(PINNED_QUOTE);
        expect(accepted).toMatchObject({ digest: PINNED_QUOTE.observationDigest });
        const outcome = await probeAfter(
          BOUND,
          async () => readQuote(DRIFTED_QUOTE),
          async () => readQuote(UNCANONICALISABLE_QUOTE),
        );
        ledger.refusedExactly(
          PIN_BOUNDARY,
          "AFTER",
          outcome.effect,
          invalidQuote,
          QUOTE_MESSAGES.drifted,
        );
        ledger.refusedExactly(
          PIN_BOUNDARY,
          "AFTER",
          outcome.probe,
          invalidQuote,
          QUOTE_MESSAGES.notCanonicalisable,
        );
      },
    },
    {
      arm: "RACE",
      boundary: PIN_BOUNDARY,
      name: "the pin seam refuses an off-host request and a drifted quote with DISTINCT codes",
      async run(ledger) {
        const outcome = await probeRacing(
          BOUND,
          async () => await prepareClaudeRuntimePin(pinRequest("linux", DRIFTED_QUOTE)),
          async () => await prepareClaudeRuntimePin(pinRequest("win32", DRIFTED_QUOTE)),
        );
        ledger.refusedSide(PIN_BOUNDARY, outcome.left, {
          code: "CLAUDE_RUNTIME_PLATFORM_UNSUPPORTED",
          layer: CLAUDE_RUNTIME_PIN_LAYER,
        });
        ledger.refusedSide(PIN_BOUNDARY, outcome.right, invalidQuote);
        const right = outcome.right.status === "fulfilled" ? outcome.right.value : null;
        expect((right as { message?: string } | null)?.message).toBe(QUOTE_MESSAGES.drifted);
      },
    },
  ]);
