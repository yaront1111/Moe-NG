/**
 * The strict current projection over the durable budget ledger, driven through a REAL
 * file-backed SqliteEventStore.
 *
 * THE ACCEPTED CASE IS COMPARED AGAINST `replayBudgetLedger`'S OWN FOLD over the same entries.
 * A hand-built expectation would agree with a projection that folds the entries itself, which
 * is the duplicate arithmetic this ledger exists to avoid.
 *
 * UNKNOWN NEVER MEANS ZERO. The dangerous simplification here is not a wrong refusal, it is a
 * confident number: a meter whose consumption nobody measured must carry NO refundable claim at
 * all, and `0` is a claim. That is what the second describe block is for, and it is the one the
 * mutation drill in step 5 targets.
 *
 * RAW SEEDING is used for exactly four states production writers refuse to produce by
 * construction — a second root, a sequence gap, a successor that disagrees with its own entry
 * fold, and tampered bytes. Each call site names the impossible state it plants.
 */

import { replayBudgetLedger } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { describe, expect, it } from "vitest";

import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import type { BudgetProjectionResult } from "./budget-current-projection.js";
import { canonicalBudgetJson, encodeBudgetLedgerRecord } from "./budget-ledger-codec.js";
import { BUDGET_LEDGER_EVENT_TYPE, BUDGET_PROJECTION_CODES } from "./budget-ledger-contracts.js";
import type { BudgetLedgerRecord } from "./budget-ledger-contracts.js";
import { settleBudgetReservation } from "./budget-ledger-holds.js";
import { authorizeBudgetRoot } from "./budget-ledger.js";
import {
  BUDGET_ACCOUNT_REF,
  GOAL_ID,
  PROJECT_ID,
  advanceActiveGraph,
  plantRawTransition,
  rawCounts,
  seedDurableBindings,
  withBudgetStore,
} from "./budget-ledger-fixtures.js";
import {
  AGGREGATE,
  AUTHORIZED,
  CHILD,
  accepted,
  context,
  currentLedger,
  observation,
  seedActivatedHold,
  seedFundedChild,
} from "./budget-transition-fixtures.js";

function projected(result: BudgetProjectionResult): Extract<BudgetProjectionResult, { ok: true }> {
  if (!result.ok) throw new Error(`unexpected refusal ${result.code}`);
  return result;
}

function rejected(result: BudgetProjectionResult): Extract<BudgetProjectionResult, { ok: false }> {
  if (result.ok) throw new Error("unexpected acceptance");
  return result;
}

const read = (store: SqliteEventStore): BudgetProjectionResult =>
  readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);

function meterOf(current: Extract<BudgetProjectionResult, { ok: true }>, meter: string) {
  const found = current.meters.find((entry) => entry.meter === meter);
  if (found === undefined) throw new Error(`no projected meter ${meter}`);
  return found;
}

function settleWith(store: SqliteEventStore, raw: unknown): void {
  const [reservation] = currentLedger(store).reservations;
  if (reservation === undefined) throw new Error("no reservation");
  accepted(settleBudgetReservation(store, {
    context: context("cmd-settle"), goalRef: GOAL_ID, observations: [raw],
    projectId: PROJECT_ID, reservationId: reservation.reservationId,
  }));
}

/** Plants bytes on the ledger aggregate that no production writer can emit. */
function plantRecord(store: SqliteEventStore, eventId: string, record: BudgetLedgerRecord): void {
  const encoded = encodeBudgetLedgerRecord(record);
  if (!encoded.ok) throw new Error(`fixture record refused: ${encoded.code}`);
  plantRawTransition(store, AGGREGATE, eventId, BUDGET_LEDGER_EVENT_TYPE, encoded.bytes);
}

const headRecord = (store: SqliteEventStore): BudgetLedgerRecord => projected(read(store)).head;

describe("the current projection replays the durable ledger", () => {
  it("returns the account fold the scheduler's own replay produces, plus per-meter coverage", () => {
    withBudgetStore("projection-accept", (store) => {
      seedFundedChild(store);

      const current = projected(read(store));

      // THE FOLD IS THE REDUCER'S. Nothing here re-adds a bucket.
      const replay = replayBudgetLedger(current.authorization, current.entries);
      expect(replay.ok).toBe(true);
      expect(canonicalBudgetJson(current.accounts)).toBe(canonicalBudgetJson(replay.state.accounts));
      expect(current.accounts.length).toBe(2);
      expect(current.entries.length).toBeGreaterThan(0);

      expect(current.binding.budgetAccountRef).toBe(BUDGET_ACCOUNT_REF);
      expect(current.binding.graphEpoch).toBe(1);
      expect(current.headVersion).toBe(2);
      expect(current.aggregateId).toBe(AGGREGATE);

      // No hold has ever existed, so every meter is fully accounted for.
      expect(current.meters.map((entry) => entry.meter).sort()).toEqual(["seconds", "tokens"]);
      const tokens = meterOf(current, "tokens");
      expect(tokens.coverage).toBe("COMPLETE");
      expect(tokens.buckets).toEqual({ available: 1_000, committed: 0, meter: "tokens", quarantined: 0, reserved: 0 });
      expect(tokens.refundable).toBe(1_000);
      expect(tokens.openHoldCount).toBe(0);
      expect(tokens.measuredCount).toBe(0);

      expect(Object.isFrozen(current)).toBe(true);
      expect(Object.isFrozen(current.meters)).toBe(true);
      expect(Object.isFrozen(tokens)).toBe(true);
    });
  });

  it("reads identically after the store is closed and reopened, and appends nothing", () => {
    withBudgetStore("projection-reopen", (store) => {
      seedFundedChild(store);
      const before = rawCounts(store, AGGREGATE);
      const first = canonicalBudgetJson(projected(read(store)));

      const second = canonicalBudgetJson(projected(read(store)));
      const third = canonicalBudgetJson(projected(read(store)));

      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(rawCounts(store, AGGREGATE)).toEqual(before);
    });
  });
});

describe("UNKNOWN coverage never becomes a number", () => {
  it("makes NO refundable claim for a meter whose consumption nobody measured", () => {
    withBudgetStore("projection-unknown", (store) => {
      seedActivatedHold(store);
      settleWith(store, observation({ coverage: "UNKNOWN", quantity: null, source: "UNKNOWN" }));

      const tokens = meterOf(projected(read(store)), "tokens");

      expect(tokens.coverage).toBe("UNKNOWN");
      // THE WHOLE POINT: not zero, not the available balance, NOTHING.
      expect(tokens.refundable).toBeNull();
      expect(tokens.refundable).not.toBe(0);
      // The units are still visible and still held — hidden units would be the other failure.
      expect(tokens.buckets.quarantined).toBe(100);
      expect(tokens.measuredCount).toBe(0);
    });
  });

  it("makes NO refundable claim for a hold that was never settled at all", () => {
    withBudgetStore("projection-open-hold", (store) => {
      seedActivatedHold(store);

      const tokens = meterOf(projected(read(store)), "tokens");

      expect(tokens.coverage).toBe("UNKNOWN");
      expect(tokens.refundable).toBeNull();
      expect(tokens.openHoldCount).toBe(1);
      expect(tokens.buckets.reserved).toBe(100);
    });
  });

  it("reads PARTIAL, and still makes no refundable claim, for a lower-bound receipt", () => {
    withBudgetStore("projection-partial", (store) => {
      seedActivatedHold(store);
      settleWith(store, observation({ coverage: "PARTIAL", source: "PROVIDER_REPORTED_PARTIAL" }));

      const tokens = meterOf(projected(read(store)), "tokens");

      expect(tokens.coverage).toBe("PARTIAL");
      expect(tokens.refundable).toBeNull();
      expect(tokens.measuredCount).toBe(1);
    });
  });

  it("reads COMPLETE and states the refundable balance once every hold is measured exactly", () => {
    withBudgetStore("projection-complete", (store) => {
      seedActivatedHold(store);
      settleWith(store, observation());

      const tokens = meterOf(projected(read(store)), "tokens");

      expect(tokens.coverage).toBe("COMPLETE");
      expect(tokens.buckets.committed).toBe(60);
      expect(tokens.buckets.reserved).toBe(0);
      // 1000 authorized, 60 committed: the rest is provably unconsumed.
      expect(tokens.refundable).toBe(940);
      expect(tokens.measuredCount).toBe(1);
    });
  });

  it("keeps an unmeasured meter UNKNOWN while a sibling meter reads COMPLETE", () => {
    withBudgetStore("projection-mixed", (store) => {
      seedActivatedHold(store);

      const current = projected(read(store));

      // `seconds` was never held at all, so it is fully accounted for...
      expect(meterOf(current, "seconds").coverage).toBe("COMPLETE");
      expect(meterOf(current, "seconds").refundable).toBe(600);
      // ...while `tokens` carries an unmeasured hold. Coverage is PER METER, not per ledger.
      expect(meterOf(current, "tokens").coverage).toBe("UNKNOWN");
      expect(meterOf(current, "tokens").refundable).toBeNull();
    });
  });
});

describe("the projection refuses rather than answering from evidence it cannot verify", () => {
  it("refuses ABSENT when the bindings exist but no ledger was ever authorized", () => {
    withBudgetStore("projection-absent", (store) => {
      seedDurableBindings(store);

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_ABSENT");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.outcome).toBe("UNKNOWN");
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("refuses CORRUPT with the codec's own code when a payload byte is flipped", () => {
    withBudgetStore("projection-corrupt", (store) => {
      seedFundedChild(store);
      const [event] = store.readEvents(AGGREGATE);
      if (event === undefined) throw new Error("no event to tamper with");
      const tampered = Uint8Array.from(event.payload);
      const last = tampered.length - 1;
      // PLANTED: the codec seals its bytes, so no writer can commit a payload that fails its
      // own digest. One flipped hex character in the trailing seal is the whole tamper.
      tampered[last] = tampered[last] === 0x61 ? 0x62 : 0x61;
      plantRawTransition(store, AGGREGATE, "tampered-event", BUDGET_LEDGER_EVENT_TYPE, tampered);

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_CORRUPT");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceCode).toBe("BUDGET_LEDGER_DIGEST_MISMATCH");
      expect(result.sourceLayer).toBe("BUDGET_LEDGER");
    });
  });

  it("refuses CORRUPT when an event of a foreign type sits on the ledger aggregate", () => {
    withBudgetStore("projection-foreign-type", (store) => {
      seedFundedChild(store);
      plantRawTransition(store, AGGREGATE, "foreign-event", "SomethingElseHappened",
        new TextEncoder().encode("{}"));

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_CORRUPT");
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("refuses SPLIT_BRAIN when a second root authorization exists for one account", () => {
    withBudgetStore("projection-split-brain", (store) => {
      seedFundedChild(store);
      const head = headRecord(store);
      // PLANTED: `authorizeBudgetRoot` refuses ALREADY_AUTHORIZED, so a second root can only
      // reach the store through a writer that does not exist.
      plantRecord(store, "second-root", { ...head, sequence: 2, transition: "ROOT_AUTHORIZED" });

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_SPLIT_BRAIN");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("refuses STALE_BINDING when the active graph moves out from under a committed ledger", () => {
    withBudgetStore("projection-stale", (store) => {
      const revision = seedDurableBindings(store);
      seedRootOnly(store);
      expect(projected(read(store)).binding.graphEpoch).toBe(1);

      // Nothing about the ledger changes; the world underneath it does.
      const successor = advanceActiveGraph(store, revision);
      expect(successor.graphEpoch).toBe(2);

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_STALE_BINDING");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("refuses SCOPE_FOREIGN when a committed record names another goal", () => {
    withBudgetStore("projection-foreign-scope", (store) => {
      seedFundedChild(store);
      const head = headRecord(store);
      // PLANTED: every writer derives the binding from the durable goal, so a record naming a
      // different goal cannot be produced by one.
      plantRecord(store, "foreign-scope", {
        ...head, binding: { ...head.binding, goalRef: "goal-somewhere-else" }, sequence: 2,
        transition: "ALLOCATED",
      });

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_SCOPE_FOREIGN");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("refuses VERSION_GAP when a record's sequence skips the position it was written at", () => {
    withBudgetStore("projection-gap", (store) => {
      seedFundedChild(store);
      const head = headRecord(store);
      // PLANTED: the writers stamp `sequence` from the head version they committed at, so a
      // record whose sequence skips its own aggregate position is unreachable in production.
      plantRecord(store, "gap-event", { ...head, sequence: 7, transition: "ALLOCATED" });

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_VERSION_GAP");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("refuses CONSERVATION_FAILED, preserving the account reducer's code, when entries overdraw", () => {
    withBudgetStore("projection-overdraw", (store) => {
      seedFundedChild(store);
      const head = headRecord(store);
      // PLANTED: `allocateToChild` refuses INSUFFICIENT_AVAILABLE, so no writer can append an
      // entry that moves more units than the parent holds.
      plantRecord(store, "overdraw-event", {
        ...head, sequence: 2, transition: "ALLOCATED",
        appended: [{
          amount: 99_999, fromRef: BUDGET_ACCOUNT_REF, kind: "ALLOCATED", meter: "tokens",
          ownerRef: null, sequence: head.appended.length + 2, toRef: CHILD,
        }],
      });

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_CONSERVATION_FAILED");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      expect(result.sourceCode).toBe("BUDGET_ACCOUNT_INSUFFICIENT_AVAILABLE");
      expect(result.sourceLayer).toBe("BUDGET_ACCOUNT");
    });
  });

  it("refuses CONSERVATION_FAILED when a successor disagrees with its own entry fold", () => {
    withBudgetStore("projection-inflated", (store) => {
      seedFundedChild(store);
      const head = headRecord(store);
      // PLANTED: every writer commits the reducer's OWN successor, so a successor that the
      // entry stream does not produce is exactly the state a locally-recomputed writer emits.
      const inflated = head.accounts.map((account) => account.accountId !== CHILD ? account : {
        ...account,
        meters: account.meters.map((bucket) => ({ ...bucket, available: bucket.available + 500 })),
      });
      plantRecord(store, "inflated-event", {
        ...head, accounts: inflated, appended: [], sequence: 2, transition: "ALLOCATED",
      });

      const result = rejected(read(store));

      expect(result.code).toBe("BUDGET_PROJECTION_CONSERVATION_FAILED");
      expect(result.layer).toBe("BUDGET_CURRENT_PROJECTION");
      // Nothing underneath refused: the fold and the committed successor simply disagree.
      expect(result.sourceLayer).toBeNull();
    });
  });

  it("leaves the store untouched on every refusal arm, and names every code it can raise", () => {
    withBudgetStore("projection-readonly", (store) => {
      seedFundedChild(store);
      const before = rawCounts(store, AGGREGATE);

      rejected(readCurrentBudgetLedger(store, PROJECT_ID, "goal-nonexistent"));
      rejected(readCurrentBudgetLedger(store, "project-elsewhere", GOAL_ID));

      expect(rawCounts(store, AGGREGATE)).toEqual(before);
      // A closed roster keeps a call site from inventing a code; assert it is the closed set
      // this suite actually exercises.
      expect([...BUDGET_PROJECTION_CODES].sort()).toEqual([
        "BUDGET_PROJECTION_ABSENT",
        "BUDGET_PROJECTION_CONSERVATION_FAILED",
        "BUDGET_PROJECTION_CORRUPT",
        "BUDGET_PROJECTION_GOAL_ABSENT",
        "BUDGET_PROJECTION_GRAPH_UNAVAILABLE",
        "BUDGET_PROJECTION_SCOPE_FOREIGN",
        "BUDGET_PROJECTION_SPLIT_BRAIN",
        "BUDGET_PROJECTION_STALE_BINDING",
        "BUDGET_PROJECTION_VERSION_GAP",
      ]);
    });
  });
});

/** Root authorization alone — the smallest ledger a binding refusal can be observed against. */
function seedRootOnly(store: SqliteEventStore): void {
  const root = authorizeBudgetRoot(store, {
    amounts: AUTHORIZED, context: context("cmd-authorize"), goalRef: GOAL_ID, projectId: PROJECT_ID,
  });
  if (!root.ok) throw new Error(`authorize refused ${root.code}`);
}
