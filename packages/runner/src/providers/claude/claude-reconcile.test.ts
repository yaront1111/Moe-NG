import { describe, expect, it } from "vitest";

import {
  CLAUDE_RECONCILED_OUTCOMES,
  reconcileClaudeRun,
  type ClaudeProcessExit,
} from "./claude-cancel-reconcile.js";
import {
  CLAUDE_ACCEPTED_SCHEMA_VERSIONS,
  CLAUDE_STREAM_DISPOSITIONS,
  recordClaudeStream,
  type ClaudeStreamRecord,
  type MoeEffectIdentity,
} from "./claude-stream.js";

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

const EFFECT: MoeEffectIdentity = Object.freeze({
  effectIntentId: "effect-intent-reconcile",
  attemptRef: "attempt-9",
  epoch: 1,
});

function streamOf(text: string): ClaudeStreamRecord {
  const result = recordClaudeStream({
    rawBytes: utf8(text),
    effect: EFFECT,
    acceptedSchemaVersions: CLAUDE_ACCEPTED_SCHEMA_VERSIONS,
  });
  if (!result.ok) {
    throw new Error(`stream record failed: ${result.code}`);
  }
  return result.record;
}

const LINE = (seq: number, type: string, subtype?: string): string =>
  JSON.stringify({
    schemaVersion: "claude-stream-json/1",
    seq,
    type,
    ...(subtype === undefined ? {} : { subtype }),
  });

const COMPLETED_STREAM = streamOf(`${LINE(1, "system")}\n${LINE(2, "result", "success")}\n`);
const CANCELLED_STREAM = streamOf(`${LINE(1, "system")}\n${LINE(2, "result", "cancelled")}\n`);
const INCOMPLETE_STREAM = streamOf(`${LINE(1, "system")}\n`);
const TRUNCATED_STREAM = streamOf(`${LINE(1, "system")}\n{"schemaVersion":"claude-stream`);
const MALFORMED_STREAM = streamOf(`${LINE(1, "system")}\n{oops}\n${LINE(3, "result", "success")}\n`);
const UNKNOWN_SCHEMA_STREAM = streamOf(
  `${LINE(1, "system")}\n{"schemaVersion":"claude-stream-json/7","seq":2,"type":"result"}\n`,
);
const RESUMED_STREAM = streamOf(
  `{"schemaVersion":"claude-stream-json/1","seq":4,"type":"system","resumedFrom":"run-a"}\n`,
);

const EXITED_OK: ClaudeProcessExit = { kind: "EXITED", code: 0 };
const EXITED_FAIL: ClaudeProcessExit = { kind: "EXITED", code: 1 };
const SIGNALLED: ClaudeProcessExit = { kind: "SIGNALLED", signal: "SIGKILL" };
const UNOBSERVED: ClaudeProcessExit = { kind: "UNOBSERVED" };

describe("cancellation and crash reconciliation", () => {
  it("maps every stream disposition to a typed outcome", () => {
    const expected: ReadonlyArray<readonly [ClaudeStreamRecord, boolean, ClaudeProcessExit, string]> =
      [
        [COMPLETED_STREAM, false, EXITED_OK, "PROVEN_RESULT"],
        [COMPLETED_STREAM, true, EXITED_OK, "COMPLETED_BEFORE_CANCEL"],
        [CANCELLED_STREAM, true, EXITED_FAIL, "CANCELLED_CLEAN"],
        [CANCELLED_STREAM, false, EXITED_OK, "CANCELLED_CLEAN"],
        [INCOMPLETE_STREAM, false, SIGNALLED, "CRASHED"],
        [INCOMPLETE_STREAM, false, EXITED_FAIL, "CRASHED"],
        [INCOMPLETE_STREAM, false, EXITED_OK, "HONEST_UNKNOWN"],
        [INCOMPLETE_STREAM, false, UNOBSERVED, "HONEST_UNKNOWN"],
        [INCOMPLETE_STREAM, true, SIGNALLED, "CANCELLED_UNKNOWN_TAIL"],
        [TRUNCATED_STREAM, true, SIGNALLED, "CANCELLED_UNKNOWN_TAIL"],
        [TRUNCATED_STREAM, false, EXITED_FAIL, "CRASHED"],
        [TRUNCATED_STREAM, false, UNOBSERVED, "HONEST_UNKNOWN"],
        [MALFORMED_STREAM, false, EXITED_OK, "HONEST_UNKNOWN"],
        [UNKNOWN_SCHEMA_STREAM, false, EXITED_OK, "HONEST_UNKNOWN"],
        [RESUMED_STREAM, false, EXITED_OK, "HONEST_UNKNOWN"],
      ];
    for (const [stream, cancelRequested, processExit, outcome] of expected) {
      const result = reconcileClaudeRun({ stream, cancelRequested, processExit });
      expect(`${stream.disposition}/${cancelRequested}/${processExit.kind}=${result.outcome}`).toBe(
        `${stream.disposition}/${cancelRequested}/${processExit.kind}=${outcome}`,
      );
    }
  });

  it("never invents a proven result from a stream that did not prove one", () => {
    const streams: readonly ClaudeStreamRecord[] = [
      COMPLETED_STREAM,
      CANCELLED_STREAM,
      INCOMPLETE_STREAM,
      TRUNCATED_STREAM,
      MALFORMED_STREAM,
      UNKNOWN_SCHEMA_STREAM,
      RESUMED_STREAM,
    ];
    const exits: readonly ClaudeProcessExit[] = [EXITED_OK, EXITED_FAIL, SIGNALLED, UNOBSERVED];
    const covered = new Set<string>();
    for (const stream of streams) {
      for (const cancelRequested of [false, true]) {
        for (const processExit of exits) {
          const result = reconcileClaudeRun({ stream, cancelRequested, processExit });
          covered.add(stream.disposition);
          expect(CLAUDE_RECONCILED_OUTCOMES).toContain(result.outcome);
          if (result.outcome === "PROVEN_RESULT") {
            expect(`${stream.disposition}/${cancelRequested}`).toBe("COMPLETED/false");
          }
        }
      }
    }
    for (const disposition of CLAUDE_STREAM_DISPOSITIONS) {
      expect(`${disposition}:${covered.has(disposition)}`).toBe(`${disposition}:true`);
    }
  });

  it("carries the stream evidence forward and stays frozen and digest bound", () => {
    const result = reconcileClaudeRun({
      stream: TRUNCATED_STREAM,
      cancelRequested: true,
      processExit: SIGNALLED,
    });
    expect(result.streamDigest).toBe(TRUNCATED_STREAM.recordDigest);
    expect(result.anomalies).toEqual(TRUNCATED_STREAM.anomalies);
    expect(result.disposition).toBe(TRUNCATED_STREAM.disposition);
    expect(result.reconciliationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
    const again = reconcileClaudeRun({
      stream: TRUNCATED_STREAM,
      cancelRequested: true,
      processExit: SIGNALLED,
    });
    expect(again.reconciliationDigest).toBe(result.reconciliationDigest);
  });
});
