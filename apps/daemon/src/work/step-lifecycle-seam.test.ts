import type { RuntimeCommandKind } from "@moe/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import {
  DAEMON_STEP_LIFECYCLE, STEP_CHECKPOINT_COMMAND_KIND, STEP_FINISH_COMMAND_KIND,
  STEP_LIFECYCLE_COMMAND_KINDS, STEP_START_COMMAND_KIND, deriveStepRef,
} from "./step-lifecycle-contracts.js";
import { readCurrentAttemptStepRecord } from "./step-lifecycle-reader.js";
import { openStepHarness, stepEventCount } from "./step-lifecycle-test-harness.js";

/**
 * The step lifecycle through the REAL registry ingress: `handleCommandRequest` over
 * the real session authenticator, the real registry and a file-backed
 * SqliteEventStore holding an activation the production ingress committed.
 *
 * The sibling suites drive the writer directly to isolate its own judgements. This
 * one proves the wiring: that an authenticated agent session holding work.write can
 * record a between-step boundary end to end, that the capability fence and the
 * payload allow-list stand in front of it, and that a smuggled key is REFUSED at the
 * seam rather than trimmed on the way through.
 */

afterEach(cleanupRestoreHarnesses);

type Harness = ReturnType<typeof openStepHarness>;
type SeamResult = ReturnType<Harness["send"]>;

/**
 * The seam answers in TWO shapes and the difference is the point: a refusal decided
 * BEFORE dispatch carries `error.code` with no layer at all, while a PORT_REFUSED
 * answer carries `refusal.code` plus the layer that actually answered. Collapsing
 * them would let an arm claiming "the seam stopped it" pass on a daemon-layer refusal.
 */
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

const send = (
  harness: Harness, kind: RuntimeCommandKind, commandId: string,
  payload: Readonly<Record<string, unknown>>, credential = harness.sessionCredential,
): SeamResult => harness.send(commandId, kind, { ...identity(harness), ...payload }, credential);

describe("the step lifecycle is served by the authenticated ingress", () => {
  it("records a whole boundary journey through handleCommandRequest", () => {
    const harness = openStepHarness("step-seam-journey");
    const digest = harness.attempt.record.activationDigest;
    expect(send(harness, STEP_START_COMMAND_KIND, "cmd-seam-s0", { label: "plan" }))
      .toMatchObject({ decision: { disposition: "DECIDED" }, httpStatus: 200, ok: true,
        outcome: "ACCEPTED" });
    expect(send(harness, STEP_START_COMMAND_KIND, "cmd-seam-s1", { label: "write" }).ok)
      .toBe(true);
    expect(send(harness, STEP_FINISH_COMMAND_KIND, "cmd-seam-f0",
      { stepRef: deriveStepRef(digest, 0) }).ok).toBe(true);
    expect(send(harness, STEP_CHECKPOINT_COMMAND_KIND, "cmd-seam-cp",
      { nextSafeActionRef: deriveStepRef(digest, 1) }).ok).toBe(true);
    expect(stepEventCount(harness.store, digest)).toBe(4);

    const answer = readCurrentAttemptStepRecord(harness.store, digest, PROJECT_ID);
    if (!answer.ok) throw new Error(`the durable reader refused: ${answer.code}`);
    expect(answer.startedSteps.map((step) => step.stepRef))
      .toEqual([deriveStepRef(digest, 0), deriveStepRef(digest, 1)]);
    expect(answer.completedSteps).toEqual([deriveStepRef(digest, 0)]);
    // THE PRODUCED FACT: a step-scoped next safe action, minted server-side, that
    // task-d9842aae reads as `nextSafeAction`. Nothing in this repo produced one before.
    expect(answer.checkpointRef).toBe(deriveStepRef(digest, 1));
  });

  // A sweep over an empty kind list would pass every case below vacuously.
  it("sweeps all three served kinds", () => {
    expect(STEP_LIFECYCLE_COMMAND_KINDS).toHaveLength(3);
    expect([...STEP_LIFECYCLE_COMMAND_KINDS].sort())
      .toEqual(["step.checkpoint", "step.finish", "step.start"]);
  });

  it.each(STEP_LIFECYCLE_COMMAND_KINDS)(
    "%s refuses a smuggled key at PAYLOAD_SHAPE, strictly before dispatch", (kind) => {
      const harness = openStepHarness(`step-seam-smuggle-${kind}`);
      // `truthClass` is precisely the claim the daemon must never adopt. Stage is the
      // assertion that matters: PAYLOAD_SHAPE sits BEFORE dispatch, so the key never
      // reaches the writer at all. A DISPATCH-stage answer would mean the daemon was
      // defending a key the seam should already have refused.
      expect(refusalOf(send(harness, kind, `cmd-smuggle-${kind}`, {
        label: "plan", nextSafeActionRef: "x", ordinal: 0, stepRef: "x",
        truthClass: "DAEMON_VERIFIED",
      }))).toEqual({ code: "INPUT_INVALID", layer: null, stage: "PAYLOAD_SHAPE" });
      expect(stepEventCount(harness.store, harness.attempt.record.activationDigest)).toBe(0);
    });

  it.each(STEP_LIFECYCLE_COMMAND_KINDS)(
    "%s is fenced behind work.write, refused above its own layer", (kind) => {
      const harness = openStepHarness(`step-seam-capability-${kind}`);
      // A REAL session that authenticates and holds review.write only.
      const unprivileged = harness.openSession(`session-nocap-${kind}`, ["review.write"]);
      const refused = refusalOf(send(harness, kind, `cmd-nocap-${kind}`, {
        label: "plan", nextSafeActionRef: deriveStepRef(
          harness.attempt.record.activationDigest, 0),
        stepRef: deriveStepRef(harness.attempt.record.activationDigest, 0),
      }, unprivileged));
      // NOT this family's code, and NOT the dispatch stage: the capability fence
      // answers ABOVE the writer, so `layer` is null because nothing downstream was
      // consulted. A DAEMON_STEP_LIFECYCLE refusal here would mean the request had
      // reached the writer despite holding no work authority.
      expect(refused).toEqual({
        code: "CAPABILITY_DENIED", layer: null, stage: "AUTHORIZE",
      });
      expect(refused.layer).not.toBe(DAEMON_STEP_LIFECYCLE);
      expect(stepEventCount(harness.store, harness.attempt.record.activationDigest)).toBe(0);
    });
});
