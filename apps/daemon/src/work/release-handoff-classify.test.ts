/**
 * The builder's refusal roster (task-a20e8ef668b54c3abbfce37a505252eb, DoD 3).
 *
 * THE POINT OF THIS FILE IS BIDIRECTIONAL COVERAGE. Iterating the classifier's own suffix
 * table would only prove the table agrees with itself. Every case below starts from a code
 * roster the SOURCE MODULE publishes, so a reader that adds an ending this builder does not
 * recognise is caught here rather than arriving downstream classified as something it is
 * not. The reverse direction is asserted too: every one of the eight source classes must be
 * produced by at least one really-published code, or a class exists that nothing can reach.
 *
 * `RELEASE_HANDOFF_SOURCE_CONFLICTING` is deliberately NOT reachable from any upstream code.
 * It is this daemon's own verdict that two durable sources disagree about one attempt, and
 * no single reader can observe that; it is raised by `refuseConflict` and asserted there.
 */

import { describe, expect, it } from "vitest";

import { JOURNAL_CODES } from "../journal/journal-contracts.js";
import { PROVIDER_RUN_LEDGER_CODES } from "../telemetry/provider-run-refusals.js";
import { FOUNDATION_ARTIFACT_LEDGER_CODES } from "./foundation-artifact-ledger.js";
import {
  FOUNDATION_CAPTURE_CONTEXT_CODES,
} from "./foundation-capture-context-contract.js";
import {
  FOUNDATION_CAPTURE_CONTEXT_LEDGER_CODES,
} from "./foundation-capture-context-ledger.js";
import {
  FOUNDATION_CONTEXT_STRICT_CODES,
} from "./foundation-context-manifest-reader.js";
import {
  HANDOFF_CLASS_SUFFIXES, HANDOFF_CROSS_CHECK_LAYER, carrySourceRefusal, classifyUpstream,
  refuseConflict, refuseForeign,
} from "./release-handoff-classify.js";
import { RELEASE_TERMINAL_CODES } from "./release-terminal-evidence-contracts.js";
import { STEP_LIFECYCLE_CODES } from "./step-lifecycle-contracts.js";

/**
 * The class each really-published code MUST land in, written out by hand rather than
 * derived, because a derivation would reproduce the very rule under test. Only codes a
 * READER can answer with are listed; a writer-only code is unreachable from this builder.
 */
const EXPECTED: Readonly<Record<string, string>> = Object.freeze({
  // step lifecycle
  STEP_RECORD_ABSENT: "RELEASE_HANDOFF_SOURCE_ABSENT",
  STEP_RECORD_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  STEP_RECORD_MALFORMED: "RELEASE_HANDOFF_SOURCE_MALFORMED",
  STEP_RECORD_AMBIGUOUS: "RELEASE_HANDOFF_SOURCE_AMBIGUOUS",
  STEP_RECORD_DRIFT: "RELEASE_HANDOFF_SOURCE_MALFORMED",
  STEP_RECORD_HORIZON_MOVED: "RELEASE_HANDOFF_SOURCE_HORIZON_MOVED",
  STEP_PROJECT_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  STEP_BINDING_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  // journal — a DIGEST mismatch is the record no longer covering its own entries, which is
  // MALFORMED. Classifying it FOREIGN would send an operator hunting another attempt.
  JOURNAL_RECORD_ABSENT: "RELEASE_HANDOFF_SOURCE_ABSENT",
  JOURNAL_RECORD_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  JOURNAL_RECORD_MALFORMED: "RELEASE_HANDOFF_SOURCE_MALFORMED",
  JOURNAL_RECORD_AMBIGUOUS: "RELEASE_HANDOFF_SOURCE_AMBIGUOUS",
  JOURNAL_PROJECT_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  JOURNAL_BINDING_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  JOURNAL_DIGEST_MISMATCH: "RELEASE_HANDOFF_SOURCE_MALFORMED",
  JOURNAL_NODE_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  // capture context
  FOUNDATION_CAPTURE_CONTEXT_READER_ABSENT: "RELEASE_HANDOFF_SOURCE_ABSENT",
  FOUNDATION_CAPTURE_CONTEXT_READER_AMBIGUOUS: "RELEASE_HANDOFF_SOURCE_AMBIGUOUS",
  FOUNDATION_CAPTURE_CONTEXT_READER_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  FOUNDATION_CAPTURE_CONTEXT_READER_EVENT_TYPE_UNEXPECTED: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  FOUNDATION_CAPTURE_CONTEXT_READER_REF_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  FOUNDATION_CAPTURE_CONTEXT_READER_BINDING_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  // provider run — only the reader-reachable family members. Codec/composition/commit
  // answers remain published below but are explicitly writer-only for this consumer.
  PROVIDER_RUN_RECORD_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  PROVIDER_RUN_EVIDENCE_ABSENT: "RELEASE_HANDOFF_SOURCE_ABSENT",
  PROVIDER_RUN_EVIDENCE_AMBIGUOUS: "RELEASE_HANDOFF_SOURCE_AMBIGUOUS",
  PROVIDER_RUN_EVIDENCE_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  PROVIDER_RUN_EVIDENCE_MALFORMED: "RELEASE_HANDOFF_SOURCE_MALFORMED",
  PROVIDER_RUN_BINDING_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  // context manifest
  FOUNDATION_CONTEXT_READER_ABSENT: "RELEASE_HANDOFF_SOURCE_ABSENT",
  FOUNDATION_CONTEXT_READER_AMBIGUOUS: "RELEASE_HANDOFF_SOURCE_AMBIGUOUS",
  FOUNDATION_CONTEXT_READER_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  FOUNDATION_CONTEXT_READER_EVENT_TYPE_UNEXPECTED: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  FOUNDATION_CONTEXT_READER_BINDING_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  FOUNDATION_CONTEXT_READER_STALE: "RELEASE_HANDOFF_SOURCE_STALE",
  // artifact ledger
  FOUNDATION_ARTIFACT_LEDGER_ABSENT: "RELEASE_HANDOFF_SOURCE_ABSENT",
  FOUNDATION_ARTIFACT_LEDGER_AMBIGUOUS: "RELEASE_HANDOFF_SOURCE_AMBIGUOUS",
  FOUNDATION_ARTIFACT_LEDGER_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  FOUNDATION_ARTIFACT_LEDGER_DRIFT: "RELEASE_HANDOFF_SOURCE_MALFORMED",
  FOUNDATION_ARTIFACT_LEDGER_HORIZON_MOVED: "RELEASE_HANDOFF_SOURCE_HORIZON_MOVED",
  FOUNDATION_ARTIFACT_LEDGER_ATTEMPT_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  FOUNDATION_ARTIFACT_LEDGER_PROJECT_MISMATCH: "RELEASE_HANDOFF_SOURCE_FOREIGN",
  // terminal evidence
  RELEASE_TERMINAL_BINDING_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  RELEASE_TERMINAL_EFFECT_ENUMERATION_UNREADABLE: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  RELEASE_TERMINAL_EFFECT_UNKNOWN: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
  RELEASE_TERMINAL_RESOURCE_UNKNOWN: "RELEASE_HANDOFF_SOURCE_UNREADABLE",
});

/**
 * Codes this builder can never SEE, named rather than skipped silently: an unlisted code is
 * a coverage hole the sweep below reports.
 *
 * Two kinds. WRITER codes belong to a commit path the builder never takes. CODEC codes are
 * real but arrive in the reader refusal's separate `codecCode` field while its own `code`
 * stays a `*_READER_*` member — `refuseReader` never promotes one — so the classifier is
 * handed the reader's code, not the codec's.
 */
const WRITER_ONLY: readonly string[] = Object.freeze([
  "STEP_REQUEST_MALFORMED", "STEP_NOT_STARTED", "STEP_ALREADY_FINISHED",
  "STEP_CHECKPOINT_TARGET_UNKNOWN", "STEP_COMMIT_UNAVAILABLE",
  "JOURNAL_REQUEST_MALFORMED", "JOURNAL_ENTRY_MALFORMED", "JOURNAL_ENTRY_LIST_EMPTY",
  "JOURNAL_COMMIT_UNAVAILABLE",
  "FOUNDATION_CAPTURE_CONTEXT_MALFORMED", "FOUNDATION_CAPTURE_CONTEXT_UNSEALED",
  "FOUNDATION_CAPTURE_CONTEXT_VERSION_UNSUPPORTED", "FOUNDATION_CAPTURE_CONTEXT_NONCANONICAL",
  "FOUNDATION_CAPTURE_CONTEXT_LEDGER_EXPECTED_VERSION_CONFLICT",
  "FOUNDATION_CAPTURE_CONTEXT_LEDGER_REPLAY_DIVERGED",
  "FOUNDATION_CAPTURE_CONTEXT_LEDGER_STORE_UNAVAILABLE",
  "FOUNDATION_CAPTURE_CONTEXT_LIMIT_EXCEEDED",
  "FOUNDATION_CAPTURE_CONTEXT_OBSERVATION_UNCLEAN",
  "FOUNDATION_CAPTURE_CONTEXT_ARTIFACT_DECLARATION_UNSUPPORTED",
  "FOUNDATION_CAPTURE_CONTEXT_FIELD_MISMATCH",
  "FOUNDATION_CAPTURE_CONTEXT_RECORD_DIGEST_MISMATCH",
  "PROVIDER_RUN_RECORD_MALFORMED", "PROVIDER_RUN_FIELD_INVALID",
  "PROVIDER_RUN_VERSION_UNSUPPORTED", "PROVIDER_RUN_HANDOFF_MALFORMED",
  "PROVIDER_RUN_USAGE_SEQUENCE_INVALID", "PROVIDER_RUN_MEASUREMENT_REFUSED",
  "PROVIDER_RUN_BYTES_MALFORMED", "PROVIDER_RUN_DIGEST_MISMATCH",
  "PROVIDER_RUN_EVENT_TYPE_UNEXPECTED", "PROVIDER_RUN_AGGREGATE_MISMATCH",
  "PROVIDER_RUN_REPLAY_DIVERGED", "PROVIDER_RUN_EXPECTED_VERSION_CONFLICT",
  "PROVIDER_RUN_IDEMPOTENCY_CONFLICT", "PROVIDER_RUN_STORE_UNAVAILABLE",
  "FOUNDATION_CONTEXT_READER_DECISION_INVALID", "FOUNDATION_CONTEXT_READER_DECISION_MISSING",
  "FOUNDATION_CONTEXT_READER_EVENT_INVALID", "FOUNDATION_CONTEXT_READER_RECEIPT_INVALID",
  "FOUNDATION_CONTEXT_READER_RECEIPT_MISSING",
  "FOUNDATION_ARTIFACT_LEDGER_CONFLICT", "FOUNDATION_ARTIFACT_LEDGER_ROSTER_UNAUTHORIZED",
  "RELEASE_TERMINAL_REQUEST_INVALID",
]);

const PUBLISHED: readonly string[] = Object.freeze([
  ...STEP_LIFECYCLE_CODES, ...JOURNAL_CODES, ...FOUNDATION_CAPTURE_CONTEXT_CODES,
  ...FOUNDATION_CAPTURE_CONTEXT_LEDGER_CODES, ...PROVIDER_RUN_LEDGER_CODES,
  ...FOUNDATION_CONTEXT_STRICT_CODES,
  ...FOUNDATION_ARTIFACT_LEDGER_CODES, ...RELEASE_TERMINAL_CODES,
]);

describe("release handoff classifier — published rosters (task-a20e8ef6)", () => {
  it("covers every published source code exactly once, as reader-reachable or writer-only", () => {
    const unclassified = PUBLISHED.filter(
      (code) => EXPECTED[code] === undefined && !WRITER_ONLY.includes(code));
    // A sweep that produced zero cases would pass; the denominator is asserted.
    expect(PUBLISHED.length).toBeGreaterThan(40);
    expect(unclassified).toEqual([]);
    // WRITER_ONLY may not smuggle in a code no source actually publishes.
    expect(WRITER_ONLY.filter((code) => !PUBLISHED.includes(code))).toEqual([]);
  });

  it("classifies every reader-reachable published code into its named class", () => {
    const entries = Object.entries(EXPECTED);
    expect(entries.length).toBeGreaterThan(30);
    const wrong = entries
      .map(([code, expected]) => ({ actual: classifyUpstream(code), code, expected }))
      .filter(({ actual, expected }) => actual !== expected);
    expect(wrong).toEqual([]);
  });

  it("reaches all eight source classes, with CONFLICTING raised only by this daemon", () => {
    const reached = new Set(Object.values(EXPECTED));
    expect([...reached].sort()).toEqual([
      "RELEASE_HANDOFF_SOURCE_ABSENT", "RELEASE_HANDOFF_SOURCE_AMBIGUOUS",
      "RELEASE_HANDOFF_SOURCE_FOREIGN", "RELEASE_HANDOFF_SOURCE_HORIZON_MOVED",
      "RELEASE_HANDOFF_SOURCE_MALFORMED", "RELEASE_HANDOFF_SOURCE_STALE",
      "RELEASE_HANDOFF_SOURCE_UNREADABLE",
    ]);
    expect(reached.has("RELEASE_HANDOFF_SOURCE_CONFLICTING")).toBe(false);
    const conflicting = refuseConflict("attempt-journal", "A_AND_B_DISAGREE");
    expect(conflicting.code).toBe("RELEASE_HANDOFF_SOURCE_CONFLICTING");
    expect(conflicting.upstream).toEqual({
      code: "A_AND_B_DISAGREE", layer: HANDOFF_CROSS_CHECK_LAYER,
    });
  });

  it("carries the upstream code and layer verbatim rather than restamping them", () => {
    const carried = carrySourceRefusal(
      "step-record", "STEP_RECORD_HORIZON_MOVED", "DAEMON_STEP_LIFECYCLE");
    expect(carried.code).toBe("RELEASE_HANDOFF_SOURCE_HORIZON_MOVED");
    expect(carried.layer).toBe("DAEMON_RELEASE_HANDOFF");
    expect(carried.upstream)
      .toEqual({ code: "STEP_RECORD_HORIZON_MOVED", layer: "DAEMON_STEP_LIFECYCLE" });
    expect(carried.source).toBe("step-record");
    // A cross-check refusal wears THIS daemon's own layer, never a reader's.
    expect(refuseForeign("capture-context", "X").upstream?.layer)
      .toBe(HANDOFF_CROSS_CHECK_LAYER);
  });

  it("defaults an unrecognised ending to MALFORMED without losing its text", () => {
    expect(HANDOFF_CLASS_SUFFIXES.some((suffix) => "SOMETHING_NOVEL".endsWith(suffix)))
      .toBe(false);
    const carried = carrySourceRefusal("terminal-evidence", "SOMETHING_NOVEL", "OTHER_LAYER");
    expect(carried.code).toBe("RELEASE_HANDOFF_SOURCE_MALFORMED");
    expect(carried.upstream).toEqual({ code: "SOMETHING_NOVEL", layer: "OTHER_LAYER" });
  });
});
