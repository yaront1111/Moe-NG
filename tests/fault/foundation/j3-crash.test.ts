/**
 * J3 (crash recovery) fault schedules — design section 18.2 and the transaction
 * boundary catalogue of section 18.3.
 *
 * The store crash boundaries execute for real against the landed
 * SqliteEventStore: a failed commit must leave whole-or-none durable truth, a
 * replayed command id must not double-write, and a stale expected version must
 * be refused rather than merged. Boundaries whose production surface does not
 * exist yet are probed, not assumed.
 */

import { describe, expect, it } from "vitest";

import {
  FOUNDATION_PARTITION_COUNTS,
  foundationPartition,
} from "../../../packages/testkit/src/foundation/foundation-fault-schedule.js";
import {
  J3_CRASH_BOUNDARIES,
  classifyRestartRecord,
  evaluateJ3Continuation,
} from "../../../packages/testkit/src/foundation/foundation-model-j3j4.js";
import {
  J3_EDITED_HISTORY,
  J3_HEALTHY_CONTINUATION,
  J3_RESTART_RECORDS,
} from "../../../packages/testkit/src/foundation/foundation-journey-fixtures.js";
import { passExpected } from "../../../packages/testkit/src/foundation/foundation-outcomes-fixtures.js";
import {
  assertPartitionOwnership,
  executorFor,
  fixturePayload,
  outcomeFromVerdict,
  partitionRows,
  produceAbsenceOutcome,
  produceEvidenceOutcome,
  store,
} from "./foundation-harness.js";
import type { FoundationExecutors } from "./foundation-harness.js";

type OpenedStore = ReturnType<typeof store.SqliteEventStore.openEphemeralForTest>;

const PARTITION = foundationPartition("J3");
const encoder = new TextEncoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

function withStore<TResult>(body: (opened: OpenedStore) => TResult): TResult {
  const opened = store.SqliteEventStore.openEphemeralForTest();
  try {
    return body(opened);
  } finally {
    opened.close();
  }
}

function seed(opened: OpenedStore) {
  return opened.commit({
    aggregateId: "goal-1",
    commandBytes: bytes("first"),
    commandId: "cmd-first",
    committedAt: "2026-08-07T10:00:00.000Z",
    events: [{ eventId: "evt-first", eventType: "goal.created", payload: bytes("first") }],
    expectedVersion: 0,
  });
}

const EXECUTORS: FoundationExecutors = {
  "fixture:j3-restart-record-classes": () => {
    const records = fixturePayload("fixture:j3-restart-record-classes", J3_RESTART_RECORDS);
    // Ordered by restart class, so cover every declared boundary rather than the order.
    expect(records.map((record) => record.boundary).sort()).toEqual([...J3_CRASH_BOUNDARIES].sort());
    expect(records.map(classifyRestartRecord)).toEqual([
      "ADOPTED", "SUSPECT", "QUARANTINED", "RECONCILIATION",
    ]);
    return passExpected();
  },

  "fixture:j3-history-edited-continuation": () =>
    outcomeFromVerdict(
      evaluateJ3Continuation(
        fixturePayload("fixture:j3-history-edited-continuation", J3_EDITED_HISTORY),
      ),
    ),

  "schedule:j3-commit-boundary-whole-or-none": () => withStore((opened) => {
    seed(opened);
    expect(() => opened.commit({
      aggregateId: "goal-1",
      commandBytes: bytes("second"),
      commandId: "cmd-second",
      committedAt: "2026-08-07T10:01:00.000Z",
      events: [
        { eventId: "evt-second", eventType: "goal.updated", payload: bytes("second") },
        { eventId: "evt-first", eventType: "goal.updated", payload: bytes("conflict") },
      ],
      expectedVersion: 1,
    })).toThrowError(store.DurableStoreError);

    // Neither event of the refused commit may survive, and the version must not move.
    expect(opened.getAggregateVersion("goal-1")).toBe(1);
    expect(opened.readEvents("goal-1").map((event) => event.eventId)).toEqual(["evt-first"]);
    expect(opened.getCommandReceipt("cmd-second")).toBeNull();
    return passExpected();
  }),

  "schedule:j3-duplicate-command-id-replays": () => withStore((opened) => {
    const first = seed(opened);
    expect(first.disposition).toBe("COMMITTED");
    const replay = seed(opened);
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.eventIds).toEqual(first.eventIds);
    expect(opened.getAggregateVersion("goal-1")).toBe(1);
    expect(opened.readEvents("goal-1")).toHaveLength(1);
    return passExpected();
  }),

  "schedule:j3-expected-version-conflict-refused": () => withStore((opened) => {
    seed(opened);
    expect(() => opened.commit({
      aggregateId: "goal-1",
      commandBytes: bytes("stale"),
      commandId: "cmd-stale",
      committedAt: "2026-08-07T10:02:00.000Z",
      events: [{ eventId: "evt-stale", eventType: "goal.stale", payload: bytes("stale") }],
      expectedVersion: 0,
    })).toThrowError(store.ExpectedVersionConflictError);
    expect(opened.getAggregateVersion("goal-1")).toBe(1);
    return passExpected();
  }),

  "schedule:j3-restart-record-classification": () => {
    // Whole-or-none is the pivot: an unobserved commit is never adopted, and an
    // unknown external effect never quietly becomes truth.
    expect(J3_CRASH_BOUNDARIES).toHaveLength(4);
    for (const boundary of J3_CRASH_BOUNDARIES) {
      expect(classifyRestartRecord({
        acknowledged: true, boundary, durableCommitObserved: false,
        externalEffectUnknown: false, truthClass: "DAEMON_VERIFIED",
      })).toBe("QUARANTINED");
      expect(classifyRestartRecord({
        acknowledged: true, boundary, durableCommitObserved: true,
        externalEffectUnknown: true, truthClass: "DAEMON_VERIFIED",
      })).toBe("RECONCILIATION");
      expect(classifyRestartRecord({
        acknowledged: true, boundary, durableCommitObserved: true,
        externalEffectUnknown: false, truthClass: "UNKNOWN",
      })).toBe("SUSPECT");
    }
    return passExpected();
  },

  "schedule:j3-healthy-continuation-single-safe-action": () => {
    expect(evaluateJ3Continuation(J3_HEALTHY_CONTINUATION)).toEqual({
      bindingRef: "binding/j3-continuation-1", ok: true,
    });
    expect(evaluateJ3Continuation({ ...J3_HEALTHY_CONTINUATION, safeActions: [] })).toEqual({
      ok: false, refusal: "J3_CONTINUATION_NOT_SINGLE_SAFE_ACTION",
    });
    expect(evaluateJ3Continuation({ ...J3_HEALTHY_CONTINUATION, bindingRef: null })).toEqual({
      ok: false, refusal: "J3_CONTINUATION_WITHOUT_BINDING",
    });
    return passExpected();
  },

  "schedule:j3-outbox-acknowledgement-boundary": (entry) => produceAbsenceOutcome(entry),
  "schedule:j3-attempt-restart-adoption": (entry) => produceAbsenceOutcome(entry),
  "incident:terminal-release-cannot-resurrect": (entry) => produceAbsenceOutcome(entry),
  "incident:release-handoff-atomicity": (entry) => produceAbsenceOutcome(entry),
  "incident:timer-callback-reentrancy": (entry) => produceAbsenceOutcome(entry),

  "schedule:j3-total-storage-loss-rpo": (entry) => produceEvidenceOutcome(entry),
};

describe("J3 crash recovery fault schedules", () => {
  it("owns exactly the J3 manifest partition", () => {
    assertPartitionOwnership(PARTITION, EXECUTORS, FOUNDATION_PARTITION_COUNTS.J3);
  });

  it.each(partitionRows(PARTITION))("%s produces its declared outcome", (entryId, entry) => {
    expect(executorFor(EXECUTORS, entryId)(entry)).toEqual(entry.outcome);
  });
});
