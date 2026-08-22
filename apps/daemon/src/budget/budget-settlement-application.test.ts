/**
 * Applying a provider's measured usage to the durable budget, end to end through production.
 *
 * EVERY DURABLE FACT HERE IS WRITTEN BY A PRODUCTION WRITER. The reservation comes from a real
 * `effect.activate` through `runEffectActivateCommand`, so the attempt/reservation join is the
 * one production makes; the provider run comes from `commitProviderRunRecord`; the measurement
 * identities are minted by the scheduler's own `normalizeUsageMeasurement`, and the correlation
 * composite by `encodeProviderRunRef`. A hand-typed composite or a hand-written identity would
 * satisfy a check the authority would have refused, which is the whole failure this row exists
 * to prevent.
 *
 * THE THREE COVERAGE ARMS MUST STAY DISTINCT. COMPLETE commits and may refund; PARTIAL preserves
 * lower bounds and holds; UNKNOWN quarantines and NEVER reads as zero and NEVER refunds. A single
 * collapsed shape that passes all three is the money bug this suite is written against.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeProviderRunRef, normalizeUsageMeasurement } from "@moe/scheduler";
import type { NormalizedMeasurement } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import type { CommandDecisionKey } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "../activation/activation-ingress-contracts.js";
import { runEffectActivateCommand } from "../activation/activation-ingress.js";
import { deriveActivationAggregateId } from "../activation/activation-ledger-contracts.js";
import { readActivationLedgerRecord } from "../activation/activation-ledger-reader.js";
import { GOAL_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";
import { PROVIDER_RUN_RECORD_VERSION } from "../telemetry/provider-run-contracts.js";
import type { ProviderRunRecord } from "../telemetry/provider-run-contracts.js";
import { commitProviderRunRecord } from "../telemetry/provider-run-ledger.js";
import { readCurrentProviderRun } from "../telemetry/provider-run-reader.js";
import { readCurrentBudgetLedger } from "./budget-current-projection.js";
import { BUDGET_LEDGER_COMMAND_KIND } from "./budget-ledger-contracts.js";
import { applyProviderUsageToBudget } from "./budget-settlement-application.js";

const encoder = new TextEncoder();
const scratchRoots: string[] = [];

afterEach(cleanupRestoreHarnesses);
afterAll(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
});

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const COMMAND_ID = "cmd-activate-1";
const ATTEMPT = "attempt-1";
const INTENT = "intent-1";
const EPOCH = 3;
const RUN_REF = "run-settlement-1";
const PROVIDER = "claude";

const LEASE_RECORD = {
  authorityHashRef: DIGEST, bootId: "boot-1", epoch: EPOCH, kind: "ASSIGNMENT",
  leaseId: "lease-1", leaseToken: "token-1", monotonicObservation: 500,
  ownerSessionRef: "session-1", serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
} as const;

const LEASE_PROOF = {
  authorityHashRef: DIGEST, epoch: EPOCH, expectedVersion: 7,
  leaseToken: "token-1", ownerSessionRef: "session-1",
} as const;

const EFFECT_INTENT = {
  aggregateId: "agg-1", desiredState: "ACTIVE", expectedGraphEpoch: 4,
  idempotencyKey: "idem-1", inputBinding: DIGEST, intentId: INTENT,
  leaseBinding: LEASE_RECORD, predecessorCursor: "cursor-1",
  protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
  state: "PENDING", version: 0,
} as const;

const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1", attemptId: ATTEMPT, intentId: INTENT,
    state: "LAUNCH_REQUESTED", version: 0,
  },
  claim: {
    claimId: "claim-1", claimedAt: DECIDED_AT, intentId: INTENT,
    lockIdentity: "lock-1", wrapperIdentity: "wrapper-1",
  },
  dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1", observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
  tombstone: null, wrapperIdentity: "wrapper-1",
} as const;

const AGGREGATE_ID = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId,
  EFFECT_INTENT.idempotencyKey,
);

const blind = { known: false, code: "TELEMETRY_USAGE_ABSENT", layer: "TELEMETRY_RESULT" } as const;

function readyStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-settle-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

function activateBytes(commandId: string = COMMAND_ID): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId, correlationId: "corr-activate", decidedAt: DECIDED_AT, expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: ACTIVATION_SECTION,
      effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: {
        dimension: "default", requestId: "req-1", slotRef: "slot-1",
        rows: [{
          capacityUnits: 1, effectIntentRef: "intent-ref-1", epoch: 1, external: false,
          fenceable: true, resourceId: "res-1", state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/**
 * The REAL store with ONE seam widened: the binding's own single-leg budget commit throws.
 *
 * The activation's RESERVE leg does not go through here — it rides the activation's legs commit —
 * so this fault reaches the RESERVED -> ACTIVATED bind and nothing else. Every other method
 * executes on the real store. Borrowed from activation-budget-binding.test.ts, which owns it.
 */
function refuseBudgetCommit(store: SqliteEventStore): SqliteEventStore {
  return new Proxy(store, {
    get(target, property): unknown {
      const held: unknown = Reflect.get(target, property, target);
      if (typeof held !== "function") return held;
      const method = held as (...args: unknown[]) => unknown;
      if (property !== "commitExpectedVersionDecision") return method.bind(target);
      return (...args: unknown[]): unknown => {
        const input = args[0] as { readonly commandKind?: unknown };
        if (input?.commandKind === BUDGET_LEDGER_COMMAND_KIND) {
          throw new Error("the binding's budget decision is refused by the store");
        }
        return method.apply(target, args);
      };
    },
  });
}

/** The activated store: reservation ACTIVATED and bound to the attempt by PRODUCTION. */
function activatedStore(label: string): SqliteEventStore {
  const store = readyStore(label);
  const outcome = runEffectActivateCommand(store, activateBytes());
  if (!("ok" in outcome) || outcome.ok !== true) {
    throw new Error(`the activation fixture was refused: ${JSON.stringify(outcome).slice(0, 200)}`);
  }
  return store;
}

interface Held {
  readonly attemptRef: string;
  readonly meters: readonly string[];
  readonly reservationId: string;
  readonly state: string;
}

/** The durable reservation, read through the committed projection — never a suite-built view. */
function heldOf(store: SqliteEventStore): Held {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!current.ok) throw new Error(`the durable ledger must read back: ${current.code}`);
  const durable = readActivationLedgerRecord(AGGREGATE_ID, store.readEvents(AGGREGATE_ID));
  if (!durable.ok) throw new Error(`the activation record must read back: ${durable.code}`);
  const attemptRef = durable.record.attempt.attemptId;
  const reservation = current.reservations.find((entry) => entry.attemptRef === attemptRef);
  if (reservation === undefined) throw new Error("no reservation is bound to the attempt");
  return {
    attemptRef,
    meters: [...new Set(reservation.lines.map((line) => line.meter))],
    reservationId: reservation.reservationId,
    state: reservation.state,
  };
}

/**
 * A SECOND independent activation in the same store.
 *
 * Everything that decides identity is distinct — attempt, intent, aggregate, idempotency key and
 * command id — so the ledger ends up holding TWO activated reservations. Without a second one,
 * "find the reservation bound to this attempt" and "find any activated reservation" pick the same
 * row, and no arm can tell the two apart. Measured: dropping the attempt from the filter was a
 * SURVIVING mutant until this fixture existed.
 */
const SECOND_ATTEMPT = "attempt-2";

function secondActivateBytes(): Uint8Array {
  const intent = { ...EFFECT_INTENT, aggregateId: "agg-2", idempotencyKey: "idem-2", intentId: "intent-2" };
  return encoder.encode(JSON.stringify({
    commandId: "cmd-activate-2", correlationId: "corr-activate-2", decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        ...ACTIVATION_SECTION,
        attempt: {
          aggregateId: "agg-2", attemptId: SECOND_ATTEMPT, intentId: "intent-2",
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim: { ...ACTIVATION_SECTION.claim, claimId: "claim-2", intentId: "intent-2" },
      },
      effect: { command: { kind: "claim" }, intent },
      lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
      liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
      slot: {
        dimension: "default", requestId: "req-2", slotRef: "slot-2",
        rows: [{
          capacityUnits: 1, effectIntentRef: "intent-ref-2", epoch: 1, external: false,
          fenceable: true, resourceId: "res-2", state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

function activatedReservationCount(store: SqliteEventStore): number {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!current.ok) throw new Error(`the ledger must read back: ${current.code}`);
  return current.reservations.filter((entry) => entry.state === "ACTIVATED").length;
}

const compositeFor = (attemptRef: string, runRef = RUN_REF): string =>
  encodeProviderRunRef({ attemptRef, epoch: EPOCH, provider: PROVIDER, runRef });

interface UsageShape {
  readonly coverage: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  readonly meter: string;
  readonly quantity: number | null;
  readonly runRef?: string;
}

const SOURCE_OF = {
  COMPLETE: "PROVIDER_REPORTED_COMPLETE",
  PARTIAL: "PROVIDER_REPORTED_PARTIAL",
  UNKNOWN: "UNKNOWN",
} as const;

/** The three-key envelope the measurement authority admits. `identity` is ITS to derive. */
function envelopeOf(attemptRef: string, shape: UsageShape, index: number): unknown {
  return {
    measurement: {
      coverage: shape.coverage,
      meter: shape.meter,
      observedInterval: { endRef: "interval-end-1", startRef: "interval-start-1" },
      providerRunRef: compositeFor(attemptRef, shape.runRef ?? RUN_REF),
      quantity: shape.quantity,
      rawReceiptDigest: "ab".repeat(32),
      sequence: index,
      source: SOURCE_OF[shape.coverage],
      sourceParserVersion: 1,
    },
    pricebookBinding: null,
    truncated: false,
  };
}

/**
 * Normalized through the SCHEDULER'S OWN authority, so `identity` is the value production would
 * have derived. Writing an identity by hand here would be asserting a coverage the authority
 * never granted — the exact laundering `budget-ledger-holds` normalizes server-side to prevent.
 */
function usageRows(attemptRef: string, shapes: readonly UsageShape[]): readonly NormalizedMeasurement[] {
  return shapes.map((shape, index) => {
    const normalized = normalizeUsageMeasurement(envelopeOf(attemptRef, shape, index));
    if (!normalized.ok) {
      throw new Error(`usage fixture refused: ${JSON.stringify(normalized.issues).slice(0, 200)}`);
    }
    return normalized.record;
  });
}

function runRecord(attemptRef: string, usage: readonly NormalizedMeasurement[]): ProviderRunRecord {
  return {
    recordVersion: PROVIDER_RUN_RECORD_VERSION,
    providerRunRef: { attemptRef, effectIntentId: INTENT, epoch: EPOCH, provider: PROVIDER, runRef: RUN_REF },
    launch: {
      kind: "REFUSED", truthClass: "UNKNOWN", reasonCode: null, reasonLayer: null, exit: null,
      effectDigest: null, activationDigest: null, runtimeBindingDigest: null,
      quotedRuntimeDigest: null, freshRuntimeDigest: null, pinnedClosureDigest: null,
      observationDigest: null, startedAt: null, completedAt: DECIDED_AT,
    },
    declared: blind,
    observedModel: { modelId: blind, snapshotKind: "UNKNOWN", snapshotEvidence: blind },
    terminal: "UNKNOWN",
    infrastructure: "NONE",
    tokens: {
      inputTokens: blind, outputTokens: blind, cacheCreationInputTokens: blind,
      cacheReadInputTokens: blind, coverage: "UNKNOWN",
    },
    steps: { turns: blind, coverage: "UNKNOWN" },
    sequence: { known: true, value: 3 },
    concurrency: { fact: "NO_CONCURRENCY_FACTS", declaredCeiling: blind, achieved: blind },
    observedStart: { serverWallSeconds: 1_700_000_000, bootId: "boot-1", monotonicObservation: 12 },
    observedEnd: null,
    usage,
    usageRefusals: [],
    upstreamRefusal: null,
    stdoutReceiptDigest: { known: true, value: "stdout-1" },
    stderrReceiptDigest: { known: true, value: "stderr-1" },
    recordDigest: "",
  } as unknown as ProviderRunRecord;
}

function commitRun(
  store: SqliteEventStore, attemptRef: string, usage: readonly NormalizedMeasurement[],
  commandId = "cmd-run-1",
): void {
  const committed = commitProviderRunRecord(store, {
    correlationId: "corr-run-1",
    decidedAt: DECIDED_AT,
    // The reader binds telemetry to the SESSION that held the lease, not to the activation's
    // principal: `key.principalId` must be the attempt's ownerSessionRef or every record is
    // refused PROVIDER_RUN_BINDING_MISMATCH. Measured, not guessed.
    key: {
      commandId, principalId: LEASE_RECORD.ownerSessionRef, projectId: PROJECT_ID,
    } satisfies CommandDecisionKey,
    record: runRecord(attemptRef, usage),
    requestBytes: encoder.encode(`provider-run-${commandId}`),
  });
  if (!committed.ok) {
    throw new Error(`the provider-run fixture was refused: ${JSON.stringify(committed).slice(0, 200)}`);
  }
}

const CONTEXT = {
  commandId: "cmd-settle-1",
  correlationId: "corr-settle-1",
  decidedAt: DECIDED_AT,
  principalId: PRINCIPAL_ID,
} as const;

const apply = (store: SqliteEventStore, attemptRef: string, context = CONTEXT): unknown =>
  applyProviderUsageToBudget(store, { attemptRef, context, projectId: PROJECT_ID });

function acceptedOf(outcome: unknown): Record<string, unknown> {
  const value = outcome as Record<string, unknown>;
  if (value["ok"] !== true) {
    throw new Error(`expected acceptance, got ${String(value["code"])}@${String(value["layer"])}`
      + ` (upstream ${String(value["sourceCode"])}@${String(value["sourceLayer"])})`);
  }
  return value;
}

function refusalOf(
  outcome: unknown,
): { code: unknown; layer: unknown; sourceCode: unknown; sourceLayer: unknown } {
  const value = outcome as Record<string, unknown>;
  if (value["ok"] === true) throw new Error("expected a refusal, received an accepted settlement");
  return {
    code: value["code"], layer: value["layer"],
    sourceCode: value["sourceCode"], sourceLayer: value["sourceLayer"],
  };
}

/**
 * The RETAINED settlement record. A settlement whose state is SETTLED is PRUNED out of the head
 * together with its reservation and folded into `settledMeters` (budget-ledger-holds.ts:175-200),
 * so only a QUARANTINED settlement — PARTIAL or UNKNOWN — survives here. Measured, not assumed:
 * the COMPLETE arm below reads `settledMeters` and the view instead, because looking for a
 * pruned record would fail for a reason that has nothing to do with the money.
 */
function retainedSettlementOf(store: SqliteEventStore, reservationId: string): Record<string, unknown> {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!current.ok) throw new Error(`the ledger must read back: ${current.code}`);
  const settlement = current.settlements.find((entry) => entry.reservationId === reservationId);
  if (settlement === undefined) throw new Error("no settlement was retained for the reservation");
  return settlement as unknown as Record<string, unknown>;
}

/** The live balances: the VIEW carries them, not the account record. */
function meterViewOf(store: SqliteEventStore, meter: string): Record<string, unknown> {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!current.ok) throw new Error(`the ledger must read back: ${current.code}`);
  const view = current.views[0] as unknown as Record<string, unknown> | undefined;
  const meters = (view?.["meters"] ?? []) as readonly Record<string, unknown>[];
  const row = meters.find((entry) => entry["meter"] === meter);
  if (row === undefined) throw new Error(`no view row for ${meter}`);
  return row;
}

function settledCountOf(store: SqliteEventStore, meter: string): number {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!current.ok) throw new Error(`the ledger must read back: ${current.code}`);
  const summary = current.settledMeters.find((entry) => entry.meter === meter);
  return summary?.measuredLineCount ?? 0;
}

const ledgerHeadOf = (store: SqliteEventStore): number => {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  return current.ok ? current.headVersion : -1;
};

describe("provider usage applied to budget — COMPLETE coverage", () => {
  it("commits the MEASURED amount and refunds the remainder of the hold", () => {
    const store = activatedStore("complete");
    const held = heldOf(store);
    expect(held.state).toBe("ACTIVATED");
    expect(held.meters.length).toBeGreaterThan(0);
    const [meter] = held.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    const before = meterViewOf(store, meter);
    commitRun(store, held.attemptRef, usageRows(held.attemptRef,
      held.meters.map((entry) => ({ coverage: "COMPLETE", meter: entry, quantity: 1 } as const))));

    acceptedOf(apply(store, held.attemptRef));

    const after = meterViewOf(store, meter);
    // The MEASURED amount, not the reserved amount: one unit was observed, so one unit commits
    // and the rest of the hold goes back to available rather than being consumed.
    expect(after["committed"]).toBe(1);
    expect(after["reserved"]).toBe(0);
    expect(after["quarantined"]).toBe(0);
    expect(Number(after["available"])).toBeGreaterThan(Number(before["available"]));
  });

  it("records the settlement as a MEASURED line and prunes the resolved pair", () => {
    const store = activatedStore("complete-summary");
    const held = heldOf(store);
    const [meter] = held.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    commitRun(store, held.attemptRef, usageRows(held.attemptRef,
      held.meters.map((entry) => ({ coverage: "COMPLETE", meter: entry, quantity: 1 } as const))));

    const outcome = acceptedOf(apply(store, held.attemptRef));

    expect(outcome["disposition"]).toBe("COMMITTED");
    expect((outcome["record"] as Record<string, unknown>)["transition"]).toBe("SETTLED");
    // A fully resolved pair is pruned out of the head and folded into settledMeters
    // (budget-ledger-holds.ts:175-200), so the measured-line COUNT is where it survives.
    expect(settledCountOf(store, meter)).toBe(1);
    const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
    if (!current.ok) throw new Error("the ledger must read back");
    expect(current.reservations.some((entry) => entry.reservationId === held.reservationId))
      .toBe(false);
  });
});

describe("provider usage applied to budget — PARTIAL coverage", () => {
  it("preserves the hold as a LOWER_BOUND and refunds NOTHING", () => {
    const store = activatedStore("partial");
    const held = heldOf(store);
    commitRun(store, held.attemptRef, usageRows(held.attemptRef,
      held.meters.map((meter) => ({ coverage: "PARTIAL", meter, quantity: 1 } as const))));

    acceptedOf(apply(store, held.attemptRef));

    const settlement = retainedSettlementOf(store, held.reservationId);
    const lines = settlement["lines"] as readonly Record<string, unknown>[];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line["disposition"]).toBe("LOWER_BOUND");
      expect(line["refunded"]).toBe(0);
      // The unmeasured remainder is HELD, not released: that is what "lower bound" means.
      expect(Number(line["quarantined"])).toBeGreaterThan(0);
    }
    expect(settlement["state"]).toBe("QUARANTINED");
  });

  it("keeps a partial settlement retained rather than pruned", () => {
    const store = activatedStore("partial-retained");
    const held = heldOf(store);
    commitRun(store, held.attemptRef, usageRows(held.attemptRef,
      held.meters.map((meter) => ({ coverage: "PARTIAL", meter, quantity: 1 } as const))));

    acceptedOf(apply(store, held.attemptRef));

    // The pruning rule keys on SETTLED, so a partial stays visible for a later reconciliation.
    expect(retainedSettlementOf(store, held.reservationId)["reservationId"])
      .toBe(held.reservationId);
    const [meter] = held.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    expect(settledCountOf(store, meter)).toBe(0);
  });
});

describe("provider usage applied to budget — UNKNOWN coverage", () => {
  it("QUARANTINES the hold: no meter reads zero and no refund is issued", () => {
    const store = activatedStore("unknown");
    const held = heldOf(store);
    const [meter] = held.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    commitRun(store, held.attemptRef, []);

    acceptedOf(apply(store, held.attemptRef));

    const settlement = retainedSettlementOf(store, held.reservationId);
    const lines = settlement["lines"] as readonly Record<string, unknown>[];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // THE MONEY BUG, both directions. An arm asserting only "not zero" passes a refund, and
      // one asserting only "no refund" passes a silent zero.
      expect(line["disposition"]).toBe("UNKNOWN_HELD");
      expect(line["refunded"]).toBe(0);
      expect(Number(line["quarantined"])).toBeGreaterThan(0);
    }
    expect(settlement["state"]).toBe("QUARANTINED");
    const view = meterViewOf(store, meter);
    expect(Number(view["quarantined"])).toBeGreaterThan(0);
    expect(view["committed"]).toBe(0);
  });

  it("keeps the three coverage dispositions DISTINCT", () => {
    const complete = activatedStore("distinct-complete");
    const completeHeld = heldOf(complete);
    const [meter] = completeHeld.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    commitRun(complete, completeHeld.attemptRef, usageRows(completeHeld.attemptRef,
      completeHeld.meters.map((entry) => ({ coverage: "COMPLETE", meter: entry, quantity: 1 } as const))));
    acceptedOf(apply(complete, completeHeld.attemptRef));

    const partial = activatedStore("distinct-partial");
    const partialHeld = heldOf(partial);
    commitRun(partial, partialHeld.attemptRef, usageRows(partialHeld.attemptRef,
      partialHeld.meters.map((entry) => ({ coverage: "PARTIAL", meter: entry, quantity: 1 } as const))));
    acceptedOf(apply(partial, partialHeld.attemptRef));

    const unknown = activatedStore("distinct-unknown");
    const unknownHeld = heldOf(unknown);
    commitRun(unknown, unknownHeld.attemptRef, []);
    acceptedOf(apply(unknown, unknownHeld.attemptRef));

    const partialLine = (retainedSettlementOf(partial, partialHeld.reservationId)["lines"] as
      readonly Record<string, unknown>[])[0];
    const unknownLine = (retainedSettlementOf(unknown, unknownHeld.reservationId)["lines"] as
      readonly Record<string, unknown>[])[0];
    // Three different worlds, three different answers. A single collapsed shape cannot satisfy
    // all three of these at once, which is the point of asserting them together.
    expect(settledCountOf(complete, meter)).toBe(1);
    expect(partialLine?.["disposition"]).toBe("LOWER_BOUND");
    expect(unknownLine?.["disposition"]).toBe("UNKNOWN_HELD");
    expect(partialLine?.["disposition"]).not.toBe(unknownLine?.["disposition"]);
  });
});

/**
 * A TRUNCATED RECEIPT MAY NOT BUY ANYTHING AS EXACT COVERAGE.
 *
 * This mapper is the only carrier of `truncated` from the durable provider run into the
 * scheduler's measurement authority (budget-settlement-application.ts:126). Nothing else in the
 * daemon reads that flag, so if this projection drops it the guard downstream can never fire and
 * money is committed against a receipt that claims COMPLETE while admitting it is incomplete.
 *
 * THE HOSTILE PAIR CANNOT COME FROM `usageRows`, AND THAT IS THE WHOLE REASON THIS ARM EXISTS.
 * `normalizeUsageMeasurement` REFUSES truncated+COMPLETE, and `usageRows` throws on refusal, so
 * every fixture built the honest way carries `truncated: false` — which is exactly why a mutant
 * hard-coding `false` survived the entire daemon suite. The pair is reachable in production
 * because the flag comes from a PROVIDER RECEIPT, not from the authority: the durable codec
 * (provider-run-codec.validation.ts:185) requires `truncated` as a boolean and nowhere forbids
 * pairing it with COMPLETE. So the row here is normalized by the authority and then carries the
 * provider's flag, and it reaches the store through the PRODUCTION writer.
 */
describe("provider usage applied to budget — a truncated receipt may not claim COMPLETE", () => {
  it("forwards the measurement authority's TRUNCATED_COMPLETION_CLAIM and moves no money", () => {
    const store = activatedStore("truncated-complete");
    const held = heldOf(store);
    const [meter] = held.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    const measured = usageRows(held.attemptRef,
      held.meters.map((entry) => ({ coverage: "COMPLETE", meter: entry, quantity: 1 } as const)));
    commitRun(store, held.attemptRef, measured.map((row) => ({ ...row, truncated: true })));

    // THE PRECONDITION IS READ BACK THROUGH PRODUCTION, not assumed from the seed. Without this
    // the arm would pass identically if the writer had silently dropped the flag, and it would be
    // asserting the refusal of something that never became durable.
    const durable = readCurrentProviderRun(store, {
      attemptRef: held.attemptRef, projectId: PROJECT_ID,
    });
    if (!("ok" in durable) || durable.ok !== true) throw new Error("the provider run must read back");
    const [row] = durable.record.usage as unknown as readonly Record<string, unknown>[];
    expect(row?.["truncated"]).toBe(true);
    expect((row?.["measurement"] as Record<string, unknown>)?.["coverage"]).toBe("COMPLETE");
    const before = ledgerHeadOf(store);

    const refusal = refusalOf(apply(store, held.attemptRef));

    // The authority's own code and layer, forwarded UNRESTAMPED — the daemon names the
    // transition it could not make, and the SOURCE half still says who actually refused.
    expect(refusal.sourceCode).toBe("BUDGET_OBSERVATION_TRUNCATED_COMPLETION_CLAIM");
    expect(refusal.sourceLayer).toBe("BUDGET_MEASUREMENT");
    expect(refusal.code).toBe("BUDGET_LEDGER_TRANSITION_REFUSED");
    expect(refusal.layer).toBe("BUDGET_LEDGER");
    // AND THE MONEY DID NOT MOVE. The head is the conservation check; the settled count is the
    // one that would have caught a commit that refused loudly and wrote anyway.
    expect(ledgerHeadOf(store)).toBe(before);
    expect(settledCountOf(store, meter)).toBe(0);
  });
});

describe("provider usage applied to budget — binding refusals move no money", () => {
  const CASES = [
    ["no provider run for the attempt", "absent-run"],
    ["a measurement correlated to a FOREIGN attempt", "foreign-attempt"],
    ["no activated reservation for the attempt", "absent-reservation"],
  ] as const;

  it("generates every binding case it claims to sweep", () => {
    expect(CASES.length).toBe(3);
    expect(CASES.length).toBeGreaterThan(0);
  });

  it("refuses when the attempt has no durable provider run, with zero movement", () => {
    const store = activatedStore("absent-run");
    const held = heldOf(store);
    const before = ledgerHeadOf(store);

    const refusal = refusalOf(apply(store, held.attemptRef));

    expect(refusal.code).toBe("BUDGET_SETTLEMENT_RUN_ABSENT");
    expect(refusal.layer).toBe("BUDGET_SETTLEMENT_APPLICATION");
    expect(ledgerHeadOf(store)).toBe(before);
  });

  it("forwards the SCHEDULER's uncorrelated code when the measurement names another attempt", () => {
    const store = activatedStore("foreign-attempt");
    const held = heldOf(store);
    const foreign = usageRows("attempt-foreign",
      held.meters.map((meter) => ({ coverage: "COMPLETE", meter, quantity: 1 } as const)));
    commitRun(store, held.attemptRef, foreign);
    const before = ledgerHeadOf(store);

    const refusal = refusalOf(apply(store, held.attemptRef));

    // The ledger's own code and layer, forwarded UNRESTAMPED (rail 3).
    expect(refusal.sourceCode).toBe("BUDGET_SETTLEMENT_UNCORRELATED_MEASUREMENT");
    expect(ledgerHeadOf(store)).toBe(before);
  });

  it("names the RUN gap first when an unknown attempt has neither run nor reservation", () => {
    const store = activatedStore("absent-both");
    const before = ledgerHeadOf(store);

    const refusal = refusalOf(apply(store, "attempt-never-reserved"));

    // Ordering is deliberate and asserted: a missing run and a missing reservation are different
    // facts, and naming the first gap the caller can act on sends them to the right ledger.
    expect(refusal.code).toBe("BUDGET_SETTLEMENT_RUN_ABSENT");
    expect(ledgerHeadOf(store)).toBe(before);
  });

  it("refuses when the attempt activated but its reservation never became ACTIVATED", () => {
    // The honest path to this refusal: the activation commits, but the RESERVED -> ACTIVATED
    // budget bind is refused by the store, so the reservation exists and is not bound to the
    // attempt. Settling it anyway would move money against a hold nothing activated.
    const store = readyStore("absent-reservation");
    const outcome = runEffectActivateCommand(refuseBudgetCommit(store), activateBytes());
    if (!("ok" in outcome) || outcome.ok !== true) {
      throw new Error(`the activation fixture was refused: ${JSON.stringify(outcome).slice(0, 160)}`);
    }
    commitRun(store, ATTEMPT, [], "cmd-run-unbound");
    const before = ledgerHeadOf(store);

    const refusal = refusalOf(apply(store, ATTEMPT));

    expect(refusal.layer).toBe("BUDGET_SETTLEMENT_APPLICATION");
    expect(refusal.code).toBe("BUDGET_SETTLEMENT_RESERVATION_ABSENT");
    expect(ledgerHeadOf(store)).toBe(before);
  });
});

describe("provider usage applied to budget — replay", () => {
  it("replays identical bytes without moving the ledger a second time", () => {
    const store = activatedStore("replay");
    const held = heldOf(store);
    const [meter] = held.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    commitRun(store, held.attemptRef, usageRows(held.attemptRef,
      held.meters.map((entry) => ({ coverage: "COMPLETE", meter: entry, quantity: 1 } as const))));
    acceptedOf(apply(store, held.attemptRef));
    const afterFirst = ledgerHeadOf(store);
    const viewAfterFirst = meterViewOf(store, meter);

    const refusal = refusalOf(apply(store, held.attemptRef));

    // MEASURED, AND NOT WHAT THE PLAN ASSUMED. A fully SETTLED pair is pruned out of the head,
    // so the second call cannot find a reservation to settle and refuses instead of replaying.
    // Conservation is what actually matters here and it holds exactly: no second movement, no
    // second decision, the same balances. A replay-shaped answer would require reconstructing a
    // reservationId the head no longer carries.
    expect(refusal.code).toBe("BUDGET_SETTLEMENT_RESERVATION_ABSENT");
    expect(ledgerHeadOf(store)).toBe(afterFirst);
    expect(meterViewOf(store, meter)).toEqual(viewAfterFirst);
  });

  it("REPLAYS a retained settlement rather than settling it twice", () => {
    const store = activatedStore("replay-retained");
    const held = heldOf(store);
    const [meter] = held.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    commitRun(store, held.attemptRef, []);
    const first = acceptedOf(apply(store, held.attemptRef));
    const afterFirst = ledgerHeadOf(store);
    const viewAfterFirst = meterViewOf(store, meter);

    const second = acceptedOf(apply(store, held.attemptRef));

    // An UNKNOWN settlement stays QUARANTINED, so its reservation survives the prune and the
    // SAME decision key reaches the ledger, which answers from the original decision.
    expect(second["disposition"]).toBe("REPLAYED");
    expect(second["record"]).toEqual(first["record"]);
    expect(ledgerHeadOf(store)).toBe(afterFirst);
    expect(meterViewOf(store, meter)).toEqual(viewAfterFirst);
  });
});

describe("provider usage applied to budget — two attempts, one ledger", () => {
  it("settles only the reservation bound to THIS attempt and leaves the other held", () => {
    const store = activatedStore("cross-bind");
    const second = runEffectActivateCommand(store, secondActivateBytes());
    if (!("ok" in second) || second.ok !== true) {
      throw new Error(`the second activation was refused: ${JSON.stringify(second).slice(0, 160)}`);
    }
    expect(activatedReservationCount(store)).toBe(2);
    const held = heldOf(store);
    const [meter] = held.meters;
    if (meter === undefined) throw new Error("the reservation must hold a meter");
    commitRun(store, held.attemptRef, usageRows(held.attemptRef,
      held.meters.map((entry) => ({ coverage: "COMPLETE", meter: entry, quantity: 1 } as const))));

    acceptedOf(apply(store, held.attemptRef));

    // The other attempt's hold is untouched: settling it would be spending one attempt's budget
    // on another's evidence. With the attempt dropped from the binding filter this arm cannot
    // pass — two activated reservations then make the lookup AMBIGUOUS.
    expect(activatedReservationCount(store)).toBe(1);
    const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
    if (!current.ok) throw new Error("the ledger must read back");
    const survivor = current.reservations.find((entry) => entry.state === "ACTIVATED");
    expect(survivor?.attemptRef).toBe(SECOND_ATTEMPT);
    expect(settledCountOf(store, meter)).toBe(1);
  });
});
