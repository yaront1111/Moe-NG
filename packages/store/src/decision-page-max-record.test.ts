import { expect, it } from "vitest";

import { MAX_BLOB_BYTES, SqliteEventStore } from "./index.js";

it("advances a near-maximum valid decision under the default page ceiling", () => {
  const store = SqliteEventStore.openEphemeralForProjectTest("project-max-page");
  try {
    const result = store.commitExpectedVersionDecision({
      commandKind: "artifact.record",
      committedResultBytes: new Uint8Array(MAX_BLOB_BYTES).fill(1),
      correlationId: "max-page-correlation",
      decidedAt: "2026-08-06T21:30:00.000Z",
      events: [
        {
          eventId: "max-page-event",
          eventType: "artifact.recorded",
          metadata: new Uint8Array(MAX_BLOB_BYTES).fill(2),
          outbox: [
            {
              messageId: "max-page-message",
              payload: new Uint8Array(7 * 1_024 * 1_024).fill(3),
              topic: "artifact.events",
            },
          ],
          payload: new Uint8Array(MAX_BLOB_BYTES).fill(4),
        },
      ],
      expectedVersion: 0,
      key: {
        commandId: "max-page-command",
        principalId: "max-page-principal",
        projectId: "project-max-page",
      },
      requestBytes: new Uint8Array([1]),
      targetAggregateId: "max-page-aggregate",
    });

    const page = store.readCommandDecisionsAfter(0n, 10);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(result.decision.decisionPosition);
    expect(page.items.map((decision) => decision.key.commandId)).toEqual([
      "max-page-command",
    ]);
  } finally {
    store.close();
  }
});
