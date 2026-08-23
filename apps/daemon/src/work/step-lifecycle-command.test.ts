import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import { runStepLifecycleCommand } from "./step-lifecycle-command.js";
import {
  DAEMON_STEP_LIFECYCLE, STEP_FINISH_COMMAND_KIND, STEP_FINISH_PAYLOAD_KEYS,
  STEP_RECORD_VERSION, STEP_START_COMMAND_KIND, STEP_START_PAYLOAD_KEYS,
  deriveAttemptStepAggregateId, deriveStepRef,
} from "./step-lifecycle-contracts.js";
import type { StepLifecycleOutcome } from "./step-lifecycle-contracts.js";
import { readCurrentAttemptStepRecord } from "./step-lifecycle-reader.js";
import {
  activate, openStepHarness, requestBytes, stepEventCount,
} from "./step-lifecycle-test-harness.js";

/**
 * The step.start / step.finish writers, driven against a file-backed
 * SqliteEventStore holding an activation the PRODUCTION ingress committed
 * (task-aa7ccdf4).
 *
 * The request bytes are assembled exactly as the registry's `requestOf` assembles
 * them, so `projectId`, `principalId` and `decidedAt` are the SERVER's stamps and
 * the payload carries only what its allow-list admits. Step 6 wires these kinds into
 * the registry and adds the arms that traverse `handleCommandRequest` itself.
 *
 * NOTHING BELOW ASSERTS MERELY THAT SOMETHING REFUSED. Every refusal arm pins the
 * exact code AND the layer that answered, because more than one layer can refuse
 * here — the binding reader, the store and this family each answer for themselves.
 */

afterEach(cleanupRestoreHarnesses);

type Harness = ReturnType<typeof openStepHarness>;

const refusalOf = (outcome: StepLifecycleOutcome): { code: string; layer: string } => {
  if (outcome.ok) throw new Error("expected a refusal, received a durable decision");
  return { code: outcome.code, layer: outcome.refusedBy };
};

const start = (
  harness: Harness, commandId: string, label: string,
  overrides: Readonly<Record<string, unknown>> = {},
): StepLifecycleOutcome => runStepLifecycleCommand(harness.store, requestBytes(
  STEP_START_COMMAND_KIND, harness, commandId, {
    attemptAggregateId: harness.attempt.aggregateId,
    effectId: harness.attempt.record.effectIntent.intentId, label, ...overrides,
  }));

const finish = (
  harness: Harness, commandId: string, stepRef: string,
): StepLifecycleOutcome => runStepLifecycleCommand(harness.store, requestBytes(
  STEP_FINISH_COMMAND_KIND, harness, commandId, {
    attemptAggregateId: harness.attempt.aggregateId,
    effectId: harness.attempt.record.effectIntent.intentId, stepRef,
  }));

function durable(harness: Harness): {
  checkpointRef: string | null; completed: readonly string[];
  started: readonly { label: string; ordinal: number; stepRef: string }[];
} {
  const answer = readCurrentAttemptStepRecord(
    harness.store, harness.attempt.record.activationDigest, PROJECT_ID);
  if (!answer.ok) throw new Error(`the durable reader refused: ${answer.code}`);
  return {
    checkpointRef: answer.checkpointRef, completed: answer.completedSteps,
    started: answer.startedSteps,
  };
}

describe("step.start — the server establishes ordering", () => {
  it("mints each step identity and ordinal from the DURABLE APPEND COUNT", () => {
    const harness = openStepHarness("step-start-order");
    const digest = harness.attempt.record.activationDigest;
    expect(stepEventCount(harness.store, digest)).toBe(0);

    expect(start(harness, "cmd-start-1", "plan")).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(start(harness, "cmd-start-2", "write")).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(stepEventCount(harness.store, digest)).toBe(2);

    const record = durable(harness);
    // Re-derived through the PRODUCTION mint, never a literal: a writer that had
    // stopped deriving from the append count could not reproduce both of these.
    expect(record.started.map((step) => step.stepRef))
      .toEqual([deriveStepRef(digest, 0), deriveStepRef(digest, 1)]);
    expect(record.started.map((step) => step.ordinal)).toEqual([0, 1]);
    // `label` is opaque: it contributes nothing to identity or order.
    expect(record.started.map((step) => step.label)).toEqual(["plan", "write"]);
    expect(record.completed).toEqual([]);
    expect(record.checkpointRef).toBeNull();
  });

  it("gives a caller NO wire channel for an ordering index at all", () => {
    // The allow-list is the structural guarantee; the refusal below is what
    // enforces it. Both are asserted, because a list that stopped being consulted
    // would still read correctly here.
    expect(STEP_START_PAYLOAD_KEYS).not.toContain("ordinal");
    expect(STEP_FINISH_PAYLOAD_KEYS).not.toContain("ordinal");
    const harness = openStepHarness("step-start-no-ordinal");
    expect(refusalOf(start(harness, "cmd-ordinal", "plan", { ordinal: 7 })))
      .toEqual({ code: "STEP_REQUEST_MALFORMED", layer: DAEMON_STEP_LIFECYCLE });
    expect(stepEventCount(harness.store, harness.attempt.record.activationDigest)).toBe(0);
  });

  it("writes truthClass itself and refuses a payload that tries to state one", () => {
    const harness = openStepHarness("step-start-truth-class");
    expect(STEP_START_PAYLOAD_KEYS).not.toContain("truthClass");
    expect(refusalOf(start(harness, "cmd-truth", "plan", { truthClass: "DAEMON_VERIFIED" })))
      .toEqual({ code: "STEP_REQUEST_MALFORMED", layer: DAEMON_STEP_LIFECYCLE });

    expect(start(harness, "cmd-start-ok", "plan").ok).toBe(true);
    // Read OUT of the durable bytes, not off the outcome: the literal the writer
    // wrote is what the record must carry.
    const aggregateId = deriveAttemptStepAggregateId(harness.attempt.record.activationDigest);
    const rows = harness.store.readEvents(aggregateId)
      .map((event) => JSON.parse(new TextDecoder().decode(event.payload)) as unknown);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recordVersion: STEP_RECORD_VERSION, truthClass: "DAEMON_VERIFIED",
    });
  });

  it("forwards the BINDING's own code and layer, unrestamped", () => {
    const harness = openStepHarness("step-start-unbound");
    const outcome = runStepLifecycleCommand(harness.store, requestBytes(
      STEP_START_COMMAND_KIND, harness, "cmd-unbound", {
        attemptAggregateId: harness.attempt.aggregateId, effectId: "intent-nowhere",
        label: "plan",
      }));
    // NOT a step code: a caller naming an effect this daemon never activated is the
    // BINDING reader's judgement, and restamping it would erase which layer knows.
    expect(refusalOf(outcome)).toEqual({
      code: "FOUNDATION_BINDING_NOT_FOUND", layer: "FOUNDATION_ACTIVATION_BINDING",
    });
  });

  it("refuses an attempt aggregate that disagrees with the bound activation", () => {
    const harness = openStepHarness("step-start-mismatch");
    // A SECOND real activation in the SAME store: the caller's effectId binds to
    // attempt one while its attemptAggregateId locates attempt two.
    const other = activate(harness.store, "step-other-attempt");
    const outcome = runStepLifecycleCommand(harness.store, requestBytes(
      STEP_START_COMMAND_KIND, harness, "cmd-mismatch", {
        attemptAggregateId: other.aggregateId,
        effectId: harness.attempt.record.effectIntent.intentId, label: "plan",
      }));
    expect(refusalOf(outcome))
      .toEqual({ code: "STEP_BINDING_MISMATCH", layer: DAEMON_STEP_LIFECYCLE });
  });
});

describe("step.finish — completed state is derived, never adopted", () => {
  it("appends to the ORDERED completed roster in durable finish order", () => {
    const harness = openStepHarness("step-finish-order");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-s1", "plan").ok).toBe(true);
    expect(start(harness, "cmd-s2", "write").ok).toBe(true);
    // Finished SECOND-then-FIRST, so a roster that merely echoed the started order
    // would disagree with this.
    expect(finish(harness, "cmd-f2", deriveStepRef(digest, 1)).ok).toBe(true);
    expect(finish(harness, "cmd-f1", deriveStepRef(digest, 0)).ok).toBe(true);
    expect(durable(harness).completed)
      .toEqual([deriveStepRef(digest, 1), deriveStepRef(digest, 0)]);
    expect(stepEventCount(harness.store, digest)).toBe(4);
  });

  it("refuses a reporter claiming a step the durable evidence never started", () => {
    const harness = openStepHarness("step-finish-not-started");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-only", "plan").ok).toBe(true);
    // Ordinal 1 is a WELL-FORMED server mint — it simply is not in this attempt's
    // durable roster. The claim is refused for want of evidence, not for shape.
    expect(refusalOf(finish(harness, "cmd-bogus", deriveStepRef(digest, 1))))
      .toEqual({ code: "STEP_NOT_STARTED", layer: DAEMON_STEP_LIFECYCLE });
    expect(durable(harness).completed).toEqual([]);
    expect(stepEventCount(harness.store, digest)).toBe(1);
  });

  it("refuses a second finish of the same step", () => {
    const harness = openStepHarness("step-finish-twice");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-s", "plan").ok).toBe(true);
    expect(finish(harness, "cmd-f", deriveStepRef(digest, 0)).ok).toBe(true);
    expect(refusalOf(finish(harness, "cmd-f-again", deriveStepRef(digest, 0))))
      .toEqual({ code: "STEP_ALREADY_FINISHED", layer: DAEMON_STEP_LIFECYCLE });
    expect(durable(harness).completed).toEqual([deriveStepRef(digest, 0)]);
    expect(stepEventCount(harness.store, digest)).toBe(2);
  });
});
