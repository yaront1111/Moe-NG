import type { RuntimeCommandKind } from "@moe/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  DAEMON_STEP_LIFECYCLE, STEP_FINISH_COMMAND_KIND,
  STEP_LIFECYCLE_COMMAND_KINDS, STEP_START_COMMAND_KIND, deriveStepRef,
} from "./step-lifecycle-contracts.js";
import type { StepLifecycleCommandKind } from "./step-lifecycle-contracts.js";
import { openStepHarness, stepEventCount } from "./step-lifecycle-test-harness.js";

/**
 * The real authenticated registry ingress over a file-backed store. The fixture has
 * session evidence but no fabricated activation authority, so valid payloads reach
 * dispatch and preserve the binding reader's exact refusal. Shape and capability
 * cases remain above dispatch and prove those earlier fences still answer first.
 */

afterEach(cleanupRestoreHarnesses);

type Harness = ReturnType<typeof openStepHarness>;
type SeamResult = ReturnType<Harness["send"]>;

function refusalOf(result: SeamResult): {
  code: string; layer: string | null; stage: string;
} {
  if (!("stage" in result)) {
    throw new Error(`expected a seam refusal, received ${JSON.stringify(result)}`);
  }
  const stage = String(result.stage);
  if ("refusal" in result) {
    return { code: result.refusal.code, layer: result.refusal.layer, stage };
  }
  if (!("error" in result)) throw new Error(`no refusal on ${JSON.stringify(result)}`);
  return { code: result.error.code, layer: null, stage };
}

const identity = (harness: Harness): Record<string, unknown> => ({
  attemptAggregateId: harness.attempt.aggregateId,
  effectId: harness.attempt.record.effectIntent.intentId,
});

const payloadFor = (
  harness: Harness, kind: StepLifecycleCommandKind,
): Readonly<Record<string, unknown>> => {
  const digest = harness.attempt.record.activationDigest;
  if (kind === STEP_START_COMMAND_KIND) return { ...identity(harness), label: "plan" };
  if (kind === STEP_FINISH_COMMAND_KIND) {
    return { ...identity(harness), stepRef: deriveStepRef(digest, 0) };
  }
  return { ...identity(harness), nextSafeActionRef: deriveStepRef(digest, 0) };
};

const send = (
  harness: Harness, kind: RuntimeCommandKind, commandId: string,
  payload: Readonly<Record<string, unknown>>, credential = harness.sessionCredential,
): SeamResult => harness.send(commandId, kind, payload, credential);

describe("the step lifecycle is served by the authenticated ingress", () => {
  it("enumerates exactly all three served kinds", () => {
    expect(STEP_LIFECYCLE_COMMAND_KINDS).toHaveLength(3);
    expect([...STEP_LIFECYCLE_COMMAND_KINDS].sort())
      .toEqual(["step.checkpoint", "step.finish", "step.start"]);
  });

  it.each(STEP_LIFECYCLE_COMMAND_KINDS)(
    "%s reaches dispatch, preserves binding refusal, and writes no step row", (kind) => {
      const harness = openStepHarness(`step-seam-unactivated-${kind}`);
      expect(refusalOf(send(
        harness, kind, `cmd-unactivated-${kind}`, payloadFor(harness, kind),
      ))).toEqual({
        code: "FOUNDATION_BINDING_NOT_FOUND",
        layer: "FOUNDATION_ACTIVATION_BINDING",
        stage: "DISPATCH",
      });
      expect(stepEventCount(
        harness.store, harness.attempt.record.activationDigest,
      )).toBe(0);
    },
  );

  it.each(STEP_LIFECYCLE_COMMAND_KINDS)(
    "%s refuses a smuggled key at PAYLOAD_SHAPE, strictly before dispatch", (kind) => {
      const harness = openStepHarness(`step-seam-smuggle-${kind}`);
      expect(refusalOf(send(harness, kind, `cmd-smuggle-${kind}`, {
        ...payloadFor(harness, kind), truthClass: "DAEMON_VERIFIED",
      }))).toEqual({ code: "INPUT_INVALID", layer: null, stage: "PAYLOAD_SHAPE" });
      expect(stepEventCount(harness.store, harness.attempt.record.activationDigest)).toBe(0);
    },
  );

  it.each(STEP_LIFECYCLE_COMMAND_KINDS)(
    "%s is fenced behind work.write, refused above its own layer", (kind) => {
      const harness = openStepHarness(`step-seam-capability-${kind}`);
      const unprivileged = harness.openSession(`session-nocap-${kind}`, ["review.write"]);
      const refused = refusalOf(send(
        harness, kind, `cmd-nocap-${kind}`, payloadFor(harness, kind), unprivileged,
      ));
      expect(refused).toEqual({
        code: "CAPABILITY_DENIED", layer: null, stage: "AUTHORIZE",
      });
      expect(refused.layer).not.toBe(DAEMON_STEP_LIFECYCLE);
      expect(stepEventCount(harness.store, harness.attempt.record.activationDigest)).toBe(0);
    },
  );
});
