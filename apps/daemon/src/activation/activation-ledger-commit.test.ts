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
import { describe, expect, expectTypeOf, it } from "vitest";

import { commitActivationLedgerRecord } from "./activation-ledger-commit.js";
import {
  ACTIVATION_LEDGER_COMMAND_KIND,
  ACTIVATION_LEDGER_EVENT_TYPE,
  ACTIVATION_LEDGER_LAYER,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import type {
  ActivationLedgerCommitInput,
  ActivationLedgerStore,
} from "./activation-ledger-contracts.js";
import { DERIVED, EFFECT_AGGREGATE, GRANT_ID, encodedBytes, record } from "./activation-ledger-fixtures.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";
import { FOUNDATION_TRANSITION_EVENT_TYPES } from "./foundation-activation-transition.js";

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

/**
 * Appends ONE further event onto an aggregate that already carries its
 * activation, through the store's own command path at the aggregate's real
 * current version.
 *
 * This is how the multi-event aggregate is CONSTRUCTED rather than waited for.
 * The Foundation launch tail is the obvious real producer, but its only
 * composition point (`createFoundationClaudeLauncher`) has no caller yet, so a
 * test that waited for a live launch to append the tail would exercise nothing
 * and pass vacuously. The event TYPE below is the real Foundation transition
 * type, not an invented one.
 */
function appendToAggregate(
  store: SqliteEventStore,
  eventType: string,
  eventId: string,
  payload: Uint8Array,
): void {
  const currentVersion = store.getAggregateVersion(DERIVED);
  store.commit({
    aggregateId: DERIVED,
    commandBytes: new TextEncoder().encode(`tail-command-${eventId}`),
    commandId: `tail-command-${eventId}`,
    committedAt: "2026-08-15T00:00:01.000Z",
    events: [{ eventId, eventType, payload }],
    expectedVersion: currentVersion,
  });
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

  /**
   * DEFECT 1's reproduction: idempotency must survive a GROWING aggregate.
   *
   * `answerReplayed` reads the derived aggregate back and hands the result to
   * `readActivationLedgerRecord`, whose first job is to refuse anything but
   * exactly one activation. Handing it EVERY event on the aggregate conflates
   * "this aggregate carries two activations" — real ambiguity — with "this
   * aggregate carries its activation plus a Foundation launch tail", which is
   * the ordinary shape of a launched effect. Idempotency is precisely the
   * property that has to keep holding as the tail accumulates.
   */
  it("replays the DURABLE record on an aggregate that also carries its Foundation tail", () => {
    withDirectory("replay-tail", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        const first = commitActivationLedgerRecord(store, input());
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        appendToAggregate(
          store,
          FOUNDATION_TRANSITION_EVENT_TYPES.GRANT_CONSUMED,
          "foundation-tail-1",
          new TextEncoder().encode("foundation-tail-payload"),
        );
        // The aggregate really does hold more than one event now: without this
        // the whole case is vacuous, because the defect needs a tail to exist.
        expect(store.readEvents(DERIVED)).toHaveLength(2);

        const replayed = commitActivationLedgerRecord(store, input());
        expect(replayed.ok).toBe(true);
        if (!replayed.ok) {
          // Named explicitly so the drill's failure output says WHICH refusal
          // won rather than merely that the call did not succeed.
          expect(replayed.code).not.toBe("ACTIVATION_LEDGER_EVIDENCE_AMBIGUOUS");
          return;
        }
        expect(replayed.disposition).toBe("REPLAYED");
        expect(replayed.record).toEqual(first.record);
        expect(replayed.digest).toBe(first.digest);
        expect(replayed.aggregateId).toBe(DERIVED);
      });
    });
  });

  /**
   * The other half of DoD 1: the tailed replay above is the STORED record, not
   * an echo of whatever the caller handed in. Same key, same request bytes —
   * so the store still replays — but a drifted grantId, which lives OUTSIDE the
   * store's replay identity. The stored bytes must win.
   */
  it("refuses a drifted candidate on a tailed aggregate, so the stored bytes win", () => {
    withDirectory("replay-tail-drift", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        expect(commitActivationLedgerRecord(store, input()).ok).toBe(true);
        appendToAggregate(
          store,
          FOUNDATION_TRANSITION_EVENT_TYPES.GRANT_CONSUMED,
          "foundation-tail-1",
          new TextEncoder().encode("foundation-tail-payload"),
        );
        expect(store.readEvents(DERIVED)).toHaveLength(2);

        const drifted = commitActivationLedgerRecord(
          store,
          input({
            record: record({ grant: { ...record().grant, grantId: "grant-NEVER-COMMITTED" } }),
          }),
        );
        expect(drifted.ok).toBe(false);
        if (drifted.ok) return;
        // THIS ledger's own cross-check refused, after reading the durable bytes
        // back — not the store, and not the exactly-one guard. `storeCode` null
        // is what says which layer answered.
        expect(drifted.code).toBe("ACTIVATION_LEDGER_REPLAY_DIVERGED");
        expect(drifted.layer).toBe(ACTIVATION_LEDGER_LAYER);
        expect(drifted.outcome).toBe("REFUSED");
        expect(drifted.storeCode).toBeNull();
      });
    });
  });

  /**
   * THE GUARD THAT MUST NOT WEAKEN.
   *
   * Narrowing the replay reader's input to the activation events is the fix;
   * relaxing the exactly-one check to "take the first" is not. Both make the
   * tailed replay above pass, and only one of them keeps the ledger's core
   * guarantee. TWO genuinely valid activation records on one aggregate is real
   * ambiguity and must still refuse with its exact code, layer and outcome.
   */
  it("still refuses an aggregate carrying TWO activation events as AMBIGUOUS", () => {
    withDirectory("two-activations", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        expect(commitActivationLedgerRecord(store, input()).ok).toBe(true);
        const second = record({ grant: { ...record().grant, grantId: "grant-0002" } });
        appendToAggregate(
          store,
          ACTIVATION_LEDGER_EVENT_TYPE,
          "grant-0002",
          encodedBytes(second),
        );
        const events = store.readEvents(DERIVED);
        // Both events are INDIVIDUALLY well-formed activation records, so this
        // is genuine ambiguity rather than a malformed tail the reader would
        // have refused for some other reason.
        expect(events).toHaveLength(2);
        expect(events.map((event) => event.eventType)).toEqual([
          ACTIVATION_LEDGER_EVENT_TYPE,
          ACTIVATION_LEDGER_EVENT_TYPE,
        ]);
        for (const event of events) {
          expect(readActivationLedgerRecord(DERIVED, [event]).ok).toBe(true);
        }

        const replayed = commitActivationLedgerRecord(store, input());
        expect(replayed.ok).toBe(false);
        if (replayed.ok) return;
        expect(replayed.code).toBe("ACTIVATION_LEDGER_EVIDENCE_AMBIGUOUS");
        expect(replayed.layer).toBe(ACTIVATION_LEDGER_LAYER);
        expect(replayed.outcome).toBe("UNKNOWN");
        // The reader refused, not the store: no store call raised anything.
        expect(replayed.storeCode).toBeNull();
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

/**
 * THE COMMAND KIND IS ONE VALUE, AND THE DURABLE ROWS SAY SO.
 *
 * The writer's command kind used to be a private literal, so a reader wanting to
 * reject a self-consistent foreign command had no choice but to copy the string.
 * Two copies of a protocol literal drift: the writer changes, the reader keeps
 * granting authority on the old one, and nothing goes red. The constant is now
 * exported and the writer consumes it — these cases are what stops that export
 * from being decorative.
 *
 * WHY THIS IS NOT A CONSTANT COMPARED TO ITSELF. Asserting only that the durable
 * `commandKind` equals `ACTIVATION_LEDGER_COMMAND_KIND` would stay green if both
 * moved together, which is exactly the change this task must make impossible.
 * Three independent things close it:
 *
 *   1. the LITERAL ratchet below — the constant is pinned to the string itself,
 *      not to whatever the writer happens to emit;
 *   2. the TYPE ratchet — a widening to `string` is a typecheck failure, so the
 *      export cannot quietly stop being a literal type;
 *   3. the IDENTITY GOLDENS — `commandKind` is hashed into the store's request
 *      identity (`identifyExpectedVersionRequest`), so changing the string moves
 *      `requestSha256`. Measured, not assumed: mutating the export alone drives
 *      the decision's `requestSha256` from `5b7ecc51…` to `be96c146…`.
 *
 * `decisionId` is NOT that golden and cannot stand in for it. It survived that
 * same mutation unchanged, because it is derived from the decision KEY —
 * projectId, principalId, commandId — and not from the request. Pinning only
 * `decisionId` would have produced a replay case that looked identity-bound and
 * was blind to the exact drift this task exists to prevent. `requestSha256` is
 * therefore asserted on BOTH the accepted and the replayed path.
 *
 * All five hashes were measured against the production writer BEFORE the
 * constant existed, so they cannot have been produced by it.
 */
const GOLDEN = Object.freeze({
  /** Store-derived decision identity; covers commandKind by construction. */
  decisionId: "1e0590ddaec1767f9bc3ce4cdf66bf5806fb0cb29739693d5a73b7eb59e91dda",
  /** The scoped-command-request domain. Distinct from the effect domain below. */
  decisionRequestSha256: "5b7ecc51684b7bf7c78867d7c7bf4b20d18617773378fdfaabc5f888cb9f450b",
  effectSha256: "dfbae7275ff136e1f8a509198a71fe4e49a84e6be1237eb430a4e2422b88b208",
  /** The effect domain: the event and the receipt share it, the decision does not. */
  eventRequestSha256: "732eaf14278101935db9574841d68bf8e255d69a3a6568d5e5ec8d6b232029dc",
  resultSha256: "0289b674efd23ee6618ee5e4350432e0fae15fa55d782c87fddb706a453a2a4e",
});

describe("activation ledger command identity", () => {
  it("pins the exported constant to the literal and to its literal TYPE", () => {
    expect(ACTIVATION_LEDGER_COMMAND_KIND).toBe("activation.commit");
    // Widening to `string` would let any writer satisfy a reader that imports
    // this, which is the whole point of exporting it. `tsc --project
    // tsconfig.json` covers src/**/*.ts, so this line is enforced by the gate.
    expectTypeOf<typeof ACTIVATION_LEDGER_COMMAND_KIND>().toEqualTypeOf<"activation.commit">();
  });

  it("binds the stored decision, receipt and event trace to the exported command kind", () => {
    withDirectory("provenance", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        const committed = commitActivationLedgerRecord(store, input());
        expect(committed.ok).toBe(true);
        if (!committed.ok) return;
        expect(committed.disposition).toBe("COMMITTED");

        // POSITIVE and singular. "Exactly one" over an empty aggregate would
        // satisfy every field assertion below vacuously.
        const events = store.readEvents(DERIVED);
        expect(events).toHaveLength(1);
        const event = events[0];
        expect(event).toBeDefined();
        if (event === undefined) return;

        const decision = store.getCommandDecision(input().key);
        expect(decision).not.toBeNull();
        if (decision === null) return;

        // ASSERTED FIRST, so a wrong-kind mutation names the command kind in the
        // failure rather than reddening on a downstream hash whose message says
        // nothing about what drifted.
        expect(decision.commandKind).toBe(ACTIVATION_LEDGER_COMMAND_KIND);
        expect(event.decisionTrace?.commandKind).toBe(ACTIVATION_LEDGER_COMMAND_KIND);

        expect(decision.effectDisposition).toBe("EFFECTS_COMMITTED");
        if (decision.effectDisposition !== "EFFECTS_COMMITTED") return;
        expect(decision.resultCode).toBe("EFFECTS_COMMITTED");
        expect(decision.targetAggregateId).toBe(DERIVED);
        // 0 -> 1: the activation is the FIRST event on its own derived aggregate.
        expect(decision.expectedVersion).toBe(0);
        expect(decision.observedVersion).toBe(0);
        expect(decision.previousVersion).toBe(0);
        expect(decision.currentVersion).toBe(1);
        expect(decision.businessEventIds).toEqual([GRANT_ID]);
        expect(decision.outboxMessageIds).toEqual([]);
        // The durable record IS the event payload, so there is no second copy of
        // the activation that could disagree with the decision's result bytes.
        expect(decision.resultBytes).toEqual(event.payload);

        expect(decision.decisionId).toBe(GOLDEN.decisionId);
        expect(decision.requestSha256).toBe(GOLDEN.decisionRequestSha256);
        expect(decision.effectSha256).toBe(GOLDEN.effectSha256);
        expect(decision.resultSha256).toBe(GOLDEN.resultSha256);

        expect(event.eventType).toBe(ACTIVATION_LEDGER_EVENT_TYPE);
        expect(event.eventId).toBe(GRANT_ID);
        expect(event.aggregateId).toBe(DERIVED);
        expect(event.aggregateSequence).toBe(1);
        expect(event.requestSha256).toBe(GOLDEN.eventRequestSha256);
        expect(event.decisionTrace?.commandId).toBe(input().key.commandId);
        expect(event.decisionTrace?.requestSha256).toBe(GOLDEN.decisionRequestSha256);

        // The receipt is keyed by the store's INTERNAL effect command id, not by
        // the caller's `command-1`. Looking it up under the caller's id returns
        // null, so the binding is asserted through the event's own commandId and
        // that id is required to carry the decision identity — the two rows are
        // then provably the same commit rather than two rows that merely agree.
        expect(store.getCommandReceipt(input().key.commandId)).toBeNull();
        expect(event.commandId).toContain(GOLDEN.decisionId);
        const receipt = store.getCommandReceipt(event.commandId);
        expect(receipt).not.toBeNull();
        if (receipt === null) return;
        expect(receipt.commandId).toBe(event.commandId);
        expect(receipt.aggregateId).toBe(DERIVED);
        expect(receipt.eventIds).toEqual([GRANT_ID]);
        expect(receipt.previousVersion).toBe(0);
        expect(receipt.currentVersion).toBe(1);
        expect(receipt.outboxMessageIds).toEqual([]);
        expect(receipt.effectSha256).toBe(GOLDEN.effectSha256);
        // The receipt shares the EFFECT request domain with the event, and the
        // decision's own `requestSha256` is a different domain over different
        // inputs. Asserting one hash for both would pass while the writer bound
        // the wrong one.
        expect(receipt.requestSha256).toBe(GOLDEN.eventRequestSha256);
        expect(receipt.requestSha256).not.toBe(decision.requestSha256);
      });
    });
  });

  it("replays the identical command without adding a raw event or decision row", () => {
    withDirectory("provenance-replay", (directory) => {
      const databasePath = join(directory, "store.sqlite");
      withStore(databasePath, (store) => {
        const first = commitActivationLedgerRecord(store, input());
        expect(first.ok).toBe(true);
        if (!first.ok) return;

        // RAW counts, taken store-wide rather than per aggregate: a second
        // decision row or a second event anywhere is what a re-executed replay
        // would leave, and a per-aggregate read could miss one written elsewhere.
        const eventsBefore = store.readEventsAfter(0n, 100).items;
        const decisionsBefore = store.readCommandDecisionsAfter(0n, 100).items;
        // Positive, so "unchanged" below is a real comparison and not 0 === 0.
        expect(eventsBefore).toHaveLength(1);
        expect(decisionsBefore).toHaveLength(1);
        const durablePayload = eventsBefore[0]?.payload;
        const durableDecisionSha256 = decisionsBefore[0]?.decisionSha256;
        expect(durablePayload).toBeDefined();
        expect(durableDecisionSha256).toBe(
          store.getCommandDecision(input().key)?.decisionSha256,
        );

        const replayed = commitActivationLedgerRecord(store, input());
        expect(replayed.ok).toBe(true);
        if (!replayed.ok) return;
        expect(replayed.disposition).toBe("REPLAYED");
        expect(replayed.digest).toBe(first.digest);
        expect(replayed.record).toEqual(first.record);

        const eventsAfter = store.readEventsAfter(0n, 100).items;
        const decisionsAfter = store.readCommandDecisionsAfter(0n, 100).items;
        expect(eventsAfter).toHaveLength(eventsBefore.length);
        expect(decisionsAfter).toHaveLength(decisionsBefore.length);
        // Byte-identical, not merely equal in number.
        expect(eventsAfter[0]?.payload).toEqual(durablePayload);
        expect(decisionsAfter[0]?.decisionSha256).toBe(durableDecisionSha256);
        expect(decisionsAfter[0]?.commandKind).toBe(ACTIVATION_LEDGER_COMMAND_KIND);
        expect(decisionsAfter[0]?.decisionId).toBe(GOLDEN.decisionId);
        expect(eventsAfter[0]?.decisionTrace?.commandKind).toBe(ACTIVATION_LEDGER_COMMAND_KIND);
        // The two assertions above compare production against the constant, so
        // they hold if BOTH move together; `decisionId` is key-derived and does
        // not move with the command kind at all. These two are what make the
        // replayed row identity-bound rather than self-consistent.
        expect(decisionsAfter[0]?.requestSha256).toBe(GOLDEN.decisionRequestSha256);
        expect(eventsAfter[0]?.requestSha256).toBe(GOLDEN.eventRequestSha256);
      });
    });
  });
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
