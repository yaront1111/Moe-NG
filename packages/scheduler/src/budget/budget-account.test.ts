import { describe, expect, it } from "vitest";
import {
  BUDGET_ACCOUNT_ISSUE_CODES, allocateToChild, closeBudgetAccount, deriveSubtreeTotals,
  openBudgetRoot, returnToParent,
  type BudgetLedgerEntry, type BudgetLedgerResult, type BudgetLedgerState,
  type BudgetMovementCommand,
} from "./budget-account.js";
import { replayBudgetLedger } from "./budget-account-replay.js";
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
    const replayed = must(replayBudgetLedger(AUTHORIZATION, [
      live.entries.slice(0, 2), live.entries.slice(2, 3), live.entries.slice(3)]));
    expect(replayed).toStrictEqual(live);
    expect(Object.isFrozen(replayed)).toBe(true);
    expect(Object.isFrozen(replayed.accounts)).toBe(true);
    expect(Object.isFrozen(account(replayed, CHILD))).toBe(true);
    expect(Object.isFrozen(account(replayed, CHILD)?.meters)).toBe(true);
    expect(Object.isFrozen(bucket(replayed, CHILD, ATTEMPTS))).toBe(true);
    expectConserved(replayed);
  });

  it("replays a multi-meter creation as ONE movement: version parity and ownerRef on every entry", () => {
    const live = must(allocateToChild(opened(), move({
      amounts: [{ meter: ATTEMPTS, amount: 4 }, { meter: MS, amount: 250 }] })));
    const replayed = must(replayBudgetLedger(AUTHORIZATION, [
      live.entries.slice(0, 2), live.entries.slice(2)]));
    expect(replayed).toStrictEqual(live);
    // One command advanced each side once, not once per meter.
    expect(account(replayed, ROOT)?.version).toBe(1);
    expect(account(replayed, CHILD)?.version).toBe(0);
    const rebuilt = replayed.entries.filter((entry) => entry.kind === "ALLOCATED");
    expect(rebuilt).toHaveLength(2);
    for (const entry of rebuilt) expect(entry.ownerRef).toBe("node:1");
    expectConserved(replayed);
  });

  it("folds an empty command group to nothing: a hold moves units without a movement entry", () => {
    const live = funded();
    const replayed = must(replayBudgetLedger(AUTHORIZATION, [
      live.entries.slice(0, 2), [], live.entries.slice(2), []]));
    expect(replayed).toStrictEqual(live);
    expectConserved(replayed);
  });

  it("refuses a group that is not one command's balanced double entry", () => {
    const inverse = must(returnToParent(funded(), onFunded()));
    // ALLOCATED and RETURNED folded into one group cannot be one command.
    expect(codesOf(replayBudgetLedger(AUTHORIZATION, [
      inverse.entries.slice(0, 2), inverse.entries.slice(2),
    ]))).toStrictEqual(["BUDGET_ACCOUNT_COMMAND_MALFORMED"]);
    // Two same-kind movements to two different children are two commands, not one.
    const forked = withSibling();
    expect(codesOf(replayBudgetLedger(AUTHORIZATION, [
      forked.entries.slice(0, 2), forked.entries.slice(2),
    ]))).toStrictEqual(["BUDGET_ACCOUNT_COMMAND_MALFORMED"]);
    // Positive control: the SAME stream grouped at its command boundaries folds cleanly, so
    // the refusals above indict the grouping and not the entries.
    expect(replayBudgetLedger(AUTHORIZATION, [
      forked.entries.slice(0, 2), forked.entries.slice(2, 3), forked.entries.slice(3),
    ]).ok).toBe(true);
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

interface ReplayForgery {
  readonly name: string;
  readonly groups: readonly (readonly BudgetLedgerEntry[])[];
  readonly code: string;
  readonly prior: BudgetLedgerState;
}

function altered(
  entry: BudgetLedgerEntry,
  changes: Partial<BudgetLedgerEntry>,
): BudgetLedgerEntry {
  return { ...entry, ...changes };
}

function replaceAt(
  entries: readonly BudgetLedgerEntry[],
  index: number,
  changes: Partial<BudgetLedgerEntry>,
): readonly BudgetLedgerEntry[] {
  return entries.map((entry, offset) => (offset === index ? altered(entry, changes) : entry));
}

const ROOT_ENTRIES = opened().entries;
const REORDERED_AUTHORIZATION_ROOT = must(openBudgetRoot({
  ...AUTHORIZATION,
  amounts: [...AUTHORIZATION.amounts].reverse(),
})).entries;
const MULTI_LIVE = must(allocateToChild(opened(), move({
  amounts: [{ meter: ATTEMPTS, amount: 4 }, { meter: MS, amount: 250 }],
})));
const MULTI_MOVE = MULTI_LIVE.entries.slice(ROOT_ENTRIES.length);
const ROOT_FIELD_TAMPERS: readonly [string, Partial<BudgetLedgerEntry>][] = [
  ["sequence", { sequence: 99 }],
  ["max-safe sequence", { sequence: Number.MAX_SAFE_INTEGER }],
  ["unsafe sequence", { sequence: Number.MAX_SAFE_INTEGER + 1 }],
  ["kind", { kind: "ALLOCATED" }],
  ["meter", { meter: "forged.meter" }],
  ["amount", { amount: 11 }],
  ["max-safe amount", { amount: Number.MAX_SAFE_INTEGER }],
  ["negative-zero amount", { amount: -0 }],
  ["fromRef", { fromRef: CHILD }],
  ["toRef", { toRef: CHILD }],
  ["ownerRef", { ownerRef: "goal:attacker" }],
];

const ROOT_TAMPERS: readonly ReplayForgery[] = [
  ...ROOT_FIELD_TAMPERS.map(([name, changes]) => ({
    name: `root ${name}`,
    groups: [replaceAt(ROOT_ENTRIES, 0, changes)],
    code: MALFORMED,
    prior: opened(),
  })),
  { name: "missing root entry", groups: [ROOT_ENTRIES.slice(1)], code: MALFORMED, prior: opened() },
  { name: "duplicate root entry", groups: [[...ROOT_ENTRIES, ROOT_ENTRIES[0]!]], code: MALFORMED, prior: opened() },
  { name: "trailing movement in root group", groups: [[...ROOT_ENTRIES, MULTI_MOVE[0]!]], code: MALFORMED, prior: opened() },
  { name: "reversed root order", groups: [[...ROOT_ENTRIES].reverse()], code: MALFORMED, prior: opened() },
  { name: "independently valid reordered authorization", groups: [REORDERED_AUTHORIZATION_ROOT], code: MALFORMED, prior: opened() },
  { name: "root after movement", groups: [MULTI_MOVE, ROOT_ENTRIES], code: MALFORMED, prior: opened() },
  { name: "repeated root group", groups: [ROOT_ENTRIES, ROOT_ENTRIES], code: MALFORMED, prior: opened() },
  { name: "midstream root group", groups: [ROOT_ENTRIES, MULTI_MOVE, ROOT_ENTRIES], code: MALFORMED, prior: MULTI_LIVE },
  { name: "omitted root", groups: [MULTI_MOVE], code: MALFORMED, prior: opened() },
  { name: "only empty groups", groups: [[], []], code: MALFORMED, prior: opened() },
];

const DRAINED = must(returnToParent(funded(), onFunded()));
const CLOSED_CHILD = must(closeBudgetAccount(DRAINED, { accountId: CHILD, expectedVersion: 1 }));
const CLOSE_ENTRY = CLOSED_CHILD.entries.slice(DRAINED.entries.length);
const BEFORE_CLOSE_GROUPS = [
  ROOT_ENTRIES,
  DRAINED.entries.slice(ROOT_ENTRIES.length, ROOT_ENTRIES.length + 1),
  DRAINED.entries.slice(ROOT_ENTRIES.length + 1),
];
const MOVEMENT_TAMPERS: readonly [string, readonly BudgetLedgerEntry[], string][] = [
  ["mixed kind", replaceAt(MULTI_MOVE, 1, { kind: "RETURNED" }), MALFORMED],
  ["mixed fromRef", replaceAt(MULTI_MOVE, 1, { fromRef: CHILD }), MALFORMED],
  ["mixed toRef", replaceAt(MULTI_MOVE, 1, { toRef: GRANDCHILD }), MALFORMED],
  ["forged sequence", replaceAt(MULTI_MOVE, 0, { sequence: 200 }), MALFORMED],
  ["creation owner mismatch", replaceAt(MULTI_MOVE, 1, { ownerRef: "node:attacker" }), MALFORMED],
  ["unknown meter", replaceAt(MULTI_MOVE, 0, { meter: "forged.meter" }), NO_METER],
  ["negative-zero amount", replaceAt(MULTI_MOVE, 0, { amount: -0 }), MALFORMED],
  ["missing first entry", MULTI_MOVE.slice(1), MALFORMED],
  ["extra duplicate entry", [...MULTI_MOVE, MULTI_MOVE[0]!], DUPLICATE],
  ["reordered entries", [...MULTI_MOVE].reverse(), MALFORMED],
];
const CLOSE_FIELD_TAMPERS: readonly [string, Partial<BudgetLedgerEntry>][] = [
  ["sequence", { sequence: 200 }],
  ["meter", { meter: ATTEMPTS }],
  ["amount", { amount: 1 }],
  ["toRef", { toRef: ROOT }],
  ["ownerRef", { ownerRef: "node:attacker" }],
];
const DESCENDANT_TAMPERS: readonly ReplayForgery[] = [
  ...MOVEMENT_TAMPERS.map(([name, group, code]) => ({
    name,
    groups: [ROOT_ENTRIES, group],
    code,
    prior: opened(),
  })),
  ...CLOSE_FIELD_TAMPERS.map(([name, changes]) => ({
    name: `close ${name}`,
    groups: [...BEFORE_CLOSE_GROUPS, replaceAt(CLOSE_ENTRY, 0, changes)],
    code: MALFORMED,
    prior: DRAINED,
  })),
  {
    name: "multi-close group",
    groups: [...BEFORE_CLOSE_GROUPS, [...CLOSE_ENTRY, CLOSE_ENTRY[0]!]],
    code: MALFORMED,
    prior: DRAINED,
  },
];

describe("canonical budget replay validation", () => {
  it("refuses an empty command group before the root delta", () => {
    const result = replayBudgetLedger(AUTHORIZATION, [[], ROOT_ENTRIES]);

    expect(codesOf(result)).toStrictEqual([MALFORMED]);
    expect(result.state).toStrictEqual(opened());
  });

  it("refuses an otherwise canonical ROOT_OPENED entry with an extra field", () => {
    const forged = [
      { ...ROOT_ENTRIES[0]!, authority: "caller" } as BudgetLedgerEntry,
      ROOT_ENTRIES[1]!,
    ];
    const result = replayBudgetLedger(AUTHORIZATION, [forged]);

    expect(codesOf(result)).toStrictEqual([MALFORMED]);
    expect(result.state).toStrictEqual(opened());
  });

  it("refuses a forged ROOT_OPENED group after the canonical root", () => {
    const forged = [altered(ROOT_ENTRIES[0]!, {
      amount: Number.MAX_SAFE_INTEGER,
      fromRef: CHILD,
      meter: "forged.meter",
      ownerRef: "goal:attacker",
      sequence: 99,
      toRef: GRANDCHILD,
    })];
    const result = replayBudgetLedger(AUTHORIZATION, [ROOT_ENTRIES, forged]);

    expect(codesOf(result)).toStrictEqual([MALFORMED]);
    expect(result.state).toStrictEqual(opened());
    expect(result.state.entries).toStrictEqual(ROOT_ENTRIES);
  });

  it.each(ROOT_TAMPERS.map((entry) => [entry.name, entry] as const))(
    "refuses %s",
    (_name, entry) => {
      const result = replayBudgetLedger(AUTHORIZATION, entry.groups);
      expect(codesOf(result)).toStrictEqual([entry.code]);
      expect(result.state).toStrictEqual(entry.prior);
      expect(Object.isFrozen(result.state)).toBe(true);
    },
  );

  it("generates a nonzero root-tamper roster covering all seven fields and group shape", () => {
    expect(ROOT_FIELD_TAMPERS.map(([field]) => field)).toStrictEqual([
      "sequence", "max-safe sequence", "unsafe sequence", "kind", "meter", "amount",
      "max-safe amount", "negative-zero amount", "fromRef", "toRef", "ownerRef",
    ]);
    expect(ROOT_TAMPERS.length).toBe(21);
  });

  it.each(DESCENDANT_TAMPERS.map((entry) => [entry.name, entry] as const))(
    "refuses descendant delta with %s",
    (_name, entry) => {
      const result = replayBudgetLedger(AUTHORIZATION, entry.groups);
      expect(codesOf(result)).toStrictEqual([entry.code]);
      expect(result.state).toStrictEqual(entry.prior);
      expect(Object.isFrozen(result.state)).toBe(true);
    },
  );

  it("replays every canonical delta with empty no-movement groups byte-for-byte", () => {
    let live = MULTI_LIVE;
    live = must(allocateToChild(live, move({
      parentAccountId: CHILD, childAccountId: GRANDCHILD, childOwnerRef: "node:2",
      expectedParentVersion: 0, amounts: [{ meter: ATTEMPTS, amount: 2 }, { meter: MS, amount: 100 }],
    })));
    live = must(returnToParent(live, move({
      parentAccountId: CHILD, childAccountId: GRANDCHILD, childOwnerRef: "node:2",
      expectedParentVersion: 1, expectedChildVersion: 0,
      amounts: [{ meter: ATTEMPTS, amount: 2 }, { meter: MS, amount: 100 }],
    })));
    live = must(closeBudgetAccount(live, { accountId: GRANDCHILD, expectedVersion: 1 }));
    live = must(returnToParent(live, move({
      expectedParentVersion: 1, expectedChildVersion: 2,
      amounts: [{ meter: ATTEMPTS, amount: 4 }, { meter: MS, amount: 250 }],
    })));
    live = must(closeBudgetAccount(live, { accountId: CHILD, expectedVersion: 3 }));
    const cuts = [2, 4, 6, 8, 9, 11, 12];
    const groups = cuts.map((end, index) => live.entries.slice(index === 0 ? 0 : cuts[index - 1], end));
    const replayed = must(replayBudgetLedger(AUTHORIZATION, [groups[0]!, [], ...groups.slice(1), []]));
    expect(replayed).toStrictEqual(live);
    expect(replayed.entries).toStrictEqual(live.entries);
    for (const value of [replayed, replayed.accounts, replayed.entries, ...replayed.entries]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("accepts a self-consistent alternate descendant command for parent head comparison", () => {
    const alternate = must(allocateToChild(opened(), move({
      childOwnerRef: "node:alternate", amounts: [{ meter: ATTEMPTS, amount: 3 }],
    })));
    const replayed = must(replayBudgetLedger(AUTHORIZATION, [
      alternate.entries.slice(0, 2), alternate.entries.slice(2),
    ]));
    expect(replayed).toStrictEqual(alternate);
    // Entries alone cannot identify another valid reducer history as tamper. The P1.6 parent
    // compares this rebuilt head with the durable record head and refuses the disagreement.
  });
});

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
