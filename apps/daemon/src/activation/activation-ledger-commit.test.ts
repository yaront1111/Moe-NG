/**
 * The commit adapter, driven through a REAL file-backed SqliteEventStore.
 *
 * A fake store would prove only that the shapes line up. Every acceptance here
 * is re-read after REOPENING the file, because the question this task exists to
 * answer is what survives a restart, not what a live handle remembers.
 *
 * WINDOWS HANDLE DISCIPLINE: every store handle is closed inside the `it` body,
 * and in the race worker's `finally` BEFORE it posts its result. A handle held
 * across the temp-directory cleanup throws EPERM, which kills the vitest worker
 * with zero test output and reads as a native crash rather than as a leak.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { DurableStoreError, SqliteEventStore } from "@moe/store";
import type { CommandDecisionResponse, CommitExpectedVersionDecisionInput } from "@moe/store";
import { describe, expect, it } from "vitest";

import { commitActivationLedgerRecord } from "./activation-ledger-commit.js";
import {
  ACTIVATION_LEDGER_LAYER,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type {
  ActivationLedgerCommitInput,
  ActivationLedgerStore,
} from "./activation-ledger-contracts.js";
import { DERIVED, EFFECT_AGGREGATE, GRANT_ID, record } from "./activation-ledger-fixtures.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";

const PROJECT_ID = "activation-project";

function input(overrides: Partial<ActivationLedgerCommitInput> = {}): ActivationLedgerCommitInput {
  return {
    correlationId: "correlation-1",
    decidedAt: "2026-08-14T00:00:00.000Z",
    key: { commandId: "command-1", principalId: "principal-1", projectId: PROJECT_ID },
    record: record(),
    requestBytes: new TextEncoder().encode("activation-request-1"),
    ...overrides,
  };
}

/** One temp directory per test, removed in `finally` once every handle is closed. */
function withDirectory<T>(name: string, run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), `moe-activation-${name}-`));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function withStore<T>(databasePath: string, run: (store: SqliteEventStore) => T): T {
  const store = SqliteEventStore.openForProject(databasePath, PROJECT_ID);
  try {
    return run(store);
  } finally {
    store.close();
  }
}

/**
 * A delegate over the REAL store that records which store methods the adapter
 * reached for, and can be made to throw. Not a fake: every call it does forward
 * lands in the same file the assertions reopen.
 */
interface StoreSpy extends ActivationLedgerStore {
  readonly calls: string[];
}

function spyOn(store: SqliteEventStore, throwOnCommit?: Error): StoreSpy {
  const calls: string[] = [];
  return {
    calls,
    commitExpectedVersionDecision(commit: CommitExpectedVersionDecisionInput): CommandDecisionResponse {
      calls.push("commitExpectedVersionDecision");
      if (throwOnCommit !== undefined) throw throwOnCommit;
      return store.commitExpectedVersionDecision(commit);
    },
    readEvents(aggregateId: string) {
      calls.push("readEvents");
      return store.readEvents(aggregateId);
    },
  };
}

describe("activation ledger commit adapter", () => {
  it("commits one activation that survives reopening the file", () => {
    withDirectory("accept", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      const committed = withStore(databasePath, (store) =>
        commitActivationLedgerRecord(store, input()),
      );
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      expect(committed.disposition).toBe("COMMITTED");
      expect(committed.aggregateId).toBe(DERIVED);

      withStore(databasePath, (reopened) => {
        const events = reopened.readEvents(DERIVED);
        expect(events).toHaveLength(1);
        expect(events[0]?.eventId).toBe(GRANT_ID);
        const read = readActivationLedgerRecord(DERIVED, events);
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(read.record).toEqual(record());
      });
    });
  });

  it("replays the same command by resolving the DURABLE record, not by echoing the caller", () => {
    withDirectory("replay", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        const first = commitActivationLedgerRecord(store, input());
        const replayInput = input();
        const spy = spyOn(store);
        const second = commitActivationLedgerRecord(spy, replayInput);
        expect(first.ok && second.ok).toBe(true);
        if (!first.ok || !second.ok) return;
        expect(first.disposition).toBe("COMMITTED");
        expect(second.disposition).toBe("REPLAYED");
        expect(second.record).toEqual(first.record);
        expect(second.digest).toBe(first.digest);
        // `toEqual` alone cannot tell a durable answer from a transcript here,
        // because the caller handed in an equal record. These two can:
        //   - the adapter READ the derived aggregate back, so readEvents is on
        //     the call list and only on the replay path;
        //   - the returned record is a DIFFERENT object from the one passed in,
        //     because it was decoded out of the stored payload.
        expect(spy.calls).toEqual(["commitExpectedVersionDecision", "readEvents"]);
        expect(second.record).not.toBe(replayInput.record);
      });

      withStore(databasePath, (reopened) => {
        expect(reopened.readEvents(DERIVED)).toHaveLength(1);
        // The aggregate advanced exactly once. A replay that re-ran the append
        // would leave version 2 here even if the decision reported REPLAYED.
        expect(reopened.getAggregateVersion(DERIVED)).toBe(1);
      });
    });
  });

  /**
   * The hole a same-input replay test can never see.
   *
   * The store's replay identity (`identifyExpectedVersionRequest`) hashes only
   * version, projectId, principalId, commandId, commandKind, targetAggregateId,
   * expectedVersion and requestBytes. The `events` array is OUTSIDE it. So a
   * second call under the same key with byte-identical requestBytes replays
   * cleanly at the store while carrying a completely different activation — and
   * an adapter that answers a replay from its own input would hand back
   * authority for a grant that was never written.
   *
   * grantId is the sharpest field to drift: it is the durable event id, so the
   * durable answer and the candidate answer cannot be confused for each other.
   * Drifting `idempotencyKey` instead would change the DERIVED AGGREGATE and be
   * refused a whole layer earlier, by the store, as IDEMPOTENCY_CONFLICT — which
   * is why that variant proves nothing about this branch.
   */
  it("refuses a replay whose candidate drifted outside the store's request identity", () => {
    withDirectory("replay-drift", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        expect(commitActivationLedgerRecord(store, input()).ok).toBe(true);
        const drifted = commitActivationLedgerRecord(
          store,
          input({
            record: record({ grant: { ...record().grant, grantId: "grant-NEVER-COMMITTED" } }),
          }),
        );
        expect(drifted.ok).toBe(false);
        if (drifted.ok) return;
        // THIS ledger refused, at the commit stage, after reading the durable
        // bytes back — not the store. `storeCode` null is what says so: every
        // store-raised refusal in this suite carries its upstream code.
        expect(drifted.code).toBe("ACTIVATION_LEDGER_REPLAY_DIVERGED");
        expect(drifted.layer).toBe(ACTIVATION_LEDGER_LAYER);
        expect(drifted.outcome).toBe("REFUSED");
        expect(drifted.storeCode).toBeNull();
      });

      withStore(databasePath, (reopened) => {
        // The durable grant is still the first one, and nothing was appended.
        const events = reopened.readEvents(DERIVED);
        expect(events).toHaveLength(1);
        expect(events[0]?.eventId).toBe(GRANT_ID);
        expect(reopened.getAggregateVersion(DERIVED)).toBe(1);
      });
    });
  });

  it("never reaches for an apply callback, which would write daemon-owned tables", () => {
    withDirectory("no-apply", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        const spy = spyOn(store);
        expect(commitActivationLedgerRecord(spy, input()).ok).toBe(true);
        expect(spy.calls).toEqual(["commitExpectedVersionDecision"]);
        expect(spy.calls).not.toContain("commitExpectedVersionDecisionWithApply");
        expect(spy.calls).not.toContain("commitWithApply");
      });
    });
  });

  it("refuses a distinct command on the same pair with EXPECTED_VERSION_CONFLICT", () => {
    withDirectory("conflict", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        expect(commitActivationLedgerRecord(store, input()).ok).toBe(true);
        const second = commitActivationLedgerRecord(
          store,
          input({
            key: { commandId: "command-2", principalId: "principal-1", projectId: PROJECT_ID },
            record: record({ grant: { ...record().grant, grantId: "grant-0002" } }),
            requestBytes: new TextEncoder().encode("activation-request-2"),
          }),
        );
        expect(second.ok).toBe(false);
        if (second.ok) return;
        expect(second.code).toBe("ACTIVATION_LEDGER_EXPECTED_VERSION_CONFLICT");
        expect(second.layer).toBe(ACTIVATION_LEDGER_LAYER);
        expect(second.outcome).toBe("REFUSED");
        // The store's own code, preserved rather than flattened into ours.
        expect(second.storeCode).toBe("EXPECTED_VERSION_CONFLICT");
      });

      withStore(databasePath, (reopened) => {
        expect(reopened.readEvents(DERIVED)).toHaveLength(1);
        expect(reopened.readEvents(DERIVED)[0]?.eventId).toBe(GRANT_ID);
      });
    });
  });

  it("refuses a reused grantId on a different aggregate with the store's uniqueness code", () => {
    withDirectory("grant-reuse", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      const otherKey = "idem-key-2";
      const otherDerived = deriveActivationAggregateId(EFFECT_AGGREGATE, otherKey);
      withStore(databasePath, (store) => {
        expect(commitActivationLedgerRecord(store, input()).ok).toBe(true);
        const reused = commitActivationLedgerRecord(
          store,
          input({
            key: { commandId: "command-3", principalId: "principal-1", projectId: PROJECT_ID },
            record: record({
              effectIntent: { ...record().effectIntent, idempotencyKey: otherKey },
            }),
            requestBytes: new TextEncoder().encode("activation-request-3"),
          }),
        );
        expect(reused.ok).toBe(false);
        if (reused.ok) return;
        expect(reused.code).toBe("ACTIVATION_LEDGER_GRANT_ID_CONFLICT");
        expect(reused.layer).toBe(ACTIVATION_LEDGER_LAYER);
        expect(reused.storeCode).toBe("DURABLE_ID_CONFLICT");
      });

      withStore(databasePath, (reopened) => {
        expect(reopened.readEvents(DERIVED)).toHaveLength(1);
        expect(reopened.readEvents(otherDerived)).toHaveLength(0);
      });
    });
  });

  it("refuses the same command id carrying a different request with IDEMPOTENCY_CONFLICT", () => {
    withDirectory("idempotency", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        expect(commitActivationLedgerRecord(store, input()).ok).toBe(true);
        const drifted = commitActivationLedgerRecord(
          store,
          input({ requestBytes: new TextEncoder().encode("a-different-request") }),
        );
        expect(drifted.ok).toBe(false);
        if (drifted.ok) return;
        expect(drifted.code).toBe("ACTIVATION_LEDGER_IDEMPOTENCY_CONFLICT");
        expect(drifted.storeCode).toBe("IDEMPOTENCY_CONFLICT");
      });
    });
  });

  it("maps a store input fault to FIELD_INVALID rather than to an availability refusal", () => {
    // Swept rather than hand-picked, and the sweep asserts its own cardinality
    // so an empty table cannot pass while testing nothing.
    const inputFaults = ["STORE_INPUT_INVALID", "STORE_LIMIT_EXCEEDED"] as const;
    expect(inputFaults).toHaveLength(2);
    withDirectory("input-fault", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        for (const storeCode of inputFaults) {
          const spy = spyOn(store, new DurableStoreError(storeCode, "rejected by the store"));
          const refused = commitActivationLedgerRecord(spy, input());
          expect(refused.ok).toBe(false);
          if (refused.ok) continue;
          // An input fault is the CALLER's, and retrying one never succeeds.
          // Reporting it as unavailability would tell the caller the opposite,
          // and it is what hid a NUL byte in the derived aggregate id.
          expect(refused.code).toBe("ACTIVATION_LEDGER_FIELD_INVALID");
          expect(refused.layer).toBe(ACTIVATION_LEDGER_LAYER);
          expect(refused.storeCode).toBe(storeCode);
        }
      });
    });
  });

  it("persists no partial tuple when the store throws mid-commit", () => {
    withDirectory("partial", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        const spy = spyOn(store, new Error("injected failure between decision and append"));
        const refused = commitActivationLedgerRecord(spy, input());
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.code).toBe("ACTIVATION_LEDGER_STORE_UNAVAILABLE");
        expect(refused.layer).toBe(ACTIVATION_LEDGER_LAYER);
        expect(refused.outcome).toBe("REFUSED");
      });

      withStore(databasePath, (reopened) => {
        // The whole record or nothing: no attempt, slot, lease, effect, grant or
        // budget fragment is observable, because all six live in ONE payload.
        expect(reopened.readEvents(DERIVED)).toHaveLength(0);
        expect(reopened.getAggregateVersion(DERIVED)).toBe(0);
        const read = readActivationLedgerRecord(DERIVED, reopened.readEvents(DERIVED));
        expect(read.ok).toBe(false);
        if (read.ok) return;
        expect(read.code).toBe("ACTIVATION_LEDGER_EVIDENCE_ABSENT");
      });
    });
  });

  it(
    "admits exactly one of two racing commits on the same pair",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "moe-activation-race-"));
      try {
        const databasePath = join(directory, "store.sqlite");
        const gate = new SharedArrayBuffer(8);
        const results = await releaseRace(gate, [
          startRaceWorker(databasePath, gate, "command-left", "grant-left"),
          startRaceWorker(databasePath, gate, "command-right", "grant-right"),
        ]);
        // The generated race set has positive cardinality: a race that produced
        // zero results would otherwise satisfy every assertion below vacuously.
        expect(results.length).toBe(2);
        const accepted = results.filter((result) => result.ok === true);
        const refused = results.filter((result) => result.ok === false);
        expect(accepted).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0]?.code).toBe("ACTIVATION_LEDGER_EXPECTED_VERSION_CONFLICT");
        expect(refused[0]?.layer).toBe(ACTIVATION_LEDGER_LAYER);
        expect(refused[0]?.storeCode).toBe("EXPECTED_VERSION_CONFLICT");

        withStore(databasePath, (reopened) => {
          const events = reopened.readEvents(DERIVED);
          expect(events).toHaveLength(1);
          expect(events[0]?.eventId).toBe(accepted[0]?.grantId);
          expect(readActivationLedgerRecord(DERIVED, events).ok).toBe(true);
        });
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    30_000,
  );
});

interface RaceResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly layer?: string;
  readonly storeCode?: string | null;
  readonly grantId?: string;
  readonly thrown?: string;
}

interface RaceWorker {
  readonly preOpenReady: Promise<void>;
  readonly ready: Promise<void>;
  readonly result: Promise<RaceResult>;
  readonly worker: Worker;
}

/**
 * The worker imports the adapter by absolute file URL and the store through the
 * URL `import.meta.resolve` gives for the PUBLIC "@moe/store" specifier — a data:
 * URL has no hierarchical base, so a bare specifier cannot be resolved from
 * inside one. Resolving it here keeps the boundary on the package root rather
 * than hardcoding a path into another package.
 */
function startRaceWorker(
  databasePath: string,
  gate: SharedArrayBuffer,
  commandId: string,
  grantId: string,
): RaceWorker {
  const adapterUrl = pathToFileURL(
    join(import.meta.dirname, "activation-ledger-commit.ts"),
  ).href;
  const storeUrl = import.meta.resolve("@moe/store");
  const script = `
    import { parentPort, workerData } from "node:worker_threads";
    import { commitActivationLedgerRecord } from ${JSON.stringify(adapterUrl)};
    import { SqliteEventStore } from ${JSON.stringify(storeUrl)};
    const { commandId, databasePath, gate, grantId, projectId, record } = workerData;
    const flags = new Int32Array(gate);
    parentPort.postMessage({ kind: "PREOPEN_READY" });
    Atomics.wait(flags, 0, 0);
    const store = SqliteEventStore.openForProject(databasePath, projectId);
    let result;
    try {
      parentPort.postMessage({ kind: "READY" });
      Atomics.wait(flags, 1, 0);
      const committed = commitActivationLedgerRecord(store, {
        correlationId: commandId,
        decidedAt: "2026-08-14T00:00:00.000Z",
        key: { commandId, principalId: "principal-1", projectId },
        record: { ...record, grant: { ...record.grant, grantId } },
        requestBytes: new TextEncoder().encode(commandId),
      });
      result = committed.ok
        ? { grantId, ok: true }
        : { code: committed.code, layer: committed.layer, ok: false, storeCode: committed.storeCode };
    } catch (error) {
      result = { ok: false, thrown: String(error) };
    } finally {
      // Closed BEFORE the result is posted: the parent removes the temp
      // directory as soon as it has both results, and an open handle turns that
      // into an EPERM that kills the worker with no output.
      store.close();
    }
    parentPort.postMessage({ kind: "RESULT", result });
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), {
    execArgv: ["--experimental-strip-types"],
    workerData: { commandId, databasePath, gate, grantId, projectId: PROJECT_ID, record: record() },
  });
  let resolvePreOpen!: () => void;
  let resolveReady!: () => void;
  let resolveResult!: (value: RaceResult) => void;
  const rejecters: ((error: Error) => void)[] = [];
  const preOpenReady = new Promise<void>((resolve, reject) => {
    resolvePreOpen = resolve;
    rejecters.push(reject);
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejecters.push(reject);
  });
  const result = new Promise<RaceResult>((resolve, reject) => {
    resolveResult = resolve;
    rejecters.push(reject);
  });
  worker.on("message", (message: { kind: string; result?: RaceResult }) => {
    if (message.kind === "PREOPEN_READY") resolvePreOpen();
    else if (message.kind === "READY") resolveReady();
    else if (message.kind === "RESULT" && message.result !== undefined) {
      resolveResult(message.result);
    }
  });
  const fail = (error: Error): void => {
    for (const reject of rejecters) reject(error);
  };
  worker.on("error", fail);
  worker.on("exit", (code) => {
    if (code !== 0) fail(new Error(`race worker exited with code ${code}`));
  });
  return { preOpenReady, ready, result, worker };
}

async function releaseRace(
  gate: SharedArrayBuffer,
  workers: readonly RaceWorker[],
): Promise<readonly RaceResult[]> {
  const flags = new Int32Array(gate);
  try {
    await Promise.all(workers.map((worker) => worker.preOpenReady));
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0, workers.length);
    await Promise.all(workers.map((worker) => worker.ready));
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1, workers.length);
    return await Promise.all(workers.map((worker) => worker.result));
  } finally {
    await Promise.all(workers.map((worker) => worker.worker.terminate()));
  }
}
