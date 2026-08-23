import type { StoredEvent } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  DAEMON_STEP_LIFECYCLE, STEP_CHECKPOINTED_EVENT_TYPE, STEP_LIFECYCLE_CODES, deriveStepRef,
} from "./step-lifecycle-contracts.js";
import { readCurrentAttemptStepRecord } from "./step-lifecycle-reader.js";
import type { AttemptStepResult, StepEventSource } from "./step-lifecycle-reader.js";
import {
  openStepHarness, plantStepEvent, startedRoster, stepBody,
} from "./step-lifecycle-test-harness.js";

/**
 * The strict CURRENT reader for the durable per-attempt step record
 * (task-aa7ccdf4), driven by PLANTED rows on a file-backed SqliteEventStore.
 *
 * Every case drifts exactly ONE field of a body the positive control proves reads
 * OK, and each pins the exact CODE and the exact refusing LAYER: an assertion that
 * only said "refused" would stay green if a different guard started answering
 * first, which is precisely how an arm detaches from its subject.
 */

afterEach(cleanupRestoreHarnesses);

const LABELS = ["plan the change", "write the test"] as const;

function refusalOf(answer: AttemptStepResult): { code: string; layer: string } {
  if (answer.ok) throw new Error("expected a refusal, received a durable step record");
  return { code: answer.code, layer: answer.layer };
}

describe("readCurrentAttemptStepRecord — the positive control and its cardinality", () => {
  it("reads a planted canonical body and answers every durable roster", () => {
    const harness = openStepHarness("step-reader-control");
    const { activationDigest } = harness.attempt.record;
    // ABSENT before any row: distinct from UNREADABLE because the two demand
    // opposite repairs — start a step, versus repair the store.
    expect(refusalOf(readCurrentAttemptStepRecord(harness.store, activationDigest, PROJECT_ID)))
      .toEqual({ code: "STEP_RECORD_ABSENT", layer: DAEMON_STEP_LIFECYCLE });

    const roster = startedRoster(activationDigest, LABELS);
    plantStepEvent(harness.store, activationDigest, stepBody(harness.attempt, LABELS, {
      checkpointRef: roster[1]?.stepRef ?? null, completedSteps: [roster[0]?.stepRef ?? ""],
    }), 0);
    const answer = readCurrentAttemptStepRecord(harness.store, activationDigest, PROJECT_ID);
    if (!answer.ok) throw new Error(`the control body was refused: ${answer.code}`);
    // The refs are re-derived through the PRODUCTION mint, never a literal.
    expect(answer.startedSteps.map((step) => step.stepRef))
      .toEqual([deriveStepRef(activationDigest, 0), deriveStepRef(activationDigest, 1)]);
    expect(answer.startedSteps.map((step) => step.ordinal)).toEqual([0, 1]);
    expect(answer.startedSteps.map((step) => step.label)).toEqual([...LABELS]);
    expect(answer.completedSteps).toEqual([deriveStepRef(activationDigest, 0)]);
    expect(answer.checkpointRef).toBe(deriveStepRef(activationDigest, 1));
    expect({
      activationDigest: answer.activationDigest, attemptRef: answer.attemptRef,
      authority: answer.authority, effectId: answer.effectId, leaseRef: answer.leaseRef,
      sessionId: answer.sessionId,
    }).toEqual({
      activationDigest, attemptRef: harness.attempt.record.attempt.attemptId,
      authority: "DURABLE_STEP_RECORD",
      effectId: harness.attempt.record.effectIntent.intentId,
      leaseRef: harness.attempt.record.lease.leaseId, sessionId: harness.attempt.sessionId,
    });
  });

  it("refuses an UNREADABLE store separately from an absent row", () => {
    const harness = openStepHarness("step-reader-unreadable");
    const { activationDigest } = harness.attempt.record;
    harness.store.close();
    expect(refusalOf(readCurrentAttemptStepRecord(harness.store, activationDigest, PROJECT_ID)))
      .toEqual({ code: "STEP_RECORD_UNREADABLE", layer: DAEMON_STEP_LIFECYCLE });
  });

  it("refuses two rows claiming one sequence, which no repair can choose between", () => {
    const harness = openStepHarness("step-reader-ambiguous");
    const { activationDigest } = harness.attempt.record;
    plantStepEvent(harness.store, activationDigest, stepBody(harness.attempt, LABELS), 0);
    plantStepEvent(harness.store, activationDigest, stepBody(harness.attempt, LABELS), 1,
      STEP_CHECKPOINTED_EVENT_TYPE);
    // REAL store rows; only the SEQUENCE of the second is drifted, because the
    // store assigns sequences itself and will not mint a duplicate.
    const collided: StepEventSource = {
      readEvents: (aggregateId: string): readonly StoredEvent[] =>
        harness.store.readEvents(aggregateId).map((event, index) =>
          index === 1 ? { ...event, aggregateSequence: 1 } : event),
    };
    expect(readCurrentAttemptStepRecord(harness.store, activationDigest, PROJECT_ID).ok)
      .toBe(true);
    expect(refusalOf(readCurrentAttemptStepRecord(collided, activationDigest, PROJECT_ID)))
      .toEqual({ code: "STEP_RECORD_AMBIGUOUS", layer: DAEMON_STEP_LIFECYCLE });
  });

  it("refuses a foreign event type on the step aggregate", () => {
    const harness = openStepHarness("step-reader-foreign-type");
    const { activationDigest } = harness.attempt.record;
    plantStepEvent(harness.store, activationDigest, stepBody(harness.attempt, LABELS), 0);
    const foreign: StepEventSource = {
      readEvents: (aggregateId: string): readonly StoredEvent[] =>
        harness.store.readEvents(aggregateId).map((event) =>
          ({ ...event, eventType: "AttemptJournalAppended" })),
    };
    expect(refusalOf(readCurrentAttemptStepRecord(foreign, activationDigest, PROJECT_ID)))
      .toEqual({ code: "STEP_RECORD_MALFORMED", layer: DAEMON_STEP_LIFECYCLE });
  });

  it("refuses a sequence hole rather than reading past it", () => {
    const harness = openStepHarness("step-reader-hole");
    const { activationDigest } = harness.attempt.record;
    plantStepEvent(harness.store, activationDigest, stepBody(harness.attempt, LABELS), 0);
    const holed: StepEventSource = {
      readEvents: (aggregateId: string): readonly StoredEvent[] =>
        harness.store.readEvents(aggregateId).map((event) =>
          ({ ...event, aggregateSequence: event.aggregateSequence + 1 })),
    };
    expect(refusalOf(readCurrentAttemptStepRecord(holed, activationDigest, PROJECT_ID)))
      .toEqual({ code: "STEP_RECORD_MALFORMED", layer: DAEMON_STEP_LIFECYCLE });
  });

  it("refuses stored bytes that no longer re-encode, as DRIFT", () => {
    const harness = openStepHarness("step-reader-drift");
    const { activationDigest } = harness.attempt.record;
    plantStepEvent(harness.store, activationDigest, stepBody(harness.attempt, LABELS), 0);
    // Canonical encoding sorts keys, so a payload stored out of key order decodes
    // cleanly and fails ONLY the byte compare. A reader that skipped the re-encode
    // would answer from this row.
    const scrambled: StepEventSource = {
      readEvents: (aggregateId: string): readonly StoredEvent[] =>
        harness.store.readEvents(aggregateId).map((event) => ({
          ...event, payload: new TextEncoder().encode('{"b":1,"a":2}'),
        })),
    };
    expect(refusalOf(readCurrentAttemptStepRecord(scrambled, activationDigest, PROJECT_ID)))
      .toEqual({ code: "STEP_RECORD_DRIFT", layer: DAEMON_STEP_LIFECYCLE });
  });

  it("refuses an AGGREGATE-SCOPED horizon that moved under the decode", () => {
    const harness = openStepHarness("step-reader-horizon");
    const { activationDigest } = harness.attempt.record;
    plantStepEvent(harness.store, activationDigest, stepBody(harness.attempt, LABELS), 0);
    let planted = false;
    // A REAL second row lands between the reader's two reads of the SAME aggregate.
    // A GLOBAL horizon would also move on an unrelated write and refuse nearly every
    // read on a busy daemon; this one moves only because THIS record moved.
    const moving: StepEventSource = {
      readEvents: (aggregateId: string): readonly StoredEvent[] => {
        const rows = harness.store.readEvents(aggregateId);
        if (!planted) {
          planted = true;
          plantStepEvent(harness.store, activationDigest,
            stepBody(harness.attempt, LABELS), 1, STEP_CHECKPOINTED_EVENT_TYPE);
        }
        return rows;
      },
    };
    expect(refusalOf(readCurrentAttemptStepRecord(moving, activationDigest, PROJECT_ID)))
      .toEqual({ code: "STEP_RECORD_HORIZON_MOVED", layer: DAEMON_STEP_LIFECYCLE });
  });
});

describe("readCurrentAttemptStepRecord — one drifted field at a time", () => {
  const cases = [
    { code: "STEP_PROJECT_MISMATCH", label: "a foreign project",
      overrides: { projectId: "project-elsewhere" } },
    { code: "STEP_RECORD_MALFORMED", label: "a stale record version",
      overrides: { recordVersion: "moe-attempt-step/0" } },
    { code: "STEP_RECORD_MALFORMED", label: "a downgraded truth class",
      overrides: { truthClass: "SUSPECT" } },
    { code: "STEP_RECORD_MALFORMED", label: "an activation digest naming another attempt",
      overrides: { activationDigest: "f".repeat(64) } },
    // ORDINAL ONLY: the ref is the genuine server mint for index 0, so this arm
    // reds on the ordinal-vs-index check and on nothing else.
    { code: "STEP_RECORD_MALFORMED", label: "an ordinal rewritten out of append order",
      overrides: { startedSteps: [{ label: "one", ordinal: 7, stepRef: "REF0" }] } },
    // REF ONLY: the ordinal agrees with the index and the ref is the scheduler
    // fixture literal "resume-step-2" — a step identity nothing minted.
    { code: "STEP_RECORD_MALFORMED", label: "a step ref that is not the server mint",
      overrides: { startedSteps: [{ label: "one", ordinal: 0, stepRef: "resume-step-2" }] } },
    { code: "STEP_RECORD_MALFORMED", label: "a completed step absent from the started roster",
      overrides: { completedSteps: ["step-9-never-started"] } },
    { code: "STEP_RECORD_MALFORMED", label: "a completed step counted twice",
      overrides: { completedSteps: ["REF0", "REF0"] } },
    { code: "STEP_RECORD_MALFORMED", label: "a checkpoint naming a step that does not exist",
      overrides: { checkpointRef: "work.resume" } },
  ] as const;

  // A swept table that generated nothing passes every assertion below vacuously.
  it("drives every drifted-field case the table declares", () => {
    expect(cases.length).toBe(9);
    expect(cases.every((item) => STEP_LIFECYCLE_CODES.includes(item.code))).toBe(true);
  });

  it.each(cases)("refuses $label with $code", ({ code, label, overrides }) => {
    const slug = label.replaceAll(" ", "-");
    // POSITIVE CONTROL on the SAME body without the drift, so the refusal below
    // cannot be caused by a fixture that was invalid before the field under test.
    const control = openStepHarness(`step-ok-${slug}`);
    plantStepEvent(control.store, control.attempt.record.activationDigest,
      stepBody(control.attempt, LABELS), 0);
    expect(readCurrentAttemptStepRecord(
      control.store, control.attempt.record.activationDigest, PROJECT_ID).ok).toBe(true);

    const drifted = openStepHarness(`step-drift-${slug}`);
    const digest = drifted.attempt.record.activationDigest;
    // "REF0" is a placeholder for the attempt's OWN first minted ref, resolved
    // through the PRODUCTION mint: a hand-written literal would silently stop
    // naming the roster the moment the derivation changed.
    const resolve = (value: unknown): unknown => {
      if (value === "REF0") return deriveStepRef(digest, 0);
      if (Array.isArray(value)) return value.map(resolve);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, resolve(item)]));
      }
      return value;
    };
    const resolved = resolve(overrides) as Record<string, unknown>;
    plantStepEvent(drifted.store, digest, stepBody(drifted.attempt, LABELS, resolved), 0);
    expect(refusalOf(readCurrentAttemptStepRecord(drifted.store, digest, PROJECT_ID)))
      .toEqual({ code, layer: DAEMON_STEP_LIFECYCLE });
  });
});
