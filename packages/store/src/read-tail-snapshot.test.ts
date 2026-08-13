/**
 * The head/tail consistency check (`assertAggregateTail`) issues two SELECTs.
 * On the public read paths those two statements must observe ONE WAL snapshot:
 * a writer committing between them is an ordinary race, and reporting it with
 * the permanent STORE_CORRUPT code would take a healthy database out of
 * service. Each test here commits from a second connection exactly between the
 * head read and the tail read, deterministically, by hooking the tail query's
 * prepare on a reader connection the test owns.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, it } from "vitest";

import { bytes, proposedDecision } from "./command-decision-test-helpers.js";
import { createDecisionLedgerCore } from "./decision-ledger.js";
import type { DecisionLedgerCore } from "./decision-ledger.js";
import { SqliteEventStore } from "./index.js";

/** Unique to the tail SELECT of assertAggregateTail; no other query orders by it descending. */
const TAIL_SCAN_MARKER = "ORDER BY aggregate_sequence DESC";

interface RaceHarness {
  readonly reader: DecisionLedgerCore;
  readonly writer: SqliteEventStore;
  cleanup(): void;
  /** Runs `run` once, after the head SELECT and before the tail SELECT. */
  onTailScan(run: () => void): void;
}

function harness(label: string): RaceHarness {
  const directory = mkdtempSync(join(tmpdir(), `moe-tail-snapshot-${label}-`));
  const databasePath = join(directory, "store.sqlite");
  const writer = SqliteEventStore.openForProject(databasePath, "project-1");

  // A second, test-owned connection so the interleave hook can be installed on
  // the raw database while the store logic above it stays pure production code.
  const readerDatabase = new DatabaseSync(databasePath, { timeout: 5_000 });
  const reader = createDecisionLedgerCore(
    readerDatabase,
    databasePath,
    "WAL_FILE",
    "project-1",
    true,
  );

  const originalPrepare = readerDatabase.prepare.bind(readerDatabase);
  let pending: (() => void) | null = null;
  (readerDatabase as { prepare: DatabaseSync["prepare"] }).prepare = (sql: string) => {
    if (pending !== null && sql.includes(TAIL_SCAN_MARKER)) {
      const run = pending;
      pending = null;
      run();
    }
    return originalPrepare(sql);
  };

  return {
    cleanup: () => {
      reader.close();
      writer.close();
      rmSync(directory, { force: true, recursive: true });
    },
    onTailScan: (run) => {
      pending = run;
    },
    reader,
    writer,
  };
}

function commitEvent(
  store: SqliteEventStore,
  aggregateId: string,
  index: number,
  expectedVersion: number,
): void {
  store.commit({
    aggregateId,
    commandBytes: bytes(`command-${aggregateId}-${index}`),
    commandId: `command-${aggregateId}-${index}`,
    committedAt: "2026-08-14T09:00:00.000Z",
    events: [
      {
        eventId: `event-${aggregateId}-${index}`,
        eventType: "goal.seeded",
        payload: bytes(`payload-${index}`),
      },
    ],
    expectedVersion,
  });
}

it("keeps getAggregateVersion's head and tail reads on one WAL snapshot", () => {
  const h = harness("version");
  try {
    commitEvent(h.writer, "aggregate-race", 1, 0);
    h.onTailScan(() => commitEvent(h.writer, "aggregate-race", 2, 1));
    expect(h.reader.getAggregateVersion("aggregate-race")).toBe(1);
    // Fresh call, fresh snapshot: proves the interleaved commit really landed,
    // so the assertion above measured isolation rather than a hook that never ran.
    expect(h.reader.getAggregateVersion("aggregate-race")).toBe(2);
  } finally {
    h.cleanup();
  }
});

it("answers 0 for an aggregate born between the head and tail reads", () => {
  const h = harness("newborn");
  try {
    h.onTailScan(() => commitEvent(h.writer, "aggregate-new", 1, 0));
    expect(h.reader.getAggregateVersion("aggregate-new")).toBe(0);
    expect(h.reader.getAggregateVersion("aggregate-new")).toBe(1);
  } finally {
    h.cleanup();
  }
});

it("validates a receipt's aggregate tail on the snapshot the receipt was read from", () => {
  const h = harness("receipt");
  try {
    commitEvent(h.writer, "aggregate-receipt", 1, 0);
    h.onTailScan(() => commitEvent(h.writer, "aggregate-receipt", 2, 1));
    const receipt = h.reader.getCommandReceipt("command-aggregate-receipt-1");
    expect(receipt?.currentVersion).toBe(1);
  } finally {
    h.cleanup();
  }
});

it("keeps decision decode and its receipt tail check on one snapshot", () => {
  const h = harness("decision");
  try {
    const decided = h.writer.commitExpectedVersionDecision(proposedDecision());
    expect(decided.disposition).toBe("DECIDED");
    h.onTailScan(() => commitEvent(h.writer, "goal-1", 2, 1));
    const record = h.reader.getCommandDecision({
      commandId: "command-1",
      principalId: "principal-1",
      projectId: "project-1",
    });
    expect(record?.effectDisposition).toBe("EFFECTS_COMMITTED");
  } finally {
    h.cleanup();
  }
});

it("preflights an expected-version decision without a false corruption verdict", () => {
  const h = harness("preflight");
  try {
    commitEvent(h.writer, "goal-preflight", 1, 0);
    h.onTailScan(() => commitEvent(h.writer, "goal-preflight", 2, 1));
    const response = h.reader.commitExpectedVersionDecision(
      proposedDecision({
        expectedVersion: 1,
        key: {
          commandId: "command-preflight",
          principalId: "principal-1",
          projectId: "project-1",
        },
        targetAggregateId: "goal-preflight",
      }),
    );
    // The locked path re-observes the moved head and DECIDES a rejection —
    // a legitimate outcome, not a corruption verdict aborting the write.
    expect(response.disposition).toBe("DECIDED");
    expect(response.decision.resultCode).toBe("EXPECTED_VERSION_CONFLICT");
  } finally {
    h.cleanup();
  }
});
