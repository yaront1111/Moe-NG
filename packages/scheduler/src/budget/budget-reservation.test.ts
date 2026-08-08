import { describe, expect, it } from "vitest";
import { MAX_BUDGET_VERSION } from "./budget-account.js";
import { BUDGET_RESERVE_PURPOSES, type BudgetMeterBuckets } from "./budget-contract.js";
import {
  ADMISSION_PURPOSES, ADMISSION_PURPOSE_RESERVE_CONTRACT, BUDGET_RESERVATION_ISSUE_CODES,
  PROTECTED_ADMISSION_PURPOSES, activateReservation, cancelReservation, deriveReservationId,
  reserveForAdmission, type AdmissionAmount, type AdmissionGate, type AdmissionRequest,
  type BudgetAvailableView, type BudgetReservationResult, type ReservationRecord,
} from "./budget-reservation.js";

const MS = "runner.authorized_ms";
const AT = "attempt.count";
const ACC = "account:child";
const REF = "admission:1";
const ID = `reservation:13:${ACC}:${REF}`;
const bucket = (meter: string, available: number, reserved = 0): BudgetMeterBuckets =>
  ({ meter, available, reserved, quarantined: 0, committed: 0 });
const view = (over: Partial<BudgetAvailableView> = {}): BudgetAvailableView =>
  ({ accountId: ACC, state: "OPEN", version: 3, meters: [bucket(MS, 100), bucket(AT, 10)], ...over });
/** MS lines sum to 90 of 100 available, AT to 1 of 10. Every protected line is caller-supplied. */
const AMOUNTS: readonly AdmissionAmount[] = [
  { purpose: "EXECUTION", meter: MS, quantity: 40 }, { purpose: "EXECUTION", meter: AT, quantity: 1 },
  { purpose: "VERIFICATION", meter: MS, quantity: 20 }, { purpose: "INDEPENDENT_REVIEW", meter: MS, quantity: 15 },
  { purpose: "FINAL_ACCEPTANCE", meter: MS, quantity: 10 }, { purpose: "CONTINGENCY", meter: MS, quantity: 5 },
];
const drop = (purpose: string): AdmissionAmount[] => AMOUNTS.filter((entry) => entry.purpose !== purpose);
const with_ = (quantity: unknown): AdmissionAmount[] =>
  [...drop("CONTINGENCY"), { purpose: "CONTINGENCY", meter: MS, quantity } as AdmissionAmount];
const admission = (over: Partial<AdmissionRequest> = {}): AdmissionRequest =>
  ({ admissionRef: REF, expectedVersion: 3, amounts: AMOUNTS, ...over });
const ALLOW: AdmissionGate = { allowance: { decisionRef: "decision:1", outcome: "ALLOW" }, approval: null };
const NONE: AdmissionGate = { allowance: null, approval: null };
const approved = (over: Partial<AdmissionGate["approval"] & object>): AdmissionGate =>
  ({ allowance: null, approval: { approvalRef: "approval:1", decision: "APPROVE", validity: "CURRENT", ...over } });
const observed = new Set<string>();
const codes = (result: BudgetReservationResult): readonly string[] => {
  if (result.ok) return [];
  for (const issue of result.issues) observed.add(issue.code);
  return result.issues.map((issue) => issue.code);
};
function must(result: BudgetReservationResult): { reservation: ReservationRecord; view: BudgetAvailableView } {
  if (!result.ok) throw new Error(`expected ok, got ${codes(result).join(",")}`);
  return { reservation: result.reservation, view: result.view };
}
const held = (): { reservation: ReservationRecord; view: BudgetAvailableView } =>
  must(reserveForAdmission(view(), admission(), ALLOW));
const bucketOf = (v: BudgetAvailableView, meter: string): BudgetMeterBuckets | undefined =>
  v.meters.find((entry) => entry.meter === meter);
const sum = (b?: BudgetMeterBuckets): number => (b === undefined ? -1 : b.available + b.reserved + b.quarantined + b.committed);
const protectedLines = (record: ReservationRecord): unknown =>
  record.lines.filter((line) => line.purpose !== "EXECUTION");
const ACTIVATE = { expectedVersion: 0, attemptRef: "attempt:1" };
const CANCEL = { expectedVersion: 0, neverStartedProofRef: "proof:never-started:1" };

it("maps the four protected purposes onto contract reserve purposes and derives one identity", () => {
  expect([...ADMISSION_PURPOSES]).toEqual(
    ["EXECUTION", "VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY"]);
  expect([...PROTECTED_ADMISSION_PURPOSES]).toEqual(
    ["VERIFICATION", "INDEPENDENT_REVIEW", "FINAL_ACCEPTANCE", "CONTINGENCY"]);
  // EXECUTION is the admitted work, never a contract reserve purpose (design 587).
  expect(ADMISSION_PURPOSE_RESERVE_CONTRACT.EXECUTION).toBeNull();
  expect(ADMISSION_PURPOSE_RESERVE_CONTRACT.VERIFICATION).toBe("VERIFICATION");
  expect(ADMISSION_PURPOSE_RESERVE_CONTRACT.INDEPENDENT_REVIEW).toBe("REVIEW");
  expect(ADMISSION_PURPOSE_RESERVE_CONTRACT.FINAL_ACCEPTANCE).toBe("ACCEPTANCE_PROCESSING");
  for (const purpose of PROTECTED_ADMISSION_PURPOSES) {
    expect(BUDGET_RESERVE_PURPOSES).toContain(ADMISSION_PURPOSE_RESERVE_CONTRACT[purpose]);
  }
  expect(Object.isFrozen(ADMISSION_PURPOSES) && Object.isFrozen(ADMISSION_PURPOSE_RESERVE_CONTRACT)).toBe(true);
  expect(deriveReservationId(ACC, REF)).toBe(ID);
  expect(deriveReservationId("a:b", "c")).not.toBe(deriveReservationId("a", "b:c"));
});

describe("reserveForAdmission", () => {
  it("holds the complete caller-supplied five-purpose set and moves AVAILABLE to RESERVED", () => {
    const before = view();
    const { reservation, view: after } = must(reserveForAdmission(before, admission(), ALLOW));
    expect(reservation).toMatchObject({ reservationId: ID, accountId: ACC, admissionRef: REF,
      state: "RESERVED", version: 0, attemptRef: null, neverStartedProofRef: null });
    expect([...reservation.lines]).toEqual([...AMOUNTS]);
    expect(bucketOf(after, MS)).toEqual(bucket(MS, 10, 90));
    expect(bucketOf(after, AT)).toEqual(bucket(AT, 9, 1));
    expect(after.version).toBe(4);
    expect(sum(bucketOf(after, MS))).toBe(sum(bucketOf(before, MS)));
    expect(Object.isFrozen(reservation) && Object.isFrozen(after)).toBe(true);
    expect(() => { (reservation as { state: string }).state = "ACTIVATED"; }).toThrow(TypeError);
    expect(must(reserveForAdmission(view(), admission(), approved({}))).reservation.state).toBe("RESERVED");
  });
  it("holds every line or none, and refuses one unit past the exact available boundary", () => {
    const before = view({ meters: [bucket(MS, 89), bucket(AT, 10)] });
    const snapshot = JSON.stringify(before);
    const refused = reserveForAdmission(before, admission(), ALLOW);
    expect(codes(refused)).toEqual(["BUDGET_RESERVATION_INSUFFICIENT_AVAILABLE"]);
    expect(refused.view).toBe(before);
    expect(JSON.stringify(before)).toBe(snapshot);
    if (!refused.ok) expect(refused.reservation).toBeNull();
    expect(must(reserveForAdmission(view({ meters: [bucket(MS, 90), bucket(AT, 1)] }), admission(), ALLOW))
      .view.meters.map((entry) => entry.available)).toEqual([0, 0]);
    for (const meters of [[bucket(MS, 89), bucket(AT, 1)], [bucket(MS, 90), bucket(AT, 0)]]) {
      expect(codes(reserveForAdmission(view({ meters }), admission(), ALLOW)))
        .toEqual(["BUDGET_RESERVATION_INSUFFICIENT_AVAILABLE"]);
    }
  });
  // Every row supplies NO gate at all, so each asserts its own code BEATS the gate check.
  it.each([
    ["malformed admission shape", view(), { admissionRef: REF, amounts: AMOUNTS } as unknown as AdmissionRequest,
      "BUDGET_RESERVATION_MALFORMED"],
    ["non-numeric quantity", view(), admission({ amounts: with_("4") }), "BUDGET_RESERVATION_MALFORMED"],
    ["unknown purpose", view(), admission({ amounts: [...AMOUNTS,
      { purpose: "SIDE_QUEST", meter: MS, quantity: 1 } as unknown as AdmissionAmount] }),
      "BUDGET_RESERVATION_MALFORMED"],
    ["duplicate purpose and meter pair", view(), admission({ amounts: [...AMOUNTS, AMOUNTS[2] as AdmissionAmount] }),
      "BUDGET_RESERVATION_DUPLICATE_PURPOSE"],
    ["zero quantity on a protected line", view(), admission({ amounts: with_(0) }),
      "BUDGET_RESERVATION_INVALID_QUANTITY"],
    ["fractional quantity", view(), admission({ amounts: with_(1.5) }), "BUDGET_RESERVATION_INVALID_QUANTITY"],
    ["missing protected contingency line", view(), admission({ amounts: drop("CONTINGENCY") }),
      "BUDGET_RESERVATION_PROTECTED_PURPOSE_MISSING"],
    ["missing verification line", view(), admission({ amounts: drop("VERIFICATION") }),
      "BUDGET_RESERVATION_PROTECTED_PURPOSE_MISSING"],
    ["missing execution line", view(), admission({ amounts: drop("EXECUTION") }),
      "BUDGET_RESERVATION_EXECUTION_MISSING"],
    ["closed account", view({ state: "CLOSED" }), admission(), "BUDGET_RESERVATION_ACCOUNT_NOT_OPEN"],
    ["overdrawn account holding new work", view({ state: "OVERDRAWN" }), admission(),
      "BUDGET_RESERVATION_ACCOUNT_NOT_OPEN"],
    ["exhausted version counter", view({ version: MAX_BUDGET_VERSION }),
      admission({ expectedVersion: MAX_BUDGET_VERSION }), "BUDGET_RESERVATION_COUNTER_EXHAUSTED"],
    ["stale expected version", view(), admission({ expectedVersion: 2 }), "BUDGET_RESERVATION_STALE_VERSION"],
    ["meter the account does not carry", view({ meters: [bucket(MS, 100)] }), admission(),
      "BUDGET_RESERVATION_UNKNOWN_METER"],
    ["insufficient available units", view({ meters: [bucket(MS, 89), bucket(AT, 10)] }), admission(),
      "BUDGET_RESERVATION_INSUFFICIENT_AVAILABLE"],
  ])("refuses %s ahead of the gate check, with one code and no movement", (_name, v, request, code) => {
    const snapshot = JSON.stringify(v);
    const refused = reserveForAdmission(v, request, NONE);
    expect(codes(refused)).toEqual([code]);
    expect(refused.view).toBe(v);
    expect(JSON.stringify(v)).toBe(snapshot);
  });
  it.each([
    ["a policy outcome that is not already ALLOW", { allowance: { decisionRef: "decision:1",
      outcome: "REQUIRE_HUMAN_APPROVAL" }, approval: null } as AdmissionGate,
      "BUDGET_RESERVATION_POLICY_NOT_ALLOWED"],
    ["a rejected human approval", approved({ decision: "REJECT" }), "BUDGET_RESERVATION_APPROVAL_NOT_CURRENT"],
    ["a human approval whose validity settled", approved({ validity: "INVALIDATED" }),
      "BUDGET_RESERVATION_APPROVAL_NOT_CURRENT"],
    ["no gate at all", NONE, "BUDGET_RESERVATION_GATE_ABSENT"],
    ["a forged gate carrying an extra key", { allowance: { decisionRef: "decision:1", outcome: "ALLOW",
      forced: true }, approval: null } as unknown as AdmissionGate, "BUDGET_RESERVATION_GATE_MALFORMED"],
    ["a gate reached through the prototype chain", Object.create(ALLOW) as AdmissionGate,
      "BUDGET_RESERVATION_GATE_MALFORMED"],
    ["a gate allowance behind an accessor", Object.defineProperty({ approval: null }, "allowance",
      { enumerable: true, get: () => ALLOW.allowance }) as AdmissionGate, "BUDGET_RESERVATION_GATE_MALFORMED"],
  ])("refuses %s at the gate layer", (_name, supplied, code) => {
    const before = view();
    expect(codes(reserveForAdmission(before, admission(), supplied))).toEqual([code]);
    expect(bucketOf(before, MS)).toEqual(bucket(MS, 100));
  });
});

describe("activateReservation", () => {
  it("activates at most once, moves no units, and leaves every protected line untouched", () => {
    const { reservation, view: reserved } = held();
    const active = must(activateReservation(reserved, reservation, ACTIVATE));
    expect(active.reservation).toMatchObject({ state: "ACTIVATED", version: 1, attemptRef: "attempt:1" });
    expect(active.view).toBe(reserved);
    // Design 587: an EXECUTION activation may not spend or reclassify a protected line.
    expect(protectedLines(active.reservation)).toEqual(protectedLines(reservation));
    expect(codes(activateReservation(reserved, active.reservation, { ...ACTIVATE, expectedVersion: 1 })))
      .toEqual(["BUDGET_RESERVATION_ALREADY_SETTLED"]);
  });
  it.each([
    ["activate", (r: ReservationRecord, v: BudgetAvailableView) => activateReservation(v, r, ACTIVATE)],
    ["cancel", (r: ReservationRecord, v: BudgetAvailableView) => cancelReservation(v, r, CANCEL)],
  ])("leaves a stale %s competitor with zero effect after the one legal winner", (_name, loser) => {
    const { reservation, view: reserved } = held();
    const winner = must(activateReservation(reserved, reservation, ACTIVATE));
    const snapshot = JSON.stringify(reserved);
    // The loser re-reads the successor the winner produced and still presents its stale version.
    const refused = loser(winner.reservation, reserved);
    expect(codes(refused)).toEqual(["BUDGET_RESERVATION_STALE_VERSION"]);
    expect(refused.view).toBe(reserved);
    expect(JSON.stringify(reserved)).toBe(snapshot);
    expect(winner.reservation.version).toBe(1);
  });

  it.each([
    ["a protected line relabelled as execution", (r: ReservationRecord) => ({ ...r,
      lines: r.lines.filter((l) => !(l.purpose === "EXECUTION" && l.meter === MS))
        .map((l) => (l.purpose === "VERIFICATION" ? { ...l, purpose: "EXECUTION" as const } : l)) }), ACTIVATE,
      "BUDGET_RESERVATION_PROTECTED_PURPOSE_MISSING"],
    ["an execution line relabelled onto a protected purpose", (r: ReservationRecord) => ({ ...r,
      lines: [{ purpose: "VERIFICATION" as const, meter: MS, quantity: 40 }, ...r.lines.slice(1)] }), ACTIVATE,
      "BUDGET_RESERVATION_DUPLICATE_PURPOSE"],
    ["a forged reservation identity", (r: ReservationRecord) => ({ ...r, reservationId: "reservation:x" }), ACTIVATE,
      "BUDGET_RESERVATION_IDENTITY_MISMATCH"],
    ["a reservation bound to another account", (r: ReservationRecord) => ({ ...r, accountId: "account:other",
      reservationId: deriveReservationId("account:other", REF) }), ACTIVATE, "BUDGET_RESERVATION_IDENTITY_MISMATCH"],
    ["a malformed activate command", (r: ReservationRecord) => r, { expectedVersion: -1, attemptRef: "" },
      "BUDGET_RESERVATION_MALFORMED"],
  ])("refuses %s", (_name, tamper, command, code) => {
    const { reservation, view: reserved } = held();
    expect(codes(activateReservation(reserved, tamper(reservation), command))).toEqual([code]);
  });
});
describe("cancelReservation", () => {
  it("refunds a proven-never-started reservation back to the pre-reserve buckets", () => {
    const before = view();
    const snapshot = JSON.stringify(before);
    const { reservation, view: reserved } = must(reserveForAdmission(before, admission(), ALLOW));
    const refunded = must(cancelReservation(reserved, reservation, CANCEL));
    expect(refunded.reservation).toMatchObject({ state: "CANCELLED", version: 1,
      neverStartedProofRef: "proof:never-started:1" });
    expect(refunded.view.meters).toEqual((JSON.parse(snapshot) as BudgetAvailableView).meters);
    expect(refunded.view.version).toBe(5);
    expect(codes(cancelReservation(refunded.view, refunded.reservation, { ...CANCEL, expectedVersion: 1 })))
      .toEqual(["BUDGET_RESERVATION_ALREADY_SETTLED"]);
  });

  it.each([
    ["an activated reservation", (r: ReservationRecord) => ({ ...r, state: "ACTIVATED" as const, version: 1 }),
      { ...CANCEL, expectedVersion: 1 }, "BUDGET_RESERVATION_ALREADY_SETTLED"],
    ["a reservation with no never-started proof", (r: ReservationRecord) => r,
      { ...CANCEL, neverStartedProofRef: null }, "BUDGET_RESERVATION_NEVER_STARTED_PROOF_MISSING"],
    ["more units than the account holds reserved", (r: ReservationRecord) => ({ ...r,
      lines: r.lines.map((l) => ({ ...l, quantity: l.quantity + 1 })) }), CANCEL,
      "BUDGET_RESERVATION_INSUFFICIENT_RESERVED"],
    ["a meter the account does not carry", (r: ReservationRecord) => ({ ...r, lines: r.lines.map((l) =>
      (l.purpose === "CONTINGENCY" ? { ...l, meter: "meter:absent" } : l)) }), CANCEL,
      "BUDGET_RESERVATION_UNKNOWN_METER"],
  ])("refuses to refund %s", (_name, tamper, command, code) => {
    const { reservation, view: reserved } = held();
    const snapshot = JSON.stringify(reserved);
    const refused = cancelReservation(reserved, tamper(reservation), command);
    expect(codes(refused)).toEqual([code]);
    expect(refused.view).toBe(reserved);
    expect(JSON.stringify(reserved)).toBe(snapshot);
  });

  it("refuses a refund that would exhaust the account version counter", () => {
    const { reservation } = held();
    expect(codes(cancelReservation(view({ version: MAX_BUDGET_VERSION,
      meters: [bucket(MS, 10, 90), bucket(AT, 9, 1)] }), reservation, CANCEL)))
      .toEqual(["BUDGET_RESERVATION_COUNTER_EXHAUSTED"]);
  });
  it("exercises every published reservation issue code", () => {
    expect(Object.isFrozen(BUDGET_RESERVATION_ISSUE_CODES)).toBe(true);
    expect(BUDGET_RESERVATION_ISSUE_CODES.length).toBeGreaterThan(0);
    expect([...observed].sort()).toEqual([...BUDGET_RESERVATION_ISSUE_CODES].sort());
  });
});
