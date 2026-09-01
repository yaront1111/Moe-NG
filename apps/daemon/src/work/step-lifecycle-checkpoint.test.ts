import { afterEach, describe, expect, it } from "vitest";

import { CONTINUATION_COMMAND_KINDS } from "../recovery/continuation-contracts.js";
import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import type { StepLifecycleRequest } from "./step-lifecycle-codec.js";
import { applyStepTransition, runStepLifecycleCommand } from "./step-lifecycle-command.js";
import {
  DAEMON_STEP_LIFECYCLE, STEP_CHECKPOINT_COMMAND_KIND, STEP_CHECKPOINT_PAYLOAD_KEYS,
  STEP_FINISH_COMMAND_KIND, STEP_START_COMMAND_KIND, deriveStepRef,
} from "./step-lifecycle-contracts.js";
import type {
  StepLifecycleCommandKind, StepLifecycleOutcome,
} from "./step-lifecycle-contracts.js";
import { openStepHarness, requestBytes, stepEventCount } from "./step-lifecycle-test-harness.js";

/**
 * The old accepted world exercised checkpoint journey, replacement, unknown-ref,
 * command-kind substitution, replay, replay-after-tail, concurrency, and conflict
 * groups. None is constructible without a committed activation. Each named group is
 * retained below as a real-writer first-fence/no-write case, while the pure production
 * reducer separately proves the downstream checkpoint distinctions remain intact.
 */

afterEach(cleanupRestoreHarnesses);

type Harness = ReturnType<typeof openStepHarness>;
type CommandSpec = {
  readonly commandId: string;
  readonly kind: StepLifecycleCommandKind;
  readonly payload: Readonly<Record<string, unknown>>;
};

const bindingRefusal = (kind: StepLifecycleCommandKind): StepLifecycleOutcome => Object.freeze({
  advisoryOnly: true, authority: "NONE", code: "FOUNDATION_BINDING_NOT_FOUND",
  error: null, kind, ok: false, refusedBy: "FOUNDATION_ACTIVATION_BINDING",
});

const identity = (harness: Harness): {
  readonly attemptAggregateId: string; readonly effectId: string;
} => ({
  attemptAggregateId: harness.attempt.aggregateId,
  effectId: harness.attempt.record.effectIntent.intentId,
});

const start = (harness: Harness, commandId: string, label: string): CommandSpec => ({
  commandId, kind: STEP_START_COMMAND_KIND, payload: { ...identity(harness), label },
});

const finish = (harness: Harness, commandId: string, stepRef: string): CommandSpec => ({
  commandId, kind: STEP_FINISH_COMMAND_KIND, payload: { ...identity(harness), stepRef },
});

const checkpoint = (
  harness: Harness, commandId: string, nextSafeActionRef: string,
): CommandSpec => ({
  commandId, kind: STEP_CHECKPOINT_COMMAND_KIND,
  payload: { ...identity(harness), nextSafeActionRef },
});

const retiredScenarios = [
  { name: "checkpoint journey", commands: (harness: Harness): readonly CommandSpec[] => {
    const digest = harness.attempt.record.activationDigest;
    return [start(harness, "cmd-j-s0", "plan"), start(harness, "cmd-j-s1", "write"),
      finish(harness, "cmd-j-f0", deriveStepRef(digest, 0)),
      checkpoint(harness, "cmd-j-cp", deriveStepRef(digest, 1))];
  } },
  { name: "checkpoint replacement", commands: (harness: Harness): readonly CommandSpec[] => {
    const ref = deriveStepRef(harness.attempt.record.activationDigest, 0);
    return [start(harness, "cmd-r-s0", "plan"), checkpoint(harness, "cmd-r-a", ref),
      checkpoint(harness, "cmd-r-b", ref)];
  } },
  { name: "unknown ref", commands: (harness: Harness): readonly CommandSpec[] => [
    checkpoint(harness, "cmd-unknown",
      deriveStepRef(harness.attempt.record.activationDigest, 7)),
  ] },
  { name: "command-kind substitution", commands: (harness: Harness): readonly CommandSpec[] => [
    checkpoint(harness, "cmd-kind-substitution", "work.resume"),
  ] },
  { name: "replay", commands: (harness: Harness): readonly CommandSpec[] => [
    start(harness, "cmd-replay", "plan"), start(harness, "cmd-replay", "plan"),
  ] },
  { name: "replay after tail", commands: (harness: Harness): readonly CommandSpec[] => [
    start(harness, "cmd-tail-first", "plan"), start(harness, "cmd-tail-second", "write"),
    start(harness, "cmd-tail-first", "plan"),
  ] },
  { name: "concurrency", commands: (harness: Harness): readonly CommandSpec[] => [
    start(harness, "cmd-winner", "first"), start(harness, "cmd-loser", "second"),
  ] },
  { name: "conflict", commands: (harness: Harness): readonly CommandSpec[] => [
    start(harness, "cmd-conflict", "plan"),
    start(harness, "cmd-conflict", "different bytes"),
  ] },
] as const;

describe("step checkpoint accepted-world replacements", () => {
  it("enumerates exactly the eight retired accepted groups", () => {
    expect(retiredScenarios).toHaveLength(8);
    expect(retiredScenarios.map(({ name }) => name)).toEqual([
      "checkpoint journey", "checkpoint replacement", "unknown ref",
      "command-kind substitution", "replay", "replay after tail", "concurrency", "conflict",
    ]);
  });

  it.each(retiredScenarios)("$name stops at binding and writes nothing", ({ name, commands }) => {
    const harness = openStepHarness(`step-retired-${name.replaceAll(" ", "-")}`);
    const generated = commands(harness);
    expect(generated.length).toBeGreaterThan(0);
    for (const { commandId, kind, payload } of generated) {
      expect(runStepLifecycleCommand(
        harness.store, requestBytes(kind, harness, commandId, payload),
      )).toEqual(bindingRefusal(kind));
      expect(harness.store.getCommandDecision({
        commandId, principalId: harness.attempt.sessionId, projectId: PROJECT_ID,
      })).toBeNull();
    }
    expect(stepEventCount(
      harness.store, harness.attempt.record.activationDigest,
    )).toBe(0);
  });
});

function checkpointRequest(harness: Harness, nextSafeActionRef: string): StepLifecycleRequest {
  return {
    ...identity(harness), commandId: "cmd-reducer", correlationId: "corr-reducer",
    decidedAt: "2026-08-15T00:00:00.000Z", kind: STEP_CHECKPOINT_COMMAND_KIND,
    nextSafeActionRef, principalId: harness.attempt.sessionId, projectId: PROJECT_ID,
  };
}

describe("step checkpoint independently reachable reducer controls", () => {
  it("distinguishes a roster member from an unknown ref on the production reducer", () => {
    const harness = openStepHarness("step-checkpoint-reducer");
    const digest = harness.attempt.record.activationDigest;
    const stepRef = deriveStepRef(digest, 0);
    const prior = Object.freeze({
      checkpointRef: null, completedSteps: Object.freeze([]),
      startedSteps: Object.freeze([{ label: "plan", ordinal: 0, stepRef }]),
    });
    const accepted = applyStepTransition(checkpointRequest(harness, stepRef), prior, digest);
    if ("ok" in accepted) throw new Error(`member refused: ${accepted.code}`);
    expect(accepted.checkpointRef).toBe(stepRef);

    expect(applyStepTransition(
      checkpointRequest(harness, deriveStepRef(digest, 1)), prior, digest,
    )).toEqual({
      advisoryOnly: true, authority: "NONE", code: "STEP_CHECKPOINT_TARGET_UNKNOWN",
      error: null, kind: STEP_CHECKPOINT_COMMAND_KIND, ok: false,
      refusedBy: DAEMON_STEP_LIFECYCLE,
    });
  });

  it("enumerates every continuation kind and refuses each as a step identity", () => {
    expect(CONTINUATION_COMMAND_KINDS).toHaveLength(1);
    expect(CONTINUATION_COMMAND_KINDS).toEqual(["work.resume"]);
    expect(STEP_CHECKPOINT_PAYLOAD_KEYS)
      .toEqual(["attemptAggregateId", "effectId", "nextSafeActionRef"]);
    const harness = openStepHarness("step-checkpoint-continuation-kinds");
    const digest = harness.attempt.record.activationDigest;
    const stepRef = deriveStepRef(digest, 0);
    const prior = Object.freeze({
      checkpointRef: null, completedSteps: Object.freeze([]),
      startedSteps: Object.freeze([{ label: "plan", ordinal: 0, stepRef }]),
    });
    for (const kind of CONTINUATION_COMMAND_KINDS) {
      expect(applyStepTransition(checkpointRequest(harness, kind), prior, digest)).toEqual({
        advisoryOnly: true, authority: "NONE", code: "STEP_CHECKPOINT_TARGET_UNKNOWN",
        error: null, kind: STEP_CHECKPOINT_COMMAND_KIND, ok: false,
        refusedBy: DAEMON_STEP_LIFECYCLE,
      });
    }
  });
});
