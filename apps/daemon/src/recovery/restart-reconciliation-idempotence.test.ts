import type { CommandDecisionRecord } from "@moe/store";
import { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  readReconciliationRecords,
  reconcileOnRestart,
  type InFlightAttempt,
} from "./restart-reconciliation.js";
import { ADVANCED_AUTHORITY, records, situation } from "./recovery-test-fixtures.js";

const PROJECT_ID = "project-recovery-idempotence";
const open: SqliteEventStore[] = [];

function store(): SqliteEventStore {
  const opened = SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
  open.push(opened);
  return opened;
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function request(attempts: readonly InFlightAttempt[]) {
  return {
    attempts,
    correlationId: "corr-restart-idempotent",
    decidedAt: "2026-08-09T00:00:00.000Z",
    principalId: "daemon-1",
    projectId: PROJECT_ID,
  };
}

function reconciliationDecisions(store: SqliteEventStore): readonly CommandDecisionRecord[] {
  const decisions: CommandDecisionRecord[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    decisions.push(...page.items.filter((entry) =>
      entry.key.projectId === PROJECT_ID && entry.commandKind === "reconciliation.decide"));
    if (!page.hasMore || page.nextCursor === null) return decisions;
    cursor = page.nextCursor;
  }
}

describe("restart reconciliation idempotence", () => {
  it("writes exactly one durable row per attempt when the same restart state is replayed", () => {
    const opened = store();
    const attempts: readonly InFlightAttempt[] = [
      { attemptRef: "attempt-adopted", situation: situation({ claimedAuthority: ADVANCED_AUTHORITY }) },
      { attemptRef: "attempt-suspect", situation: situation({ records: records({ lockState: "UNKNOWN" }) }) },
    ];

    const first = reconcileOnRestart(opened, request(attempts));
    const second = reconcileOnRestart(opened, request(attempts));

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(reconciliationDecisions(opened)).toHaveLength(attempts.length);
    const persisted = readReconciliationRecords(opened, PROJECT_ID);
    expect(persisted.size).toBe(attempts.length);
    for (const attempt of attempts) expect(persisted.has(attempt.attemptRef)).toBe(true);
  });

  it("converges after a legitimate state change and does not duplicate the converged row", () => {
    const opened = store();
    const attemptRef = "attempt-changed";
    const adopted = request([
      { attemptRef, situation: situation({ claimedAuthority: ADVANCED_AUTHORITY }) },
    ]);
    const suspect = request([
      {
        attemptRef,
        situation: situation({
          claimedAuthority: ADVANCED_AUTHORITY,
          records: records({ lockState: "UNKNOWN" }),
        }),
      },
    ]);

    const first = reconcileOnRestart(opened, adopted);
    const changed = reconcileOnRestart(opened, suspect);
    const replayedChange = reconcileOnRestart(opened, suspect);

    expect(first.ok && first.records[0]?.classification).toBe("ADOPTED");
    expect(changed.ok && changed.records[0]?.classification).toBe("SUSPECT");
    expect(replayedChange).toEqual(changed);
    expect(readReconciliationRecords(opened, PROJECT_ID).get(attemptRef)?.classification).toBe("SUSPECT");
    expect(reconciliationDecisions(opened)).toHaveLength(2);
  });
});
