import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readContinuationBindings } from "./continuation-service.js";
import {
  ABSENT,
  PROJECT_ID,
  closeOpenStores,
  decisions,
  run,
  seed,
  snapshot,
  store,
} from "./continuation-test-harness.js";
import {
  readReconciliationRecords,
  reconciliationAggregateId,
} from "./restart-reconciliation.js";

afterEach(closeOpenStores);

/**
 * Every durable row on the interrupted attempt's OWN aggregate, byte for byte.
 *
 * Keyed by target aggregate rather than by command kind, and the aggregate id
 * comes from production rather than a literal restated here. A mutation drill
 * proved why: pointing the continuation's write at the attempt's aggregate
 * survived a kind-keyed filter, because the row carried the continuation's kind.
 * A write into the attempt's history is a write into the attempt's history
 * whatever kind it is filed under.
 */
function attemptHistory(opened: SqliteEventStore, attemptRef: string): string {
  const aggregateId = reconciliationAggregateId(attemptRef);
  return JSON.stringify(
    decisions(opened)
      .filter((entry) => entry.targetAggregateId === aggregateId)
      .map((entry) => [entry.commandKind, entry.currentVersion, [...entry.resultBytes]]),
  );
}

describe("continuation creates a binding, not edited history", () => {
  it("leaves the pre-crash record byte-identical and records the continuation as a successor", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);

    const priorRecord = readReconciliationRecords(opened, PROJECT_ID).get("attempt-absent");
    const priorRecordBytes = JSON.stringify(priorRecord);
    const priorHistory = attemptHistory(opened, "attempt-absent");
    expect(priorRecord?.classification).toBe("ABSENT");

    const outcome = run(opened);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // BYTE-IDENTICAL, both ways it could be broken: the record as read back, and
    // the durable rows it was read from. "A new record appeared" would pass
    // against an in-place rewrite, which is exactly the defect this pins.
    const afterRecord = readReconciliationRecords(opened, PROJECT_ID).get("attempt-absent");
    expect(JSON.stringify(afterRecord)).toBe(priorRecordBytes);
    expect(afterRecord?.classification).toBe("ABSENT");
    expect(attemptHistory(opened, "attempt-absent")).toBe(priorHistory);

    // ...and the continuation is traceable back to the attempt it succeeds.
    expect(outcome.binding.attemptRef).toBe("attempt-absent");
    expect(outcome.binding.successorRef).toBe("successor-1");
    expect(outcome.binding.classification).toBe("ABSENT");
    expect(outcome.appendsOnly).toBe(true);
    expect(readContinuationBindings(opened, PROJECT_ID)[0]?.bindingRef).toBe(outcome.binding.bindingRef);
  });

  it("refuses a second binding for the same successor rather than overwriting the first", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);
    expect(run(opened).ok).toBe(true);
    const before = snapshot(opened);

    const second = run(opened, { safeHandoff: "handoff-2" });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("CONTINUATION_BINDING_CONFLICT");
    expect(second.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(before);
    expect(readContinuationBindings(opened, PROJECT_ID)[0]?.safeHandoff).toBe("handoff-1");
  });

  it("stays bound and appends nothing when the one action is retried verbatim", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", ABSENT)).toBe(true);
    expect(run(opened).ok).toBe(true);
    const before = snapshot(opened);

    // A crash between issuing and observing the command must not make the retry
    // an error, and must not append a second binding either.
    expect(run(opened).ok).toBe(true);
    expect(snapshot(opened)).toBe(before);
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(1);
  });
});
