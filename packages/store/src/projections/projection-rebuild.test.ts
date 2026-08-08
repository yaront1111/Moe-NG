import { describe, expect, it } from "vitest";

import type { ProjectionReducer, ProjectionState } from "./projection-fold.js";
import type { StoredEventUpcaster } from "./projection-upcast.js";
import {
  DRILL_ORIGIN_DIGEST, DRILL_ORIGIN_STATE, DRILL_PROJECTION, DRILL_REDUCERS, DRILL_UPCASTER,
  PLAIN_EVENT, countRows, crashCommit, curatedHistory, drillCommitInput, readDurableProjection,
  relayHistory, withDrillDatabase, withDrillDirectory, withDrillStore,
} from "./projection-drill-test-helpers.js";
import { rebuildProjection } from "./projection-rebuild.js";
import type {
  ProjectionRebuildRefused, ProjectionRebuildResult, ProjectionRebuilt,
} from "./projection-rebuild.js";

/**
 * DoD 2: a full rebuild from the event ledger reproduces the incrementally-relayed state
 * byte for byte. Digest equality is the byte-identity proof — the canonical encoder key-sorts
 * and length-frames every field, so two states sharing a digest cannot differ in ordering,
 * whitespace, or field presence. Every refusal arm names its code AND its layer, and the
 * fold's own verdict is asserted separately from the rebuild's, because both can refuse.
 */

const FOREIGN_DIGEST = "f".repeat(64);
const NO_REDUCERS: Readonly<Record<string, ProjectionReducer>> = Object.freeze({});

interface RebuildOptions {
  readonly name?: string;
  readonly pageLimit?: number;
  readonly reducers?: Readonly<Record<string, ProjectionReducer>>;
  readonly state?: ProjectionState;
  readonly upcaster?: StoredEventUpcaster;
}

function show(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item);
}

function rebuild(path: string, options: RebuildOptions = {}): ProjectionRebuildResult {
  return withDrillStore(path, (store) => withDrillDatabase(path, (database) =>
    rebuildProjection(database, {
      name: options.name ?? DRILL_PROJECTION,
      pageLimit: options.pageLimit ?? 100,
      reducers: options.reducers ?? DRILL_REDUCERS,
      source: store,
      state: options.state ?? DRILL_ORIGIN_STATE,
      upcaster: options.upcaster ?? DRILL_UPCASTER,
    })));
}

function rebuilt(result: ProjectionRebuildResult): ProjectionRebuilt {
  if (result.outcome !== "REBUILT") {
    throw new Error(`expected a completed rebuild, got ${show(result)}`);
  }
  return result;
}

function refused(result: ProjectionRebuildResult): ProjectionRebuildRefused {
  if (result.outcome !== "REFUSED") {
    throw new Error(`expected a refusal, got ${show(result)}`);
  }
  return result;
}

function tamper(path: string, position: string, digest: string | null): void {
  withDrillDatabase(path, (database) => {
    database
      .prepare("UPDATE projections SET last_applied_position = ?, state_digest = ? WHERE " +
        "projection_name = ?")
      .run(position, digest, DRILL_PROJECTION);
  });
}

describe("rebuildProjection", () => {
  it("reproduces the incrementally-relayed state and its durable digest", () => {
    withDrillDirectory((path) => {
      const incremental = withDrillStore(path, (store) => relayHistory(store, curatedHistory()));

      const result = rebuilt(rebuild(path));

      expect(result.stateDigest).toBe(incremental.digest);
      expect(result.checkpoint.globalPosition).toBe(incremental.checkpoint);
      expect(result.state).toStrictEqual(incremental.state);
      // The `up:` prefix only exists downstream of the upcast hop.
      expect(result.state["names"]).toStrictEqual(["up:renamed-3", "up:renamed-4"]);
      expect(result.state["count"]).toBe(5);
      const durable = withDrillDatabase(path, (database) => readDurableProjection(database));
      expect(durable).toStrictEqual({
        digest: incremental.digest, position: incremental.checkpoint,
      });
    });
  });

  it("reaches the same digest one event per page as it does in a single page", () => {
    withDrillDirectory((path) => {
      const incremental = withDrillStore(path, (store) => relayHistory(store, curatedHistory()));

      const paged = rebuilt(rebuild(path, { pageLimit: 1 }));

      expect(paged.pages).toBe(5);
      expect(paged.stateDigest).toBe(incremental.digest);
      expect(paged.state).toStrictEqual(incremental.state);
    });
  });

  it("changes nothing when it is run a second time", () => {
    withDrillDirectory((path) => {
      withDrillStore(path, (store) => relayHistory(store, curatedHistory()));
      const first = rebuilt(rebuild(path));
      const before = withDrillDatabase(path, (database) => readDurableProjection(database));

      const second = rebuilt(rebuild(path));

      expect(second.stateDigest).toBe(first.stateDigest);
      expect(second.checkpoint.globalPosition).toBe(first.checkpoint.globalPosition);
      const after = withDrillDatabase(path, (database) => ({
        row: readDurableProjection(database), rows: countRows(database, "projections"),
      }));
      expect(after.row).toStrictEqual(before);
      expect(after.rows).toBe(1);
    });
  });

  it("records the origin state at checkpoint zero for an empty ledger", () => {
    withDrillDirectory((path) => {
      withDrillStore(path, () => undefined);

      const result = rebuilt(rebuild(path));

      expect(result.checkpoint.globalPosition).toBe(0n);
      expect(result.pages).toBe(0);
      expect(result.stateDigest).toBe(DRILL_ORIGIN_DIGEST);
      expect(result.state).toStrictEqual(DRILL_ORIGIN_STATE);
      expect(withDrillDatabase(path, (database) => readDurableProjection(database)))
        .toStrictEqual({ digest: DRILL_ORIGIN_DIGEST, position: 0n });
    });
  });

  it("refuses a durable digest it did not recompute instead of overwriting it", () => {
    withDrillDirectory((path) => {
      const incremental = withDrillStore(path, (store) => relayHistory(store, curatedHistory()));
      tamper(path, String(incremental.checkpoint), FOREIGN_DIGEST);

      const result = refused(rebuild(path));

      expect(result.code).toBe("PROJECTION_REBUILD_STATE_CONFLICT");
      expect(result.layer).toBe("STATE");
      expect(result.fold).toBeNull();
      expect(withDrillDatabase(path, (database) => readDurableProjection(database)))
        .toStrictEqual({ digest: FOREIGN_DIGEST, position: incremental.checkpoint });
    });
  });

  it("verifies the durable digest even when one page spans it", () => {
    withDrillDirectory((path) => {
      const relayed = withDrillStore(path, (store) => {
        const carried = relayHistory(store, [crashCommit(0), crashCommit(1)]);
        for (let index = 2; index < 5; index += 1) {
          store.commit(drillCommitInput(crashCommit(index), index));
        }
        return carried;
      });
      expect(relayed.checkpoint).toBe(2n);
      tamper(path, "2", FOREIGN_DIGEST);

      // The whole five-event ledger fits in one page, so only clamping the walk at the
      // durable checkpoint can make it land there and compare digests instead of folding
      // straight past a row it never verified.
      const result = refused(rebuild(path, { pageLimit: 100 }));

      expect(result.code).toBe("PROJECTION_REBUILD_STATE_CONFLICT");
      expect(result.layer).toBe("STATE");
      expect(result.detail).toContain("position 2");
      expect(withDrillDatabase(path, (database) => readDurableProjection(database)))
        .toStrictEqual({ digest: FOREIGN_DIGEST, position: 2n });
    });
  });

  it("walks a page past an intact durable checkpoint to the end of the ledger", () => {
    withDrillDirectory((path) => {
      withDrillStore(path, (store) => {
        relayHistory(store, [crashCommit(0), crashCommit(1)]);
        for (let index = 2; index < 5; index += 1) {
          store.commit(drillCommitInput(crashCommit(index), index));
        }
      });

      const result = rebuilt(rebuild(path, { pageLimit: 100 }));

      expect(result.checkpoint.globalPosition).toBe(5n);
      expect(result.state["count"]).toBe(5);
      expect(withDrillDatabase(path, (database) => readDurableProjection(database)))
        .toStrictEqual({ digest: result.stateDigest, position: 5n });
    });
  });

  it("refuses a durable checkpoint that runs ahead of the ledger", () => {
    withDrillDirectory((path) => {
      const incremental = withDrillStore(path, (store) => relayHistory(store, curatedHistory()));
      const ahead = incremental.checkpoint + 40n;
      tamper(path, String(ahead), incremental.digest);

      const result = refused(rebuild(path));

      expect(result.code).toBe("PROJECTION_REBUILD_STATE_CONFLICT");
      expect(result.layer).toBe("STATE");
      expect(withDrillDatabase(path, (database) => readDurableProjection(database)))
        .toStrictEqual({ digest: incremental.digest, position: ahead });
    });
  });

  it("propagates the fold's own code and layer rather than a bare failure", () => {
    withDrillDirectory((path) => {
      const incremental = withDrillStore(path, (store) => relayHistory(store, curatedHistory()));

      const result = refused(rebuild(path, { reducers: NO_REDUCERS }));

      expect(result.code).toBe("PROJECTION_REBUILD_FOLD_REFUSED");
      expect(result.layer).toBe("PROJECTION");
      expect(result.fold).toMatchObject({
        code: "PROJECTION_FOLD_REDUCER_MISSING", eventId: "evt-1", layer: "REDUCER",
      });
      expect(withDrillDatabase(path, (database) => readDurableProjection(database)))
        .toStrictEqual({ digest: incremental.digest, position: incremental.checkpoint });
    });
  });

  it("refuses a page limit outside the ledger's bounded page size", () => {
    withDrillDirectory((path) => {
      withDrillStore(path, (store) => relayHistory(store, curatedHistory()));

      const result = refused(rebuild(path, { pageLimit: 0 }));

      expect(result.code).toBe("PROJECTION_REBUILD_INPUT_INVALID");
      expect(result.layer).toBe("INPUT");
      expect(result.detail).toContain("pageLimit");
    });
  });

  it("refuses an unusable projection name before it reads the ledger", () => {
    withDrillDirectory((path) => {
      withDrillStore(path, (store) => relayHistory(store, curatedHistory()));

      const result = refused(rebuild(path, { name: "" }));

      expect(result.code).toBe("PROJECTION_REBUILD_INPUT_INVALID");
      expect(result.layer).toBe("INPUT");
    });
  });

  it("refuses state the canonical encoder cannot represent", () => {
    withDrillDirectory((path) => {
      withDrillStore(path, () => undefined);

      const result = refused(rebuild(path, {
        reducers: Object.freeze({ [PLAIN_EVENT]: (state) => state }),
        state: { broken: new Date(0) as unknown as string },
      }));

      expect(result.code).toBe("PROJECTION_REBUILD_INPUT_INVALID");
      expect(result.layer).toBe("INPUT");
      expect(result.detail).toContain("state");
    });
  });
});
