/**
 * DEVELOPMENT_ONLY / NOT_CONFIRMATORY held-out fixture data for J1, J3 and J4.
 *
 * Split out of `foundation-outcomes-fixtures.ts` purely for size: that module
 * owns the vocabulary, probes and manifest machinery, this one owns the frozen
 * payloads and their pinned identities. Data only — no behaviour lives here.
 *
 * Every digest below is a LITERAL. Pinning a fixture to a value the same code
 * recomputes would make the identity assertion tautological, so editing a
 * payload turns the spec test red until the digest is re-pinned by hand.
 */

import {
  FOUNDATION_LABELS,
  expectedRed,
  passExpected,
} from "./foundation-outcomes-fixtures.js";
import type {
  FoundationFixture,
  FoundationJourney,
  FoundationOutcome,
} from "./foundation-outcomes-fixtures.js";
import { J1_AGGREGATE_ONLY_ACTIVATION } from "./foundation-model-j1.js";
import type { J1Trace } from "./foundation-model-j1.js";
import type { J3Continuation, J3RestartRecord, J4ReplanRound } from "./foundation-model-j3j4.js";

const j1Trace = (attempt: J1Trace["attempt"], acceptanceProofRef: string | null): J1Trace =>
  Object.freeze({
    acceptanceProofRef,
    attempt,
    humanActions: Object.freeze(["goal.create", "graph.approve", "acceptance.final"] as const),
  });

export const J1_WORKED: J1Trace = j1Trace(Object.freeze({
  agentClaimsGreen: true,
  artifactRefs: Object.freeze(["artifact/patch.diff"]),
  attemptRef: "attempt/j1-1",
  changedPaths: Object.freeze(["src/auth/token.ts"]),
  receipts: Object.freeze([
    Object.freeze({ receiptRef: "receipt/tests", truthClass: "DAEMON_VERIFIED" as const }),
  ]),
}), "proof/j1-verified");

/** Empty diff, no artifact, no receipt — and a green self-claim over the top. */
export const J1_ZERO_WORK: J1Trace = j1Trace(Object.freeze({
  agentClaimsGreen: true,
  artifactRefs: Object.freeze([]),
  attemptRef: "attempt/j1-noop",
  changedPaths: Object.freeze([]),
  receipts: Object.freeze([]),
}), "proof/j1-claimed");

/** Real work, but the only receipt is the agent's own narration (CORE-I14). */
export const J1_AGENT_TEXT: J1Trace = j1Trace(Object.freeze({
  agentClaimsGreen: true,
  artifactRefs: Object.freeze(["artifact/summary.md"]),
  attemptRef: "attempt/j1-narrated",
  changedPaths: Object.freeze(["src/auth/token.ts"]),
  receipts: Object.freeze([
    Object.freeze({ receiptRef: "receipt/agent-says-green", truthClass: "AGENT_REPORTED" as const }),
  ]),
}), "proof/j1-narrated");

/** One record per declared crash boundary; classes are asserted by the J3 test. */
export const J3_RESTART_RECORDS: readonly J3RestartRecord[] = Object.freeze([
  Object.freeze({
    acknowledged: true, boundary: "TRANSACTION_COMMIT" as const, durableCommitObserved: true,
    externalEffectUnknown: false, truthClass: "DAEMON_VERIFIED" as const,
  }),
  Object.freeze({
    acknowledged: false, boundary: "TRANSACTION_WRITE" as const, durableCommitObserved: true,
    externalEffectUnknown: false, truthClass: "DAEMON_VERIFIED" as const,
  }),
  Object.freeze({
    acknowledged: false, boundary: "TRANSACTION_BEGIN" as const, durableCommitObserved: false,
    externalEffectUnknown: false, truthClass: "UNKNOWN" as const,
  }),
  Object.freeze({
    acknowledged: true, boundary: "EFFECT_ACK" as const, durableCommitObserved: true,
    externalEffectUnknown: true, truthClass: "UNKNOWN" as const,
  }),
]);

export const J3_HEALTHY_CONTINUATION: J3Continuation = Object.freeze({
  bindingRef: "binding/j3-continuation-1",
  editsHistory: false,
  safeActions: Object.freeze(["recovery.complete"]),
});

export const J3_EDITED_HISTORY: J3Continuation = Object.freeze({
  bindingRef: "binding/j3-rewrite",
  editsHistory: true,
  safeActions: Object.freeze([J1_AGGREGATE_ONLY_ACTIVATION]),
});

export const J4_ROUND: J4ReplanRound = Object.freeze({
  delta: Object.freeze({
    carryForwardNodeRefs: Object.freeze(["node/parser"]),
    changedHashes: Object.freeze([
      "3f5a1c0d2b4e6f8a9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b",
    ]),
    invalidatedNodeRefs: Object.freeze(["node/codegen"]),
  }),
  escalated: false,
  findings: Object.freeze([
    Object.freeze({
      evidenceRef: "evidence/failing-case", findingRef: "finding/1",
      requiredChangeRef: "change/rewrite-parser",
    }),
  ]),
  readableHistoryRefs: Object.freeze(["plan/1", "attempt/1", "review/1"]),
  round: 2,
});

/** Same round, but one node is claimed as both invalidated and carried forward. */
export const J4_CONFLICTING_DELTA: J4ReplanRound = Object.freeze({
  ...J4_ROUND,
  delta: Object.freeze({
    ...J4_ROUND.delta,
    carryForwardNodeRefs: Object.freeze(["node/codegen"]),
  }),
});

const fixture = (
  fixtureId: string,
  journey: FoundationJourney,
  outcome: FoundationOutcome,
  payload: unknown,
  pinnedDigest: string,
): FoundationFixture =>
  Object.freeze({ fixtureId, journey, labels: FOUNDATION_LABELS, outcome, payload, pinnedDigest });

export const FOUNDATION_FIXTURES: readonly FoundationFixture[] = Object.freeze([
  fixture(
    "fixture:j1-linear-happy-path", "J1", passExpected(), J1_WORKED,
    "becb07ae350f06787da2bf08e3f2b67cf1dfdbd7145181c19b4db75cb609d38b",
  ),
  fixture(
    "fixture:j1-zero-work-false-green", "J1", expectedRed("J1_ZERO_WORK_FALSE_GREEN"),
    J1_ZERO_WORK, "97e1a2c992ed5ff01bf41dab9e0bd8186d9160e93dc263650dd5a50ddf35b6a5",
  ),
  fixture(
    "fixture:j1-agent-text-as-gate", "J1", expectedRed("J1_AGENT_TEXT_AS_GATE"),
    J1_AGENT_TEXT, "03cc9ba2c6eb08b6251180fb8d5e887f44243aeab29fed06bb7eb6a0552ed0f8",
  ),
  fixture(
    "fixture:j3-restart-record-classes", "J3", passExpected(),
    J3_RESTART_RECORDS, "7412b0469d0c87b658d0c47585a8a6c9aad14ed9f1c24ad8ff8457f5ccb8fa58",
  ),
  fixture(
    "fixture:j3-history-edited-continuation", "J3", expectedRed("J3_HISTORY_EDITED"),
    J3_EDITED_HISTORY, "51d0577e569455d799fd4473b6bdf2d2495ed7ff8c86810bc52e49e6b854b064",
  ),
  fixture(
    "fixture:j4-delta-approval-round", "J4", passExpected(), J4_ROUND,
    "287811c1d54c1cb295ec57bb6cb9a368a4c237e776a1090e586a35714fbf4d00",
  ),
  fixture(
    "fixture:j4-node-both-invalidated-and-carried", "J4",
    expectedRed("J4_NODE_BOTH_INVALIDATED_AND_CARRIED"), J4_CONFLICTING_DELTA,
    "bff6206830451cc1776586cfc8433b611576114a632eb54a361a311c6839f4a6",
  ),
]);
