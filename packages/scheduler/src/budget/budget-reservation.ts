/**
 * Protected admission reservations (design 11.1: 587, 601-603, 655-660). Admission moves a
 * caller-supplied five-purpose amount set from an account's AVAILABLE bucket to its RESERVED
 * bucket in ONE all-or-none step: every line is held or nothing moves and no record is minted.
 * Execution spend cannot consume proof (design 587) because the four protected lines live in the
 * same indivisible record and NO operation here selects a purpose to spend or reclassify.
 *
 * ADMISSION_PURPOSES is LOCAL, not the contract reserve vocabulary: EXECUTION is the admitted work
 * itself and has no contract purpose, while the protected four map onto the landed
 * BUDGET_RESERVE_PURPOSES through ADMISSION_PURPOSE_RESERVE_CONTRACT. The gate is a NARROW
 * ALREADY-VALIDATED fact mirroring core's PolicyDecisionRecord (whose outcome field core spells
 * `decision`, pointed at by ApprovalDecisionRecord.policyDecisionRef) and that record's
 * approvalRef/decision/validity. @moe/core is not imported by design and no policy is re-evaluated:
 * a present allowance must ALREADY read ALLOW and a present approval ALREADY APPROVE + CURRENT, so
 * composing authority from a REQUIRE_HUMAN_APPROVAL pair is refused rather than performed.
 * Activation binds an attempt and moves NO units, because RESERVED -> COMMITTED is design 602 and
 * belongs to settlement; cancellation is the design 603/660 refund and needs a proven-never-started
 * ref. Issue codes are local because the contract and ledger unions are closed and unowned here, so
 * the three layers stay separately assertable. No Date and no randomness: an identity derives from
 * the supplied account and admission refs.
 */
import { isPlainArray, isPlainRecord, hasOnlyOwnStringKeys, readOwnDataProperty } from "../runtime-shape.js";
import { MAX_BUDGET_VERSION } from "./budget-account.js";
import {
  BUDGET_ACCOUNT_STATES, BUDGET_POLICY_OUTCOMES, MAX_BUDGET_METERS, type BudgetAccountState,
  type BudgetMeterBuckets, type BudgetPolicyOutcome, type BudgetReservePurpose,
} from "./budget-contract.js";

export const ADMISSION_PURPOSES = Object.freeze([
  "EXECUTION", "VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY"] as const);
export type AdmissionPurpose = (typeof ADMISSION_PURPOSES)[number];
/** Design 587: these four are protected before ANY acceptance-bearing executor launches. */
export const PROTECTED_ADMISSION_PURPOSES = Object.freeze([
  "VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY"] as const);
export const ADMISSION_PURPOSE_RESERVE_CONTRACT: Readonly<Record<AdmissionPurpose, BudgetReservePurpose | null>> =
  Object.freeze({ EXECUTION: null, VERIFICATION: "VERIFICATION", INDEPENDENT_REVIEW: "REVIEW",
    FINAL_ACCEPTANCE: "ACCEPTANCE_PROCESSING", CONTINGENCY: "CONTINGENCY" });
export const RESERVATION_STATES = Object.freeze(["RESERVED", "ACTIVATED", "CANCELLED"] as const);
export type ReservationState = (typeof RESERVATION_STATES)[number];
/** Mirrors RUNTIME_LIFECYCLES.APPROVAL_DECISION / APPROVAL_VALIDITY by value; not importable here. */
const APPROVAL_DECISIONS = Object.freeze(["APPROVE", "REJECT"] as const);
const APPROVAL_VALIDITIES = Object.freeze(["CURRENT", "INVALIDATED", "SUPERSEDED"] as const);
export const BUDGET_RESERVATION_ISSUE_CODES = Object.freeze([
  "BUDGET_RESERVATION_ACCOUNT_NOT_OPEN", "BUDGET_RESERVATION_ALREADY_SETTLED",
  "BUDGET_RESERVATION_APPROVAL_NOT_CURRENT", "BUDGET_RESERVATION_COUNTER_EXHAUSTED",
  "BUDGET_RESERVATION_DUPLICATE_PURPOSE", "BUDGET_RESERVATION_EXECUTION_MISSING",
  "BUDGET_RESERVATION_GATE_ABSENT", "BUDGET_RESERVATION_GATE_MALFORMED",
  "BUDGET_RESERVATION_IDENTITY_MISMATCH", "BUDGET_RESERVATION_INSUFFICIENT_AVAILABLE",
  "BUDGET_RESERVATION_INSUFFICIENT_RESERVED", "BUDGET_RESERVATION_INVALID_QUANTITY",
  "BUDGET_RESERVATION_MALFORMED", "BUDGET_RESERVATION_NEVER_STARTED_PROOF_MISSING",
  "BUDGET_RESERVATION_POLICY_NOT_ALLOWED", "BUDGET_RESERVATION_PROTECTED_PURPOSE_MISSING",
  "BUDGET_RESERVATION_STALE_VERSION", "BUDGET_RESERVATION_UNKNOWN_METER"] as const);
export type BudgetReservationIssueCode = (typeof BUDGET_RESERVATION_ISSUE_CODES)[number];
export interface BudgetReservationIssue { readonly code: BudgetReservationIssueCode; readonly message: string }
/** The narrow ledger-derived projection this module reserves within: one account, its buckets. */
export interface BudgetAvailableView { readonly accountId: string; readonly state: BudgetAccountState; readonly version: number; readonly meters: readonly BudgetMeterBuckets[] }
export interface AdmissionAmount { readonly purpose: AdmissionPurpose; readonly meter: string; readonly quantity: number }
export type ReservationLine = AdmissionAmount;
export interface AdmissionRequest { readonly admissionRef: string; readonly expectedVersion: number; readonly amounts: readonly AdmissionAmount[] }
export interface AdmissionPolicyAllowance { readonly decisionRef: string; readonly outcome: BudgetPolicyOutcome }
export interface AdmissionHumanApproval { readonly approvalRef: string; readonly decision: (typeof APPROVAL_DECISIONS)[number]; readonly validity: (typeof APPROVAL_VALIDITIES)[number] }
export interface AdmissionGate { readonly allowance: AdmissionPolicyAllowance | null; readonly approval: AdmissionHumanApproval | null }
export interface ReservationRecord {
  readonly reservationId: string; readonly accountId: string; readonly admissionRef: string;
  readonly state: ReservationState; readonly version: number; readonly lines: readonly ReservationLine[];
  readonly attemptRef: string | null; readonly neverStartedProofRef: string | null }
export interface ReservationActivateCommand { readonly expectedVersion: number; readonly attemptRef: string }
export interface ReservationCancelCommand { readonly expectedVersion: number; readonly neverStartedProofRef: string | null }
export type BudgetReservationResult =
  | { readonly ok: true; readonly reservation: ReservationRecord; readonly view: BudgetAvailableView }
  | { readonly ok: false; readonly reservation: ReservationRecord | null; readonly view: BudgetAvailableView; readonly issues: readonly BudgetReservationIssue[] };

const LINE_KEYS = ["purpose", "meter", "quantity"] as const;
const ADMISSION_KEYS = ["admissionRef", "expectedVersion", "amounts"] as const;
const GATE_KEYS = ["allowance", "approval"] as const;
const ALLOWANCE_KEYS = ["decisionRef", "outcome"] as const;
const APPROVAL_KEYS = ["approvalRef", "decision", "validity"] as const;
const BUCKET_AMOUNTS = ["available", "reserved", "quarantined", "committed"] as const;
const MAX_ADMISSION_LINES = MAX_BUDGET_METERS * ADMISSION_PURPOSES.length;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
}
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const isRef = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRefOrNull = (value: unknown): value is string | null => value === null || isRef(value);
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && (values as readonly string[]).includes(value);
/** The CODE is the contract; the message restates it so no prose can drift away from the code. */
const issue = (code: BudgetReservationIssueCode): BudgetReservationIssue => ({ code, message: code.slice("BUDGET_RESERVATION_".length).toLowerCase().split("_").join(" ") });
const fail = (view: BudgetAvailableView, reservation: ReservationRecord | null, code: BudgetReservationIssueCode): BudgetReservationResult =>
  deepFreeze({ ok: false, reservation, view, issues: [issue(code)] });
const accept = (reservation: ReservationRecord, view: BudgetAvailableView): BudgetReservationResult => deepFreeze({ ok: true, reservation, view });
const bucketOf = (view: BudgetAvailableView, meter: string): BudgetMeterBuckets | undefined => view.meters.find((entry) => entry.meter === meter);
/** Ordered precedence: the FIRST failing check decides the single reported code. */
type Check = readonly [boolean, BudgetReservationIssueCode];
const firstOf = (checks: readonly Check[]): BudgetReservationIssueCode | null => checks.find((check) => check[0])?.[1] ?? null;
/** Own data properties only: an accessor, proxy, prototype-carried key, or extra key refuses. */
function readRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !hasOnlyOwnStringKeys(value, allowed)) return null;
  const output: Record<string, unknown> = {};
  for (const key of allowed) {
    const read = readOwnDataProperty(value, key);
    if (!read.ok || !read.present) return null;
    output[key] = read.value;
  }
  return output;
}
/** Rebuilds each line field by field, so no caller reference reaches a record this module returns. */
function readLines(value: unknown): ReservationLine[] | null {
  if (!isPlainArray(value) || value.length === 0 || value.length > MAX_ADMISSION_LINES) return null;
  const output: ReservationLine[] = [];
  for (const entry of value) {
    const item = readRecord(entry, LINE_KEYS);
    if (item === null || !oneOf(item.purpose, ADMISSION_PURPOSES) || !isRef(item.meter) || typeof item.quantity !== "number") return null;
    output.push({ purpose: item.purpose, meter: item.meter, quantity: item.quantity });
  }
  return output;
}
/**
 * Meters must be unique, as the contract validator's readMeters already requires: `bucketOf`
 * reads only the FIRST row of a meter for the sufficiency check while `shiftView` shifts EVERY
 * row, so a duplicated meter would pass a hold once and then reserve (and later refund) it on
 * each copy — units minted and destroyed by a caller-shaped view.
 */
const isView = (value: unknown): value is BudgetAvailableView =>
  isPlainRecord(value) && isRef(value.accountId) && isCount(value.version) && oneOf(value.state, BUDGET_ACCOUNT_STATES)
  && isPlainArray(value.meters) && value.meters.length > 0 && value.meters.length <= MAX_BUDGET_METERS
  && value.meters.every((entry) => isPlainRecord(entry) && isRef(entry.meter) && BUCKET_AMOUNTS.every((key) => isCount(entry[key])))
  && new Set(value.meters.map((entry) => (entry as { readonly meter: string }).meter)).size === value.meters.length;
/** The account length prefix keeps the join injective, so no two distinct pairs can collide. */
export const deriveReservationId = (accountId: string, admissionRef: string): string => `reservation:${accountId.length}:${accountId}:${admissionRef}`;
/** A caller-supplied amount is a fact, so a zero-quantity protected line refuses, never defaults. */
function checkLines(lines: readonly ReservationLine[]): BudgetReservationIssueCode | null {
  const keys = lines.map((line) => `${line.purpose} ${line.meter}`);
  const present = new Set(lines.map((line) => line.purpose));
  return firstOf([
    [new Set(keys).size !== keys.length, "BUDGET_RESERVATION_DUPLICATE_PURPOSE"],
    [lines.some((line) => !isCount(line.quantity) || line.quantity === 0), "BUDGET_RESERVATION_INVALID_QUANTITY"],
    [PROTECTED_ADMISSION_PURPOSES.some((p) => !present.has(p)), "BUDGET_RESERVATION_PROTECTED_PURPOSE_MISSING"],
    [!present.has("EXECUTION"), "BUDGET_RESERVATION_EXECUTION_MISSING"],
  ]);
}
function readGate(gate: unknown): AdmissionGate | null {
  const item = readRecord(gate, GATE_KEYS);
  if (item === null) return null;
  const one = item.allowance === null ? null : readRecord(item.allowance, ALLOWANCE_KEYS);
  const two = item.approval === null ? null : readRecord(item.approval, APPROVAL_KEYS);
  if (item.allowance !== null && (one === null || !isRef(one.decisionRef) || !oneOf(one.outcome, BUDGET_POLICY_OUTCOMES))) return null;
  if (item.approval !== null && (two === null || !isRef(two.approvalRef)
    || !oneOf(two.decision, APPROVAL_DECISIONS) || !oneOf(two.validity, APPROVAL_VALIDITIES))) return null;
  return { allowance: one === null ? null : { decisionRef: one.decisionRef as string, outcome: one.outcome as BudgetPolicyOutcome },
    approval: two === null ? null : { approvalRef: two.approvalRef as string,
      decision: two.decision as AdmissionHumanApproval["decision"], validity: two.validity as AdmissionHumanApproval["validity"] } };
}
/** A present member must ALREADY be valid; composing one from an invalid pair would be evaluation. */
const checkGate = (gate: AdmissionGate): BudgetReservationIssueCode | null => firstOf([
  [gate.allowance !== null && gate.allowance.outcome !== "ALLOW", "BUDGET_RESERVATION_POLICY_NOT_ALLOWED"],
  [gate.approval !== null && (gate.approval.decision !== "APPROVE" || gate.approval.validity !== "CURRENT"),
    "BUDGET_RESERVATION_APPROVAL_NOT_CURRENT"],
  [gate.allowance === null && gate.approval === null, "BUDGET_RESERVATION_GATE_ABSENT"],
]);
/** Sums per meter. Precision can only be lost above the available ceiling, which always refuses. */
function totalPerMeter(lines: readonly ReservationLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.meter, (totals.get(line.meter) ?? 0) + line.quantity);
  return totals;
}
const shiftView = (view: BudgetAvailableView, totals: ReadonlyMap<string, number>, sign: 1 | -1): BudgetAvailableView =>
  ({ accountId: view.accountId, state: view.state, version: view.version + 1,
    meters: view.meters.map((entry) => {
      const moved = sign * (totals.get(entry.meter) ?? 0);
      return { ...entry, available: entry.available - moved, reserved: entry.reserved + moved };
    }) });
const unknownMeter = (view: BudgetAvailableView, totals: ReadonlyMap<string, number>): boolean =>
  [...totals.keys()].some((meter) => bucketOf(view, meter) === undefined);

export function reserveForAdmission(view: BudgetAvailableView, admission: AdmissionRequest, gate: AdmissionGate): BudgetReservationResult {
  const request = readRecord(admission, ADMISSION_KEYS);
  const lines = request === null ? null : readLines(request.amounts);
  if (!isView(view) || request === null || lines === null || !isRef(request.admissionRef)
    || !isCount(request.expectedVersion)) return fail(view, null, "BUDGET_RESERVATION_MALFORMED");
  const supplied = readGate(gate);
  if (supplied === null) return fail(view, null, "BUDGET_RESERVATION_GATE_MALFORMED");
  const totals = totalPerMeter(lines);
  // All-or-none: any short line refuses the WHOLE set, so a partial hold is unreachable.
  const code = checkLines(lines) ?? firstOf([
    [view.state !== "OPEN", "BUDGET_RESERVATION_ACCOUNT_NOT_OPEN"],
    [view.version >= MAX_BUDGET_VERSION, "BUDGET_RESERVATION_COUNTER_EXHAUSTED"],
    [view.version !== request.expectedVersion, "BUDGET_RESERVATION_STALE_VERSION"],
    [unknownMeter(view, totals), "BUDGET_RESERVATION_UNKNOWN_METER"],
    [[...totals].some(([meter, amount]) => (bucketOf(view, meter)?.available ?? 0) < amount),
      "BUDGET_RESERVATION_INSUFFICIENT_AVAILABLE"],
  ]) ?? checkGate(supplied);
  if (code !== null) return fail(view, null, code);
  return accept(deepFreeze({
    reservationId: deriveReservationId(view.accountId, request.admissionRef), accountId: view.accountId,
    admissionRef: request.admissionRef, state: "RESERVED" as const, version: 0, lines,
    attemptRef: null, neverStartedProofRef: null,
  }), deepFreeze(shiftView(view, totals, 1)));
}

type Transition = { readonly code: BudgetReservationIssueCode } | { readonly record: ReservationRecord };
/** Re-derives identity and re-checks the whole purpose set, so a tampered record cannot transition. */
function checkTransition(view: BudgetAvailableView, reservation: ReservationRecord, expectedVersion: number): Transition {
  const lines = isPlainRecord(reservation) ? readLines(reservation.lines) : null;
  if (!isView(view) || lines === null || !isRef(reservation.reservationId) || !isRef(reservation.accountId)
    || !isRef(reservation.admissionRef) || !oneOf(reservation.state, RESERVATION_STATES)
    || !isCount(reservation.version) || !isRefOrNull(reservation.attemptRef)
    || !isRefOrNull(reservation.neverStartedProofRef)) return { code: "BUDGET_RESERVATION_MALFORMED" };
  const code = checkLines(lines) ?? firstOf([
    [reservation.accountId !== view.accountId
      || reservation.reservationId !== deriveReservationId(reservation.accountId, reservation.admissionRef),
    "BUDGET_RESERVATION_IDENTITY_MISMATCH"],
    [reservation.version !== expectedVersion, "BUDGET_RESERVATION_STALE_VERSION"],
    [reservation.state !== "RESERVED", "BUDGET_RESERVATION_ALREADY_SETTLED"],
  ]);
  if (code !== null) return { code };
  return { record: { reservationId: reservation.reservationId, accountId: reservation.accountId,
    admissionRef: reservation.admissionRef, state: reservation.state, version: reservation.version, lines,
    attemptRef: reservation.attemptRef, neverStartedProofRef: reservation.neverStartedProofRef } };
}

/** One use only, and it moves NO units: the caller's view is returned by reference. */
export function activateReservation(view: BudgetAvailableView, reservation: ReservationRecord, command: ReservationActivateCommand): BudgetReservationResult {
  if (!isPlainRecord(command) || !isCount(command.expectedVersion) || !isRef(command.attemptRef)) {
    return fail(view, reservation, "BUDGET_RESERVATION_MALFORMED");
  }
  const checked = checkTransition(view, reservation, command.expectedVersion);
  if ("code" in checked) return fail(view, reservation, checked.code);
  return accept(deepFreeze({ ...checked.record, state: "ACTIVATED" as const,
    version: checked.record.version + 1, attemptRef: command.attemptRef }), view);
}

/** Design 660: only a proven-never-started reservation refunds, and it refunds the whole set. */
export function cancelReservation(view: BudgetAvailableView, reservation: ReservationRecord, command: ReservationCancelCommand): BudgetReservationResult {
  if (!isPlainRecord(command) || !isCount(command.expectedVersion) || !isRefOrNull(command.neverStartedProofRef)) {
    return fail(view, reservation, "BUDGET_RESERVATION_MALFORMED");
  }
  const checked = checkTransition(view, reservation, command.expectedVersion);
  if ("code" in checked) return fail(view, reservation, checked.code);
  const totals = totalPerMeter(checked.record.lines);
  const code = firstOf([
    [command.neverStartedProofRef === null, "BUDGET_RESERVATION_NEVER_STARTED_PROOF_MISSING"],
    [view.version >= MAX_BUDGET_VERSION, "BUDGET_RESERVATION_COUNTER_EXHAUSTED"],
    [unknownMeter(view, totals), "BUDGET_RESERVATION_UNKNOWN_METER"],
    [[...totals].some(([meter, amount]) => (bucketOf(view, meter)?.reserved ?? 0) < amount),
      "BUDGET_RESERVATION_INSUFFICIENT_RESERVED"],
  ]);
  if (code !== null) return fail(view, reservation, code);
  return accept(deepFreeze({ ...checked.record, state: "CANCELLED" as const,
    version: checked.record.version + 1, neverStartedProofRef: command.neverStartedProofRef }),
  deepFreeze(shiftView(view, totals, -1)));
}
