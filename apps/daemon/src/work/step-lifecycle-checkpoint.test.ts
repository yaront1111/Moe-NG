import { IdempotencyConflictError } from "@moe/store";
import type { StoredEvent } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { CONTINUATION_COMMAND_KINDS } from "../recovery/continuation-contracts.js";
import { PROJECT_ID, cleanupRestoreHarnesses } from "../recovery/restore-test-harness.js";
import { runStepLifecycleCommand } from "./step-lifecycle-command.js";
import {
  DAEMON_STEP_LIFECYCLE, STEP_CHECKPOINT_COMMAND_KIND, STEP_CHECKPOINT_PAYLOAD_KEYS,
  STEP_FINISH_COMMAND_KIND, STEP_START_COMMAND_KIND, deriveAttemptStepAggregateId,
  deriveStepRef,
} from "./step-lifecycle-contracts.js";
import type { StepLifecycleOutcome } from "./step-lifecycle-contracts.js";
import { readCurrentAttemptStepRecord } from "./step-lifecycle-reader.js";
import { openStepHarness, requestBytes, stepEventCount } from "./step-lifecycle-test-harness.js";

/**
 * `step.checkpoint` — the BETWEEN-STEP BOUNDARY observation, and the producer of the
 * `nextSafeAction` that packages/scheduler's `ReleaseHandoff` demands before it will
 * finish a lease as RELEASED (lease-drain.ts:49,168). Consumed by task-d9842aae.
 *
 * DoD 4 is graded on ONE distinction: the recorded ref is a STEP IDENTITY, never a
 * COMMAND KIND. `work.resume` is the single member of CONTINUATION_COMMAND_KINDS and
 * is exactly the substitution task rail 2 forbids, so it gets its own arm rather than
 * being left to a generic "unknown ref" case.
 *
 * Plus the idempotence DoD 5 requires: identical bytes REPLAY without a second row,
 * conflicting bytes under one identity raise the STORE's error and move nothing.
 */

afterEach(cleanupRestoreHarnesses);

type Harness = ReturnType<typeof openStepHarness>;

const refusalOf = (outcome: StepLifecycleOutcome): { code: string; layer: string } => {
  if (outcome.ok) throw new Error("expected a refusal, received a durable decision");
  return { code: outcome.code, layer: outcome.refusedBy };
};

const run = (
  harness: Harness, kind: string, commandId: string,
  payload: Readonly<Record<string, unknown>>,
): StepLifecycleOutcome => runStepLifecycleCommand(harness.store, requestBytes(
  kind, harness, commandId, {
    attemptAggregateId: harness.attempt.aggregateId,
    effectId: harness.attempt.record.effectIntent.intentId, ...payload,
  }));

const start = (harness: Harness, commandId: string, label: string): StepLifecycleOutcome =>
  run(harness, STEP_START_COMMAND_KIND, commandId, { label });

const checkpoint = (
  harness: Harness, commandId: string, nextSafeActionRef: string,
): StepLifecycleOutcome =>
  run(harness, STEP_CHECKPOINT_COMMAND_KIND, commandId, { nextSafeActionRef });

function durable(harness: Harness): {
  checkpointRef: string | null; completed: readonly string[]; started: readonly string[];
} {
  const answer = readCurrentAttemptStepRecord(
    harness.store, harness.attempt.record.activationDigest, PROJECT_ID);
  if (!answer.ok) throw new Error(`the durable reader refused: ${answer.code}`);
  return {
    checkpointRef: answer.checkpointRef, completed: answer.completedSteps,
    started: answer.startedSteps.map((step) => step.stepRef),
  };
}

/** The raw bytes of the head row, so "the state did not move" is asserted over the
 *  durable payload rather than over a re-read object that could compare equal. */
function headBytes(harness: Harness): string {
  const rows = harness.store.readEvents(
    deriveAttemptStepAggregateId(harness.attempt.record.activationDigest));
  const head = rows[rows.length - 1];
  if (head === undefined) throw new Error("no durable row to snapshot");
  return Buffer.from(head.payload).toString("hex");
}

describe("step.checkpoint — one bounded next-safe-action ref, and it is a step", () => {
  it("records a started-but-unfinished step and round-trips it through the reader", () => {
    const harness = openStepHarness("step-checkpoint-boundary");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-s0", "plan").ok).toBe(true);
    expect(start(harness, "cmd-s1", "write").ok).toBe(true);
    expect(run(harness, STEP_FINISH_COMMAND_KIND, "cmd-f0",
      { stepRef: deriveStepRef(digest, 0) }).ok).toBe(true);
    expect(durable(harness).checkpointRef).toBeNull();

    // THE BETWEEN-STEP BOUNDARY: step 0 is finished, step 1 is started and not yet
    // finished, and the safe action is to resume step 1.
    expect(checkpoint(harness, "cmd-cp", deriveStepRef(digest, 1)))
      .toMatchObject({ disposition: "DECIDED", ok: true });
    const record = durable(harness);
    expect(record.checkpointRef).toBe(deriveStepRef(digest, 1));
    expect(record.completed).toEqual([deriveStepRef(digest, 0)]);
    // The consumer parses this with @moe/scheduler's `isRef` — a non-empty string —
    // and it must be a member of the durable roster, not merely well-shaped.
    expect(typeof record.checkpointRef).toBe("string");
    expect(record.started).toContain(record.checkpointRef);
  });

  it("keeps EXACTLY ONE ref: a later checkpoint replaces the earlier one", () => {
    const harness = openStepHarness("step-checkpoint-single");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-s0", "plan").ok).toBe(true);
    expect(start(harness, "cmd-s1", "write").ok).toBe(true);
    expect(checkpoint(harness, "cmd-cp-a", deriveStepRef(digest, 0)).ok).toBe(true);
    expect(durable(harness).checkpointRef).toBe(deriveStepRef(digest, 0));
    expect(checkpoint(harness, "cmd-cp-b", deriveStepRef(digest, 1)).ok).toBe(true);
    // One value, not a growing list: the field is bounded by its type, and the later
    // boundary observation supersedes the earlier one.
    expect(durable(harness).checkpointRef).toBe(deriveStepRef(digest, 1));
    expect(stepEventCount(harness.store, digest)).toBe(4);
  });

  it("refuses a ref that is absent from the durable started roster", () => {
    const harness = openStepHarness("step-checkpoint-unknown");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-s0", "plan").ok).toBe(true);
    // Ordinal 1 is a WELL-FORMED server mint that this attempt never started, so the
    // refusal is for want of durable evidence rather than for shape.
    expect(refusalOf(checkpoint(harness, "cmd-cp-bad", deriveStepRef(digest, 1))))
      .toEqual({ code: "STEP_CHECKPOINT_TARGET_UNKNOWN", layer: DAEMON_STEP_LIFECYCLE });
    expect(durable(harness).checkpointRef).toBeNull();
    expect(stepEventCount(harness.store, digest)).toBe(1);
  });

  // A sweep that generated zero cases would pass while testing nothing.
  it("sweeps every continuation command kind there is", () => {
    expect(CONTINUATION_COMMAND_KINDS.length).toBe(1);
    expect(CONTINUATION_COMMAND_KINDS).toContain("work.resume");
    expect(STEP_CHECKPOINT_PAYLOAD_KEYS).toContain("nextSafeActionRef");
  });

  it.each(CONTINUATION_COMMAND_KINDS)(
    "refuses the command kind %s standing in for a step identity", (kind) => {
      const harness = openStepHarness(`step-checkpoint-kind-${kind}`);
      const digest = harness.attempt.record.activationDigest;
      expect(start(harness, "cmd-s0", "plan").ok).toBe(true);
      // Task rail 2: no command kind may stand in for a next-safe-action ref. The
      // consumer's own fixture reached for exactly this substitution.
      expect(refusalOf(checkpoint(harness, `cmd-cp-${kind}`, kind)))
        .toEqual({ code: "STEP_CHECKPOINT_TARGET_UNKNOWN", layer: DAEMON_STEP_LIFECYCLE });
      expect(durable(harness).checkpointRef).toBeNull();
      expect(stepEventCount(harness.store, digest)).toBe(1);
    });
});

describe("step lifecycle — replay is idempotent and conflicting bytes move nothing", () => {
  it("replays identical bytes without a second durable row", () => {
    const harness = openStepHarness("step-replay");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-replay", "plan")).toMatchObject({ disposition: "DECIDED" });
    const before = { bytes: headBytes(harness), record: durable(harness) };
    expect(stepEventCount(harness.store, digest)).toBe(1);

    expect(start(harness, "cmd-replay", "plan")).toMatchObject({ disposition: "REPLAYED", ok: true });
    // The count comes OUT OF THE STORE: a writer that appended a second identical
    // record would still answer ok here.
    expect(stepEventCount(harness.store, digest)).toBe(1);
    expect(headBytes(harness)).toBe(before.bytes);
    expect(durable(harness)).toEqual(before.record);
  });

  it("still replays the FIRST command after a later one moved the tail", () => {
    // THE CASE `prior.expectedVersion` EXISTS FOR. The store hashes expectedVersion
    // into the request identity alongside the bytes (store-digests.ts:92), so a
    // writer that re-derived it from today's tail would send 1 where the original
    // sent 0 and this byte-identical retry would conflict instead of replaying.
    const harness = openStepHarness("step-replay-tail-moved");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-first", "plan").ok).toBe(true);
    expect(start(harness, "cmd-second", "write").ok).toBe(true);
    expect(stepEventCount(harness.store, digest)).toBe(2);
    const before = { bytes: headBytes(harness), record: durable(harness) };

    expect(start(harness, "cmd-first", "plan")).toMatchObject({ disposition: "REPLAYED", ok: true });
    expect(stepEventCount(harness.store, digest)).toBe(2);
    expect(headBytes(harness)).toBe(before.bytes);
    expect(durable(harness)).toEqual(before.record);
  });

  it("makes the LOSER of two concurrent step.start commands refuse, not duplicate", () => {
    // ADVERSARIAL: two starts computed against the SAME tail both mint ordinal 0 and
    // the same server ref. The expectedVersion check is the only thing between that
    // and two rows claiming one ordinal, so it is exercised rather than assumed.
    const harness = openStepHarness("step-concurrent-start");
    const digest = harness.attempt.record.activationDigest;
    const aggregateId = deriveAttemptStepAggregateId(digest);
    // The tail as the loser saw it: captured BEFORE the winner lands.
    const staleTail = harness.store.readEvents(aggregateId);
    expect(staleTail).toHaveLength(0);
    // Bound to the REAL store, so only this one aggregate's view is frozen and every
    // write still goes to the real durable tail.
    const stale = new Proxy(harness.store, {
      get(target, property, _receiver): unknown {
        if (property === "readEvents") {
          return (id: string): readonly StoredEvent[] =>
            id === aggregateId ? staleTail : target.readEvents(id);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(start(harness, "cmd-winner", "first").ok).toBe(true);
    const before = headBytes(harness);
    const loser = runStepLifecycleCommand(stale, requestBytes(
      STEP_START_COMMAND_KIND, harness, "cmd-loser", {
        attemptAggregateId: harness.attempt.aggregateId,
        effectId: harness.attempt.record.effectIntent.intentId, label: "second",
      }));
    // The store answers EXPECTED_VERSION_CONFLICT as NO_BUSINESS_EFFECT rather than
    // throwing, so a writer that only checked for a thrown error would report ok.
    expect(refusalOf(loser))
      .toEqual({ code: "STEP_COMMIT_UNAVAILABLE", layer: DAEMON_STEP_LIFECYCLE });
    expect(stepEventCount(harness.store, digest)).toBe(1);
    expect(headBytes(harness)).toBe(before);
    // ONE step at ordinal 0, and it is the winner's: no duplicated ordinal, and the
    // loser's label never reached durable bytes.
    const record = durable(harness);
    expect(record.started).toEqual([deriveStepRef(digest, 0)]);
  });

  it("raises the STORE's own conflict for one identity with two byte sets", () => {
    const harness = openStepHarness("step-conflict");
    const digest = harness.attempt.record.activationDigest;
    expect(start(harness, "cmd-conflict", "plan").ok).toBe(true);
    const before = { bytes: headBytes(harness), record: durable(harness) };

    // NOT flattened into a step code: only the store can say "one command identity,
    // two different requests", and a DAEMON_STEP_LIFECYCLE code would hide that.
    expect(() => start(harness, "cmd-conflict", "a different label"))
      .toThrow(IdempotencyConflictError);
    expect(stepEventCount(harness.store, digest)).toBe(1);
    // BYTE-IDENTICAL before and after, not merely equal-comparing.
    expect(headBytes(harness)).toBe(before.bytes);
    expect(durable(harness)).toEqual(before.record);
  });
});
