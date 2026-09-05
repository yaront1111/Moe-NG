/**
 * Settlement and reconciliation (design 11.1 601-613, 11.4 655-664, recovery matrix 1038-1039). An exact correlated
 * receipt commits RESERVED -> COMMITTED and refunds only the proven remainder; PARTIAL commits its lower bound and
 * quarantines the rest; UNKNOWN or a missing receipt quarantines the whole hold rather than laundering it into zero
 * measured spend. Measured use above the hold enters COMMITTED and is simultaneously recorded as explicit overrun with
 * state OVERDRAWN, which is what keeps AVAILABLE+RESERVED+QUARANTINED+COMMITTED = authorized + recorded overrun; no
 * bucket goes negative and no sibling meter funds another, and quarantine keeps only the four closed exits.
 * RESERVATION_STATES is closed and unowned here, so settlement mints its own record. Pure: no Date, no randomness, no
 * registry — a replay is fenced by the caller-supplied prior plus the version fence, so the store, not this module,
 * enforces at-most-one. SETTLING is a ledger lifecycle, and close can only judge the settlement records it is handed.
 */
import { hasOnlyOwnStringKeys, isPlainArray, isPlainRecord, readOwnDataProperty } from "../runtime-shape.js";
import { MAX_BUDGET_VERSION } from "./budget-account.js";
import { BUDGET_ACCOUNT_STATES, BUDGET_MEASUREMENT_COVERAGES, type BudgetAccountState, type BudgetMeterBuckets } from "./budget-contract.js";
import { deriveReservationId, type BudgetAvailableView, type ReservationRecord } from "./budget-reservation.js";
import type { NormalizedMeasurement } from "./budget-measurement.js";
import { decodeProviderRunRefAttempt } from "./budget-run-ref.js";

export const BUDGET_SETTLEMENT_ISSUE_CODES = Object.freeze([
  "BUDGET_SETTLEMENT_ACKNOWLEDGEMENT_MISSING", "BUDGET_SETTLEMENT_ALREADY_SETTLED", "BUDGET_SETTLEMENT_COUNTER_EXHAUSTED",
  "BUDGET_SETTLEMENT_DUPLICATE_METER", "BUDGET_SETTLEMENT_EVIDENCE_AMBIGUOUS", "BUDGET_SETTLEMENT_IDENTITY_MISMATCH",
  "BUDGET_SETTLEMENT_ILLEGAL_CLOSE", "BUDGET_SETTLEMENT_INSUFFICIENT_QUARANTINED", "BUDGET_SETTLEMENT_INSUFFICIENT_RESERVED",
  "BUDGET_SETTLEMENT_MALFORMED", "BUDGET_SETTLEMENT_MEASUREMENT_CONFLICT", "BUDGET_SETTLEMENT_NOT_ACTIVATED",
  "BUDGET_SETTLEMENT_SEQUENCE_STALE", "BUDGET_SETTLEMENT_STALE_VERSION", "BUDGET_SETTLEMENT_UNCORRELATED_MEASUREMENT",
  "BUDGET_SETTLEMENT_UNKNOWN_METER"] as const);
export const SETTLEMENT_STATES = Object.freeze(["QUARANTINED", "SETTLED", "WRITTEN_OFF"] as const);
export const LINE_DISPOSITIONS = Object.freeze(["EXACT", "LOWER_BOUND", "UNKNOWN_HELD", "CONSERVATIVE_WRITE_OFF", "NEVER_STARTED_REFUND"] as const);
export type BudgetSettlementIssueCode = (typeof BUDGET_SETTLEMENT_ISSUE_CODES)[number];
export type SettlementState = (typeof SETTLEMENT_STATES)[number];
export type LineDisposition = (typeof LINE_DISPOSITIONS)[number];
export interface BudgetSettlementIssue { readonly code: BudgetSettlementIssueCode; readonly message: string }
export interface BudgetOverrun { readonly meter: string; readonly amount: number }
/** identity/sequence belong to the measurement that last moved this line; reconcile orders on them. */
export interface SettlementLine { readonly meter: string; readonly reserved: number; readonly committed: number; readonly refunded: number;
  readonly quarantined: number; readonly disposition: LineDisposition; readonly identity: string | null; readonly sequence: number | null }
export interface SettlementRecord { readonly settlementId: string; readonly reservationId: string; readonly accountId: string;
  readonly attemptRef: string; readonly version: number; readonly state: SettlementState; readonly lines: readonly SettlementLine[];
  readonly unknownExternalLiability: boolean; readonly overrun: readonly BudgetOverrun[] }
export interface SettleEvidence { readonly measurements: readonly NormalizedMeasurement[] }
export interface ReconcileEvidence { readonly measurements: readonly NormalizedMeasurement[] | null; readonly neverStartedProofRef: string | null }
export interface SettleCommand { readonly expectedViewVersion: number; readonly expectedReservationVersion: number; readonly prior: SettlementRecord | null }
export interface SettlementCommand { readonly expectedViewVersion: number; readonly expectedSettlementVersion: number }
export interface ConservativeCommand extends SettlementCommand { readonly acknowledgementRef: string; readonly enforceableUpperBound: boolean }
export interface CloseCommand { readonly expectedVersion: number }
export type BudgetSettlementResult =
  | { readonly ok: true; readonly settlement: SettlementRecord | null; readonly view: BudgetAvailableView }
  | { readonly ok: false; readonly settlement: SettlementRecord | null; readonly view: BudgetAvailableView; readonly issues: readonly BudgetSettlementIssue[] };

const MAX_REF_LENGTH = 512, MAX_LINES = 512;
const AMOUNTS = ["available", "reserved", "quarantined", "committed"] as const, LINE_AMOUNTS = ["reserved", "committed", "refunded", "quarantined"] as const;
const HOLD_KEYS = ["purpose", "meter", "quantity"] as const, ARM_KEYS = ["measurements", "neverStartedProofRef"] as const;
const SETTLE_KEYS = ["expectedViewVersion", "expectedReservationVersion", "prior"] as const, FENCE_KEYS = ["expectedViewVersion", "expectedSettlementVersion"] as const;
const ACK_KEYS = [...FENCE_KEYS, "acknowledgementRef", "enforceableUpperBound"] as const;
const OBSERVATION_KEYS = ["measurement", "pricebookBinding", "truncated", "identity"] as const;
const MEASUREMENT_KEYS = ["meter", "quantity", "coverage", "source", "providerRunRef", "sourceParserVersion", "sequence", "rawReceiptDigest", "observedInterval"] as const;
const RESERVATION_KEYS = ["reservationId", "accountId", "admissionRef", "state", "version", "lines", "attemptRef", "neverStartedProofRef"] as const;
const SETTLEMENT_KEYS = ["settlementId", "reservationId", "accountId", "attemptRef", "version", "state", "lines", "unknownExternalLiability", "overrun"] as const;
const LINE_KEYS = [...LINE_AMOUNTS, "meter", "disposition", "identity", "sequence"] as const;
/** A line is resolved only when nothing about it is still unmeasured; anything else stays quarantined. */
const RESOLVED: readonly LineDisposition[] = ["EXACT", "CONSERVATIVE_WRITE_OFF", "NEVER_STARTED_REFUND"];

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value); for (const k of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[k]); return value; }
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const isRef = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_REF_LENGTH;
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && (values as readonly string[]).includes(value);
/** The CODE is the contract; the message restates it so no prose can drift away from the code. */
const issue = (code: BudgetSettlementIssueCode): BudgetSettlementIssue => ({ code, message: code.slice("BUDGET_SETTLEMENT_".length).toLowerCase().split("_").join(" ") });
const fail = (view: BudgetAvailableView, settlement: SettlementRecord | null, code: BudgetSettlementIssueCode): BudgetSettlementResult =>
  deepFreeze({ ok: false, settlement, view, issues: [issue(code)] });
const accept = (settlement: SettlementRecord | null, view: BudgetAvailableView): BudgetSettlementResult => deepFreeze({ ok: true, settlement, view });
type Check = readonly [boolean, BudgetSettlementIssueCode];
const firstOf = (checks: readonly Check[]): BudgetSettlementIssueCode | null => checks.find((c) => c[0])?.[1] ?? null;
const bucketOf = (view: BudgetAvailableView, meter: string): BudgetMeterBuckets | undefined => view.meters.find((e) => e.meter === meter);
/** The compare-and-swap seam every unit-moving operation shares; the store enforces at-most-one. */
const fence = (view: BudgetAvailableView, version: number, expectedView: number, expected: number): readonly Check[] =>
  [[view.version >= MAX_BUDGET_VERSION, "BUDGET_SETTLEMENT_COUNTER_EXHAUSTED"], [view.version !== expectedView || version !== expected, "BUDGET_SETTLEMENT_STALE_VERSION"]];
/** Own data properties only: an accessor, proxy, prototype-carried key, or extra key refuses. */
function readRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, allowed)) return null;
  const output: Record<string, unknown> = {};
  for (const key of allowed) { const read = readOwnDataProperty(value, key); if (!read.ok || !read.present) return null; output[key] = read.value; }
  return output; }
const isView = (value: unknown): value is BudgetAvailableView => isPlainRecord(value) && isRef(value.accountId)
  && isCount(value.version) && oneOf(value.state, BUDGET_ACCOUNT_STATES) && isPlainArray(value.meters) && value.meters.length > 0
  && value.meters.length <= MAX_LINES && value.meters.every((e) => isPlainRecord(e) && isRef(e.meter) && AMOUNTS.every((k) => isCount(e[k])));
/** The reservation length prefix keeps the join injective, so no two reservations can collide. */
export const deriveSettlementId = (reservationId: string): string => `settlement:${reservationId.length}:${reservationId}`;
/** Sums the admitted hold per meter; the purposes themselves were already gated at admission. */
function readHolds(value: unknown): Map<string, number> | null {
  if (!isPlainArray(value) || value.length === 0 || value.length > MAX_LINES) return null;
  const totals = new Map<string, number>();
  for (const entry of value) { const item = readRecord(entry, HOLD_KEYS);
    if (item === null || !isRef(item.meter) || !isCount(item.quantity)) return null; totals.set(item.meter, (totals.get(item.meter) ?? 0) + item.quantity); }
  return totals; }
const isLine = (v: unknown): v is SettlementLine => isPlainRecord(v) && hasOnlyOwnStringKeys(v, LINE_KEYS)
  && isRef(v.meter) && oneOf(v.disposition, LINE_DISPOSITIONS) && LINE_AMOUNTS.every((k) => isCount(v[k]))
  && (v.identity === null || isRef(v.identity)) && (v.sequence === null || isCount(v.sequence));
/** Re-reads a settlement field by field and re-derives its identity, so a forgery cannot transition. Honest records
 * carry at most one line per meter, so a duplicate-meter record is a forgery: per-line sufficiency checks and the
 * per-meter movement map would otherwise let one line's units answer for another's. */
function readSettlement(value: unknown): SettlementRecord | null {
  const item = readRecord(value, SETTLEMENT_KEYS);
  if (item === null || !isRef(item.reservationId) || !isRef(item.accountId) || !isRef(item.attemptRef)
    || !isCount(item.version) || !oneOf(item.state, SETTLEMENT_STATES) || !isPlainArray(item.lines)
    || !isPlainArray(item.overrun) || typeof item.unknownExternalLiability !== "boolean"
    || item.settlementId !== deriveSettlementId(item.reservationId)
    || item.lines.length > MAX_LINES || !item.lines.every(isLine)
    || new Set((item.lines as readonly SettlementLine[]).map((l) => l.meter)).size !== item.lines.length) return null;
  return item as unknown as SettlementRecord; }
interface Reading { readonly meter: string; readonly quantity: number; readonly complete: boolean;
  readonly known: boolean; readonly run: string; readonly sequence: number; readonly identity: string }
/** Re-reads a normalized measurement defensively: this module trusts no caller-shaped envelope. */
function readMeasurement(value: unknown): Reading | null {
  const item = readRecord(value, OBSERVATION_KEYS);
  const inner = item === null ? null : readRecord(item.measurement, MEASUREMENT_KEYS);
  if (item === null || inner === null || !isRef(item.identity) || !isRef(inner.meter) || !isRef(inner.providerRunRef)
    || !isCount(inner.sequence) || !oneOf(inner.coverage, BUDGET_MEASUREMENT_COVERAGES)) return null;
  const known = inner.coverage !== "UNKNOWN";
  if (known ? !isCount(inner.quantity) : inner.quantity !== null) return null;
  return { meter: inner.meter, quantity: known ? (inner.quantity as number) : 0, known, identity: item.identity,
    complete: inner.coverage === "COMPLETE", run: inner.providerRunRef, sequence: inner.sequence }; }
function readReadings(value: unknown): Reading[] | null {
  if (!isPlainArray(value) || value.length > MAX_LINES) return null;
  const output: Reading[] = []; for (const entry of value) { const one = readMeasurement(entry); if (one === null) return null; output.push(one); }
  return output; }
interface Movement { available: number; reserved: number; quarantined: number; committed: number }
const stateOf = (lines: readonly SettlementLine[]): SettlementState => lines.every((l) => l.quarantined === 0 && RESOLVED.includes(l.disposition)) ? "SETTLED" : "QUARANTINED";
function shift(view: BudgetAvailableView, moves: ReadonlyMap<string, Movement>, state: BudgetAccountState): BudgetAvailableView {
  const one = (e: BudgetMeterBuckets, m: Movement | undefined): BudgetMeterBuckets => m === undefined ? { ...e }
    : { meter: e.meter, available: e.available + m.available, reserved: e.reserved + m.reserved,
      quarantined: e.quarantined + m.quarantined, committed: e.committed + m.committed };
  return { accountId: view.accountId, state, version: view.version + 1, meters: view.meters.map((e) => one(e, moves.get(e.meter))) }; }
/** One meter. `hold` sits in bucket `from`; `credited` is what it already committed, so a receipt quantity is always
 * TOTAL measured use and the committed delta is quantity - credited. UNKNOWN and a missing receipt hold the units. */
function dispose(meter: string, hold: number, credited: number, from: "reserved" | "quarantined",
  reading: Reading | undefined): { line: SettlementLine; move: Movement; overrun: number } {
  const move: Movement = { available: 0, reserved: 0, quarantined: 0, committed: 0 };
  const base = { meter, reserved: hold, identity: reading?.identity ?? null, sequence: reading?.sequence ?? null };
  move[from] -= hold;
  if (reading === undefined || !reading.known) { move.quarantined += hold;
    return { line: { ...base, committed: credited, refunded: 0, quarantined: hold, disposition: "UNKNOWN_HELD" }, move, overrun: 0 }; }
  const delta = reading.quantity - credited, rest = Math.max(0, hold - delta);
  move.committed += delta; move[reading.complete ? "available" : "quarantined"] += rest;
  return { line: { ...base, committed: reading.quantity, refunded: reading.complete ? rest : 0,
    quarantined: reading.complete ? 0 : rest, disposition: reading.complete ? "EXACT" : "LOWER_BOUND" }, move, overrun: Math.max(0, delta - hold) }; }

/** Settles one ACTIVATED reservation. `prior` is the settlement the caller already holds for it: byte-identical inputs
 * return THAT record by reference and move nothing, any other prior refuses, so a replay can never double-commit. */
export function settleReservation(view: BudgetAvailableView, reservation: ReservationRecord,
  evidence: SettleEvidence, command: SettleCommand): BudgetSettlementResult {
  const cmd = readRecord(command, SETTLE_KEYS), record = readRecord(reservation, RESERVATION_KEYS);
  const held = record === null ? null : readHolds(record.lines), arm = readRecord(evidence, ["measurements"]);
  const readings = arm === null ? null : readReadings(arm.measurements);
  if (!isView(view) || cmd === null || record === null || held === null || readings === null
    || !isCount(cmd.expectedViewVersion) || !isCount(cmd.expectedReservationVersion)
    || (cmd.prior !== null && !isPlainRecord(cmd.prior)) || !isRef(record.reservationId) || !isRef(record.accountId)
    || !isRef(record.admissionRef) || !isCount(record.version)) return fail(view, null, "BUDGET_SETTLEMENT_MALFORMED");
  const code = firstOf([
    [record.accountId !== view.accountId || record.reservationId !== deriveReservationId(record.accountId, record.admissionRef),
      "BUDGET_SETTLEMENT_IDENTITY_MISMATCH"],
    [record.state !== "ACTIVATED" || !isRef(record.attemptRef), "BUDGET_SETTLEMENT_NOT_ACTIVATED"],
    ...fence(view, record.version, cmd.expectedViewVersion, cmd.expectedReservationVersion),
    [readings.some((r) => decodeProviderRunRefAttempt(r.run) !== record.attemptRef),
      "BUDGET_SETTLEMENT_UNCORRELATED_MEASUREMENT"],
    [new Set(readings.map((r) => r.meter)).size !== readings.length, "BUDGET_SETTLEMENT_DUPLICATE_METER"],
    [readings.some((r) => !held.has(r.meter)), "BUDGET_SETTLEMENT_UNKNOWN_METER"],
    [[...held].some(([m, q]) => (bucketOf(view, m)?.reserved ?? -1) < q), "BUDGET_SETTLEMENT_INSUFFICIENT_RESERVED"]]);
  if (code !== null) return fail(view, null, code);
  const moves = new Map<string, Movement>(), lines: SettlementLine[] = [], overrun: BudgetOverrun[] = [];
  for (const [meter, hold] of held) {
    const one = dispose(meter, hold, 0, "reserved", readings.find((r) => r.meter === meter));
    lines.push(one.line); moves.set(meter, one.move);
    if (one.overrun > 0) overrun.push({ meter, amount: one.overrun }); }
  const settlement: SettlementRecord = { settlementId: deriveSettlementId(record.reservationId), reservationId: record.reservationId,
    accountId: record.accountId, attemptRef: record.attemptRef as string, version: 0, state: stateOf(lines), lines, unknownExternalLiability: false, overrun };
  // The replay check compares STRUCTURE, not serialisation: a prior that round-tripped through
  // a store or a JSON layer with its keys in another order is the same settlement, and the old
  // JSON.stringify equality refused it ALREADY_SETTLED. A prior that does not read as a
  // settlement at all is malformed, never "different".
  if (cmd.prior !== null) {
    const prior = readSettlement(cmd.prior);
    if (prior === null) return fail(view, null, "BUDGET_SETTLEMENT_MALFORMED");
    // The caller's own prior comes back by reference, as before; `prior` above only proved shape.
    return canonical(prior) === canonical(settlement)
      ? accept(cmd.prior as unknown as SettlementRecord, view) : fail(view, null, "BUDGET_SETTLEMENT_ALREADY_SETTLED");
  }
  return accept(settlement, shift(view, moves, overrun.length > 0 ? "OVERDRAWN" : view.state));
}
/** Key-order-insensitive serialisation of a plain data tree; arrays keep their order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
type Opened = { readonly code: BudgetSettlementIssueCode } | { readonly record: SettlementRecord };
/** Shared preamble for the quarantine exits: only a QUARANTINED record with backing units transitions, and only one
 * bound to this account — the injective reservation length prefix keeps a foreign record from moving these units. */
function openQuarantine(view: BudgetAvailableView, settlement: unknown, cmd: Record<string, unknown> | null,
  extra: (record: SettlementRecord) => readonly Check[]): Opened {
  const record = readSettlement(settlement);
  if (!isView(view) || cmd === null || record === null || !isCount(cmd.expectedViewVersion)
    || !isCount(cmd.expectedSettlementVersion)) return { code: "BUDGET_SETTLEMENT_MALFORMED" };
  const code = firstOf([
    [record.accountId !== view.accountId
      || !record.reservationId.startsWith(`reservation:${record.accountId.length}:${record.accountId}:`),
    "BUDGET_SETTLEMENT_IDENTITY_MISMATCH"],
    [record.state !== "QUARANTINED", "BUDGET_SETTLEMENT_ALREADY_SETTLED"], ...extra(record),
    ...fence(view, record.version, cmd.expectedViewVersion, cmd.expectedSettlementVersion),
    [record.lines.some((l) => (bucketOf(view, l.meter)?.quarantined ?? -1) < l.quarantined), "BUDGET_SETTLEMENT_INSUFFICIENT_QUARANTINED"]]);
  return code === null ? { record } : { code }; }

/** Design exits 1 and 2, one verb with two evidence arms: exactly one of a correlated receipt or a never-started proof.
 * The proof arm never touches COMMITTED, and a receipt below the committed lower bound is a conflict, not a refund.
 * Applicability keys on line resolution, not on remaining quarantined units: a LOWER_BOUND line whose whole hold was
 * already committed still holds an unresolved upper bound, so a later COMPLETE receipt must be able to land on it. */
export function reconcileSettlement(view: BudgetAvailableView, settlement: SettlementRecord,
  evidence: ReconcileEvidence, command: SettlementCommand): BudgetSettlementResult {
  const arm = readRecord(evidence, ARM_KEYS), proof = arm === null ? null : arm.neverStartedProofRef;
  const parsed = arm === null || arm.measurements === null ? null : readReadings(arm.measurements);
  if (arm === null || (arm.measurements !== null && parsed === null) || (proof !== null && !isRef(proof)))
    return fail(view, settlement, "BUDGET_SETTLEMENT_MALFORMED");
  const some = (f: (r: Reading) => boolean): boolean => readings !== null && readings.some(f);
  const readings = parsed !== null && parsed.length > 0 ? parsed : null, at = (r: SettlementRecord, m: string): SettlementLine | undefined => r.lines.find((l) => l.meter === m);
  const opened = openQuarantine(view, settlement, readRecord(command, FENCE_KEYS), (r) => [
    [(readings === null) === (proof === null), "BUDGET_SETTLEMENT_EVIDENCE_AMBIGUOUS"],
    [some((x) => decodeProviderRunRefAttempt(x.run) !== r.attemptRef), "BUDGET_SETTLEMENT_UNCORRELATED_MEASUREMENT"],
    [readings !== null && new Set(readings.map((x) => x.meter)).size !== readings.length, "BUDGET_SETTLEMENT_DUPLICATE_METER"],
    [some((x) => { const l = at(r, x.meter); return l === undefined || RESOLVED.includes(l.disposition); }),
      "BUDGET_SETTLEMENT_UNKNOWN_METER"],
    [some((x) => x.sequence <= (at(r, x.meter)?.sequence ?? -1)), "BUDGET_SETTLEMENT_SEQUENCE_STALE"],
    [some((x) => x.known && x.quantity < (at(r, x.meter)?.committed ?? 0))
      || (readings === null && r.lines.some((l) => l.committed > 0)), "BUDGET_SETTLEMENT_MEASUREMENT_CONFLICT"]]);
  if ("code" in opened) return fail(view, settlement, opened.code);
  const record = opened.record, moves = new Map<string, Movement>(), lines: SettlementLine[] = [], overrun = [...record.overrun];
  for (const line of record.lines) {
    const reading = readings?.find((x) => x.meter === line.meter);
    if (RESOLVED.includes(line.disposition) || (readings !== null && reading === undefined)) { lines.push(line); continue; }
    if (readings === null) {
      moves.set(line.meter, { available: line.quarantined, reserved: 0, quarantined: -line.quarantined, committed: 0 });
      lines.push({ ...line, refunded: line.refunded + line.quarantined, quarantined: 0, disposition: "NEVER_STARTED_REFUND" }); continue; }
    const one = dispose(line.meter, line.quarantined, line.committed, "quarantined", reading);
    moves.set(line.meter, one.move);
    lines.push({ ...one.line, reserved: line.reserved, refunded: line.refunded + one.line.refunded });
    if (one.overrun > 0) overrun.push({ meter: line.meter, amount: one.overrun }); }
  return accept({ ...record, version: record.version + 1, state: stateOf(lines), lines, overrun },
    shift(view, moves, overrun.length > record.overrun.length ? "OVERDRAWN" : view.state));
}

/** Design exits 3 and 4. Recovery matrix 1039 requires human acknowledgement PLUS a bound classification, so both are
 * one evidence requirement; the whole hold commits, nothing refunds, and an unenforceable bound mints liability. */
export function conservativeSettle(view: BudgetAvailableView, settlement: SettlementRecord, command: ConservativeCommand): BudgetSettlementResult {
  const cmd = readRecord(command, ACK_KEYS);
  const opened = openQuarantine(view, settlement, cmd, () => cmd === null ? [] : [[!isRef(cmd.acknowledgementRef)
    || typeof cmd.enforceableUpperBound !== "boolean", "BUDGET_SETTLEMENT_ACKNOWLEDGEMENT_MISSING"]]);
  if ("code" in opened) return fail(view, settlement, opened.code);
  const record = opened.record, moves = new Map<string, Movement>();
  const lines = record.lines.map((l) => { if (l.quarantined === 0) return l;
    moves.set(l.meter, { available: 0, reserved: 0, quarantined: -l.quarantined, committed: l.quarantined });
    return { ...l, committed: l.committed + l.quarantined, quarantined: 0, disposition: "CONSERVATIVE_WRITE_OFF" as const }; });
  return accept({ ...record, version: record.version + 1, state: "WRITTEN_OFF", lines,
    unknownExternalLiability: record.unknownExternalLiability || cmd?.enforceableUpperBound === false }, shift(view, moves, view.state));
}

/** Design 664: no account closes with RESERVED or QUARANTINED units and AVAILABLE must already have gone back to the
 * parent; OVERDRAWN has no exit. Terminal state is structural: a supplied settlement with liability closes path 4. */
export function closeSettledView(view: BudgetAvailableView, settlements: readonly SettlementRecord[], command: CloseCommand): BudgetSettlementResult {
  const cmd = readRecord(command, ["expectedVersion"]);
  const records = isPlainArray(settlements) && settlements.length <= MAX_LINES ? settlements.map(readSettlement) : null;
  if (!isView(view) || cmd === null || records === null || !isCount(cmd.expectedVersion)
    || records.some((r) => r === null)) return fail(view, null, "BUDGET_SETTLEMENT_MALFORMED");
  const code = firstOf([
    [records.some((r) => r !== null && r.accountId !== view.accountId), "BUDGET_SETTLEMENT_IDENTITY_MISMATCH"],
    ...fence(view, 0, cmd.expectedVersion, 0),
    [view.state !== "OPEN" || view.meters.some((m) => m.available + m.reserved + m.quarantined > 0)
      || records.some((r) => r?.state === "QUARANTINED"), "BUDGET_SETTLEMENT_ILLEGAL_CLOSE"]]);
  if (code !== null) return fail(view, null, code);
  return accept(null, shift(view, new Map(), records.some((r) => r?.unknownExternalLiability === true) ? "CLOSED_WITH_UNKNOWN_LIABILITY" : "CLOSED"));
}
