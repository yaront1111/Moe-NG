/**
 * Hierarchical budget ledger (design 11.1). Allocation moves units from a parent's direct
 * AVAILABLE to a child's; return is the exact inverse. Units are never copied and never reach a
 * sibling, because every movement is one balanced double entry debiting exactly one account and
 * crediting exactly one other for the same integer amount — conservation is a property of the
 * entry shape, not a check bolted on afterwards.
 *
 * Local issue codes rather than the contract's: BUDGET_ISSUE_CODES is a closed frozen union of
 * eight SHAPE codes and this task may not edit that file, so transition failures cannot be
 * spelled with it; only the {code, message} shape is reused. deepFreeze and isCount are
 * module-private there and are cloned here for the same reason. Reservations, measurement,
 * settlement and quarantine are out of scope, and nothing here raises the authorized amount.
 */
import { MAX_BUDGET_METERS, type BudgetAccountRecord, type BudgetAccountState, type BudgetMeterBuckets } from "./budget-contract.js";
export const BUDGET_ACCOUNT_ISSUE_CODES = Object.freeze([
  "BUDGET_ACCOUNT_COMMAND_MALFORMED", "BUDGET_ACCOUNT_COUNTER_EXHAUSTED",
  "BUDGET_ACCOUNT_DUPLICATE_IDENTITY", "BUDGET_ACCOUNT_ILLEGAL_CLOSE",
  "BUDGET_ACCOUNT_INSUFFICIENT_AVAILABLE", "BUDGET_ACCOUNT_PARENT_MISMATCH",
  "BUDGET_ACCOUNT_STALE_VERSION", "BUDGET_ACCOUNT_UNKNOWN_ACCOUNT",
  "BUDGET_ACCOUNT_UNKNOWN_METER"] as const);
export type BudgetAccountIssueCode = (typeof BUDGET_ACCOUNT_ISSUE_CODES)[number];
export interface BudgetAccountIssue { readonly code: BudgetAccountIssueCode; readonly message: string }
export interface BudgetMeterAmount { readonly meter: string; readonly amount: number }
export type BudgetLedgerEntryKind = "ROOT_OPENED" | "ALLOCATED" | "RETURNED" | "CLOSED";
/**
 * `ownerRef` is set only on the ALLOCATED entry that brings a child into existence. Without it
 * the stream is not replayable: creation is folded into allocation, so the owner is a canonical
 * fact of that movement and cannot be re-derived from the other fields.
 */
export interface BudgetLedgerEntry {
  readonly sequence: number; readonly kind: BudgetLedgerEntryKind; readonly meter: string;
  readonly amount: number; readonly fromRef: string | null; readonly toRef: string | null;
  readonly ownerRef: string | null }
export interface BudgetAuthorization {
  readonly rootAccountId: string; readonly ownerRef: string;
  readonly graphRevisionRef: string; readonly amounts: readonly BudgetMeterAmount[] }
export interface BudgetLedgerState {
  readonly rootAccountId: string; readonly authorized: readonly BudgetMeterAmount[];
  readonly overrun: readonly BudgetMeterAmount[]; readonly accounts: readonly BudgetAccountRecord[];
  readonly entries: readonly BudgetLedgerEntry[] }
export interface BudgetMovementCommand {
  readonly parentAccountId: string; readonly childAccountId: string; readonly childOwnerRef: string;
  readonly expectedParentVersion: number; readonly expectedChildVersion: number | null;
  readonly amounts: readonly BudgetMeterAmount[] }
export interface BudgetCloseCommand { readonly accountId: string; readonly expectedVersion: number }
export type BudgetLedgerResult =
  | { readonly ok: true; readonly state: BudgetLedgerState }
  | { readonly ok: false; readonly state: BudgetLedgerState; readonly issues: readonly BudgetAccountIssue[] };
/** Mirrors authority-kernel.ts: a record at the ceiling is readable but may not be mutated. */
export const MAX_BUDGET_VERSION = Number.MAX_SAFE_INTEGER - 1_000_000;
const EMPTY: BudgetLedgerState = { rootAccountId: "", authorized: [], overrun: [], accounts: [], entries: [] };
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
const isRef = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const fail = (state: BudgetLedgerState, code: BudgetAccountIssueCode, message: string): BudgetLedgerResult =>
  deepFreeze({ ok: false, state, issues: [{ code, message }] });
const accept = (state: BudgetLedgerState): BudgetLedgerResult => deepFreeze({ ok: true, state });
const find = (state: BudgetLedgerState, id: string): BudgetAccountRecord | undefined =>
  state.accounts.find((record) => record.accountId === id);
const bucketOf = (record: BudgetAccountRecord, meter: string): BudgetMeterBuckets | undefined =>
  record.meters.find((entry) => entry.meter === meter);
/** Root plus every descendant, each direct bucket counted once. Never stored: design 607 keeps
 * roll-ups derived so they cannot drift from the direct buckets they summarise. */
export function deriveSubtreeTotals(state: BudgetLedgerState): readonly BudgetMeterAmount[] {
  const totals = new Map<string, number>();
  for (const record of state.accounts) for (const m of record.meters) {
    totals.set(m.meter, (totals.get(m.meter) ?? 0) + m.available + m.reserved + m.quarantined + m.committed);
  }
  return deepFreeze([...totals].map(([meter, amount]) => ({ meter, amount }))
    .sort((left, right) => (left.meter < right.meter ? -1 : left.meter > right.meter ? 1 : 0)));
}
const zeroBucket = (meter: string, available: number): BudgetMeterBuckets =>
  ({ meter, available, reserved: 0, quarantined: 0, committed: 0 });
/** The authorized amount is an input fact: no transition here raises it, and `overrun` starts
 * empty and stays so until settlement (17.04) exists to record one. */
export function openBudgetRoot(authorization: BudgetAuthorization): BudgetLedgerResult {
  const { rootAccountId, ownerRef, graphRevisionRef, amounts } = authorization;
  if (!isRef(rootAccountId) || !isRef(ownerRef) || !isRef(graphRevisionRef)) {
    return fail(EMPTY, "BUDGET_ACCOUNT_COMMAND_MALFORMED", "root authorization is malformed");
  }
  if (amounts.length === 0 || amounts.length > MAX_BUDGET_METERS
    || amounts.some((entry) => !isRef(entry.meter) || !isCount(entry.amount))
    || new Set(amounts.map((entry) => entry.meter)).size !== amounts.length) {
    return fail(EMPTY, "BUDGET_ACCOUNT_COMMAND_MALFORMED", "authorized amounts are malformed or duplicated");
  }
  return accept(deepFreeze({
    rootAccountId, authorized: amounts.map((entry) => ({ ...entry })), overrun: [],
    accounts: [{ accountId: rootAccountId, ownerRef, parentRef: null, graphRevisionRef, version: 0,
      state: "OPEN" as BudgetAccountState, meters: amounts.map((e) => zeroBucket(e.meter, e.amount)) }],
    entries: amounts.map((entry, index) => ({
      sequence: index, kind: "ROOT_OPENED" as const, meter: entry.meter, amount: entry.amount,
      fromRef: null, toRef: rootAccountId, ownerRef,
    })),
  }));
}
/**
 * Published check order — malformed, duplicate identity, unknown account, exhausted counter,
 * stale version, parent mismatch, unknown meter, insufficient available. The FIRST failing check
 * decides the single reported code (lease-fencing.ts:87-95), so one rejected command never
 * reports two causes. Nothing is constructed until every check passes, and every rejection hands
 * back the prior state BY REFERENCE with no entry appended.
 */
function applyMovement(
  state: BudgetLedgerState, command: BudgetMovementCommand, kind: "ALLOCATED" | "RETURNED",
): BudgetLedgerResult {
  const { parentAccountId: pid, childAccountId: cid, expectedChildVersion: cv, amounts } = command;
  if (!isRef(pid) || !isRef(cid) || !isRef(command.childOwnerRef) || amounts.length === 0
    || amounts.length > MAX_BUDGET_METERS || !isCount(command.expectedParentVersion)
    || (cv !== null && !isCount(cv))
    || amounts.some((e) => !isRef(e.meter) || !isCount(e.amount) || e.amount === 0)) {
    return fail(state, "BUDGET_ACCOUNT_COMMAND_MALFORMED", "movement command is malformed");
  }
  const existing = find(state, cid);
  if (pid === cid || new Set(amounts.map((e) => e.meter)).size !== amounts.length
    || (cv === null && existing !== undefined)) {
    return fail(state, "BUDGET_ACCOUNT_DUPLICATE_IDENTITY", "movement duplicates an identity");
  }
  const parent = find(state, pid);
  if (parent === undefined || (cv !== null && existing === undefined)) {
    return fail(state, "BUDGET_ACCOUNT_UNKNOWN_ACCOUNT", "movement names an unknown account");
  }
  if (parent.version >= MAX_BUDGET_VERSION || (existing?.version ?? 0) >= MAX_BUDGET_VERSION) {
    return fail(state, "BUDGET_ACCOUNT_COUNTER_EXHAUSTED", "an account version counter is exhausted");
  }
  if (parent.version !== command.expectedParentVersion
    || (existing !== undefined && cv !== null && existing.version !== cv)) {
    return fail(state, "BUDGET_ACCOUNT_STALE_VERSION", "an expected version is not current");
  }
  if (existing !== undefined && existing.parentRef !== pid) {
    return fail(state, "BUDGET_ACCOUNT_PARENT_MISMATCH", "child is not bound to the named parent");
  }
  const child: BudgetAccountRecord = existing ?? {
    accountId: cid, ownerRef: command.childOwnerRef, parentRef: pid,
    graphRevisionRef: parent.graphRevisionRef, version: 0, state: "OPEN", meters: [],
  };
  const source = kind === "ALLOCATED" ? parent : child;
  const sink = kind === "ALLOCATED" ? child : parent;
  // The sink may gain a meter only when it is a child being funded; a parent's meter set is
  // authorized, so returning a meter it does not carry fails closed rather than autovivifying.
  if (amounts.some((e) => bucketOf(source, e.meter) === undefined
    || (kind === "RETURNED" && bucketOf(sink, e.meter) === undefined))) {
    return fail(state, "BUDGET_ACCOUNT_UNKNOWN_METER", "an account does not carry a named meter");
  }
  if (amounts.some((e) => (bucketOf(source, e.meter)?.available ?? 0) < e.amount)) {
    return fail(state, "BUDGET_ACCOUNT_INSUFFICIENT_AVAILABLE", "available units are insufficient");
  }
  const grown = shift(sink, amounts, 1);
  if (grown.length > MAX_BUDGET_METERS) {
    return fail(state, "BUDGET_ACCOUNT_COMMAND_MALFORMED", "movement would exceed the meter ceiling");
  }
  const nextSource = { ...source, version: source.version + 1, meters: shift(source, amounts, -1) };
  const nextSink = { ...sink, version: existing === undefined && sink === child ? 0 : sink.version + 1, meters: grown };
  const nextParent = kind === "ALLOCATED" ? nextSource : nextSink;
  const nextChild = kind === "ALLOCATED" ? nextSink : nextSource;
  const base = state.accounts.map((r) => (r.accountId === pid ? nextParent : r.accountId === cid ? nextChild : r));
  return accept(deepFreeze({
    ...state,
    accounts: existing === undefined ? [...base, nextChild] : base,
    entries: [...state.entries, ...amounts.map((e, index) => ({
      sequence: state.entries.length + index, kind, meter: e.meter, amount: e.amount,
      fromRef: source.accountId, toRef: sink.accountId,
      ownerRef: existing === undefined && kind === "ALLOCATED" ? child.ownerRef : null,
    }))],
  }));
}

/** Returns a NEW bucket list; the input record is never mutated in place. */
function shift(record: BudgetAccountRecord, amounts: readonly BudgetMeterAmount[], sign: 1 | -1): BudgetMeterBuckets[] {
  const next = record.meters.map((meter) => ({ ...meter }));
  for (const entry of amounts) {
    const found = next.find((meter) => meter.meter === entry.meter);
    if (found === undefined) next.push(zeroBucket(entry.meter, entry.amount));
    else found.available += sign * entry.amount;
  }
  return next;
}
export const allocateToChild = (state: BudgetLedgerState, command: BudgetMovementCommand): BudgetLedgerResult =>
  applyMovement(state, command, "ALLOCATED");
export const returnToParent = (state: BudgetLedgerState, command: BudgetMovementCommand): BudgetLedgerResult =>
  applyMovement(state, command, "RETURNED");

/** COMMITTED may be nonzero: measured spend is a real fact, so a closed account is RETAINED and
 * its committed units keep counting toward the derived total. Closing a parent whose child is
 * still open would strand a funded subtree, so it is refused. */
export function closeBudgetAccount(state: BudgetLedgerState, command: BudgetCloseCommand): BudgetLedgerResult {
  if (!isRef(command.accountId) || !isCount(command.expectedVersion)) {
    return fail(state, "BUDGET_ACCOUNT_COMMAND_MALFORMED", "close command is malformed");
  }
  const record = find(state, command.accountId);
  if (record === undefined) return fail(state, "BUDGET_ACCOUNT_UNKNOWN_ACCOUNT", "close names an unknown account");
  if (record.version >= MAX_BUDGET_VERSION) {
    return fail(state, "BUDGET_ACCOUNT_COUNTER_EXHAUSTED", "an account version counter is exhausted");
  }
  if (record.version !== command.expectedVersion) {
    return fail(state, "BUDGET_ACCOUNT_STALE_VERSION", "an expected version is not current");
  }
  const drained = record.meters.every((m) => m.available === 0 && m.reserved === 0 && m.quarantined === 0);
  const childrenClosed = state.accounts.every((r) => r.parentRef !== record.accountId || r.state === "CLOSED");
  if (record.state === "CLOSED" || !drained || !childrenClosed) {
    return fail(state, "BUDGET_ACCOUNT_ILLEGAL_CLOSE", "account is not in a legally closable state");
  }
  const closed: BudgetAccountRecord = { ...record, version: record.version + 1, state: "CLOSED" };
  return accept(deepFreeze({
    ...state,
    accounts: state.accounts.map((r) => (r.accountId === record.accountId ? closed : r)),
    entries: [...state.entries, { sequence: state.entries.length, kind: "CLOSED" as const,
      meter: "", amount: 0, fromRef: record.accountId, toRef: null, ownerRef: null }],
  }));
}

/** Folds canonical entries through the SAME transition core as live application, so replay cannot
 * drift from it. Versions come from the state being rebuilt, not from the entries, because a
 * version is a consequence of the fold rather than an independent fact. */
export function replayBudgetLedger(
  authorization: BudgetAuthorization, entries: readonly BudgetLedgerEntry[],
): BudgetLedgerResult {
  const opened = openBudgetRoot(authorization);
  if (!opened.ok) return opened;
  let state = opened.state;
  for (const entry of entries) {
    if (entry.kind === "ROOT_OPENED") continue;
    if (entry.kind === "CLOSED") {
      const id = entry.fromRef ?? "";
      const closed = closeBudgetAccount(state, { accountId: id, expectedVersion: find(state, id)?.version ?? -1 });
      if (!closed.ok) return closed;
      state = closed.state;
      continue;
    }
    const allocating = entry.kind === "ALLOCATED";
    const pid = (allocating ? entry.fromRef : entry.toRef) ?? "";
    const cid = (allocating ? entry.toRef : entry.fromRef) ?? "";
    const child = find(state, cid);
    const applied = applyMovement(state, {
      parentAccountId: pid, childAccountId: cid, childOwnerRef: entry.ownerRef ?? child?.ownerRef ?? "",
      expectedParentVersion: find(state, pid)?.version ?? -1,
      expectedChildVersion: child?.version ?? null,
      amounts: [{ meter: entry.meter, amount: entry.amount }],
    }, entry.kind);
    if (!applied.ok) return applied;
    state = applied.state;
  }
  return accept(state);
}
