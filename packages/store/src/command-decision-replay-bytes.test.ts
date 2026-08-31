import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { bytes, proposedDecision } from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

/**
 * `replayRequestSha256` is the durable evidence a replay path needs to prove SAME BYTES before
 * echoing an earlier decision. Its preimage is the primary leg's commit-request identity —
 * {aggregateId, expectedVersion, requestBytes} — so when a caller recomputes it from the STORED
 * record's own `targetAggregateId` and `expectedVersion`, the request bytes are the only free
 * variable and equality is a byte-equality proof.
 *
 * The digest is NOT bytes-only, and this suite says so out loud: a case below moves the aggregate
 * alone and asserts the digest moves. That is safe for replay (both co-inputs are read back off
 * the same record) and it is exactly why no new durable column was needed.
 */

const PROJECT_ID = "project-1";

/**
 * Frozen preimage pin. Derived from the production helper once and then held constant, so a
 * change to `COMMAND_REQUEST_IDENTITY_VERSION`, to the framing, or to the field order reds here
 * instead of silently redefining what a replay proof means.
 */
const FROZEN_GOAL_A_DIGEST =
  "5fb6d650a6826f7702455b48e279e5a0d3a1c9ecdad46c1e906648fe9e63f51f";

type LegsInput = storeModule.CommitExpectedVersionDecisionLegsInput;

function leg(
  aggregateId: string,
  expectedVersion: number,
  eventId: string,
): storeModule.ExpectedVersionDecisionLeg {
  return {
    aggregateId,
    events: [{ eventId, eventType: "goal.created", payload: bytes(`payload-${eventId}`) }],
    expectedVersion,
  };
}

function legsInput(overrides: Partial<LegsInput> = {}): LegsInput {
  return {
    commandKind: "goal.create",
    committedResultBytes: bytes('{"goalId":"goal-1"}'),
    correlationId: "correlation-1",
    decidedAt: "2026-08-20T09:00:00.000Z",
    key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
    legs: [leg("goal-a", 0, "event-a1"), leg("goal-b", 0, "event-b1")],
    requestBytes: bytes("goal.create/v1"),
    ...overrides,
  };
}

function ephemeral(): storeModule.SqliteEventStore {
  return storeModule.SqliteEventStore.openEphemeralForProjectTest(PROJECT_ID);
}

function withStore<Result>(run: (store: storeModule.SqliteEventStore) => Result): Result {
  const store = ephemeral();
  try {
    return run(store);
  } finally {
    store.close();
  }
}

describe("command decision replay-request digest — both commit paths record it", () => {
  it("exports the correlation identity helper used by provenance readers", () => {
    expect(typeof (storeModule as Readonly<Record<string, unknown>>)["identifyCorrelation"])
      .toBe("function");
  });

  it("records the single-aggregate decision's digest over the exact request bytes", () => {
    withStore((store) => {
      const decision = store.commitExpectedVersionDecision(
        proposedDecision({ requestBytes: bytes("goal.create/v1"), targetAggregateId: "goal-a" }),
      ).decision;

      expect(decision.replayRequestSha256).toBe(FROZEN_GOAL_A_DIGEST);
      expect(decision.replayRequestSha256).toBe(
        storeModule.identifyReplayRequest(decision, bytes("goal.create/v1")),
      );
    });
  });

  it("records the SAME digest through the multi-leg path for the same primary leg", () => {
    withStore((store) => {
      const decision = store.commitExpectedVersionDecisionLegs(legsInput()).decision;

      expect(decision.targetAggregateId).toBe("goal-a");
      expect(decision.replayRequestSha256).toBe(FROZEN_GOAL_A_DIGEST);
      expect(decision.replayRequestSha256).toBe(
        storeModule.identifyReplayRequest(decision, bytes("goal.create/v1")),
      );
    });
  });

  it("moves the digest when only the request bytes move, on both commit paths", () => {
    const single = withStore((store) =>
      store.commitExpectedVersionDecision(
        proposedDecision({ requestBytes: bytes("goal.create/v2"), targetAggregateId: "goal-a" }),
      ).decision.replayRequestSha256,
    );
    const legs = withStore((store) =>
      store.commitExpectedVersionDecisionLegs(
        legsInput({ requestBytes: bytes("goal.create/v2") }),
      ).decision.replayRequestSha256,
    );

    expect(single).not.toBe(FROZEN_GOAL_A_DIGEST);
    expect(legs).not.toBe(FROZEN_GOAL_A_DIGEST);
    expect(legs).toBe(single);
  });

  it("moves the digest when only the fenced aggregate moves — it is not bytes-only", () => {
    withStore((store) => {
      const decision = store.commitExpectedVersionDecision(
        proposedDecision({ requestBytes: bytes("goal.create/v1"), targetAggregateId: "goal-z" }),
      ).decision;

      expect(decision.replayRequestSha256).not.toBe(FROZEN_GOAL_A_DIGEST);
      expect(decision.replayRequestSha256).toBe(
        storeModule.identifyReplayRequest(decision, bytes("goal.create/v1")),
      );
    });
  });
});

describe("command decision replay-request digest — durable read paths agree", () => {
  it("returns the committed digest from every decision read surface", () => {
    withStore((store) => {
      const key = { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID };
      const written = store.commitExpectedVersionDecision(
        proposedDecision({ requestBytes: bytes("goal.create/v1"), targetAggregateId: "goal-a" }),
      ).decision;

      expect(store.getCommandDecision(key)?.replayRequestSha256).toBe(FROZEN_GOAL_A_DIGEST);
      expect(store.readCommandDecisionsAfter(0n, 10).items[0]?.replayRequestSha256)
        .toBe(FROZEN_GOAL_A_DIGEST);
      expect(store.getCommandDecision(key)).toEqual(written);
    });
  });

  it("carries null on a NO_BUSINESS_EFFECT row, whose receipt covers audit bytes not request bytes", () => {
    withStore((store) => {
      store.commitExpectedVersionDecision(
        proposedDecision({ requestBytes: bytes("goal.create/v1"), targetAggregateId: "goal-a" }),
      );
      const conflicted = store.commitExpectedVersionDecision(
        proposedDecision({
          key: { commandId: "command-2", principalId: "principal-1", projectId: PROJECT_ID },
          requestBytes: bytes("goal.create/v1"),
          targetAggregateId: "goal-a",
        }),
      ).decision;

      expect(conflicted.effectDisposition).toBe("NO_BUSINESS_EFFECT");
      expect(conflicted.replayRequestSha256).toBeNull();
      expect(
        store.getCommandDecision({
          commandId: "command-2",
          principalId: "principal-1",
          projectId: PROJECT_ID,
        })?.replayRequestSha256,
      ).toBeNull();
    });
  });
});

describe("command decision replay-request digest — tamper evidence", () => {
  /**
   * The digest is not stored on `command_decisions`: it is the primary receipt's request
   * identity, which `identifyCommandEffects` folds into `effect_sha256`, which the decision row
   * pins and `decision_sha256` covers. Forging it must therefore be caught by the digest chain
   * that already exists rather than by a new check — this case proves that claim instead of
   * asserting it in a comment.
   */
  it("refuses to open a store whose receipt request digest was forged", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-replay-bytes-tamper-"));
    try {
      const databasePath = join(directory, "forged.sqlite");
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      store.commitExpectedVersionDecision(
        proposedDecision({ requestBytes: bytes("goal.create/v1"), targetAggregateId: "goal-a" }),
      );
      store.close();

      const tamper = new DatabaseSync(databasePath);
      tamper.exec(`UPDATE command_receipts SET request_sha256 = '${"3".repeat(64)}'`);
      tamper.exec(`UPDATE domain_events SET request_sha256 = '${"3".repeat(64)}'`);
      tamper.close();

      expect(() => {
        const wronglyOpened = storeModule.SqliteEventStore.open(databasePath);
        wronglyOpened.close();
      }).toThrowError(/STORE_CORRUPT/u);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps the untampered control readable, so the drill above is not vacuous", () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-replay-bytes-control-"));
    try {
      const databasePath = join(directory, "control.sqlite");
      const store = storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID);
      store.commitExpectedVersionDecision(
        proposedDecision({ requestBytes: bytes("goal.create/v1"), targetAggregateId: "goal-a" }),
      );
      store.close();

      const reopened = storeModule.SqliteEventStore.open(databasePath);
      try {
        expect(
          reopened.getCommandDecision({
            commandId: "command-1",
            principalId: "principal-1",
            projectId: PROJECT_ID,
          })?.replayRequestSha256,
        ).toBe(FROZEN_GOAL_A_DIGEST);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
