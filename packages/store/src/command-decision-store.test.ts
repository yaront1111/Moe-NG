import { describe, expect, it } from "vitest";
import {
  bytes,
  proposedDecision,
  text,
} from "./command-decision-test-helpers.js";
import * as storeModule from "./index.js";

describe("expected-version command decision ledger outcomes", () => {
  it("atomically commits a composite-scoped factual decision and proposed effects", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      const result = store.commitExpectedVersionDecision(proposedDecision());

      expect(result).toMatchObject({
        disposition: "DECIDED",
        historical: false,
        requiresAffordanceRefresh: false,
        decision: {
          businessEventIds: ["event-1"],
          commandKind: "goal.create",
          coverage: "EXPECTED_VERSION_ONLY",
          effectDisposition: "EFFECTS_COMMITTED",
          expectedVersion: 0,
          key: {
            commandId: "command-1",
            principalId: "principal-1",
            projectId: "project-1",
          },
          observedVersion: 0,
          outboxMessageIds: ["message-1"],
          previousVersion: 0,
          currentVersion: 1,
          resultCode: "EFFECTS_COMMITTED",
          targetAggregateId: "goal-1",
        },
      });
      expect(result.decision.decisionId).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.decision.decisionSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.decision.requestSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(text(result.decision.resultBytes)).toBe('{"goalId":"goal-1"}');
      expect(result.decision.auditEventId).toBeNull();
      expect("nextAllowedCommands" in result.decision).toBe(false);
      expect(store.getAggregateVersion("goal-1")).toBe(1);
      expect(store.readEvents("goal-1").map((event) => event.eventId)).toEqual([
        "event-1",
      ]);
      const storedBusinessEvent = store.readEvents("goal-1")[0]!;
      expect(storedBusinessEvent).toMatchObject({
        commandId: expect.stringMatching(/^moe-internal:decision-effect:/u),
        decisionTrace: {
          commandId: "command-1",
          commandKind: "goal.create",
          principalId: "principal-1",
          projectId: "project-1",
          requestIdentityVersion: storeModule.COMMAND_DECISION_REQUEST_IDENTITY_VERSION,
          requestSha256: result.decision.requestSha256,
        },
      });
      expect(store.getCommandReceipt(storedBusinessEvent.commandId)?.requestSha256).toBe(
        storedBusinessEvent.requestSha256,
      );
      expect(store.readPendingOutbox().map((message) => message.messageId)).toEqual([
        "message-1",
      ]);

      const loaded = store.getCommandDecision({
        commandId: "command-1",
        principalId: "principal-1",
        projectId: "project-1",
      });
      expect(loaded).toEqual(result.decision);
      expect(store.readCommandDecisionsAfter(0n, 10)).toEqual({
        hasMore: false,
        items: [result.decision],
        nextCursor: result.decision.decisionPosition,
      });
    } finally {
      store.close();
    }
  });

  it("durably records a stale outcome and redacted audit on the global event ledger", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("seed"),
        commandId: "seed-command",
        committedAt: "2026-08-06T17:59:00.000Z",
        events: [
          {
            eventId: "seed-event",
            eventType: "goal.seeded",
            payload: bytes("seed-payload"),
          },
        ],
        expectedVersion: 0,
      });

      const result = store.commitExpectedVersionDecision(
        proposedDecision({
          committedResultBytes: bytes("caller-result-must-not-survive"),
          requestBytes: bytes("credential=SECRET_TOKEN; raw request"),
        }),
      );

      expect(result).toMatchObject({
        disposition: "DECIDED",
        historical: false,
        requiresAffordanceRefresh: false,
        decision: {
          businessEventIds: [],
          coverage: "EXPECTED_VERSION_ONLY",
          currentVersion: null,
          effectDisposition: "NO_BUSINESS_EFFECT",
          expectedVersion: 0,
          observedVersion: 1,
          outboxMessageIds: [],
          previousVersion: null,
          resultCode: "EXPECTED_VERSION_CONFLICT",
          targetAggregateId: "goal-1",
        },
      });
      expect(result.decision.auditEventId).toMatch(
        /^moe-internal:command-rejection-event:[0-9a-f]{64}$/u,
      );
      expect(text(result.decision.resultBytes)).not.toContain("SECRET_TOKEN");
      expect(text(result.decision.resultBytes)).not.toContain("caller-result");
      expect("nextAllowedCommands" in result.decision).toBe(false);

      expect(store.getAggregateVersion("goal-1")).toBe(1);
      expect(store.readEvents("goal-1").map((event) => event.eventId)).toEqual([
        "seed-event",
      ]);
      expect(store.readPendingOutbox()).toEqual([]);

      const timeline = store.readEventsAfter(0n, 10).items;
      expect(timeline).toHaveLength(2);
      const audit = timeline[1]!;
      expect(audit.eventId).toBe(result.decision.auditEventId);
      expect(audit.eventType).toBe("command.expected-version-rejected");
      const durableAuditText = `${text(audit.payload)} ${text(audit.metadata)}`;
      expect(durableAuditText).not.toContain("SECRET_TOKEN");
      expect(durableAuditText).not.toContain("caller-result");
      expect(durableAuditText).not.toContain("nextAllowedCommands");
      expect(durableAuditText).not.toContain("stack");
      expect(durableAuditText).not.toContain("SQL");

      store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("advance-after-stale"),
        commandId: "advance-after-stale-command",
        committedAt: "2026-08-06T18:01:00.000Z",
        events: [
          {
            eventId: "advance-after-stale-event",
            eventType: "goal.changed",
            payload: bytes("advance"),
          },
        ],
        expectedVersion: 1,
      });
      const replayInput = proposedDecision({
        decidedAt: "2026-08-06T18:02:00.000Z",
        requestBytes: bytes("credential=SECRET_TOKEN; raw request"),
      });
      Object.defineProperty(replayInput, "committedResultBytes", {
        get(): never {
          throw new Error("stale replay inspected replacement result");
        },
      });
      Object.defineProperty(replayInput, "events", {
        get(): never {
          throw new Error("stale replay inspected replacement effects");
        },
      });
      Object.defineProperty(replayInput, "correlationId", {
        configurable: true,
        get(): never {
          throw new Error("replay inspected replacement correlation");
        },
      });
      Object.defineProperty(replayInput, "decidedAt", {
        configurable: true,
        get(): never {
          throw new Error("replay inspected replacement timestamp");
        },
      });
      const replay = store.commitExpectedVersionDecision(replayInput);
      expect(replay).toEqual({
        decision: result.decision,
        disposition: "REPLAYED",
        historical: true,
        requiresAffordanceRefresh: true,
      });
      expect(
        store
          .readEventsAfter(0n, 10)
          .items.filter((event) => event.eventType === "command.expected-version-rejected"),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("durably rejects a future expected version without a business effect", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      const futureInput = proposedDecision({
        expectedVersion: 1,
        key: {
          commandId: "future-version-command",
          principalId: "principal-1",
          projectId: "project-1",
        },
        targetAggregateId: "future-version-goal",
      });
      Object.defineProperty(futureInput, "committedResultBytes", {
        get(): never {
          throw new Error("future-version rejection inspected result proposal");
        },
      });
      Object.defineProperty(futureInput, "events", {
        get(): never {
          throw new Error("future-version rejection inspected effect proposal");
        },
      });
      const result = store.commitExpectedVersionDecision(futureInput);
      expect(result.decision).toMatchObject({
        effectDisposition: "NO_BUSINESS_EFFECT",
        expectedVersion: 1,
        observedVersion: 0,
        resultCode: "EXPECTED_VERSION_CONFLICT",
      });
      expect(store.getAggregateVersion("future-version-goal")).toBe(0);
      expect(store.readEvents("future-version-goal")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("replays immutable history before reconsidering state or proposal-only fields", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      const first = store.commitExpectedVersionDecision(proposedDecision());

      store.commit({
        aggregateId: "goal-1",
        commandBytes: bytes("advance"),
        commandId: "advance-command",
        committedAt: "2026-08-06T18:01:00.000Z",
        events: [
          {
            eventId: "advance-event",
            eventType: "goal.advanced",
            payload: bytes("advance"),
          },
        ],
        expectedVersion: 1,
      });

      const replay = store.commitExpectedVersionDecision(
        proposedDecision({
          committedResultBytes: bytes("hostile-recomputed-result"),
          decidedAt: "2026-08-06T18:02:00.000Z",
          events: [
            {
              eventId: "hostile-recomputed-event",
              eventType: "goal.deleted",
              payload: bytes("hostile"),
            },
          ],
        }),
      );

      expect(replay).toEqual({
        decision: first.decision,
        disposition: "REPLAYED",
        historical: true,
        requiresAffordanceRefresh: true,
      });
      expect(store.readEvents("goal-1").map((event) => event.eventId)).toEqual([
        "event-1",
        "advance-event",
      ]);
      expect(text(replay.decision.resultBytes)).toBe('{"goalId":"goal-1"}');

      expect(() =>
        store.commitExpectedVersionDecision(
          proposedDecision({ requestBytes: bytes("different-request") }),
        ),
      ).toThrowError(/IDEMPOTENCY_CONFLICT/u);
      expect(store.readCommandDecisionsAfter(0n, 10).items).toEqual([first.decision]);
    } finally {
      store.close();
    }
  });

  it("binds every request-identity field before replay", () => {
    const variants: ReadonlyArray<{
      readonly name: string;
      readonly override: Partial<storeModule.CommitExpectedVersionDecisionInput>;
    }> = [
      { name: "command kind", override: { commandKind: "goal.delete" } },
      { name: "target aggregate", override: { targetAggregateId: "other-goal" } },
      { name: "expected version", override: { expectedVersion: 1 } },
      { name: "request bytes", override: { requestBytes: bytes("other-request") } },
    ];
    for (const variant of variants) {
      const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
      try {
        const first = store.commitExpectedVersionDecision(proposedDecision());
        expect(
          () =>
            store.commitExpectedVersionDecision(
              proposedDecision({
                ...variant.override,
                committedResultBytes: bytes(`replacement-${variant.name}`),
                decidedAt: "2026-08-06T18:04:00.000Z",
                events: [
                  {
                    eventId: `replacement-${variant.name}`,
                    eventType: "goal.changed",
                    payload: bytes("replacement"),
                  },
                ],
              }),
            ),
          variant.name,
        ).toThrowError(/IDEMPOTENCY_CONFLICT/u);
        expect(store.readCommandDecisionsAfter(0n, 10).items).toEqual([first.decision]);
        expect(store.readEvents("goal-1").map((event) => event.eventId)).toEqual([
          "event-1",
        ]);
        expect(store.getAggregateVersion("other-goal")).toBe(0);
      } finally {
        store.close();
      }
    }
  });

  it("allows one raw command ID in independent principal scopes within one project", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      const first = store.commitExpectedVersionDecision(proposedDecision());
      const second = store.commitExpectedVersionDecision(
        proposedDecision({
          committedResultBytes: bytes("second"),
          events: [
            {
              eventId: "event-2",
              eventType: "goal.created",
              payload: bytes("payload-2"),
            },
          ],
          key: {
            commandId: "command-1",
            principalId: "principal-2",
            projectId: "project-1",
          },
          targetAggregateId: "goal-2",
        }),
      );

      expect(first.decision.decisionId).not.toBe(second.decision.decisionId);
      expect(first.decision.key.commandId).toBe(second.decision.key.commandId);
      expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("length-frames composite keys so delimiter and boundary ambiguity cannot alias", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      const first = store.commitExpectedVersionDecision(
        proposedDecision({
          events: [
            {
              eventId: "ambiguous-event-1",
              eventType: "goal.created",
              payload: bytes("one"),
            },
          ],
          key: { commandId: "d|e", principalId: "bc", projectId: "project-1" },
          targetAggregateId: "ambiguous-goal-1",
        }),
      );
      const second = store.commitExpectedVersionDecision(
        proposedDecision({
          events: [
            {
              eventId: "ambiguous-event-2",
              eventType: "goal.created",
              payload: bytes("two"),
            },
          ],
          key: { commandId: "cd|e", principalId: "b", projectId: "project-1" },
          targetAggregateId: "ambiguous-goal-2",
        }),
      );

      expect(first.decision.decisionId).not.toBe(second.decision.decisionId);
      expect(store.readCommandDecisionsAfter(0n, 10).items).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("does not inspect proposal-only fields for a stale decision or historical replay", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      const first = store.commitExpectedVersionDecision(proposedDecision());
      const replayInput = proposedDecision({ decidedAt: "2026-08-06T18:05:00.000Z" });
      Object.defineProperty(replayInput, "committedResultBytes", {
        configurable: true,
        get(): never {
          throw new Error("replay inspected recomputed result");
        },
      });
      Object.defineProperty(replayInput, "events", {
        configurable: true,
        get(): never {
          throw new Error("replay inspected recomputed effects");
        },
      });
      expect(
        store.commitExpectedVersionDecision(replayInput).decision.decisionSha256,
      ).toBe(first.decision.decisionSha256);

      store.commit({
        aggregateId: "stale-goal",
        commandBytes: bytes("seed-stale"),
        commandId: "seed-stale-command",
        committedAt: "2026-08-06T18:06:00.000Z",
        events: [
          {
            eventId: "seed-stale-event",
            eventType: "goal.seeded",
            payload: bytes("seed"),
          },
        ],
        expectedVersion: 0,
      });
      const staleInput = proposedDecision({
        decidedAt: "2026-08-06T18:07:00.000Z",
        key: {
          commandId: "stale-command",
          principalId: "principal-1",
          projectId: "project-1",
        },
        targetAggregateId: "stale-goal",
      });
      Object.defineProperty(staleInput, "committedResultBytes", {
        configurable: true,
        get(): never {
          throw new Error("stale path inspected result proposal");
        },
      });
      Object.defineProperty(staleInput, "events", {
        configurable: true,
        get(): never {
          throw new Error("stale path inspected effect proposal");
        },
      });
      expect(
        store.commitExpectedVersionDecision(staleInput).decision.effectDisposition,
      ).toBe("NO_BUSINESS_EFFECT");
    } finally {
      store.close();
    }
  });

  it("copies decision inputs and outputs and enforces blob limits", () => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest("project-1");
    try {
      const requestBytes = bytes("stable-request");
      const resultBytes = bytes("stable-result");
      const eventPayload = bytes("stable-event");
      const result = store.commitExpectedVersionDecision(
        proposedDecision({
          committedResultBytes: resultBytes,
          events: [
            {
              eventId: "copy-event",
              eventType: "goal.created",
              payload: eventPayload,
            },
          ],
          requestBytes,
        }),
      );
      requestBytes.fill(0);
      resultBytes.fill(0);
      eventPayload.fill(0);
      result.decision.resultBytes.fill(0);

      const loaded = store.getCommandDecision(result.decision.key)!;
      expect(text(loaded.resultBytes)).toBe("stable-result");
      expect(text(store.readEvents("goal-1")[0]!.payload)).toBe("stable-event");
      expect(() =>
        store.commitExpectedVersionDecision(
          proposedDecision({
            committedResultBytes: new Uint8Array(storeModule.MAX_BLOB_BYTES + 1),
            events: [
              {
                eventId: "oversized-result-event",
                eventType: "goal.created",
                payload: bytes("payload"),
              },
            ],
            key: {
              commandId: "oversized-result",
              principalId: "principal-1",
              projectId: "project-1",
            },
            targetAggregateId: "oversized-result-goal",
          }),
        ),
      ).toThrowError(/STORE_LIMIT_EXCEEDED/u);
      expect(
        store.getCommandDecision({
          commandId: "oversized-result",
          principalId: "principal-1",
          projectId: "project-1",
        }),
      ).toBeNull();
    } finally {
      store.close();
    }
  });

});
