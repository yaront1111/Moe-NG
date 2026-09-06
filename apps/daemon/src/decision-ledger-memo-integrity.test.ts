import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteEventStore } from "@moe/store";
import { expect, it } from "vitest";
import { decisionsOf, enrollDecisionLedgerMemo } from "./decision-ledger-memo.js";

it("revalidates memoized history after an external database modification", () => {
  const directory = mkdtempSync(join(tmpdir(), "moe-ledger-memo-integrity-"));
  const path = join(directory, "store.sqlite");
  const store = SqliteEventStore.openForProject(path, "project-1");
  const bytes = new TextEncoder().encode("{}");
  try {
    store.commitExpectedVersionDecision({
      commandKind: "memo.probe", committedResultBytes: bytes,
      correlationId: "correlation-1", decidedAt: "2026-09-06T17:00:00.000Z",
      events: [{ eventId: "event-1", eventType: "MemoProbed", payload: bytes }],
      expectedVersion: 0,
      key: { commandId: "command-1", principalId: "principal-1", projectId: "project-1" },
      requestBytes: bytes, targetAggregateId: "aggregate-1",
    });
    enrollDecisionLedgerMemo(store);
    expect(decisionsOf(store, 100)).toHaveLength(1);
    const other = new DatabaseSync(path);
    try {
      other.prepare("UPDATE command_decisions SET result_bytes = ?")
        .run(new TextEncoder().encode("altered"));
    } finally { other.close(); }
    expect(() => decisionsOf(store, 100)).toThrowError(/STORE_CORRUPT/u);
  } finally {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  }
});
