import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SqliteEventStore } from "../sqlite-event-store.js";
import { bytes } from "../sqlite-event-store-test-helpers.js";
import { snapshotSubscriberId } from "./subscription-contracts.js";
import type {
  GenerationBaseline, SnapshotDoc, SubscriptionAckResult, SubscriptionAdvanceResult,
  SubscriptionCursor, SubscriptionPublishResult, SubscriptionRefused, SubscriptionSeatResult,
} from "./subscription-contracts.js";
import { readSubscriptionPage } from "./subscription-read-page.js";
import {
  acknowledge, advanceGeneration, publishSnapshot, registerSubscription, reseatToSnapshot,
} from "./subscription-writes.js";

const AGGREGATE = "goal-1";
const AT = "2026-08-08T10:00:00.000Z";
const EVENT_TYPE = "goal.created";
const OTHER_PROJECTION = "goal-audit";
const PROJECT = "moe-subscription-project";
const PROJECTION = "goal-count";
const STATE_DIGEST = "a".repeat(64);
const SUBSCRIBER = "goal-consumer";

type AnyResult =
  | SubscriptionAckResult | SubscriptionAdvanceResult | SubscriptionPublishResult
  | SubscriptionSeatResult;

interface Harness {
  readonly database: DatabaseSync;
  readonly path: string;
  readonly store: SqliteEventStore;
}

function openHarness(path: string): Harness {
  const store = SqliteEventStore.openForProject(path, PROJECT);
  return { database: new DatabaseSync(path, { timeout: 5_000 }), path, store };
}

function closeHarness(harness: Harness): void {
  harness.database.close();
  harness.store.close();
}

function withDirectory(run: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "moe-subscriptions-"));
  try {
    run(join(directory, "events.sqlite"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withHarness(run: (harness: Harness) => void): void {
  withDirectory((path) => {
    const harness = openHarness(path);
    try {
      run(harness);
    } finally {
      closeHarness(harness);
    }
  });
}

function commitEvent(store: SqliteEventStore, index: number): void {
  store.commit({
    aggregateId: AGGREGATE, commandBytes: bytes(`{"n":${index}}`), commandId: `cmd-${index}`,
    committedAt: AT,
    events: [{ eventId: `evt-${index}`, eventType: EVENT_TYPE, payload: bytes(`p-${index}`) }],
    expectedVersion: index - 1,
  });
}

/** The relay's durable output, written directly so this suite never imports the relay. */
function setCheckpoint(database: DatabaseSync, projection: string, position: bigint): void {
  database.prepare(`INSERT INTO projections (projection_name, last_applied_position, state_digest)
    VALUES (?, ?, NULL) ON CONFLICT(projection_name)
    DO UPDATE SET last_applied_position = excluded.last_applied_position`)
    .run(projection, position.toString());
}

function baseline(projection: string, checkpoint: bigint, count = 0): GenerationBaseline {
  return { checkpoint, projection, state: { count }, stateDigest: STATE_DIGEST };
}

function storedDoc(database: DatabaseSync, subscriberId: string): string | null {
  const row = database.prepare("SELECT filter_json FROM event_subscriptions WHERE subscriber_id = ?")
    .get(subscriberId);
  return row === undefined ? null : String(row["filter_json"]);
}

function seed(harness: Harness, checkpoint = 0n, projections = [PROJECTION]): void {
  const advanced = advanceGeneration(harness.database, {
    at: AT, baselines: projections.map((name) => baseline(name, checkpoint)), reason: "initial",
  });
  if (advanced.outcome !== "ADVANCED") {
    throw new Error(`expected a seeded generation, got ${JSON.stringify(advanced)}`);
  }
}

function refused(result: AnyResult): SubscriptionRefused {
  if (result.outcome !== "REFUSED") {
    throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  }
  return result;
}

function seated(result: SubscriptionSeatResult): { cursor: string; snapshot: SnapshotDoc } {
  if (result.outcome === "REFUSED") {
    throw new Error(`expected a seated cursor, got ${JSON.stringify(result)}`);
  }
  return { cursor: result.cursor.position, snapshot: result.snapshot };
}

function register(harness: Harness, subscriberId = SUBSCRIBER): SubscriptionSeatResult {
  return registerSubscription(harness.database, {
    at: AT, filter: [EVENT_TYPE], projection: PROJECTION, subscriberId,
  });
}

function issuedCursor(harness: Harness, limit: number, database = harness.database): SubscriptionCursor {
  const result = readSubscriptionPage(harness.store, database, {
    limit, projection: PROJECTION, subscriberId: SUBSCRIBER,
  });
  if (result.outcome !== "PAGE" || result.nextCursor === null) {
    throw new Error(`expected an issued page cursor, got ${result.outcome}`);
  }
  return result.nextCursor;
}

describe("registerSubscription", () => {
  it("refuses before any cursor generation exists", () => {
    withHarness((harness) => {
      const result = refused(register(harness));

      expect(result.code).toBe("SUBSCRIPTION_GENERATION_MISSING");
      expect(result.layer).toBe("STATE");
      expect(storedDoc(harness.database, SUBSCRIBER)).toBeNull();
    });
  });

  it("seats a new cursor at the baseline checkpoint and returns the snapshot", () => {
    withHarness((harness) => {
      seed(harness, 4n);
      setCheckpoint(harness.database, PROJECTION, 4n);

      const result = seated(register(harness));

      expect(result.cursor).toBe("4");
      expect(result.snapshot.checkpoint).toBe("4");
      expect(result.snapshot.generation).toBe(1);
      expect(result.snapshot.projection).toBe(PROJECTION);
      expect(storedDoc(harness.database, SUBSCRIBER)).not.toBeNull();
    });
  });

  it("refuses a duplicate registration without disturbing the seated cursor", () => {
    withHarness((harness) => {
      seed(harness, 4n);
      seated(register(harness));
      const before = storedDoc(harness.database, SUBSCRIBER);

      const result = refused(register(harness));

      expect(result.code).toBe("SUBSCRIPTION_INPUT_INVALID");
      expect(result.layer).toBe("INPUT");
      expect(storedDoc(harness.database, SUBSCRIBER)).toBe(before);
    });
  });

  it("allows an ORIGIN start only while the whole ledger is still retained", () => {
    withHarness((harness) => {
      seed(harness);
      const empty = registerSubscription(harness.database, {
        at: AT, projection: PROJECTION, startMode: "ORIGIN", subscriberId: "from-origin",
      });
      expect(seated(empty).cursor).toBe("0");

      commitEvent(harness.store, 1);
      commitEvent(harness.store, 2);
      expect(seated(registerSubscription(harness.database, {
        at: AT, projection: PROJECTION, startMode: "ORIGIN", subscriberId: "from-origin-2",
      })).cursor).toBe("0");

      harness.database.prepare("DELETE FROM domain_events WHERE global_position = 1").run();
      const pruned = refused(registerSubscription(harness.database, {
        at: AT, projection: PROJECTION, startMode: "ORIGIN", subscriberId: "from-origin-3",
      }));
      expect(pruned.code).toBe("SUBSCRIPTION_INPUT_INVALID");
      expect(pruned.detail).toContain("retained history");
    });
  });
});

describe("reserved snapshot sentinel ids", () => {
  const entryPoints: readonly (readonly [string, (harness: Harness, id: string) => AnyResult])[] = [
    ["registerSubscription", (harness, id) => register(harness, id)],
    ["acknowledge", (harness, id) => acknowledge(harness.database, {
      cursor: { generation: 1, position: "1" }, subscriberId: id,
    })],
    ["reseatToSnapshot", (harness, id) => reseatToSnapshot(harness.database, {
      projection: PROJECTION, subscriberId: id,
    })],
  ];

  it("covers every subscriber-facing entry point", () => {
    expect(entryPoints.length).toBeGreaterThan(0);
  });

  it.each(entryPoints)("%s refuses a sentinel id and leaves the baseline intact", (_label, call) => {
    withHarness((harness) => {
      seed(harness, 4n);
      const sentinel = snapshotSubscriberId(PROJECTION);
      const before = storedDoc(harness.database, sentinel);

      const result = refused(call(harness, sentinel));

      expect(result.code).toBe("SUBSCRIPTION_INPUT_INVALID");
      expect(result.layer).toBe("INPUT");
      expect(storedDoc(harness.database, sentinel)).toBe(before);
    });
  });
});

describe("advanceGeneration", () => {
  it("numbers generations from one and upserts the baseline sentinel", () => {
    withHarness((harness) => {
      seed(harness);

      const second = advanceGeneration(harness.database, {
        at: AT, baselines: [baseline(PROJECTION, 2n, 7)], reason: "rebuild",
      });

      expect(second).toEqual({ generation: 2, outcome: "ADVANCED" });
      const seatedCursor = seated(register(harness));
      expect(seatedCursor.snapshot.generation).toBe(2);
      expect(seatedCursor.snapshot.state).toEqual({ count: 7 });
    });
  });

  it("refuses unless every covered projection carries a baseline", () => {
    withHarness((harness) => {
      seed(harness, 0n, [PROJECTION, OTHER_PROJECTION]);
      const generations = () => harness.database
        .prepare("SELECT COUNT(*) AS total FROM cursor_generations").get()?.["total"];
      expect(generations()).toBe(1);

      const partial = refused(advanceGeneration(harness.database, {
        at: AT, baselines: [baseline(PROJECTION, 1n)], reason: "rebuild",
      }));

      expect(partial.code).toBe("SUBSCRIPTION_GENERATION_BASELINE_MISSING");
      expect(partial.layer).toBe("STATE");
      expect(partial.detail).toContain(OTHER_PROJECTION);
      expect(generations()).toBe(1);

      const full = advanceGeneration(harness.database, {
        at: AT, baselines: [baseline(PROJECTION, 1n), baseline(OTHER_PROJECTION, 1n)],
        reason: "rebuild",
      });
      expect(full).toEqual({ generation: 2, outcome: "ADVANCED" });
      expect(generations()).toBe(2);
    });
  });

  it("counts a live subscriber as covered even before its projection has a sentinel", () => {
    withHarness((harness) => {
      seed(harness, 0n, [PROJECTION]);
      seated(register(harness));
      harness.database.prepare("DELETE FROM event_subscriptions WHERE subscriber_id = ?")
        .run(snapshotSubscriberId(PROJECTION));

      const result = refused(advanceGeneration(harness.database, {
        at: AT, baselines: [baseline(OTHER_PROJECTION, 1n)], reason: "rebuild",
      }));

      expect(result.code).toBe("SUBSCRIPTION_GENERATION_BASELINE_MISSING");
      expect(result.detail).toContain(PROJECTION);
    });
  });
});

describe("publishSnapshot", () => {
  it("advances the baseline for the current generation", () => {
    withHarness((harness) => {
      seed(harness);

      const result = publishSnapshot(harness.database, {
        checkpoint: 5n, generation: 1, projection: PROJECTION,
        state: { count: 5 }, stateDigest: STATE_DIGEST,
      });

      expect(result.outcome).toBe("PUBLISHED");
      setCheckpoint(harness.database, PROJECTION, 5n);
      expect(seated(register(harness)).cursor).toBe("5");
    });
  });

  it("refuses a checkpoint regression", () => {
    withHarness((harness) => {
      seed(harness, 5n);

      const result = refused(publishSnapshot(harness.database, {
        checkpoint: 4n, generation: 1, projection: PROJECTION,
        state: { count: 4 }, stateDigest: STATE_DIGEST,
      }));

      expect(result.code).toBe("SUBSCRIPTION_SNAPSHOT_REGRESSION");
      expect(result.layer).toBe("STATE");
    });
  });

  it("refuses a publish whose generation was superseded after the caller read it", () => {
    withHarness((harness) => {
      seed(harness);
      const stale = {
        checkpoint: 5n, generation: 1, projection: PROJECTION,
        state: { count: 5 }, stateDigest: STATE_DIGEST,
      };
      const racedIn = advanceGeneration(harness.database, {
        at: AT, baselines: [baseline(PROJECTION, 0n, 99)], reason: "raced",
      });
      expect(racedIn.outcome).toBe("ADVANCED");

      const result = refused(publishSnapshot(harness.database, stale));

      expect(result.code).toBe("SUBSCRIPTION_GENERATION_MISSING");
      expect(result.layer).toBe("STATE");
      expect(seated(register(harness)).snapshot.state).toEqual({ count: 99 });
    });
  });

  it("refuses when the baseline sentinel is gone", () => {
    withHarness((harness) => {
      seed(harness);
      harness.database.prepare("DELETE FROM event_subscriptions WHERE subscriber_id = ?")
        .run(snapshotSubscriberId(PROJECTION));

      const result = refused(publishSnapshot(harness.database, {
        checkpoint: 5n, generation: 1, projection: PROJECTION,
        state: { count: 5 }, stateDigest: STATE_DIGEST,
      }));

      expect(result.code).toBe("SUBSCRIPTION_STATE_CORRUPT");
      expect(result.layer).toBe("STATE");
      expect(result.detail).toContain("missing");
    });
  });
});

describe("acknowledge", () => {
  it("keeps the acknowledged cursor across a full reopen", () => {
    withDirectory((path) => {
      const first = openHarness(path);
      try {
        seed(first);
        for (let index = 1; index <= 9; index += 1) commitEvent(first.store, index);
        setCheckpoint(first.database, PROJECTION, 9n);
        seated(register(first));
        const result = acknowledge(first.database, {
          cursor: issuedCursor(first, 6), subscriberId: SUBSCRIBER,
        });
        expect(result).toEqual({ cursor: { generation: 1, position: "6" }, outcome: "ACKNOWLEDGED" });
      } finally {
        closeHarness(first);
      }

      const second = openHarness(path);
      try {
        const regression = refused(acknowledge(second.database, {
          cursor: { generation: 1, position: "5" }, subscriberId: SUBSCRIBER,
        }));
        expect(regression.code).toBe("SUBSCRIPTION_CURSOR_REGRESSION");
        expect(regression.layer).toBe("STATE");
        expect(acknowledge(second.database, {
          cursor: issuedCursor(second, 1), subscriberId: SUBSCRIBER,
        }).outcome).toBe("ACKNOWLEDGED");
      } finally {
        closeHarness(second);
      }
    });
  });

  it("refuses a cursor beyond the projection checkpoint", () => {
    withHarness((harness) => {
      seed(harness);
      for (let index = 1; index <= 3; index += 1) commitEvent(harness.store, index);
      setCheckpoint(harness.database, PROJECTION, 3n);
      seated(register(harness));
      expect(issuedCursor(harness, 3)).toEqual({ generation: 1, position: "3" });

      const result = refused(acknowledge(harness.database, {
        cursor: { generation: 1, position: "4" }, subscriberId: SUBSCRIBER,
      }));

      expect(result.code).toBe("SUBSCRIPTION_CURSOR_NOT_ISSUED");
      expect(result.layer).toBe("STATE");
    });
  });

  it("refuses a cursor from a superseded generation", () => {
    withHarness((harness) => {
      seed(harness);
      setCheckpoint(harness.database, PROJECTION, 3n);
      seated(register(harness));
      advanceGeneration(harness.database, {
        at: AT, baselines: [baseline(PROJECTION, 0n)], reason: "rebuild",
      });

      const result = refused(acknowledge(harness.database, {
        cursor: { generation: 1, position: "2" }, subscriberId: SUBSCRIBER,
      }));

      expect(result.code).toBe("SUBSCRIPTION_GENERATION_MISSING");
      expect(result.layer).toBe("STATE");
    });
  });

  it("refuses an unregistered subscriber", () => {
    withHarness((harness) => {
      seed(harness);

      const result = refused(acknowledge(harness.database, {
        cursor: { generation: 1, position: "1" }, subscriberId: "never-registered",
      }));

      expect(result.code).toBe("SUBSCRIPTION_NOT_REGISTERED");
      expect(result.layer).toBe("STATE");
    });
  });
});

describe("reseatToSnapshot", () => {
  it("reseats a corrupted cursor onto the current baseline", () => {
    withHarness((harness) => {
      seed(harness);
      seated(register(harness));
      advanceGeneration(harness.database, {
        at: AT, baselines: [baseline(PROJECTION, 3n, 3)], reason: "rebuild",
      });
      harness.database.prepare("UPDATE event_subscriptions SET filter_json = ? WHERE subscriber_id = ?")
        .run("{\"tampered\":true}", SUBSCRIBER);

      const result = seated(reseatToSnapshot(harness.database, {
        projection: PROJECTION, subscriberId: SUBSCRIBER,
      }));

      expect(result.cursor).toBe("3");
      expect(result.snapshot.generation).toBe(2);
      expect(result.snapshot.state).toEqual({ count: 3 });
    });
  });

  it("refuses when retained history no longer reaches the snapshot", () => {
    withHarness((harness) => {
      seed(harness);
      seated(register(harness));
      for (let index = 1; index <= 3; index += 1) {
        commitEvent(harness.store, index);
      }
      harness.database.prepare("DELETE FROM domain_events WHERE global_position <= 2").run();

      const result = refused(reseatToSnapshot(harness.database, {
        projection: PROJECTION, subscriberId: SUBSCRIBER,
      }));

      expect(result.code).toBe("SUBSCRIPTION_SNAPSHOT_STALE");
      expect(result.layer).toBe("STATE");
    });
  });

  it("refuses when the ledger is empty but the projection ran past the snapshot", () => {
    withHarness((harness) => {
      seed(harness);
      seated(register(harness));
      setCheckpoint(harness.database, PROJECTION, 5n);

      const result = refused(reseatToSnapshot(harness.database, {
        projection: PROJECTION, subscriberId: SUBSCRIBER,
      }));

      expect(result.code).toBe("SUBSCRIPTION_SNAPSHOT_STALE");
      expect(result.layer).toBe("STATE");
    });
  });

  it("refuses a projection the subscriber is not following", () => {
    withHarness((harness) => {
      seed(harness, 0n, [PROJECTION, OTHER_PROJECTION]);
      seated(register(harness));

      const result = refused(reseatToSnapshot(harness.database, {
        projection: OTHER_PROJECTION, subscriberId: SUBSCRIBER,
      }));

      expect(result.code).toBe("SUBSCRIPTION_INPUT_INVALID");
      expect(result.layer).toBe("INPUT");
    });
  });
});

describe("hostile input", () => {
  it("refuses malformed input at every write entry point", () => {
    withHarness((harness) => {
      seed(harness);
      const database = harness.database;
      const cases: readonly (readonly [string, () => AnyResult])[] = [
        ["a non-canonical timestamp", () => registerSubscription(database, {
          at: "2026-08-08", projection: PROJECTION, subscriberId: SUBSCRIBER,
        })],
        ["an empty subscriber id", () => registerSubscription(database, {
          at: AT, projection: PROJECTION, subscriberId: "",
        })],
        ["a null projection", () => registerSubscription(database, {
          at: AT, projection: null as unknown as string, subscriberId: SUBSCRIBER,
        })],
        ["an oversized filter", () => registerSubscription(database, {
          at: AT, filter: Array.from({ length: 65 }, (_unused, index) => `type-${index}`),
          projection: PROJECTION, subscriberId: SUBSCRIBER,
        })],
        ["a missing cursor", () => acknowledge(database, {
          cursor: undefined as unknown as SubscriptionCursor, subscriberId: SUBSCRIBER,
        })],
        ["an empty advance reason", () => advanceGeneration(database, {
          at: AT, baselines: [baseline(PROJECTION, 0n)], reason: "",
        })],
        ["a snapshot larger than the durable ceiling", () => publishSnapshot(database, {
          checkpoint: 1n, generation: 1, projection: PROJECTION,
          state: { blob: "x".repeat(70_000) }, stateDigest: STATE_DIGEST,
        })],
        ["a negative checkpoint", () => publishSnapshot(database, {
          checkpoint: -1n, generation: 1, projection: PROJECTION,
          state: { count: 1 }, stateDigest: STATE_DIGEST,
        })],
        ["a non-bigint checkpoint", () => publishSnapshot(database, {
          checkpoint: 1 as unknown as bigint, generation: 1, projection: PROJECTION,
          state: { count: 1 }, stateDigest: STATE_DIGEST,
        })],
        ["an empty reseat projection", () => reseatToSnapshot(database, {
          projection: "", subscriberId: SUBSCRIBER,
        })],
      ];
      expect(cases.length).toBeGreaterThan(0);

      for (const [label, call] of cases) {
        const result = refused(call());
        expect(result.code, label).toBe("SUBSCRIPTION_INPUT_INVALID");
        expect(result.layer, label).toBe("INPUT");
      }
      expect(storedDoc(harness.database, SUBSCRIBER)).toBeNull();
    });
  });
});

describe("write concurrency", () => {
  it("serializes two independent connections without losing an update", () => {
    withHarness((harness) => {
      seed(harness);
      for (let index = 1; index <= 9; index += 1) commitEvent(harness.store, index);
      setCheckpoint(harness.database, PROJECTION, 9n);
      seated(register(harness));
      const other = new DatabaseSync(harness.path, { timeout: 5_000 });

      try {
        expect(acknowledge(harness.database, {
          cursor: issuedCursor(harness, 5), subscriberId: SUBSCRIBER,
        }).outcome).toBe("ACKNOWLEDGED");

        const loser = refused(acknowledge(other, {
          cursor: { generation: 1, position: "3" }, subscriberId: SUBSCRIBER,
        }));

        expect(loser.code).toBe("SUBSCRIPTION_CURSOR_REGRESSION");
        expect(loser.layer).toBe("STATE");
        expect(acknowledge(other, {
          cursor: issuedCursor(harness, 2, other), subscriberId: SUBSCRIBER,
        }).outcome).toBe("ACKNOWLEDGED");
        expect(storedDoc(harness.database, SUBSCRIBER)).toContain("\"position\":\"7\"");
      } finally {
        other.close();
      }
    });
  });

  /** A string IS iterable, so it would refuse even without the array guard; the non-iterable
   *  case is the one that would otherwise escape as a raw TypeError. */
  it("refuses baselines that are not an array instead of throwing", () => {
    const shapes: readonly (readonly [string, unknown])[] = [
      ["a non-iterable object", { 0: baseline(PROJECTION, 1n), length: 1 }],
      ["a string", "every-projection"],
      ["null", null],
    ];

    withHarness((harness) => {
      seed(harness);
      expect(shapes.length).toBeGreaterThan(0);

      for (const [, baselines] of shapes) {
        const result = refused(advanceGeneration(harness.database, {
          at: AT, baselines: baselines as GenerationBaseline[], reason: "bad",
        }));

        expect(result.code).toBe("SUBSCRIPTION_INPUT_INVALID");
        expect(result.layer).toBe("INPUT");
      }
      expect(harness.database.prepare("SELECT COUNT(*) AS total FROM cursor_generations")
        .get()?.["total"]).toBe(1);
    });
  });

  it("reports a busy store instead of guessing", () => {
    withHarness((harness) => {
      seed(harness);
      const blocker = new DatabaseSync(harness.path, { timeout: 0 });
      blocker.exec("BEGIN IMMEDIATE");
      blocker.prepare("INSERT INTO cursor_generations (generation, created_at, reason) VALUES (9, ?, 'block')")
        .run(AT);
      const impatient = new DatabaseSync(harness.path, { timeout: 0 });

      try {
        const result = refused(registerSubscription(impatient, {
          at: AT, projection: PROJECTION, subscriberId: SUBSCRIBER,
        }));

        expect(result.code).toBe("SUBSCRIPTION_STORE_BUSY");
        expect(result.layer).toBe("STATE");
      } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        impatient.close();
      }
    });
  });
});
