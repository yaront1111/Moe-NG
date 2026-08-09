import { describe, expect, it } from "vitest";

import {
  CLAUDE_RECONCILED_OUTCOMES,
  reconcileClaudeRun,
  type ClaudeProcessExit,
} from "../claude/claude-cancel-reconcile.js";
import {
  CLAUDE_CAPABILITIES,
  CLAUDE_CAPABILITY_STATUSES,
} from "../claude/claude-capabilities.js";
import {
  OBSERVATION_TRUTH_CLASSES as CLAUDE_TRUTH_CLASSES,
  claudeFailure,
} from "../claude/claude-observation.js";
import {
  CLAUDE_ACCEPTED_SCHEMA_VERSIONS,
  recordClaudeStream,
} from "../claude/claude-stream.js";
import {
  CODEX_RECONCILED_OUTCOMES,
  reconcileCodexRun,
  type CodexProcessExit,
} from "./codex-cancel-reconcile.js";
import { CODEX_CAPABILITIES, CODEX_CAPABILITY_STATUSES } from "./codex-capabilities.js";
import {
  OBSERVATION_TRUTH_CLASSES as CODEX_TRUTH_CLASSES,
  codexFailure,
} from "./codex-observation.js";
import { CODEX_ACCEPTED_SCHEMA_VERSIONS, recordCodexStream } from "./codex-stream.js";

const encoder = new TextEncoder();
const effect = { effectIntentId: "effect-parity", attemptRef: "attempt-1", epoch: 1 };

function setEqual(left: readonly string[], right: readonly string[]): void {
  expect(left.length).toBeGreaterThan(0);
  expect(right.length).toBeGreaterThan(0);
  expect([...new Set(left)].sort()).toEqual([...new Set(right)].sort());
}

function claudeIncomplete() {
  const result = recordClaudeStream({
    rawBytes: encoder.encode('{"schemaVersion":"claude-stream-json/1","seq":1,"type":"assistant"}\n'),
    effect,
    acceptedSchemaVersions: CLAUDE_ACCEPTED_SCHEMA_VERSIONS,
  });
  if (!result.ok) throw new Error(result.code);
  return result.record;
}

function codexIncomplete() {
  const result = recordCodexStream({
    rawBytes: encoder.encode('{"schemaVersion":"codex-stream-json/1","seq":1,"type":"assistant"}\n'),
    effect,
    acceptedSchemaVersions: CODEX_ACCEPTED_SCHEMA_VERSIONS,
  });
  if (!result.ok) throw new Error(result.code);
  return result.record;
}

describe("Claude and Codex provider-contract parity", () => {
  it("keeps non-empty reconciliation vocabularies set-equal", () => {
    setEqual(CLAUDE_RECONCILED_OUTCOMES, CODEX_RECONCILED_OUTCOMES);
  });

  it("admits the same three process-exit arms through both production reconcilers", () => {
    const exits = [
      { kind: "EXITED", code: 0 },
      { kind: "SIGNALLED", signal: "SIGTERM" },
      { kind: "UNOBSERVED" },
    ] as const satisfies readonly ClaudeProcessExit[] & readonly CodexProcessExit[];
    const claudeObserved = exits.map((processExit) => reconcileClaudeRun({
      stream: claudeIncomplete(), cancelRequested: true, processExit,
    }).processExit.kind);
    const codexObserved = exits.map((processExit) => reconcileCodexRun({
      stream: codexIncomplete(), cancelRequested: true, processExit,
    }).processExit.kind);
    expect(claudeObserved).toEqual(["EXITED", "SIGNALLED", "UNOBSERVED"]);
    expect(codexObserved).toEqual(claudeObserved);
  });

  it("produces identical reconciliation outcomes for the shared exit table", () => {
    const exits = [
      { kind: "EXITED", code: 0 },
      { kind: "EXITED", code: 1 },
      { kind: "SIGNALLED", signal: "SIGKILL" },
      { kind: "UNOBSERVED" },
    ] as const satisfies readonly ClaudeProcessExit[] & readonly CodexProcessExit[];
    for (const cancelRequested of [false, true]) {
      const claude = exits.map((processExit) => reconcileClaudeRun({
        stream: claudeIncomplete(), cancelRequested, processExit,
      }).outcome);
      const codex = exits.map((processExit) => reconcileCodexRun({
        stream: codexIncomplete(), cancelRequested, processExit,
      }).outcome);
      expect(codex).toEqual(claude);
    }
  });

  it("keeps status, truth, and failure record contracts structurally congruent", () => {
    setEqual(CLAUDE_CAPABILITY_STATUSES, CODEX_CAPABILITY_STATUSES);
    setEqual(CLAUDE_TRUTH_CLASSES, CODEX_TRUTH_CLASSES);
    const claude = claudeFailure("CLAUDE_TEST", "refused");
    const codex = codexFailure("CODEX_TEST", "refused");
    expect(Object.keys(codex).sort()).toEqual(Object.keys(claude).sort());
    expect(Object.entries(codex).map(([key, value]) => [key, typeof value])).toEqual(
      Object.entries(claude).map(([key, value]) => [key, typeof value]),
    );
  });

  it("pins the one intentional Codex-only capability explicitly", () => {
    expect(CLAUDE_CAPABILITIES).toEqual([
      "CANCEL_ON_READING", "CONTEXT_LIMIT_DECLARATION", "PIN_METHOD",
      "PROCESS_TREE_TERMINATION", "RAW_STREAM", "RESUME",
      "RUN_ENUMERATION_NEGATIVE_PROOF", "SCHEMA_VERSION_REPORT",
      "STRUCTURED_STREAM", "TOKENIZER_AVAILABILITY", "VERSION_REPORT",
    ]);
    expect(CODEX_CAPABILITIES).toEqual([
      "CANCEL_ON_READING", "CONTEXT_LIMIT_DECLARATION", "CWD_OBSERVATION", "PIN_METHOD",
      "PROCESS_TREE_TERMINATION", "RAW_STREAM", "RESUME",
      "RUN_ENUMERATION_NEGATIVE_PROOF", "SCHEMA_VERSION_REPORT",
      "STRUCTURED_STREAM", "TOKENIZER_AVAILABILITY", "VERSION_REPORT",
    ]);
    expect(CODEX_CAPABILITIES.filter((value) =>
      !(CLAUDE_CAPABILITIES as readonly string[]).includes(value))).toEqual(["CWD_OBSERVATION"]);
    expect(CLAUDE_CAPABILITIES.filter((value) =>
      !(CODEX_CAPABILITIES as readonly string[]).includes(value))).toEqual([]);
  });
});
