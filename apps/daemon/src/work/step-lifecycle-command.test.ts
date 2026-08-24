import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import { decodeStepRequest } from "./step-lifecycle-codec.js";
import type { StepLifecycleRequest } from "./step-lifecycle-codec.js";
import { applyStepTransition, runStepLifecycleCommand } from "./step-lifecycle-command.js";
import {
  STEP_CHECKPOINT_COMMAND_KIND, STEP_FINISH_COMMAND_KIND, STEP_FINISH_PAYLOAD_KEYS,
  STEP_LIFECYCLE_COMMAND_KINDS, STEP_START_COMMAND_KIND, STEP_START_PAYLOAD_KEYS,
  deriveStepRef,
} from "./step-lifecycle-contracts.js";
import type {
  StepLifecycleCommandKind, StepLifecycleOutcome,
} from "./step-lifecycle-contracts.js";
import { openStepHarness, requestBytes, stepEventCount } from "./step-lifecycle-test-harness.js";

/**
 * No task-local helper can manufacture a committed activation. These writer tests
 * therefore drive the real file-backed store from its honest unactivated state.
 * Independently reachable codec/reducer behavior remains covered below, while the
 * writer pins the first production fence and proves it writes neither an event nor
 * a command decision.
 */

afterEach(cleanupRestoreHarnesses);

type Harness = ReturnType<typeof openStepHarness>;

const EMPTY_ROSTER = Object.freeze({
  checkpointRef: null,
  completedSteps: Object.freeze([]),
  startedSteps: Object.freeze([]),
});

const bindingRefusal = (kind: StepLifecycleCommandKind): StepLifecycleOutcome => Object.freeze({
  advisoryOnly: true, authority: "NONE", code: "FOUNDATION_BINDING_NOT_FOUND",
  error: null, kind, ok: false, refusedBy: "FOUNDATION_ACTIVATION_BINDING",
});

function decodedRequest(bytes: Uint8Array): StepLifecycleRequest {
  const decoded = decodeStepRequest(bytes);
  if ("ok" in decoded) throw new Error(`valid case failed to decode: ${decoded.code}`);
  return decoded;
}

function downstreamAnswer(request: StepLifecycleRequest, activationDigest: string): string {
  const next = applyStepTransition(request, EMPTY_ROSTER, activationDigest);
  if ("ok" in next) return `${next.code}@${next.refusedBy}`;
  return `STARTED:${next.startedSteps.length}`;
}

const writerCases = (harness: Harness) => {
  const digest = harness.attempt.record.activationDigest;
  const identity = {
    attemptAggregateId: harness.attempt.aggregateId,
    effectId: harness.attempt.record.effectIntent.intentId,
  };
  return [
    { commandId: "cmd-start", downstream: "STARTED:1", kind: STEP_START_COMMAND_KIND,
      payload: { ...identity, label: "plan" } },
    { commandId: "cmd-finish", downstream: "STEP_NOT_STARTED@DAEMON_STEP_LIFECYCLE",
      kind: STEP_FINISH_COMMAND_KIND,
      payload: { ...identity, stepRef: deriveStepRef(digest, 0) } },
    { commandId: "cmd-checkpoint",
      downstream: "STEP_CHECKPOINT_TARGET_UNKNOWN@DAEMON_STEP_LIFECYCLE",
      kind: STEP_CHECKPOINT_COMMAND_KIND,
      payload: { ...identity, nextSafeActionRef: deriveStepRef(digest, 0) } },
  ] as const;
};

describe("step lifecycle writer — honest unactivated world", () => {
  it("enumerates exactly the three served kinds", () => {
    const harness = openStepHarness("step-writer-roster");
    const cases = writerCases(harness);
    expect(cases).toHaveLength(3);
    expect(cases.map(({ kind }) => kind).sort())
      .toEqual(["step.checkpoint", "step.finish", "step.start"]);
    expect([...STEP_LIFECYCLE_COMMAND_KINDS].sort())
      .toEqual(cases.map(({ kind }) => kind).sort());
  });

  it("distinguishes all downstream inputs, then refuses each at the real binding fence", () => {
    const harness = openStepHarness("step-writer-first-fence");
    const digest = harness.attempt.record.activationDigest;
    const cases = writerCases(harness);
    const downstream = cases.map(({ commandId, downstream: expected, kind, payload }) => {
      const bytes = requestBytes(kind, harness, commandId, payload);
      const answer = downstreamAnswer(decodedRequest(bytes), digest);
      expect(answer).toBe(expected);
      expect(runStepLifecycleCommand(harness.store, bytes)).toEqual(bindingRefusal(kind));
      expect(harness.store.getCommandDecision({
        commandId, principalId: harness.attempt.sessionId, projectId: PROJECT_ID,
      })).toBeNull();
      expect(stepEventCount(harness.store, digest)).toBe(0);
      return answer;
    });
    expect(downstream).toHaveLength(3);
    expect(new Set(downstream).size).toBe(3);
  });
});

describe("step lifecycle writer — caller authority channels", () => {
  const smuggledCases = [
    { key: "ordinal", value: 7 },
    { key: "truthClass", value: "DAEMON_VERIFIED" },
  ] as const;

  it("enumerates the two forbidden start claims outside every payload roster", () => {
    expect(smuggledCases).toHaveLength(2);
    expect(smuggledCases.map(({ key }) => key)).toEqual(["ordinal", "truthClass"]);
    expect(STEP_START_PAYLOAD_KEYS).not.toContain("ordinal");
    expect(STEP_START_PAYLOAD_KEYS).not.toContain("truthClass");
    expect(STEP_FINISH_PAYLOAD_KEYS).not.toContain("ordinal");
  });

  it.each(smuggledCases)(
    "refuses caller-supplied $key before the binding reader", ({ key, value }) => {
      const harness = openStepHarness(`step-smuggled-${key}`);
      const commandId = `cmd-smuggled-${key}`;
      const bytes = requestBytes(STEP_START_COMMAND_KIND, harness, commandId, {
        attemptAggregateId: harness.attempt.aggregateId,
        effectId: harness.attempt.record.effectIntent.intentId,
        label: "plan", [key]: value,
      });
      expect(runStepLifecycleCommand(harness.store, bytes)).toEqual({
        advisoryOnly: true, authority: "NONE", code: "STEP_REQUEST_MALFORMED",
        error: null, kind: null, ok: false, refusedBy: "DAEMON_STEP_LIFECYCLE",
      });
      expect(harness.store.getCommandDecision({
        commandId, principalId: harness.attempt.sessionId, projectId: PROJECT_ID,
      })).toBeNull();
      expect(stepEventCount(harness.store, harness.attempt.record.activationDigest)).toBe(0);
    },
  );
});
