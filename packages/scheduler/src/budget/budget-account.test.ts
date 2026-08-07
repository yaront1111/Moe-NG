import { describe, expect, it } from "vitest";
import {
  BUDGET_ACCOUNT_ISSUE_CODES, allocateToChild, closeBudgetAccount, deriveSubtreeTotals,
  openBudgetRoot, replayBudgetLedger, returnToParent,
  type BudgetLedgerResult, type BudgetLedgerState, type BudgetMovementCommand,
} from "./budget-account.js";
import type {
  BudgetAccountRecord, BudgetAccountState, BudgetMeterBuckets,
} from "./budget-contract.js";

const ATTEMPTS = "attempt.count";
const MS = "runner.authorized_ms";
const ROOT = "account:root";
const CHILD = "account:child";
const GRANDCHILD = "account:grandchild";
const SIBLING = "account:sibling";
const AUTHORIZATION = {
  rootAccountId: ROOT, ownerRef: "goal:1", graphRevisionRef: "graph:rev-1",
  amounts: [{ meter: ATTEMPTS, amount: 10 }, { meter: MS, amount: 1000 }],
};

function must(result: BudgetLedgerResult): BudgetLedgerState {
  if (!result.ok) throw new Error(`expected ok, got ${result.issues.map((i) => i.code).join(",")}`);
  return result.state;
}
const codesOf = (r: BudgetLedgerResult): readonly string[] =>
  r.ok ? [] : r.issues.map((issue) => issue.code);
const account = (s: BudgetLedgerState, id: string): BudgetAccountRecord | undefined =>
  s.accounts.find((entry) => entry.accountId === id);
const bucket = (s: BudgetLedgerState, id: string, meter: string): BudgetMeterBuckets | undefined =>
  account(s, id)?.meters.find((entry) => entry.meter === meter);
const available = (s: BudgetLedgerState, id: string, meter: string): number | undefined =>
  bucket(s, id, meter)?.available;
const move = (overrides: Partial<BudgetMovementCommand> = {}): BudgetMovementCommand => ({
  parentAccountId: ROOT, childAccountId: CHILD, childOwnerRef: "node:1",
  expectedParentVersion: 0, expectedChildVersion: null,
  amounts: [{ meter: ATTEMPTS, amount: 4 }], ...overrides,
});
const opened = (): BudgetLedgerState => must(openBudgetRoot(AUTHORIZATION));
const funded = (): BudgetLedgerState => must(allocateToChild(opened(), move()));
const onFunded = (o: Partial<BudgetMovementCommand> = {}): BudgetMovementCommand =>
  move({ expectedParentVersion: 1, expectedChildVersion: 0, ...o });

/**
 * Sums direct buckets independently of the production roll-up, then requires the production
 * surface to agree AND conservation to hold — checking the roll-up against itself would not.
 */
function expectConserved(state: BudgetLedgerState): void {
  const derived = deriveSubtreeTotals(state);
  for (const authorized of AUTHORIZATION.amounts) {
    let independent = 0;
    for (const record of state.accounts) {
      for (const m of record.meters.filter((entry) => entry.meter === authorized.meter)) {
        for (const amount of [m.available, m.reserved, m.quarantined, m.committed]) {
          expect(Number.isSafeInteger(amount) && amount >= 0).toBe(true);
          independent += amount;
        }
      }
    }
    const overrun = state.overrun.find((entry) => entry.meter === authorized.meter)?.amount ?? 0;
    expect(overrun).toBe(0);
    expect(derived.find((entry) => entry.meter === authorized.meter)?.amount).toBe(independent);
    expect(independent).toBe(authorized.amount + overrun);
  }
}
const buckets = (available: number, committed = 0): Record<string, unknown> =>
  ({ meter: ATTEMPTS, available, reserved: 0, quarantined: 0, committed });

describe("budget root", () => {
  it("opens with the authorized amount entirely available and nothing else allocated", () => {
    const state = opened();
    expect(account(state, ROOT)?.parentRef).toBeNull();
    expect(account(state, ROOT)?.version).toBe(0);
    expect(account(state, ROOT)?.state).toBe("OPEN");
    expect(state.accounts).toHaveLength(1);
    expect(bucket(state, ROOT, ATTEMPTS)).toStrictEqual(buckets(10));
    expect(available(state, ROOT, MS)).toBe(1000);
    expect(state.entries.map((entry) => entry.kind)).toStrictEqual(["ROOT_OPENED", "ROOT_OPENED"]);
    expectConserved(state);
  });
});

describe("allocation and return", () => {
  it("moves exactly the requested units and leaves every other bucket byte-identical", () => {
    const before = opened();
    const state = must(allocateToChild(before, move()));
    expect(bucket(state, ROOT, MS)).toStrictEqual(bucket(before, ROOT, MS));
    expect(bucket(state, ROOT, ATTEMPTS)).toStrictEqual(buckets(6));
    expect(bucket(state, CHILD, ATTEMPTS)).toStrictEqual(buckets(4));
    expect(account(state, CHILD)?.parentRef).toBe(ROOT);
    expectConserved(state);
  });

  it("returns units to the current parent as the exact inverse", () => {
    const state = must(returnToParent(funded(), onFunded()));
    expect(available(state, ROOT, ATTEMPTS)).toBe(10);
    expect(available(state, CHILD, ATTEMPTS)).toBe(0);
    expectConserved(state);
  });

  it("emits one balanced double-entry per meter, mirrored for a return", () => {
    const allocated = funded();
    expect(allocated.entries.at(-1)).toStrictEqual({ sequence: 2, kind: "ALLOCATED",
      meter: ATTEMPTS, amount: 4, fromRef: ROOT, toRef: CHILD, ownerRef: "node:1" });
    expect(must(returnToParent(allocated, onFunded())).entries.at(-1)).toStrictEqual({ sequence: 3,
      kind: "RETURNED", meter: ATTEMPTS, amount: 4, fromRef: CHILD, toRef: ROOT, ownerRef: null });
  });

  it("bumps the version of both sides on every movement", () => {
    const allocated = funded();
    expect(account(allocated, ROOT)?.version).toBe(1);
    expect(account(allocated, CHILD)?.version).toBe(0);
    const topped = must(allocateToChild(allocated, onFunded({ amounts: [{ meter: ATTEMPTS, amount: 2 }] })));
    expect(account(topped, ROOT)?.version).toBe(2);
    expect(account(topped, CHILD)?.version).toBe(1);
    expect(available(topped, ROOT, ATTEMPTS)).toBe(4);
    expect(available(topped, CHILD, ATTEMPTS)).toBe(6);
    expectConserved(topped);
  });

  it("counts a grandchild in the derived total, never in the root's direct bucket, and stores no roll-up", () => {
    const deep = must(allocateToChild(funded(), move({
      parentAccountId: CHILD, childAccountId: GRANDCHILD, childOwnerRef: "node:2",
      amounts: [{ meter: ATTEMPTS, amount: 3 }],
    })));
    expect(available(deep, ROOT, ATTEMPTS)).toBe(6);
    expect(available(deep, CHILD, ATTEMPTS)).toBe(1);
    expect(available(deep, GRANDCHILD, ATTEMPTS)).toBe(3);
    expect(deriveSubtreeTotals(deep).find((entry) => entry.meter === ATTEMPTS)?.amount).toBe(10);
    for (const record of deep.accounts) {
      expect(Object.keys(record).sort()).toStrictEqual([
        "accountId", "graphRevisionRef", "meters", "ownerRef", "parentRef", "state", "version"]);
    }
    expectConserved(deep);
  });

  it("moves several meters atomically in one command", () => {
    const state = must(allocateToChild(opened(), move({
      amounts: [{ meter: ATTEMPTS, amount: 4 }, { meter: MS, amount: 250 }] })));
    expect(available(state, ROOT, MS)).toBe(750);
    expect(available(state, CHILD, MS)).toBe(250);
    expect(state.entries.filter((entry) => entry.kind === "ALLOCATED")).toHaveLength(2);
    expectConserved(state);
  });
});

describe("closure and replay", () => {
  it("closes a drained child, retains the record, and keeps committed units counted", () => {
    const drained = must(returnToParent(funded(), onFunded()));
    const closed = must(closeBudgetAccount(drained, { accountId: CHILD, expectedVersion: 1 }));
    expect(account(closed, CHILD)?.state).toBe("CLOSED");
    expect(closed.accounts).toHaveLength(2);
    expect(closed.entries.at(-1)?.kind).toBe("CLOSED");
    expectConserved(closed);
  });

  it("replays canonical entries into a deeply frozen state equal to the live one", () => {
    const live = must(allocateToChild(funded(), move({
      parentAccountId: CHILD, childAccountId: GRANDCHILD, childOwnerRef: "node:2",
      amounts: [{ meter: ATTEMPTS, amount: 3 }] })));
    const replayed = must(replayBudgetLedger(AUTHORIZATION, live.entries));
    expect(replayed).toStrictEqual(live);
    expect(Object.isFrozen(replayed)).toBe(true);
    expect(Object.isFrozen(replayed.accounts)).toBe(true);
    expect(Object.isFrozen(account(replayed, CHILD))).toBe(true);
    expect(Object.isFrozen(account(replayed, CHILD)?.meters)).toBe(true);
    expect(Object.isFrozen(bucket(replayed, CHILD, ATTEMPTS))).toBe(true);
    expectConserved(replayed);
  });
});

const ON = { expectedParentVersion: 1, expectedChildVersion: 0 };
const STALE = "BUDGET_ACCOUNT_STALE_VERSION";
const UNKNOWN = "BUDGET_ACCOUNT_UNKNOWN_ACCOUNT";
const MISMATCH = "BUDGET_ACCOUNT_PARENT_MISMATCH";
const SHORT = "BUDGET_ACCOUNT_INSUFFICIENT_AVAILABLE";
const NO_METER = "BUDGET_ACCOUNT_UNKNOWN_METER";
const DUPLICATE = "BUDGET_ACCOUNT_DUPLICATE_IDENTITY";
const MALFORMED = "BUDGET_ACCOUNT_COMMAND_MALFORMED";
const ILLEGAL = "BUDGET_ACCOUNT_ILLEGAL_CLOSE";

const withSibling = (): BudgetLedgerState => must(allocateToChild(funded(), onFunded({
  childAccountId: SIBLING, childOwnerRef: "node:3", expectedChildVersion: null,
  amounts: [{ meter: ATTEMPTS, amount: 2 }] })));
/** Hand-built, because reserving and quarantining belong to sibling children 17.03 and 17.04. */
const handmade = (child: Partial<BudgetMeterBuckets>, state: BudgetAccountState = "OPEN",
  rootAvailable = 10): BudgetLedgerState => ({
  rootAccountId: ROOT, authorized: AUTHORIZATION.amounts, overrun: [], entries: [],
  accounts: [
    { ...stub(ROOT, null, "OPEN"), ownerRef: "goal:1", meters: [zeroed({ available: rootAvailable })] },
    { ...stub(CHILD, ROOT, state), ownerRef: "node:1", meters: [zeroed(child)] }],
});
const stub = (accountId: string, parentRef: string | null, state: BudgetAccountState) =>
  ({ accountId, parentRef, state, ownerRef: "", graphRevisionRef: "graph:rev-1", version: 0 });
function zeroed(overrides: Partial<BudgetMeterBuckets>): BudgetMeterBuckets {
  return { meter: ATTEMPTS, available: 0, reserved: 0, quarantined: 0, committed: 0, ...overrides };
}

interface RejectionCase {
  readonly name: string; readonly code: string; readonly setup?: () => BudgetLedgerState;
  readonly alloc?: Partial<BudgetMovementCommand>; readonly back?: Partial<BudgetMovementCommand>;
  readonly close?: { readonly accountId: string; readonly expectedVersion: number };
}

const REJECTIONS: readonly RejectionCase[] = [
  { name: "a stale parent version", code: STALE, alloc: { expectedChildVersion: 0 } },
  { name: "a stale child version", code: STALE, alloc: { expectedParentVersion: 1, expectedChildVersion: 7 } },
  { name: "a stale version on close", code: STALE, close: { accountId: CHILD, expectedVersion: 9 } },
  { name: "an unknown parent account", code: UNKNOWN, alloc: { parentAccountId: "account:ghost", expectedChildVersion: 0 } },
  { name: "an unknown child on return", code: UNKNOWN, back: { childAccountId: "account:ghost", expectedParentVersion: 1, expectedChildVersion: 0 } },
  { name: "an unknown account on close", code: UNKNOWN, close: { accountId: "account:ghost", expectedVersion: 0 } },
  { name: "one sibling funding another", code: MISMATCH, setup: withSibling, alloc: { parentAccountId: SIBLING, expectedParentVersion: 0, expectedChildVersion: 0 } },
  { name: "an allocation over available by exactly one unit", code: SHORT, alloc: { ...ON, amounts: [{ meter: ATTEMPTS, amount: 7 }] } },
  { name: "a meter absent from both accounts", code: NO_METER, alloc: { ...ON, amounts: [{ meter: "no.such", amount: 1 }] } },
  { name: "returning a meter the parent does not carry", code: NO_METER, setup: () => handmade({ meter: "child.only", available: 3 }), back: { expectedParentVersion: 0, expectedChildVersion: 0, amounts: [{ meter: "child.only", amount: 3 }] } },
  { name: "re-creating an existing child identity", code: DUPLICATE, alloc: { expectedParentVersion: 1 } },
  { name: "an account funding itself", code: DUPLICATE, alloc: { ...ON, childAccountId: ROOT } },
  { name: "a duplicate meter within one command", code: DUPLICATE, alloc: { ...ON, amounts: [{ meter: ATTEMPTS, amount: 1 }, { meter: ATTEMPTS, amount: 1 }] } },
  { name: "a zero-unit movement that would append an inert entry", code: MALFORMED, alloc: { ...ON, amounts: [{ meter: ATTEMPTS, amount: 0 }] } },
  { name: "a negative-zero amount", code: MALFORMED, alloc: { ...ON, amounts: [{ meter: ATTEMPTS, amount: -0 }] } },
  { name: "an empty amounts list", code: MALFORMED, alloc: { ...ON, amounts: [] } },
  { name: "closing an account still holding available units", code: ILLEGAL, close: { accountId: CHILD, expectedVersion: 0 } },
  { name: "closing an account holding reserved units", code: ILLEGAL, setup: () => handmade({ reserved: 2 }), close: { accountId: CHILD, expectedVersion: 0 } },
  { name: "closing an account holding quarantined units", code: ILLEGAL, setup: () => handmade({ quarantined: 5 }), close: { accountId: CHILD, expectedVersion: 0 } },
  { name: "closing an already-closed account", code: ILLEGAL, setup: () => handmade({}, "CLOSED"), close: { accountId: CHILD, expectedVersion: 0 } },
  { name: "closing a parent whose child is still open", code: ILLEGAL, setup: () => handmade({}, "OPEN", 0), close: { accountId: ROOT, expectedVersion: 0 } },
  { name: "several failing checks at once, reporting only the first in the published order", code: STALE, alloc: { expectedChildVersion: 0, amounts: [{ meter: "no.such", amount: 99 }] } },
];

describe("budget ledger rejections", () => {
  it("exercises every declared code except the unreachable counter ceiling", () => {
    const covered = [...new Set(REJECTIONS.map((entry) => entry.code))].sort();
    expect(REJECTIONS.length).toBeGreaterThan(0);
    expect(covered).toStrictEqual([...BUDGET_ACCOUNT_ISSUE_CODES]
      .filter((code) => code !== "BUDGET_ACCOUNT_COUNTER_EXHAUSTED").sort());
  });

  it.each(REJECTIONS.map((entry) => [entry.name, entry] as const))("refuses %s", (_name, entry) => {
    const prior = (entry.setup ?? funded)();
    const before = prior.entries.length;
    const result = entry.close !== undefined ? closeBudgetAccount(prior, entry.close)
      : entry.back !== undefined ? returnToParent(prior, onFunded(entry.back))
        : allocateToChild(prior, move(entry.alloc));
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toStrictEqual([entry.code]);
    expect(result.state).toBe(prior);
    expect(result.state.entries).toHaveLength(before);
    expect(result.ok ? true : Object.isFrozen(result.issues[0])).toBe(true);
  });
});
