/**
 * Budget replay extraction. This module deliberately calls only the live account transitions;
 * it never reproduces their arithmetic or mutates a caller-supplied entry into state directly.
 */
import {
  allocateToChild,
  closeBudgetAccount,
  openBudgetRoot,
  refuseMalformedBudgetReplay,
  returnToParent,
} from "./budget-account.js";
import type {
  BudgetAuthorization,
  BudgetLedgerEntry,
  BudgetLedgerResult,
  BudgetLedgerState,
} from "./budget-account.js";

const ENTRY_KEYS = Object.freeze([
  "sequence", "kind", "meter", "amount", "fromRef", "toRef", "ownerRef",
] as const);

function versionOf(state: BudgetLedgerState, accountId: string): number | undefined {
  return state.accounts.find((record) => record.accountId === accountId)?.version;
}

function ownerOf(state: BudgetLedgerState, accountId: string): string | undefined {
  return state.accounts.find((record) => record.accountId === accountId)?.ownerRef;
}

function hasExactEntryShape(value: unknown): value is BudgetLedgerEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    return keys.length === ENTRY_KEYS.length && keys.every((key) => {
      if (typeof key !== "string" || !(ENTRY_KEYS as readonly string[]).includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function entryEquals(left: BudgetLedgerEntry, right: unknown): boolean {
  if (!hasExactEntryShape(right)) return false;
  return (
    Object.is(left.sequence, right.sequence) &&
    left.kind === right.kind &&
    left.meter === right.meter &&
    Object.is(left.amount, right.amount) &&
    left.fromRef === right.fromRef &&
    left.toRef === right.toRef &&
    left.ownerRef === right.ownerRef
  );
}

function deltaEquals(
  expected: readonly BudgetLedgerEntry[],
  supplied: readonly BudgetLedgerEntry[],
): boolean {
  return expected.length === supplied.length &&
    expected.every((entry, index) => entryEquals(entry, supplied[index]!));
}

function applyClose(state: BudgetLedgerState, first: BudgetLedgerEntry): BudgetLedgerResult {
  const accountId = first.fromRef ?? "";
  return closeBudgetAccount(state, {
    accountId,
    expectedVersion: versionOf(state, accountId) ?? -1,
  });
}

function applyMovementGroup(
  state: BudgetLedgerState,
  group: readonly BudgetLedgerEntry[],
): BudgetLedgerResult {
  const first = group[0]!;
  const allocating = first.kind === "ALLOCATED";
  const parentAccountId = (allocating ? first.fromRef : first.toRef) ?? "";
  const childAccountId = (allocating ? first.toRef : first.fromRef) ?? "";
  const childVersion = versionOf(state, childAccountId);
  const command = {
    parentAccountId,
    childAccountId,
    childOwnerRef: first.ownerRef ?? ownerOf(state, childAccountId) ?? "",
    expectedParentVersion: versionOf(state, parentAccountId) ?? -1,
    expectedChildVersion: childVersion ?? null,
    amounts: group.map((entry) => ({ meter: entry.meter, amount: entry.amount })),
  };
  return allocating ? allocateToChild(state, command) : returnToParent(state, command);
}

function applyCanonicalGroup(
  state: BudgetLedgerState,
  group: readonly BudgetLedgerEntry[],
): BudgetLedgerResult {
  for (let index = 0; index < group.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(group, index) || !hasExactEntryShape(group[index])) {
      return refuseMalformedBudgetReplay(state, "replay group carries a malformed entry");
    }
  }
  const first = group[0]!;
  if (group.some((entry) => entry.kind !== first.kind)) {
    return refuseMalformedBudgetReplay(state, "replay group mixes entry kinds");
  }
  if (group.some((entry) => entry.kind === "ROOT_OPENED")) {
    return refuseMalformedBudgetReplay(state, "replay repeats the root delta");
  }
  if (first.kind !== "CLOSED" &&
      group.some((entry) => entry.fromRef !== first.fromRef || entry.toRef !== first.toRef)) {
    return refuseMalformedBudgetReplay(state, "replay group spans more than one movement");
  }
  const applied = first.kind === "CLOSED"
    ? applyClose(state, first)
    : applyMovementGroup(state, group);
  if (!applied.ok) return applied;
  const appended = applied.state.entries.slice(state.entries.length);
  return deltaEquals(appended, group)
    ? applied
    : refuseMalformedBudgetReplay(state, "replay group differs from the canonical delta");
}

/**
 * Entries arrive grouped by command because a flat stream cannot distinguish one multi-meter
 * movement from several single-meter commands. Group zero is always the root authorization;
 * later empty groups are intentional no-movement facts.
 */
export function replayBudgetLedger(
  authorization: BudgetAuthorization,
  commands: readonly (readonly BudgetLedgerEntry[])[],
): BudgetLedgerResult {
  const opened = openBudgetRoot(authorization);
  if (!opened.ok) return opened;
  const rootGroup = commands[0];
  if (rootGroup === undefined || !deltaEquals(opened.state.entries, rootGroup)) {
    return refuseMalformedBudgetReplay(opened.state, "replay root differs from authorization");
  }
  let state = opened.state;
  for (const group of commands.slice(1)) {
    if (group.length === 0) continue;
    const applied = applyCanonicalGroup(state, group);
    if (!applied.ok) return applied;
    state = applied.state;
  }
  return Object.freeze({ ok: true, state });
}
