import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { runContinuationCommand } from "./continuation-command.js";
import type { ContinuationCommandInput } from "./continuation-command.js";
import { CONTINUATION_SCHEMA_VERSION } from "./continuation-contracts.js";
import {
  evaluateContinuationCommandBytes,
  readContinuationBindings,
} from "./continuation-service.js";
import {
  PROJECT_ID,
  closeOpenStores,
  decisions,
  seed,
  snapshot,
  store,
} from "./continuation-test-harness.js";
import { SETTLED, observation, records, situation } from "./recovery-test-fixtures.js";
import {
  readReconciliationRecords,
  reconciliationAggregateId,
} from "./restart-reconciliation.js";

afterEach(closeOpenStores);

const encoder = new TextEncoder();
const HANDOFF = "handoff-stored-1";
const OTHER_HANDOFF = "handoff-stored-2";

/** ABSENT, released, carrying exactly the handoff its predecessor committed. */
function absentWith(safeHandoff: string): unknown {
  return situation({
    observation: observation({ effectStatus: "PROVEN_ABSENT", processExit: { kind: "EXITED", code: 0 } }),
    records: records({ ...SETTLED, safeHandoff }),
  });
}

/**
 * A request with no release or handoff assertion. Built locally rather than taken
 * from the shared harness, whose builder still mints the pre-migration envelope.
 */
function evaluate(
  opened: SqliteEventStore,
  overrides: Readonly<Record<string, unknown>> = {},
): ReturnType<typeof evaluateContinuationCommandBytes> {
  const request = {
    attemptRef: "attempt-absent",
    correlationId: "corr-continuation",
    decidedAt: "2026-08-09T00:00:00.000Z",
    kind: "work.resume",
    principalId: "daemon-1",
    projectId: PROJECT_ID,
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    successorRef: "successor-1",
    ...overrides,
  };
  return evaluateContinuationCommandBytes(opened, encoder.encode(JSON.stringify(request)));
}

/** The authenticated command edge, which is where DECIDED and REPLAYED are told apart. */
function command(successorRef: string, attemptRef = "attempt-absent"): ContinuationCommandInput {
  return {
    correlationId: "corr-continuation",
    decidedAt: "2026-08-09T00:00:00.000Z",
    payload: { attemptRef, successorRef },
    principalId: "daemon-1",
    projectId: PROJECT_ID,
  };
}

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
    expect(seed(opened, "attempt-absent", absentWith(HANDOFF))).toBe(true);

    const priorRecord = readReconciliationRecords(opened, PROJECT_ID).get("attempt-absent");
    const priorRecordBytes = JSON.stringify(priorRecord);
    const priorHistory = attemptHistory(opened, "attempt-absent");
    expect(priorRecord?.classification).toBe("ABSENT");

    const outcome = evaluate(opened);
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

  it("carries the STORED handoff into the binding, byte for byte", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", absentWith(OTHER_HANDOFF))).toBe(true);
    const stored = readReconciliationRecords(opened, PROJECT_ID).get("attempt-absent")?.safeHandoff;
    expect(stored).toBe(OTHER_HANDOFF);

    const outcome = evaluate(opened);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Read back off disk, not from the returned value: the binding a caller is
    // told about and the binding that is durable must be the same handoff, and
    // both must be the predecessor's, not a request's.
    expect(outcome.binding.safeHandoff).toBe(stored);
    expect(readContinuationBindings(opened, PROJECT_ID)[0]?.safeHandoff).toBe(OTHER_HANDOFF);
  });

  it("refuses a second binding for the same successor rather than overwriting the first", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", absentWith(HANDOFF))).toBe(true);
    expect(seed(opened, "attempt-rival", absentWith(OTHER_HANDOFF))).toBe(true);
    expect(evaluate(opened).ok).toBe(true);
    const boundBefore = JSON.stringify(readContinuationBindings(opened, PROJECT_ID));
    const rivalHistoryBefore = attemptHistory(opened, "attempt-rival");

    const storeBefore = snapshot(opened);

    // A DIFFERENT predecessor claiming the same successor. The successor side of
    // one-to-one is answered by reading the committed bindings BEFORE the append,
    // so the refusal leaves the store byte-identical: no binding, and no ledger
    // row either, because nothing was ever handed to the store to decide.
    const second = evaluate(opened, { attemptRef: "attempt-rival" });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("CONTINUATION_BINDING_CONFLICT");
    expect(second.layer).toBe("CONTINUATION");
    expect(snapshot(opened)).toBe(storeBefore);

    expect(JSON.stringify(readContinuationBindings(opened, PROJECT_ID))).toBe(boundBefore);
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(1);
    expect(readContinuationBindings(opened, PROJECT_ID)[0]?.safeHandoff).toBe(HANDOFF);
    // The loser's own history is not edited either.
    expect(attemptHistory(opened, "attempt-rival")).toBe(rivalHistoryBefore);
    // And the retry of the losing pair is refused again, by re-evaluation.
    const retried = evaluate(opened, { attemptRef: "attempt-rival" });
    expect(retried.ok).toBe(false);
    if (retried.ok) return;
    expect(retried.code).toBe("CONTINUATION_BINDING_CONFLICT");
    expect(snapshot(opened)).toBe(storeBefore);
  });

  it("binds one interrupted attempt to ONE successor, refusing a second at the store", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", absentWith(HANDOFF))).toBe(true);
    const attemptHistoryBefore = attemptHistory(opened, "attempt-absent");

    // The first continuation is a decision: the binding is new to the ledger.
    const first = runContinuationCommand(opened, command("successor-1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replayed).toBe(false);
    expect(first.resultCode).toBe("BOUND");
    const boundBefore = JSON.stringify(readContinuationBindings(opened, PROJECT_ID));

    // The SAME attempt claiming a DIFFERENT successor. The successor is unbound,
    // so the pre-append read admits it; the store is what refuses, because the
    // binding aggregate is keyed on the attempt and is no longer at version 0.
    const second = runContinuationCommand(opened, command("successor-2"));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("CONTINUATION_BINDING_CONFLICT");
    expect(second.layer).toBe("CONTINUATION");

    // The refused command IS recorded: that ledger row is what makes retrying
    // it idempotent. It carries NO effect, and it names the ATTEMPT aggregate:
    // the guard that refused is the one keyed on the attempt, not a successor row.
    const conflictRows = decisions(opened).filter(
      (entry) => entry.effectDisposition !== "EFFECTS_COMMITTED",
    );
    expect(conflictRows).toHaveLength(1);
    expect(conflictRows[0]?.targetAggregateId).toBe("recovery-continuation:attempt:attempt-absent");
    expect(conflictRows[0]?.commandKind).toBe("work.resume");
    expect(JSON.stringify(readContinuationBindings(opened, PROJECT_ID))).toBe(boundBefore);
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(1);
    expect(readContinuationBindings(opened, PROJECT_ID)[0]?.successorRef).toBe("successor-1");
    // The attempt's reconciliation history is still not where the binding lives.
    expect(attemptHistory(opened, "attempt-absent")).toBe(attemptHistoryBefore);

    // The original pair, retried, is the one action issued twice: it replays
    // onto the durable binding and appends nothing.
    const storeBeforeReplay = snapshot(opened);
    const replay = runContinuationCommand(opened, command("successor-1"));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replayed).toBe(true);
    expect(replay.bindingRef).toBe(first.bindingRef);
    expect(snapshot(opened)).toBe(storeBeforeReplay);
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(1);
  });

  it("stays bound and appends nothing when the one action is retried verbatim", () => {
    const opened = store();
    expect(seed(opened, "attempt-absent", absentWith(HANDOFF))).toBe(true);
    expect(evaluate(opened).ok).toBe(true);
    const before = snapshot(opened);

    // A crash between issuing and observing the command must not make the retry
    // an error, and must not append a second binding either.
    expect(evaluate(opened).ok).toBe(true);
    expect(snapshot(opened)).toBe(before);
    expect(readContinuationBindings(opened, PROJECT_ID)).toHaveLength(1);
  });
});
