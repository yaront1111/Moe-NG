import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteEventStore } from "./index.js";
import type {
  CommandDecisionResponse,
  CommitExpectedVersionDecisionInput,
} from "./index.js";
import { bytes, proposedDecision } from "./command-decision-test-helpers.js";

interface DecisionApplyContext {
  readonly database: DatabaseSync;
}

interface AtomicDecisionStore {
  commitExpectedVersionDecisionWithApply(
    input: CommitExpectedVersionDecisionInput,
    apply: (context: DecisionApplyContext) => void,
  ): CommandDecisionResponse;
}

const stores: SqliteEventStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function store(): SqliteEventStore {
  const opened = SqliteEventStore.openEphemeralForProjectTest("project-1");
  stores.push(opened);
  return opened;
}

function atomic(store: SqliteEventStore): AtomicDecisionStore {
  return store as unknown as AtomicDecisionStore;
}

describe("atomic command decision apply", () => {
  it("commits the canonical decision and caller projection together", () => {
    const opened = store();
    const response = atomic(opened).commitExpectedVersionDecisionWithApply(
      proposedDecision(),
      ({ database }) => {
        database.exec("CREATE TABLE restore_projection (value TEXT NOT NULL) STRICT");
        database.prepare("INSERT INTO restore_projection (value) VALUES (?)").run("QUIESCED");
      },
    );

    expect(response).toMatchObject({
      decision: { effectDisposition: "EFFECTS_COMMITTED", resultCode: "EFFECTS_COMMITTED" },
      disposition: "DECIDED",
    });
    expect(opened.getCommandDecision(proposedDecision().key)).not.toBeNull();
  });

  it("rolls back decision effects and projection when apply throws", () => {
    const opened = store();
    const input = proposedDecision({
      committedResultBytes: bytes('{"state":"QUIESCED"}'),
      key: { commandId: "rollback-command", principalId: "principal-1", projectId: "project-1" },
    });

    expect(() => atomic(opened).commitExpectedVersionDecisionWithApply(input, ({ database }) => {
      database.exec("CREATE TABLE restore_projection (value TEXT NOT NULL) STRICT");
      database.prepare("INSERT INTO restore_projection (value) VALUES (?)").run("MIXED");
      throw new Error("interrupt projection");
    })).toThrow();

    expect(opened.getCommandDecision(input.key)).toBeNull();
    expect(opened.getAggregateVersion(input.targetAggregateId)).toBe(0);
    expect(opened.readEvents(input.targetAggregateId)).toEqual([]);
  });

  it("never runs apply for a replayed or stale decision", () => {
    const opened = store();
    const input = proposedDecision();
    let calls = 0;
    atomic(opened).commitExpectedVersionDecisionWithApply(input, () => { calls += 1; });
    const replay = atomic(opened).commitExpectedVersionDecisionWithApply(
      input,
      () => { calls += 1; },
    );
    const stale = atomic(opened).commitExpectedVersionDecisionWithApply(
      proposedDecision({
        key: { commandId: "stale-command", principalId: "principal-1", projectId: "project-1" },
        requestBytes: bytes("stale-request"),
      }),
      () => { calls += 1; },
    );

    expect(replay.disposition).toBe("REPLAYED");
    expect(stale.decision).toMatchObject({
      effectDisposition: "NO_BUSINESS_EFFECT",
      resultCode: "EXPECTED_VERSION_CONFLICT",
    });
    expect(calls).toBe(1);
  });
});
