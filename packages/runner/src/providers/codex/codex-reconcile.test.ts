import { describe, expect, it } from "vitest";

import {
  CODEX_RECONCILED_OUTCOMES,
  reconcileCodexRun,
  type CodexProcessExit,
} from "./codex-cancel-reconcile.js";
import {
  CODEX_ACCEPTED_SCHEMA_VERSIONS,
  recordCodexStream,
  type CodexStreamRecord,
} from "./codex-stream.js";

const encoder = new TextEncoder();
const EXITED_OK: CodexProcessExit = { kind: "EXITED", code: 0 };
const EXITED_FAIL: CodexProcessExit = { kind: "EXITED", code: 1 };
const SIGNALLED: CodexProcessExit = { kind: "SIGNALLED", signal: "SIGKILL" };
const UNOBSERVED: CodexProcessExit = { kind: "UNOBSERVED" };

const line = (
  seq: number,
  type = "assistant",
  extra: Record<string, unknown> = {},
) => JSON.stringify({ schemaVersion: "codex-stream-json/1", seq, type, ...extra });

function stream(text: string): CodexStreamRecord {
  const result = recordCodexStream({
    rawBytes: encoder.encode(text),
    effect: { effectIntentId: "effect-1", attemptRef: "attempt-1", epoch: 1 },
    acceptedSchemaVersions: CODEX_ACCEPTED_SCHEMA_VERSIONS,
  });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.record;
}

const complete = stream(`${line(1)}\n${line(2, "result", { subtype: "success" })}\n`);
const cancelled = stream(`${line(1)}\n${line(2, "result", { subtype: "cancelled" })}\n`);
const incomplete = stream(`${line(1)}\n`);
const truncated = stream(`${line(1)}\n{"seq":2`);
const gapped = stream(`${line(1)}\n${line(3)}\n`);
const unknownSchema = stream(`${JSON.stringify({ schemaVersion: "future", seq: 1, type: "assistant" })}\n`);
const resumed = stream(`${line(7, "system", { resumedFrom: "run-old" })}\n`);

describe("Codex cancellation and crash reconciliation", () => {
  it.each([
    [complete, false, EXITED_OK, "PROVEN_RESULT"],
    [complete, true, EXITED_OK, "COMPLETED_BEFORE_CANCEL"],
    [cancelled, false, EXITED_OK, "CANCELLED_CLEAN"],
    [incomplete, false, EXITED_FAIL, "CRASHED"],
    [incomplete, false, SIGNALLED, "CRASHED"],
    [incomplete, false, UNOBSERVED, "HONEST_UNKNOWN"],
    [incomplete, true, EXITED_OK, "HONEST_UNKNOWN"],
    [incomplete, true, UNOBSERVED, "CANCELLED_UNKNOWN_TAIL"],
    [truncated, true, SIGNALLED, "CANCELLED_UNKNOWN_TAIL"],
    [truncated, false, EXITED_FAIL, "CRASHED"],
    [gapped, false, EXITED_FAIL, "HONEST_UNKNOWN"],
    [unknownSchema, false, EXITED_FAIL, "HONEST_UNKNOWN"],
    [resumed, false, EXITED_FAIL, "HONEST_UNKNOWN"],
  ] as const)(
    "maps %s cancel=%s exit=%s to the exact outcome %s",
    (record, cancelRequested, processExit, outcome) => {
      expect(reconcileCodexRun({ stream: record, cancelRequested, processExit }).outcome).toBe(outcome);
    },
  );

  it("keeps UNOBSERVED distinct from a proven clean exit", () => {
    expect(reconcileCodexRun({ stream: incomplete, cancelRequested: true, processExit: UNOBSERVED }))
      .toMatchObject({ outcome: "CANCELLED_UNKNOWN_TAIL", processExit: { kind: "UNOBSERVED" } });
    expect(reconcileCodexRun({ stream: incomplete, cancelRequested: true, processExit: EXITED_OK }))
      .toMatchObject({ outcome: "HONEST_UNKNOWN", processExit: { kind: "EXITED", code: 0 } });
  });

  it("returns a deeply frozen digest-bound reconciliation", () => {
    const result = reconcileCodexRun({
      stream: complete,
      cancelRequested: false,
      processExit: EXITED_OK,
    });
    expect(result.outcome).toBe("PROVEN_RESULT");
    expect(result.streamDigest).toBe(complete.recordDigest);
    expect(result.reconciliationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.processExit)).toBe(true);
  });

  it("reaches every non-empty reconciled outcome vocabulary member", () => {
    const observed = new Set<string>();
    for (const record of [complete, cancelled, incomplete, truncated]) {
      for (const cancelRequested of [false, true]) {
        for (const processExit of [EXITED_OK, EXITED_FAIL, SIGNALLED, UNOBSERVED]) {
          observed.add(reconcileCodexRun({ stream: record, cancelRequested, processExit }).outcome);
        }
      }
    }
    expect(CODEX_RECONCILED_OUTCOMES.length).toBeGreaterThan(0);
    expect([...observed].sort()).toEqual([...CODEX_RECONCILED_OUTCOMES].sort());
  });
});
