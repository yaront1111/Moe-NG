import { expect, it } from "vitest";

import * as storeModule from "./index.js";
import type { CommitInput, EventDraft, StoredEvent } from "./index.js";
import { DOMAIN_EVENT_SCHEMA_VERSION } from "./store-contracts.js";
import { bytes, proposedDecision, text } from "./command-decision-test-helpers.js";

const COMMITTED_AT = "2026-08-08T12:00:00.000Z";
const CUSTOM_VERSION = "moe-domain-schema/2";
const OTHER_VERSION = "moe-domain-schema/7";
const BAD_DETAIL =
  "must be well-formed, non-empty, at most 512 UTF-8 bytes, and contain no NUL";

function withStore(
  run: (store: storeModule.SqliteEventStore) => void,
  // proposedDecision() is scoped to "project-1"; decision tests must bind to it.
  projectId = "project-domain-schema",
): void {
  const store = storeModule.SqliteEventStore.openEphemeralForProjectTest(projectId);
  try {
    run(store);
  } finally {
    store.close();
  }
}

function commitInput(overrides: Partial<EventDraft> = {}): CommitInput {
  return {
    aggregateId: "goal-a",
    commandBytes: new Uint8Array([1, 2, 3]),
    commandId: "command-a",
    committedAt: COMMITTED_AT,
    events: [
      {
        eventId: "event-a",
        eventType: "goal.created",
        payload: new Uint8Array([4, 5]),
        ...overrides,
      },
    ],
    expectedVersion: 0,
  };
}

/** Every public read path that materializes a StoredEvent. */
function readEveryPath(store: storeModule.SqliteEventStore): readonly StoredEvent[] {
  return [
    store.readEvents("goal-a")[0]!,
    store.readAggregateEvents("goal-a").items[0]!,
    store.readEventsAfter(0n).items[0]!,
  ];
}

it("defaults the domain schema version and reads it back on every read path", () => {
  withStore((store) => {
    store.commit(commitInput());
    expect(DOMAIN_EVENT_SCHEMA_VERSION).toBe("moe-domain-schema/0");
    for (const event of readEveryPath(store)) {
      expect(event.domainSchemaVersion).toBe(DOMAIN_EVENT_SCHEMA_VERSION);
    }
  });
});

it("reads an explicit caller version back unchanged on every read path", () => {
  withStore((store) => {
    store.commit(commitInput({ domainSchemaVersion: CUSTOM_VERSION }));
    for (const event of readEveryPath(store)) {
      expect(event.domainSchemaVersion).toBe(CUSTOM_VERSION);
    }
  });
});

it("records a distinct version per event so an upcaster can dispatch per event", () => {
  withStore((store) => {
    store.commit({
      aggregateId: "goal-a",
      commandBytes: new Uint8Array([9]),
      commandId: "command-mixed",
      committedAt: COMMITTED_AT,
      events: [
        {
          domainSchemaVersion: CUSTOM_VERSION,
          eventId: "event-mixed-1",
          eventType: "goal.created",
          payload: new Uint8Array([1]),
        },
        {
          domainSchemaVersion: OTHER_VERSION,
          eventId: "event-mixed-2",
          eventType: "goal.renamed",
          payload: new Uint8Array([2]),
        },
        {
          eventId: "event-mixed-3",
          eventType: "goal.archived",
          payload: new Uint8Array([3]),
        },
      ],
      expectedVersion: 0,
    });

    expect(
      store.readEvents("goal-a").map((event) => event.domainSchemaVersion),
    ).toStrictEqual([CUSTOM_VERSION, OTHER_VERSION, DOMAIN_EVENT_SCHEMA_VERSION]);
  });
});

type InvalidCase = readonly [string, unknown];

const INVALID_VERSIONS: readonly InvalidCase[] = [
  ["an empty string", ""],
  ["a non-string", 3],
  ["a null", null],
  ["an object", {}],
  ["an oversized string", "v".repeat(513)],
  ["an embedded NUL", `moe${String.fromCharCode(0)}schema`],
];

for (const [name, value] of INVALID_VERSIONS) {
  it(`rejects ${name} domain schema version and persists nothing`, () => {
    withStore((store) => {
      const draft = { domainSchemaVersion: value } as unknown as Partial<EventDraft>;
      try {
        store.commit(commitInput(draft));
      } catch (error) {
        expect(error).toBeInstanceOf(storeModule.DurableStoreError);
        expect((error as storeModule.DurableStoreError).code).toBe("STORE_INPUT_INVALID");
        expect((error as storeModule.DurableStoreError).message).toBe(
          `STORE_INPUT_INVALID: events[0].domainSchemaVersion ${BAD_DETAIL}`,
        );
        expect(store.readEventsAfter(0n).items).toStrictEqual([]);
        expect(store.getAggregateVersion("goal-a")).toBe(0);
        return;
      }
      throw new Error(`expected ${name} to be rejected`);
    });
  });
}

it("keeps the domain schema version out of the request and effect digests", () => {
  const results = [DOMAIN_EVENT_SCHEMA_VERSION, CUSTOM_VERSION].map((version) => {
    const store = storeModule.SqliteEventStore.openEphemeralForProjectTest(
      "project-domain-schema",
    );
    try {
      return store.commit(commitInput({ domainSchemaVersion: version }));
    } finally {
      store.close();
    }
  });

  // Byte-identical commits differing ONLY in domainSchemaVersion must digest
  // identically: the field is deliberately outside both identity functions, so a
  // later upcaster can rewrite it without invalidating a durable receipt.
  expect(results[0]!.requestSha256).toBe(results[1]!.requestSha256);
  expect(results[0]!.effectSha256).toBe(results[1]!.effectSha256);
});

it("re-proves a receipt whose events carry a non-default version", () => {
  withStore((store) => {
    const committed = store.commit(commitInput({ domainSchemaVersion: CUSTOM_VERSION }));

    // loadReceipt rebuilds effect events from durable rows and re-proves the
    // stored effect digest. If the field entered that digest the write and
    // replay sides would diverge and this would throw STORE_CORRUPT.
    const receipt = store.getCommandReceipt("command-a");
    expect(receipt).not.toBeNull();
    expect(receipt!.effectSha256).toBe(committed.effectSha256);
    expect(receipt!.requestSha256).toBe(committed.requestSha256);
  });
});

it("stamps the default version on a rejection audit event", () => {
  withStore((store) => {
    store.commit({
      aggregateId: "goal-1",
      commandBytes: bytes("seed"),
      commandId: "seed-command",
      committedAt: COMMITTED_AT,
      events: [
        {
          eventId: "seed-event",
          eventType: "goal.seeded",
          payload: bytes("seed-payload"),
        },
      ],
      expectedVersion: 0,
    });

    const result = store.commitExpectedVersionDecision(proposedDecision());
    expect(result.decision.resultCode).toBe("EXPECTED_VERSION_CONFLICT");

    const timeline = store.readEventsAfter(0n, 10).items;
    const audit = timeline.find(
      (event) => event.eventType === "command.expected-version-rejected",
    );
    expect(audit).toBeDefined();
    expect(audit!.eventId).toBe(result.decision.auditEventId);
    expect(audit!.domainSchemaVersion).toBe(DOMAIN_EVENT_SCHEMA_VERSION);
    expect(text(audit!.payload)).not.toContain("domainSchemaVersion");
  }, "project-1");
});

it("carries the version through a decision's committed business events", () => {
  withStore((store) => {
    store.commitExpectedVersionDecision(
      proposedDecision({
        events: [
          {
            domainSchemaVersion: CUSTOM_VERSION,
            eventId: "event-1",
            eventType: "goal.created",
            payload: bytes("payload-1"),
          },
        ],
      }),
    );

    const stored = store.readEvents("goal-1")[0]!;
    expect(stored.domainSchemaVersion).toBe(CUSTOM_VERSION);
  }, "project-1");
});
