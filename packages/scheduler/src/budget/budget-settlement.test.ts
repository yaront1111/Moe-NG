import { expect, it } from "vitest";
import { MAX_BUDGET_VERSION } from "./budget-account.js";
import type { BudgetMeasurementCoverage, BudgetMeterBuckets } from "./budget-contract.js";
import type { NormalizedMeasurement } from "./budget-measurement.js";
import { deriveReservationId, type BudgetAvailableView, type ReservationLine, type ReservationRecord } from "./budget-reservation.js";
import { BUDGET_SETTLEMENT_ISSUE_CODES, closeSettledView, conservativeSettle, deriveSettlementId,
  reconcileSettlement, settleReservation, type BudgetOverrun, type BudgetSettlementResult,
  type ReconcileEvidence, type SettlementRecord } from "./budget-settlement.js";

const MS = "runner.authorized_ms", AT = "attempt.count", ACC = "account:child";
const REF = "admission:1", RUN = "run-1", RID = deriveReservationId(ACC, REF), DIGEST = "a".repeat(64);
const bucket = (meter: string, available: number, reserved = 0, quarantined = 0, committed = 0): BudgetMeterBuckets =>
  ({ meter, available, reserved, quarantined, committed });
/** MS holds 90 of 100; AT is the untouched sibling and already carries one committed attempt. */
const mkView = (over: Partial<BudgetAvailableView> = {}): BudgetAvailableView =>
  ({ accountId: ACC, state: "OPEN", version: 4, meters: [bucket(MS, 10, 90), bucket(AT, 9, 0, 0, 1)], ...over });
const HELD: readonly ReservationLine[] = [{ purpose: "EXECUTION", meter: MS, quantity: 60 },
  { purpose: "VERIFICATION", meter: MS, quantity: 20 }, { purpose: "CONTINGENCY", meter: MS, quantity: 10 }];
const mkActivated = (over: Partial<ReservationRecord> = {}): ReservationRecord =>
  ({ reservationId: RID, accountId: ACC, admissionRef: REF, state: "ACTIVATED", version: 1, lines: HELD,
    attemptRef: RUN, neverStartedProofRef: null, ...over });
const mkMeasurement = (coverage: BudgetMeasurementCoverage, quantity: number | null, sequence: number,
  meter = MS, run = RUN): NormalizedMeasurement =>
  ({ measurement: { meter, quantity, coverage, source: coverage === "UNKNOWN" ? "UNKNOWN" : "ACTUAL_BILLED",
    providerRunRef: run, sourceParserVersion: 1, sequence, rawReceiptDigest: DIGEST,
    observedInterval: { startRef: "t0", endRef: "t1" } }, pricebookBinding: null, truncated: false,
  identity: `${run.length}:${run}|${meter.length}:${meter}|${sequence}` });
const SETTLE = { expectedViewVersion: 4, expectedReservationVersion: 1, prior: null as SettlementRecord | null };
const RECONCILE = { expectedViewVersion: 5, expectedSettlementVersion: 0 };
const ACK = { ...RECONCILE, acknowledgementRef: "ack:human:1", enforceableUpperBound: true };
const observed = new Set<string>();
const codes = (result: BudgetSettlementResult): readonly string[] => {
  if (result.ok) return [];
  for (const entry of result.issues) observed.add(entry.code);
  return result.issues.map((entry) => entry.code); };
function must(result: BudgetSettlementResult): { settlement: SettlementRecord; view: BudgetAvailableView } {
  if (!result.ok || result.settlement === null) throw new Error(`expected ok, got ${codes(result).join(",")}`);
  return { settlement: result.settlement, view: result.view }; }
const bucketOf = (view: BudgetAvailableView, meter: string): BudgetMeterBuckets =>
  view.meters.find((entry) => entry.meter === meter) ?? bucket("absent", -1);
const total = (e: BudgetMeterBuckets): number => e.available + e.reserved + e.quarantined + e.committed;
let conserved = 0;
/** Design 610-613: buckets = authorized + explicit recorded overrun, per meter, and never negative. */
function expectConserved(before: BudgetAvailableView, after: BudgetAvailableView, overrun: readonly BudgetOverrun[]): void {
  conserved += 1;
  for (const entry of before.meters) {
    const post = bucketOf(after, entry.meter);
    expect(total(post)).toBe(total(entry) + (overrun.find((o) => o.meter === entry.meter)?.amount ?? 0));
    expect(Math.min(post.available, post.reserved, post.quarantined, post.committed)).toBeGreaterThanOrEqual(0);
  }
}
const settled = (coverage: BudgetMeasurementCoverage, quantity: number | null): ReturnType<typeof must> =>
  must(settleReservation(mkView(), mkActivated(), { measurements: [mkMeasurement(coverage, quantity, 3)] }, SETTLE));
/** The UNKNOWN hold: 90 quarantined, nothing committed. The PARTIAL hold: 50 committed, 40 quarantined. */
const quarantined = (): ReturnType<typeof must> => settled("UNKNOWN", null);
const partial = (): ReturnType<typeof must> => settled("PARTIAL", 50);

it("commits exact measured use, refunds only the proven remainder, and mints one settlement", () => {
  const before = mkView();
  const { settlement, view } = must(settleReservation(before, mkActivated(),
    { measurements: [mkMeasurement("COMPLETE", 70, 3)] }, SETTLE));
  expect(settlement).toMatchObject({ settlementId: deriveSettlementId(RID), reservationId: RID, accountId: ACC,
    attemptRef: RUN, version: 0, state: "SETTLED", unknownExternalLiability: false, overrun: [] });
  expect([...settlement.lines]).toEqual([{ meter: MS, reserved: 90, committed: 70, refunded: 20, quarantined: 0,
    disposition: "EXACT", identity: mkMeasurement("COMPLETE", 70, 3).identity, sequence: 3 }]);
  expect([bucketOf(view, MS), bucketOf(view, AT)]).toEqual([bucket(MS, 30, 0, 0, 70), bucket(AT, 9, 0, 0, 1)]);
  expect([view.version, view.state]).toEqual([5, "OPEN"]);
  expect(Object.isFrozen(settlement) && Object.isFrozen(view)).toBe(true);
  expectConserved(before, view, settlement.overrun);
});
it("is duplicate-safe: a byte-identical replay returns the prior record itself and moves nothing", () => {
  const before = mkView(), evidence = { measurements: [mkMeasurement("COMPLETE", 70, 3)] };
  const first = must(settleReservation(before, mkActivated(), evidence, SETTLE));
  const replay = settleReservation(before, mkActivated(), evidence, { ...SETTLE, prior: first.settlement });
  expect(replay.ok).toBe(true);
  expect(replay.settlement).toBe(first.settlement);
  expect(replay.view).toBe(before);
  expectConserved(before, replay.view, []);
});
it("records measured excess as explicit overrun and OVERDRAWN, never funded from a sibling meter", () => {
  const before = mkView(), sibling = bucketOf(before, AT);
  const { settlement, view } = must(settleReservation(before, mkActivated(),
    { measurements: [mkMeasurement("COMPLETE", 130, 3)] }, SETTLE));
  expect([...settlement.overrun]).toEqual([{ meter: MS, amount: 40 }]);
  expect(settlement.lines[0]).toMatchObject({ committed: 130, refunded: 0, quarantined: 0, disposition: "EXACT" });
  expect([bucketOf(view, MS), view.state]).toEqual([bucket(MS, 10, 0, 0, 130), "OVERDRAWN"]);
  expect(bucketOf(view, AT)).toEqual(sibling);
  expectConserved(before, view, settlement.overrun);
});
it("commits only the proven lower bound of a PARTIAL receipt and quarantines the remainder", () => {
  const { settlement, view } = partial();
  expect(settlement).toMatchObject({ state: "QUARANTINED",
    lines: [{ committed: 50, refunded: 0, quarantined: 40, disposition: "LOWER_BOUND" }] });
  expect(bucketOf(view, MS)).toEqual(bucket(MS, 10, 0, 40, 50));
  expectConserved(mkView(), view, settlement.overrun);
});
it.each([["an UNKNOWN receipt", [mkMeasurement("UNKNOWN", null, 3)], 3], ["no receipt at all", [], null]])(
  "quarantines the whole hold for %s and never writes a zero-committed exact settlement", (_name, measurements, sequence) => {
    const before = mkView();
    const { settlement, view } = must(settleReservation(before, mkActivated(), { measurements }, SETTLE));
    expect(settlement).toMatchObject({ state: "QUARANTINED", lines: [{ committed: 0, refunded: 0,
      quarantined: 90, disposition: "UNKNOWN_HELD", sequence }] });
    expect([bucketOf(view, MS), bucketOf(view, AT)]).toEqual([bucket(MS, 10, 0, 90, 0), bucket(AT, 9, 0, 0, 1)]);
    expectConserved(before, view, settlement.overrun);
  });
it("commits exact use out of QUARANTINED on a later correlated receipt and refunds the remainder", () => {
  const held = quarantined();
  const { settlement, view } = must(reconcileSettlement(held.view, held.settlement,
    { measurements: [mkMeasurement("COMPLETE", 70, 4)], neverStartedProofRef: null }, RECONCILE));
  expect(settlement).toMatchObject({ state: "SETTLED", version: 1,
    lines: [{ committed: 70, refunded: 20, quarantined: 0, disposition: "EXACT", sequence: 4 }] });
  expect([bucketOf(view, MS), view.version]).toEqual([bucket(MS, 30, 0, 0, 70), 6]);
  expectConserved(held.view, view, settlement.overrun);
});
it("lands a late COMPLETE receipt on a LOWER_BOUND line whose whole hold already committed and keeps the overrun explicit", () => {
  const held = settled("PARTIAL", 95);
  const { settlement, view } = must(reconcileSettlement(held.view, held.settlement,
    { measurements: [mkMeasurement("COMPLETE", 100, 4)], neverStartedProofRef: null }, RECONCILE));
  expect(settlement).toMatchObject({ state: "SETTLED", version: 1,
    lines: [{ committed: 100, refunded: 0, quarantined: 0, disposition: "EXACT", sequence: 4 }] });
  expect([...settlement.overrun]).toEqual([{ meter: MS, amount: 5 }, { meter: MS, amount: 5 }]);
  expect([bucketOf(view, MS), view.state, view.version]).toEqual([bucket(MS, 10, 0, 0, 100), "OVERDRAWN", 6]);
  expectConserved(held.view, view, settlement.overrun);
});
it("settles a PARTIAL receipt that consumed exactly its hold once a COMPLETE receipt confirms no further use", () => {
  const held = settled("PARTIAL", 90);
  const { settlement, view } = must(reconcileSettlement(held.view, held.settlement,
    { measurements: [mkMeasurement("COMPLETE", 90, 4)], neverStartedProofRef: null }, RECONCILE));
  expect(settlement).toMatchObject({ state: "SETTLED", version: 1, overrun: [],
    lines: [{ committed: 90, refunded: 0, quarantined: 0, disposition: "EXACT", sequence: 4 }] });
  expect([bucketOf(view, MS), view.state, view.version]).toEqual([bucket(MS, 10, 0, 0, 90), "OPEN", 6]);
  expectConserved(held.view, view, settlement.overrun);
});
it("refunds every quarantined unit on never-started proof while committed attempt.count stays spent", () => {
  const held = quarantined();
  const { settlement, view } = must(reconcileSettlement(held.view, held.settlement,
    { measurements: null, neverStartedProofRef: "proof:never-started:1" }, RECONCILE));
  expect(settlement).toMatchObject({ state: "SETTLED", version: 1, lines: [{ committed: 0, refunded: 90,
    quarantined: 0, disposition: "NEVER_STARTED_REFUND" }] });
  expect([bucketOf(view, MS), bucketOf(view, AT)]).toEqual([bucket(MS, 100, 0, 0, 0), bucket(AT, 9, 0, 0, 1)]);
  expectConserved(held.view, view, settlement.overrun);
});
it.each([[true, false], [false, true]])(
  "writes the whole held reservation off (enforceable upper bound %s) and refunds nothing", (bound, liability) => {
    const held = quarantined();
    const { settlement, view } = must(conservativeSettle(held.view, held.settlement,
      { ...ACK, enforceableUpperBound: bound }));
    expect(settlement).toMatchObject({ state: "WRITTEN_OFF", version: 1, unknownExternalLiability: liability,
      lines: [{ committed: 90, refunded: 0, quarantined: 0, disposition: "CONSERVATIVE_WRITE_OFF" }] });
    expect(bucketOf(view, MS)).toEqual(bucket(MS, 10, 0, 0, 90));
    expectConserved(held.view, view, settlement.overrun);
  });
const writtenOff = (liability: boolean): SettlementRecord => { const held = quarantined();
  return must(conservativeSettle(held.view, held.settlement, { ...ACK, enforceableUpperBound: !liability })).settlement; };
const drained = (over: Partial<BudgetAvailableView> = {}): BudgetAvailableView =>
  mkView({ version: 9, meters: [bucket(MS, 0, 0, 0, 90), bucket(AT, 0, 0, 0, 1)], ...over });
const CLOSE = { expectedVersion: 9 };
it.each([[false, "CLOSED"], [true, "CLOSED_WITH_UNKNOWN_LIABILITY"]])(
  "closes a drained account whose settlements carry unknown liability=%s as %s", (liability, state) => {
    const before = drained(), result = closeSettledView(before, [writtenOff(liability)], CLOSE);
    if (!result.ok) throw new Error(`expected ok, got ${codes(result).join(",")}`);
    expect([result.settlement, result.view.state, result.view.version]).toEqual([null, state, 10]);
    expectConserved(before, result.view, []);
  });

type Held = ReturnType<typeof must>;
type Probe = readonly [BudgetSettlementResult, BudgetAvailableView, unknown, string];
/** Snapshots the view AND the supplied record before the call, so every row proves zero mutation. */
const probe = (view: BudgetAvailableView, record: unknown, run: () => BudgetSettlementResult): Probe => {
  const shot = JSON.stringify([view, record]);
  return [run(), view, record, shot]; };
const M70 = mkMeasurement("COMPLETE", 70, 3);
const R4: ReconcileEvidence = { measurements: [mkMeasurement("COMPLETE", 70, 4)], neverStartedProofRef: null };
const PROOF: ReconcileEvidence = { measurements: null, neverStartedProofRef: "proof:never-started:1" };
const EXACT = settled("COMPLETE", 70).settlement;
/** Rebinds a record to another account with a self-consistent inner identity, so only the view binding refuses. */
const foreign = (record: SettlementRecord): SettlementRecord => { const rid = deriveReservationId("account:other", REF);
  return { ...record, accountId: "account:other", reservationId: rid, settlementId: deriveSettlementId(rid) }; };
const onSettle = (reservation: ReservationRecord, measurements: readonly NormalizedMeasurement[] = [M70],
  command = SETTLE, view = mkView()) => (): Probe =>
  probe(view, reservation, () => settleReservation(view, reservation, { measurements }, command));
const onReconcile = (evidence: ReconcileEvidence, mutate: (h: Held) => Held = (h) => h, command = RECONCILE) =>
  (): Probe => { const h = mutate(quarantined());
    return probe(h.view, h.settlement, () => reconcileSettlement(h.view, h.settlement, evidence, command)); };
const onConservative = (command = ACK, mutate: (h: Held) => Held = (h) => h) => (): Probe => {
  const h = mutate(quarantined());
  return probe(h.view, h.settlement, () => conservativeSettle(h.view, h.settlement, command)); };
const onClose = (view = drained(), settlements: readonly SettlementRecord[] = []) => (): Probe =>
  probe(view, settlements, () => closeSettledView(view, settlements, CLOSE));
const ROWS: readonly (readonly [string, () => Probe, string])[] = [
  ["a settle command with an extra key", onSettle(mkActivated(), [M70],
    { ...SETTLE, forced: true } as typeof SETTLE), "MALFORMED"],
  ["a measurement reached through the prototype chain",
    onSettle(mkActivated(), [Object.create(M70) as NormalizedMeasurement]), "MALFORMED"],
  ["a negative expected view version", onSettle(mkActivated(), [M70],
    { ...SETTLE, expectedViewVersion: -1 }), "MALFORMED"],
  ["a forged reservation identity", onSettle(mkActivated({ reservationId: "reservation:x" })), "IDENTITY_MISMATCH"],
  ["a reservation bound to another account", onSettle(mkActivated({ accountId: "account:other",
    reservationId: deriveReservationId("account:other", REF) })), "IDENTITY_MISMATCH"],
  ["a settle before activation", onSettle(mkActivated({ state: "RESERVED", attemptRef: null })), "NOT_ACTIVATED"],
  ["a settle of a cancelled reservation", onSettle(mkActivated({ state: "CANCELLED" })), "NOT_ACTIVATED"],
  ["a prior settlement of this reservation carrying different bytes", onSettle(mkActivated(), [M70],
    { ...SETTLE, prior: { ...EXACT, version: 7 } }), "ALREADY_SETTLED"],
  ["a stale expected view version", onSettle(mkActivated(), [M70],
    { ...SETTLE, expectedViewVersion: 3 }), "STALE_VERSION"],
  ["a stale expected reservation version", onSettle(mkActivated(), [M70],
    { ...SETTLE, expectedReservationVersion: 0 }), "STALE_VERSION"],
  ["an exhausted view version counter", onSettle(mkActivated(), [M70],
    { ...SETTLE, expectedViewVersion: MAX_BUDGET_VERSION }, mkView({ version: MAX_BUDGET_VERSION })),
  "COUNTER_EXHAUSTED"],
  ["a measurement from another provider run", onSettle(mkActivated(),
    [mkMeasurement("COMPLETE", 70, 3, MS, "run-2")]), "UNCORRELATED_MEASUREMENT"],
  ["two measurements of one meter", onSettle(mkActivated(), [M70, mkMeasurement("COMPLETE", 5, 4)]), "DUPLICATE_METER"],
  ["a measurement of a meter the reservation never held", onSettle(mkActivated(),
    [mkMeasurement("COMPLETE", 70, 3, AT)]), "UNKNOWN_METER"],
  ["a view holding fewer reserved units than the hold", onSettle(mkActivated(), [M70], SETTLE,
    mkView({ meters: [bucket(MS, 10, 89), bucket(AT, 9, 0, 0, 1)] })), "INSUFFICIENT_RESERVED"],
  ["a reconcile of an already settled record", onReconcile(R4,
    (h) => ({ ...h, settlement: { ...h.settlement, state: "SETTLED" } })), "ALREADY_SETTLED"],
  ["a reconcile of a written-off record", onReconcile(R4,
    (h) => ({ ...h, settlement: { ...h.settlement, state: "WRITTEN_OFF" } })), "ALREADY_SETTLED"],
  ["a reconcile of a settlement bound to another account", onReconcile(R4,
    (h) => ({ ...h, settlement: foreign(h.settlement) })), "IDENTITY_MISMATCH"],
  ["a reconcile of a settlement whose reservation id names another account", onReconcile(R4,
    (h) => ({ ...h, settlement: { ...h.settlement, reservationId: deriveReservationId("account:other", REF),
      settlementId: deriveSettlementId(deriveReservationId("account:other", REF)) } })), "IDENTITY_MISMATCH"],
  ["a forged settlement carrying two lines of one meter", onReconcile(R4,
    (h) => ({ ...h, settlement: { ...h.settlement,
      lines: [...h.settlement.lines, ...h.settlement.lines] } })), "MALFORMED"],
  ["a receipt for a meter the settlement never quarantined", onReconcile(
    { measurements: [mkMeasurement("COMPLETE", 70, 4, AT)], neverStartedProofRef: null }), "UNKNOWN_METER"],
  ["a receipt whose sequence does not advance past the stored one",
    onReconcile({ measurements: [M70], neverStartedProofRef: null }), "SEQUENCE_STALE"],
  ["a receipt below the already-committed lower bound", onReconcile(
    { measurements: [mkMeasurement("COMPLETE", 30, 4)], neverStartedProofRef: null },
    () => partial()), "MEASUREMENT_CONFLICT"],
  ["never-started proof against a settlement that already committed use",
    onReconcile(PROOF, () => partial()), "MEASUREMENT_CONFLICT"],
  ["a reconcile carrying both a receipt and never-started proof", onReconcile(
    { measurements: R4.measurements, neverStartedProofRef: "proof:1" }), "EVIDENCE_AMBIGUOUS"],
  ["a reconcile carrying no evidence at all",
    onReconcile({ measurements: null, neverStartedProofRef: null }), "EVIDENCE_AMBIGUOUS"],
  ["a reconcile whose receipt array is empty, which is no evidence either",
    onReconcile({ measurements: [], neverStartedProofRef: null }), "EVIDENCE_AMBIGUOUS"],
  ["a reconcile at a stale settlement version", onReconcile(R4, (h) => h,
    { ...RECONCILE, expectedSettlementVersion: 1 }), "STALE_VERSION"],
  ["a reconcile against a view holding fewer quarantined units", onReconcile(R4, (h) => ({ ...h,
    view: mkView({ version: 5, meters: [bucket(MS, 10, 0, 89), bucket(AT, 9, 0, 0, 1)] }) })),
  "INSUFFICIENT_QUARANTINED"],
  ["a conservative settlement with no human acknowledgement",
    onConservative({ ...ACK, acknowledgementRef: "" }), "ACKNOWLEDGEMENT_MISSING"],
  ["a conservative settlement of a record bound to another account",
    onConservative(ACK, (h) => ({ ...h, settlement: foreign(h.settlement) })), "IDENTITY_MISMATCH"],
  ["a close with units still reserved",
    onClose(drained({ meters: [bucket(MS, 0, 5, 0, 85), bucket(AT, 0, 0, 0, 1)] })), "ILLEGAL_CLOSE"],
  ["a close with units still quarantined",
    onClose(drained({ meters: [bucket(MS, 0, 0, 5, 85), bucket(AT, 0, 0, 0, 1)] })), "ILLEGAL_CLOSE"],
  ["a close with available units not yet returned to the parent",
    onClose(drained({ meters: [bucket(MS, 5, 0, 0, 85), bucket(AT, 0, 0, 0, 1)] })), "ILLEGAL_CLOSE"],
  ["a close of an overdrawn account", onClose(drained({ state: "OVERDRAWN" })), "ILLEGAL_CLOSE"],
  ["a close of an already closed account", onClose(drained({ state: "CLOSED" })), "ILLEGAL_CLOSE"],
  ["a close while a supplied settlement is still quarantined",
    onClose(drained(), [quarantined().settlement]), "ILLEGAL_CLOSE"],
  ["a close judging a settlement bound to another account",
    onClose(drained(), [foreign(writtenOff(false))]), "IDENTITY_MISMATCH"],
];
it.each(ROWS)("refuses %s with a single frozen code and zero effect", (_name, thunk, code) => {
  const [result, view, record, shot] = thunk();
  expect(codes(result)).toEqual([`BUDGET_SETTLEMENT_${code}`]);
  expect(result.view).toBe(view);
  expect(JSON.stringify([view, record])).toBe(shot);
  expect(Object.isFrozen(result)).toBe(true);
  if (!result.ok) expect(Object.isFrozen(result.issues[0])).toBe(true);
});
it("generates every refusal case, covers the published codes exactly, and conserves on every path", () => {
  expect(ROWS.length).toBe(38);
  expect(Object.isFrozen(BUDGET_SETTLEMENT_ISSUE_CODES)).toBe(true);
  expect([...observed].sort()).toEqual([...BUDGET_SETTLEMENT_ISSUE_CODES].sort());
  expect(conserved).toBe(14);
});
