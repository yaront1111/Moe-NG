import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  bytes,
  proposedDecision,
  releaseDecisionRace,
  startDecisionRaceWorker,
  text,
} from "./command-decision-test-helpers.js";
import { startRaceWorker } from "./sqlite-event-store-test-helpers.js";
import * as storeModule from "./index.js";

describe("expected-version command decision ledger concurrency", () => {
  it(
    "serializes same-key replay/conflict and same-version competing commands",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "moe-decision-races-"));
      try {
        const replayPath = join(directory, "replay.sqlite");
        const replayGate = new SharedArrayBuffer(8);
        const replayResults = await releaseDecisionRace(replayGate, [
          startDecisionRaceWorker(replayPath, replayGate, {
            commandId: "shared-command",
            requestBytes: "same-request",
            suffix: "replay-left",
          }),
          startDecisionRaceWorker(replayPath, replayGate, {
            commandId: "shared-command",
            requestBytes: "same-request",
            suffix: "replay-right",
          }),
        ]);
        expect(replayResults.map((result) => result.disposition).sort()).toEqual([
          "DECIDED",
          "REPLAYED",
        ]);
        expect(new Set(replayResults.map((result) => result.decisionId)).size).toBe(1);
        for (const field of [
          "decisionSha256",
          "effectSha256",
          "resultSha256",
        ] as const) {
          expect(new Set(replayResults.map((result) => result[field])).size).toBe(1);
        }
        expect(replayResults[0]!.businessEventIds).toEqual(
          replayResults[1]!.businessEventIds,
        );
        const replayVerification = storeModule.SqliteEventStore.open(replayPath);
        try {
          expect(replayVerification.readCommandDecisionsAfter(0n, 10).items).toHaveLength(1);
          expect(replayVerification.readEvents("race-goal")).toHaveLength(1);
        } finally {
          replayVerification.close();
        }

        const conflictPath = join(directory, "conflict.sqlite");
        const conflictGate = new SharedArrayBuffer(8);
        const conflictResults = await releaseDecisionRace(conflictGate, [
          startDecisionRaceWorker(conflictPath, conflictGate, {
            commandId: "shared-command",
            requestBytes: "left-request",
            suffix: "conflict-left",
          }),
          startDecisionRaceWorker(conflictPath, conflictGate, {
            commandId: "shared-command",
            requestBytes: "right-request",
            suffix: "conflict-right",
          }),
        ]);
        expect(
          conflictResults
            .map((result) => result.disposition ?? result.code)
            .sort(),
        ).toEqual(["DECIDED", "IDEMPOTENCY_CONFLICT"]);
        const conflictVerification = storeModule.SqliteEventStore.open(conflictPath);
        try {
          expect(conflictVerification.readCommandDecisionsAfter(0n, 10).items).toHaveLength(1);
          expect(conflictVerification.readEvents("race-goal")).toHaveLength(1);
        } finally {
          conflictVerification.close();
        }

        const versionPath = join(directory, "version.sqlite");
        const versionGate = new SharedArrayBuffer(8);
        const versionResults = await releaseDecisionRace(versionGate, [
          startDecisionRaceWorker(versionPath, versionGate, {
            commandId: "left-command",
            requestBytes: "left-request",
            suffix: "version-left",
          }),
          startDecisionRaceWorker(versionPath, versionGate, {
            commandId: "right-command",
            requestBytes: "right-request",
            suffix: "version-right",
          }),
        ]);
        expect(versionResults.map((result) => result.disposition)).toEqual([
          "DECIDED",
          "DECIDED",
        ]);
        expect(
          versionResults.map((result) => result.effectDisposition).sort(),
        ).toEqual(["EFFECTS_COMMITTED", "NO_BUSINESS_EFFECT"]);
        const versionVerification = storeModule.SqliteEventStore.open(versionPath);
        try {
          expect(versionVerification.readCommandDecisionsAfter(0n, 10).items).toHaveLength(2);
          expect(versionVerification.readEvents("race-goal")).toHaveLength(1);
          expect(
            versionVerification
              .readEventsAfter(0n, 10)
              .items.map((event) => event.eventType)
              .sort(),
          ).toEqual(["command.expected-version-rejected", "goal.raced"]);
        } finally {
          versionVerification.close();
        }
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it("reconciles a committed decision after the writer exits before an acknowledgement", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-lost-response-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const moduleUrl = new URL("./sqlite-event-store.ts", import.meta.url).href;
      const childScript = `
        import { SqliteEventStore } from ${JSON.stringify(moduleUrl)};
        const bytes = (value) => new TextEncoder().encode(value);
        const store = SqliteEventStore.openForProject(${JSON.stringify(databasePath)}, "child-project");
        store.commitExpectedVersionDecision({
          commandKind: "goal.create",
          committedResultBytes: bytes("original-result"),
          correlationId: "child-correlation",
          decidedAt: "2026-08-06T18:50:00.000Z",
          events: [{
            eventId: "child-decision-event",
            eventType: "goal.created",
            payload: bytes("original-event"),
          }],
          expectedVersion: 0,
          key: {
            commandId: "child-command",
            principalId: "child-principal",
            projectId: "child-project",
          },
          requestBytes: bytes("child-request"),
          targetAggregateId: "child-goal",
        });
      `;
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "--eval", childScript],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect({ signal: child.signal, status: child.status, stderr: child.stderr }).toMatchObject({
        signal: null,
        status: 0,
      });

      const reopened = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "child-project",
      );
      try {
        const replay = reopened.commitExpectedVersionDecision({
          commandKind: "goal.create",
          committedResultBytes: bytes("must-not-replace"),
          correlationId: "new-correlation",
          decidedAt: "2026-08-06T18:51:00.000Z",
          events: [
            {
              eventId: "must-not-replace-event",
              eventType: "goal.deleted",
              payload: bytes("replacement"),
            },
          ],
          expectedVersion: 0,
          key: {
            commandId: "child-command",
            principalId: "child-principal",
            projectId: "child-project",
          },
          requestBytes: bytes("child-request"),
          targetAggregateId: "child-goal",
        });
        expect(replay.disposition).toBe("REPLAYED");
        expect(replay.historical).toBe(true);
        expect(replay.requiresAffordanceRefresh).toBe(true);
        expect(text(replay.decision.resultBytes)).toBe("original-result");
        expect(reopened.readEvents("child-goal").map((event) => event.eventId)).toEqual([
          "child-decision-event",
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it(
    "chooses proposal validation from the aggregate version observed under the write lock",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "moe-proposal-version-race-"));
      const databasePath = join(directory, "store.sqlite");
      const store = storeModule.SqliteEventStore.openForProject(
        databasePath,
        "moe-test-project",
      );
      const gate = new SharedArrayBuffer(12);
      const gateView = new Int32Array(gate);
      const worker = startRaceWorker(databasePath, gate, "proposal-version");
      const originalSet = Uint8Array.prototype.set;
      let releasedDuringProposalSnapshot = false;
      try {
        await worker.preOpenReady;
        Atomics.store(gateView, 0, 1);
        Atomics.notify(gateView, 0, 1);
        await worker.ready;

        Uint8Array.prototype.set = function setWithConcurrentVersionAdvance(
          source: ArrayLike<number>,
          offset?: number,
        ): void {
          if (
            !releasedDuringProposalSnapshot &&
            source.length === storeModule.MAX_BLOB_BYTES
          ) {
            releasedDuringProposalSnapshot = true;
            Atomics.store(gateView, 1, 1);
            Atomics.notify(gateView, 1, 1);
            if (Atomics.wait(gateView, 2, 0, 5_000) === "timed-out") {
              throw new Error("concurrent version writer did not finish during proposal snapshot");
            }
          }
          Reflect.apply(originalSet, this, [source, offset]);
        };

        const decision = store.commitExpectedVersionDecision(
          proposedDecision({
            committedResultBytes: new Uint8Array(storeModule.MAX_BLOB_BYTES),
            events: [],
            key: {
              commandId: "proposal-version-command",
              principalId: "principal-1",
              projectId: "moe-test-project",
            },
            targetAggregateId: "goal-race",
          }),
        );
        expect(releasedDuringProposalSnapshot).toBe(true);
        expect(decision).toMatchObject({
          decision: {
            effectDisposition: "NO_BUSINESS_EFFECT",
            observedVersion: 1,
            resultCode: "EXPECTED_VERSION_CONFLICT",
          },
          disposition: "DECIDED",
        });
        expect(await worker.result).toMatchObject({ disposition: "COMMITTED" });
        expect(store.readEvents("goal-race")).toHaveLength(1);
      } finally {
        Uint8Array.prototype.set = originalSet;
        Atomics.store(gateView, 1, 1);
        Atomics.notify(gateView, 1, 1);
        await worker.result.catch(() => undefined);
        store.close();
        rmSync(directory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it("keeps command-decision cursors exact beyond JavaScript safe integers", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-decision-cursor-"));
    const databasePath = join(directory, "store.sqlite");
    try {
      const store = storeModule.SqliteEventStore.openForProject(databasePath, "project-1");
      try {
        const first = store.commitExpectedVersionDecision(proposedDecision());

        const sequence = new DatabaseSync(databasePath);
        try {
          sequence
            .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'command_decisions'")
            .run(Number.MAX_SAFE_INTEGER);
        } finally {
          sequence.close();
        }

        const second = store.commitExpectedVersionDecision(
          proposedDecision({
            committedResultBytes: bytes("second"),
            events: [
              {
                eventId: "cursor-event-2",
                eventType: "goal.created",
                payload: bytes("second"),
              },
            ],
            key: {
              commandId: "cursor-command-2",
              principalId: "principal-1",
              projectId: "project-1",
            },
            targetAggregateId: "cursor-goal-2",
          }),
        );
        expect(second.decision.decisionPosition).toBe(9_007_199_254_740_992n);
        const firstPage = store.readCommandDecisionsAfter(0n, 1);
        expect(firstPage).toMatchObject({
          hasMore: true,
          nextCursor: first.decision.decisionPosition,
        });
        const secondPage = store.readCommandDecisionsAfter(firstPage.nextCursor!, 1);
        expect(secondPage).toMatchObject({
          hasMore: false,
          nextCursor: 9_007_199_254_740_992n,
        });
        expect(secondPage.items.map((decision) => decision.decisionId)).toEqual([
          second.decision.decisionId,
        ]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
