import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bytes, text } from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

const PROJECT_ID = "project-1";
const DECIDED_AT = "2026-08-20T09:00:00.000Z";

type LegsInput = storeModule.CommitExpectedVersionDecisionLegsInput;
type Leg = storeModule.ExpectedVersionDecisionLeg;

function leg(aggregateId: string, expectedVersion: number, eventIds: readonly string[]): Leg {
  return {
    aggregateId,
    events: eventIds.map((eventId) => ({
      eventId,
      eventType: "goal.created",
      payload: bytes(`payload-${eventId}`),
    })),
    expectedVersion,
  };
}

function legsInput(overrides: Partial<LegsInput> = {}): LegsInput {
  return {
    commandKind: "goal.create",
    committedResultBytes: bytes('{"goalId":"goal-1"}'),
    correlationId: "correlation-1",
    decidedAt: DECIDED_AT,
    key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
    legs: [leg("goal-a", 0, ["event-a1"]), leg("goal-b", 0, ["event-b1"])],
    requestBytes: bytes("goal.create/v1"),
    ...overrides,
  };
}

interface Fixture {
  readonly databasePath: string;
  readonly directory: string;
  readonly store: storeModule.SqliteEventStore;
}

function openFixture(label: string): Fixture {
  const directory = mkdtempSync(join(tmpdir(), `moe-multi-leg-${label}-`));
  const databasePath = join(directory, "store.sqlite");
  return {
    databasePath,
    directory,
    store: storeModule.SqliteEventStore.openForProject(databasePath, PROJECT_ID),
  };
}

function closeFixture(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.directory, { force: true, recursive: true });
}

function refusalCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof storeModule.DurableStoreError) {
      return error.code;
    }
    return `NON_STORE_ERROR: ${String(error)}`;
  }
  return "NO_REFUSAL";
}

function auditPayload(
  store: storeModule.SqliteEventStore,
  decision: storeModule.CommandDecisionRecord,
): Record<string, unknown> {
  const auditEventId = decision.auditEventId;
  expect(auditEventId).not.toBeNull();
  const auditAggregateId = store
    .readEventsAfter(0n, 1_000)
    .items.find((event) => event.eventId === auditEventId)?.aggregateId;
  expect(auditAggregateId).toBeDefined();
  const audit = store.readEvents(auditAggregateId!)[0]!;
  return JSON.parse(text(audit.payload)) as Record<string, unknown>;
}

describe("multi-aggregate expected-version decision legs", () => {
  it("commits every leg under one decision with per-leg fences and sequences", () => {
    const fixture = openFixture("accepted");
    try {
      const { store } = fixture;
      store.commit({
        aggregateId: "goal-b",
        commandBytes: bytes("seed"),
        commandId: "seed-command",
        committedAt: DECIDED_AT,
        events: [{ eventId: "seed-b", eventType: "goal.seeded", payload: bytes("seed") }],
        expectedVersion: 0,
      });

      const response = store.commitExpectedVersionDecisionLegs(
        legsInput({ legs: [leg("goal-a", 0, ["event-a1", "event-a2"]), leg("goal-b", 1, ["event-b1"])] }),
      );

      expect(response.disposition).toBe("DECIDED");
      expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
      expect(response.decision.resultCode).toBe("EFFECTS_COMMITTED");
      expect(response.decision.targetAggregateId).toBe("goal-a");
      expect(response.decision.businessEventIds).toEqual(["event-a1", "event-a2"]);
      expect(store.getAggregateVersion("goal-a")).toBe(2);
      expect(store.getAggregateVersion("goal-b")).toBe(2);
      expect(store.readEvents("goal-a").map((event) => event.eventId)).toEqual([
        "event-a1",
        "event-a2",
      ]);
      expect(store.readEvents("goal-b").map((event) => event.eventId)).toEqual([
        "seed-b",
        "event-b1",
      ]);
      expect(store.readEvents("goal-b").map((event) => event.aggregateSequence)).toEqual([1, 2]);
      expect(
        store.readCommandDecisionsAfter(0n, 100).items.map((item) => item.decisionId),
      ).toEqual([response.decision.decisionId]);
    } finally {
      closeFixture(fixture);
    }
  });

  it("gives every leg its own truthful receipt and decision trace", () => {
    const fixture = openFixture("receipts");
    try {
      const { store } = fixture;
      const response = store.commitExpectedVersionDecisionLegs(legsInput());
      const secondLegEvent = store.readEvents("goal-b")[0]!;
      const secondLegReceipt = store.getCommandReceipt(secondLegEvent.commandId);

      expect(secondLegReceipt).toMatchObject({
        aggregateId: "goal-b",
        currentVersion: 1,
        eventIds: ["event-b1"],
        previousVersion: 0,
      });
      expect(secondLegEvent.decisionTrace).toMatchObject({
        commandId: "command-1",
        commandKind: "goal.create",
        principalId: "principal-1",
        projectId: PROJECT_ID,
        requestSha256: response.decision.requestSha256,
      });
      const firstLegEvent = store.readEvents("goal-a")[0]!;
      expect(store.getCommandReceipt(firstLegEvent.commandId)).toMatchObject({
        aggregateId: "goal-a",
        effectSha256: response.decision.effectSha256,
      });
      expect(secondLegEvent.commandId).not.toBe(firstLegEvent.commandId);
    } finally {
      closeFixture(fixture);
    }
  });

  it("reopens a store holding a multi-leg commit without a reserved-namespace refusal", () => {
    const fixture = openFixture("reopen");
    try {
      fixture.store.commitExpectedVersionDecisionLegs(legsInput());
      fixture.store.close();
      const reopened = storeModule.SqliteEventStore.openForProject(
        fixture.databasePath,
        PROJECT_ID,
      );
      try {
        expect(reopened.getAggregateVersion("goal-b")).toBe(1);
        expect(
          reopened.getCommandDecision({
            commandId: "command-1",
            principalId: "principal-1",
            projectId: PROJECT_ID,
          })?.targetAggregateId,
        ).toBe("goal-a");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });

  it("refuses the whole commit and persists zero rows on the earlier leg when a later fence is stale", () => {
    const fixture = openFixture("stale-later");
    try {
      const { store } = fixture;
      store.commit({
        aggregateId: "goal-b",
        commandBytes: bytes("seed"),
        commandId: "seed-command",
        committedAt: DECIDED_AT,
        events: [{ eventId: "seed-b", eventType: "goal.seeded", payload: bytes("seed") }],
        expectedVersion: 0,
      });

      const response = store.commitExpectedVersionDecisionLegs(legsInput());

      expect(response.decision.resultCode).toBe("EXPECTED_VERSION_CONFLICT");
      expect(response.decision.effectDisposition).toBe("NO_BUSINESS_EFFECT");
      expect(response.decision.targetAggregateId).toBe("goal-b");
      expect(response.decision.expectedVersion).toBe(0);
      expect(response.decision.observedVersion).toBe(1);
      expect(auditPayload(store, response.decision)).toMatchObject({
        expectedVersion: 0,
        observedVersion: 1,
        targetAggregateId: "goal-b",
      });
      expect(store.readEvents("goal-a")).toEqual([]);
      expect(store.getAggregateVersion("goal-a")).toBe(0);
      expect(store.readEvents("goal-b").map((event) => event.eventId)).toEqual(["seed-b"]);
    } finally {
      closeFixture(fixture);
    }
  });

  it("names the first leg when the first leg's own fence is stale", () => {
    const fixture = openFixture("stale-first");
    try {
      const { store } = fixture;
      store.commit({
        aggregateId: "goal-a",
        commandBytes: bytes("seed"),
        commandId: "seed-command",
        committedAt: DECIDED_AT,
        events: [{ eventId: "seed-a", eventType: "goal.seeded", payload: bytes("seed") }],
        expectedVersion: 0,
      });

      const response = store.commitExpectedVersionDecisionLegs(legsInput());

      expect(response.decision.resultCode).toBe("EXPECTED_VERSION_CONFLICT");
      expect(response.decision.targetAggregateId).toBe("goal-a");
      expect(response.decision.observedVersion).toBe(1);
      expect(store.readEvents("goal-b")).toEqual([]);
    } finally {
      closeFixture(fixture);
    }
  });

  it("rolls back every leg when a later leg throws mid-loop", () => {
    const fixture = openFixture("rollback");
    try {
      const { store } = fixture;
      store.commit({
        aggregateId: "goal-c",
        commandBytes: bytes("seed"),
        commandId: "seed-command",
        committedAt: DECIDED_AT,
        events: [{ eventId: "event-b1", eventType: "goal.seeded", payload: bytes("seed") }],
        expectedVersion: 0,
      });

      expect(refusalCode(() => store.commitExpectedVersionDecisionLegs(legsInput()))).toBe(
        "DURABLE_ID_CONFLICT",
      );
      expect(store.readEvents("goal-a")).toEqual([]);
      expect(store.getAggregateVersion("goal-a")).toBe(0);
      expect(
        store.getCommandDecision({
          commandId: "command-1",
          principalId: "principal-1",
          projectId: PROJECT_ID,
        }),
      ).toBeNull();
    } finally {
      closeFixture(fixture);
    }
  });

  it("replays the original decision without re-appending any leg's events", () => {
    const fixture = openFixture("replay");
    try {
      const { store } = fixture;
      const first = store.commitExpectedVersionDecisionLegs(legsInput());
      const replay = store.commitExpectedVersionDecisionLegs(legsInput());

      expect(replay.disposition).toBe("REPLAYED");
      expect(replay.decision).toStrictEqual(first.decision);
      expect(store.readEvents("goal-a").map((event) => event.eventId)).toEqual(["event-a1"]);
      expect(store.readEvents("goal-b").map((event) => event.eventId)).toEqual(["event-b1"]);
      expect(store.getAggregateVersion("goal-a")).toBe(1);
      expect(store.getAggregateVersion("goal-b")).toBe(1);
      expect(store.readCommandDecisionsAfter(0n, 100).items).toHaveLength(1);
    } finally {
      closeFixture(fixture);
    }
  });

  it("refuses a different leg list under the same key and leaves the first record intact", () => {
    const fixture = openFixture("leg-conflict");
    try {
      const { store } = fixture;
      const first = store.commitExpectedVersionDecisionLegs(legsInput());

      expect(
        refusalCode(() =>
          store.commitExpectedVersionDecisionLegs(
            legsInput({ legs: [leg("goal-a", 0, ["event-a1"]), leg("goal-z", 0, ["event-z1"])] }),
          ),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
      expect(
        store.getCommandDecision({
          commandId: "command-1",
          principalId: "principal-1",
          projectId: PROJECT_ID,
        }),
      ).toStrictEqual(first.decision);
      expect(store.readEvents("goal-z")).toEqual([]);
    } finally {
      closeFixture(fixture);
    }
  });

  it("refuses different request bytes under the same key without changing either leg", () => {
    const fixture = openFixture("conflict");
    try {
      const { store } = fixture;
      const first = store.commitExpectedVersionDecisionLegs(legsInput());
      const countsBeforeConflict = {
        decisions: store.readCommandDecisionsAfter(0n, 100).items.length,
        goalAEvents: store.readEvents("goal-a").length,
        goalAHead: store.getAggregateVersion("goal-a"),
        goalBEvents: store.readEvents("goal-b").length,
        goalBHead: store.getAggregateVersion("goal-b"),
        rawEvents: store.readEventsAfter(0n, 100).items.length,
      };

      expect(
        refusalCode(() =>
          store.commitExpectedVersionDecisionLegs(
            legsInput({ requestBytes: bytes("goal.create/v2") }),
          ),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
      expect(
        store.getCommandDecision({
          commandId: "command-1",
          principalId: "principal-1",
          projectId: PROJECT_ID,
        }),
      ).toStrictEqual(first.decision);
      expect({
        decisions: store.readCommandDecisionsAfter(0n, 100).items.length,
        goalAEvents: store.readEvents("goal-a").length,
        goalAHead: store.getAggregateVersion("goal-a"),
        goalBEvents: store.readEvents("goal-b").length,
        goalBHead: store.getAggregateVersion("goal-b"),
        rawEvents: store.readEventsAfter(0n, 100).items.length,
      }).toStrictEqual(countsBeforeConflict);
    } finally {
      closeFixture(fixture);
    }
  });

  it("produces a byte-identical decision to the single-aggregate commit for one leg", () => {
    const singleFixture = openFixture("single");
    const legsFixture = openFixture("one-leg");
    try {
      const single = singleFixture.store.commitExpectedVersionDecision({
        commandKind: "goal.create",
        committedResultBytes: bytes('{"goalId":"goal-1"}'),
        correlationId: "correlation-1",
        decidedAt: DECIDED_AT,
        events: [{ eventId: "event-a1", eventType: "goal.created", payload: bytes("payload-event-a1") }],
        expectedVersion: 0,
        key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
        requestBytes: bytes("goal.create/v1"),
        targetAggregateId: "goal-a",
      });
      const legsOnly = legsFixture.store.commitExpectedVersionDecisionLegs(
        legsInput({ legs: [leg("goal-a", 0, ["event-a1"])] }),
      );

      expect(legsOnly).toStrictEqual(single);
      const singleEvent = singleFixture.store.readEvents("goal-a")[0]!;
      const legsEvent = legsFixture.store.readEvents("goal-a")[0]!;
      expect(legsEvent).toStrictEqual(singleEvent);
      expect(legsFixture.store.getCommandReceipt(legsEvent.commandId)).toStrictEqual(
        singleFixture.store.getCommandReceipt(singleEvent.commandId),
      );
    } finally {
      closeFixture(legsFixture);
      closeFixture(singleFixture);
    }
  });

  it("refuses leg lists that cannot carry a coherent per-leg version fence", () => {
    const fixture = openFixture("bounds");
    try {
      const { store } = fixture;
      expect(refusalCode(() => store.commitExpectedVersionDecisionLegs(legsInput({ legs: [] }))))
        .toBe("STORE_INPUT_INVALID");
      expect(
        refusalCode(() =>
          store.commitExpectedVersionDecisionLegs(
            legsInput({ legs: [leg("goal-a", 0, ["event-a1"]), leg("goal-a", 1, ["event-a2"])] }),
          ),
        ),
      ).toBe("STORE_INPUT_INVALID");
      expect(
        refusalCode(() =>
          store.commitExpectedVersionDecisionLegs(
            legsInput({ legs: [leg("goal-a", 0, ["event-a1"]), leg("goal-b", 0, [])] }),
          ),
        ),
      ).toBe("STORE_INPUT_INVALID");
      expect(
        refusalCode(() =>
          store.commitExpectedVersionDecisionLegs(
            legsInput({
              legs: [leg("goal-a", 0, ["event-a1"]), leg("moe-internal:goal-b", 0, ["event-b1"])],
            }),
          ),
        ),
      ).toBe("STORE_INPUT_INVALID");
    } finally {
      closeFixture(fixture);
    }
  });

  it("accepts exactly MAX_DECISION_LEGS legs and refuses one more", () => {
    const fixture = openFixture("limit");
    try {
      const { store } = fixture;
      const limit = storeModule.MAX_DECISION_LEGS;
      expect(limit).toBeGreaterThan(1);
      const atLimit = Array.from({ length: limit }, (_unused, index) =>
        leg(`goal-${index}`, 0, [`event-${index}`]),
      );
      expect(atLimit).toHaveLength(limit);

      const accepted = store.commitExpectedVersionDecisionLegs(legsInput({ legs: atLimit }));
      expect(accepted.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
      expect(store.getAggregateVersion(`goal-${limit - 1}`)).toBe(1);

      const overLimit = [...atLimit, leg(`goal-${limit}`, 0, [`event-${limit}`])];
      expect(overLimit).toHaveLength(limit + 1);
      expect(
        refusalCode(() =>
          store.commitExpectedVersionDecisionLegs(
            legsInput({
              key: { commandId: "command-2", principalId: "principal-1", projectId: PROJECT_ID },
              legs: overLimit,
            }),
          ),
        ),
      ).toBe("STORE_LIMIT_EXCEEDED");
    } finally {
      closeFixture(fixture);
    }
  });
});
