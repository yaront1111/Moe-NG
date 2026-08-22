import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeProviderRunRef } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { GOAL_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import { BUDGET_LEDGER_COMMAND_KIND } from "../budget/budget-ledger-contracts.js";
import { activateBudgetReservation, settleBudgetReservation } from "../budget/budget-ledger-holds.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  ACTIVATION_LEDGER_COMMAND_KIND,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import { runEffectActivateCommand } from "./activation-ingress.js";

/**
 * THE RESERVED -> ACTIVATED BUDGET BINDING, driven through PRODUCTION `effect.activate`.
 *
 * Filed as task-03049148 on a measured gap: `reserveForAdmission` mints RESERVED with
 * `attemptRef: null`, `activateBudgetReservation` was the ONLY writer of ACTIVATED and had
 * ZERO production callers, and `settleReservation` refuses `BUDGET_SETTLEMENT_NOT_ACTIVATED`
 * while `state !== "ACTIVATED" || !isRef(attemptRef)` — so settlement could never run.
 *
 * NOTHING HERE SEEDS LEDGER STATE. `budget-transition-fixtures.ts` can hand a suite an already
 * ACTIVATED hold in one call; using it would prove only that the fixture can construct the
 * state this row is supposed to make production reach. Every reservation below is minted by
 * `runEffectActivateCommand` and read back out of the durable aggregate.
 *
 * THE EXPECTED OPERANDS ARE PRODUCTION'S OWN OUTPUT. The attempt ref is read from the committed
 * activation record, the meters from the reservation the ledger wrote, the account from the
 * durable binding. A literal on either side of one of these assertions would agree with itself
 * no matter what the binding actually bound.
 */

const encoder = new TextEncoder();
const scratchRoots: string[] = [];

afterEach(cleanupRestoreHarnesses);
afterAll(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) rmSync(root, { force: true, maxRetries: 5, recursive: true });
  }
});

/** Opened inside a case, never in a describe body: a held handle kills the worker. */
function readyStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-bind-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const COMMAND_ID = "cmd-activate-1";
const ADMISSION_REF = `activation:${COMMAND_ID}`;

const LEASE_RECORD = {
  authorityHashRef: DIGEST,
  bootId: "boot-1",
  epoch: 3,
  kind: "ASSIGNMENT",
  leaseId: "lease-1",
  leaseToken: "token-1",
  monotonicObservation: 500,
  ownerSessionRef: "session-1",
  serverWallDeadline: 1_000,
  state: "ACTIVE",
  version: 7,
} as const;

const LEASE_PROOF = {
  authorityHashRef: DIGEST,
  epoch: 3,
  expectedVersion: 7,
  leaseToken: "token-1",
  ownerSessionRef: "session-1",
} as const;

const RESOURCE_ROW = {
  capacityUnits: 1,
  effectIntentRef: "intent-ref-1",
  epoch: 1,
  external: false,
  fenceable: true,
  resourceId: "res-1",
  state: "ACTIVE",
} as const;

const EFFECT_INTENT = {
  aggregateId: "agg-1",
  desiredState: "ACTIVE",
  expectedGraphEpoch: 4,
  idempotencyKey: "idem-1",
  inputBinding: DIGEST,
  intentId: "intent-1",
  leaseBinding: LEASE_RECORD,
  predecessorCursor: "cursor-1",
  protocolVersion: "moe-effect-intent/1",
  runtimeObservationDigest: DIGEST,
  state: "PENDING",
  version: 0,
} as const;

const ACTIVATION_SECTION = {
  attempt: {
    aggregateId: "agg-1",
    attemptId: "attempt-1",
    intentId: "intent-1",
    state: "LAUNCH_REQUESTED",
    version: 0,
  },
  claim: {
    claimId: "claim-1",
    claimedAt: DECIDED_AT,
    intentId: "intent-1",
    lockIdentity: "lock-1",
    wrapperIdentity: "wrapper-1",
  },
  dependencyWitnesses: [],
  desiredState: "ACTIVE",
  leaseProof: LEASE_PROOF,
  lockIdentity: "lock-1",
  observedGraphEpoch: 4,
  observedRuntimeDigest: DIGEST,
  tombstone: null,
  wrapperIdentity: "wrapper-1",
} as const;

const AGGREGATE_ID = deriveActivationAggregateId(
  EFFECT_INTENT.aggregateId,
  EFFECT_INTENT.idempotencyKey,
);

function activationPayload(): Record<string, unknown> {
  return structuredClone({
    activation: ACTIVATION_SECTION,
    effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
    lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
    liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
    slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
  });
}

function activateBytes(commandId: string = COMMAND_ID): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId,
    correlationId: "corr-activate",
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: activationPayload(),
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

interface Ledger {
  readonly aggregateId: string;
  readonly accountId: string;
  readonly headVersion: number;
  readonly reservation: {
    readonly attemptRef: string | null;
    readonly lines: readonly { readonly meter: string; readonly quantity: number }[];
    readonly reservationId: string;
    readonly state: string;
    readonly version: number;
  };
}

/** The DURABLE budget head, read through the committed projection — never a suite-built view. */
function ledgerOf(store: SqliteEventStore): Ledger {
  const current = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!current.ok) throw new Error(`the durable ledger must read back: ${current.code}`);
  const reservation = current.reservations.find(
    (entry) => entry.admissionRef === ADMISSION_REF,
  );
  if (reservation === undefined) {
    throw new Error(`the activation's own reservation must exist for ${ADMISSION_REF}`);
  }
  return {
    accountId: current.binding.budgetAccountRef,
    aggregateId: current.aggregateId,
    headVersion: current.headVersion,
    reservation,
  };
}

/** The attempt id the ACTIVATION committed, read from the durable record rather than chosen. */
function committedAttemptRef(store: SqliteEventStore): string {
  const durable = readActivationLedgerRecord(AGGREGATE_ID, store.readEvents(AGGREGATE_ID));
  if (!durable.ok) throw new Error(`the activation record must read back: ${durable.code}`);
  return durable.record.attempt.attemptId;
}

/**
 * One usage envelope per meter the reservation actually holds, correlated to the bound ref.
 *
 * `run` is `providerRunRef`, and settlement compares it against `record.attemptRef` — see the
 * DISCLOSED CORRELATION FINDING below for what production's real composite does to this.
 */
function observationsFor(reservation: Ledger["reservation"], runRef: string): readonly unknown[] {
  const meters = [...new Set(reservation.lines.map((line) => line.meter))];
  return meters.map((meter, index) => ({
    measurement: {
      coverage: "COMPLETE",
      meter,
      observedInterval: { endRef: "interval-end-1", startRef: "interval-start-1" },
      providerRunRef: runRef,
      quantity: 1,
      rawReceiptDigest: "ab".repeat(32),
      sequence: index,
      source: "PROVIDER_REPORTED_COMPLETE",
      sourceParserVersion: 1,
    },
    pricebookBinding: null,
    truncated: false,
  }));
}

function settle(
  store: SqliteEventStore, reservation: Ledger["reservation"], runRef: string,
): ReturnType<typeof settleBudgetReservation> {
  return settleBudgetReservation(store, {
    context: {
      commandId: "cmd-settle-1",
      correlationId: "corr-settle",
      decidedAt: DECIDED_AT,
      principalId: PRINCIPAL_ID,
    },
    goalRef: GOAL_ID,
    observations: observationsFor(reservation, runRef),
    projectId: PROJECT_ID,
    reservationId: reservation.reservationId,
  });
}

/**
 * The REAL store with ONE seam widened: the binding's own single-leg budget commit throws.
 *
 * The activation's RESERVE leg does NOT go through here — `captureBudgetLeg` injects its own
 * port and the reservation rides the activation's legs commit — so this fault reaches the
 * binding and nothing else. Not a fake: every other method executes on the real store.
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

/**
 * The REAL store, with `readEvents` made to throw only AFTER the activation's legs commit.
 *
 * The bind's read preamble (`readBudgetBinding` / `readCurrentBudgetLedger`) calls `readEvents`
 * UNCAUGHT, so this is the one seam where a store fault could escape a durably committed
 * activation. Arming it after the commit is what makes the fault reach the bind and nothing
 * above it.
 */
function throwAfterCommit(store: SqliteEventStore): SqliteEventStore {
  let armed = false;
  return new Proxy(store, {
    get(target, property): unknown {
      const held: unknown = Reflect.get(target, property, target);
      if (typeof held !== "function") return held;
      const method = held as (...args: unknown[]) => unknown;
      if (property === "commitExpectedVersionDecisionLegs") {
        return (...args: unknown[]): unknown => {
          const answer = method.apply(target, args);
          armed = true;
          return answer;
        };
      }
      if (property !== "readEvents") return method.bind(target);
      return (...args: unknown[]): unknown => {
        if (armed) throw new Error("the store is unreadable after the activation committed");
        return method.apply(target, args);
      };
    },
  });
}

const decisionKey = (commandId: string): { commandId: string; principalId: string; projectId: string } =>
  ({ commandId, principalId: PRINCIPAL_ID, projectId: PROJECT_ID });

/**
 * RETIRED MIRROR, REPLACED BY THE PRODUCTION ENCODER (task-763c24cf). This helper used to
 * reproduce `runRefOf`'s format by hand because production did not export it. That format is now
 * a published contract — `encodeProviderRunRef` in `@moe/scheduler` — which the runner encodes
 * through and the settlement reducer decodes through, so asserting against a hand-written mirror
 * would be exactly the "property asserted against a test helper that reimplements it" the project
 * rail forbids.
 */
const DISPATCH_REF = "dispatch-1";
const productionRunRef = (attemptRef: string): string =>
  encodeProviderRunRef({ attemptRef, epoch: 3, provider: "claude", runRef: DISPATCH_REF });

describe("effect.activate — the RESERVED -> ACTIVATED budget binding", () => {
  it("binds the attempt's OWN ref to the durable reservation and moves it to ACTIVATED", () => {
    const store = readyStore("bound");

    const outcome = runEffectActivateCommand(store, activateBytes());
    expect(outcome).toMatchObject({ disposition: "DECIDED", ok: true });

    // The expected operand is the committed activation's attempt id, not "attempt-1": a literal
    // here would pass against a binding that wrote any ref it liked.
    const { reservation } = ledgerOf(store);
    expect(reservation.attemptRef).toBe(committedAttemptRef(store));
    expect(reservation.state).toBe("ACTIVATED");
  });

  it("unblocks settlement: the bound reservation no longer refuses BUDGET_SETTLEMENT_NOT_ACTIVATED", () => {
    const store = readyStore("settles");
    runEffectActivateCommand(store, activateBytes());

    const { reservation } = ledgerOf(store);
    // The reading carries the PRODUCTION composite (task-763c24cf); a bare attempt id is not a
    // shape any real measurement has, and since that row it fails the correlation gate closed.
    const settled = settle(store, reservation, productionRunRef(committedAttemptRef(store)));

    // ASSERT THE POSITIVE. "does not refuse NOT_ACTIVATED" is free against a call that refused
    // for some other reason, so the arm pins the accept itself.
    expect(settled.ok).toBe(true);
  });

  it("CONTROL — a reservation the binding never reached still refuses NOT_ACTIVATED, at the scheduler", () => {
    const store = readyStore("control");
    // The activation commits; only the BINDING's budget decision is refused, so this is the
    // exact pre-row world: a live attempt whose reservation is still RESERVED.
    const outcome = runEffectActivateCommand(refuseBudgetCommit(store), activateBytes());
    expect(outcome).toMatchObject({ ok: true });

    const { reservation } = ledgerOf(store);
    expect(reservation.state).toBe("RESERVED");
    expect(reservation.attemptRef).toBeNull();

    const settled = settle(store, reservation, committedAttemptRef(store));
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error("unreachable: the control asserted a refusal");
    expect(settled.code).toBe("BUDGET_LEDGER_TRANSITION_REFUSED");
    expect(settled.sourceCode).toBe("BUDGET_SETTLEMENT_NOT_ACTIVATED");
    // WHICH LAYER ANSWERED: the scheduler's settlement, forwarded by the daemon's ledger
    // unrestamped. A daemon-side code here would mean the daemon had started deciding this.
    expect(settled.sourceLayer).toBe("BUDGET_SETTLEMENT");
  });

  it("commits its OWN suffixed budget.transition decision, leaving the activation's identity intact", () => {
    const store = readyStore("identity");
    runEffectActivateCommand(store, activateBytes());

    // The activation's own decision still answers under the UNSUFFIXED key: the binding
    // borrowed no identity from it.
    const activation = store.getCommandDecision(decisionKey(COMMAND_ID));
    expect(activation?.commandKind).toBe(ACTIVATION_LEDGER_COMMAND_KIND);

    // And the binding's decision exists under the suffixed key with the LEDGER's own kind.
    // Reusing the activation's commandId would meet answerBudgetReplay's foreign-kind rule
    // (budget-ledger-commit.ts:137) and refuse BUDGET_LEDGER_IDEMPOTENCY_CONFLICT.
    const binding = store.getCommandDecision(decisionKey(`${COMMAND_ID}:BUDGET_ACTIVATE`));
    expect(binding?.commandKind).toBe(BUDGET_LEDGER_COMMAND_KIND);
  });

  it("a THROWN store fault does not escape a committed activation", () => {
    const store = readyStore("throws");

    // The activation commits, then the bind's read preamble throws. The ingress must still
    // answer for the decision it durably made — a thrown error here would report a committed
    // activation as a crash, and would skip the resource bind that runs after this one.
    const outcome = runEffectActivateCommand(throwAfterCommit(store), activateBytes());
    expect(outcome).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(store.readEvents(AGGREGATE_ID)).toHaveLength(1);

    // Fail-closed, same observable as any other refused bind.
    const { reservation } = ledgerOf(store);
    expect(reservation.state).toBe("RESERVED");
    expect(reservation.attemptRef).toBeNull();
  });

  it("THE SUFFIX IS MANDATORY: the activation's own commandId is already burned under a foreign kind", () => {
    const store = readyStore("suffix");
    runEffectActivateCommand(store, activateBytes());
    const { reservation } = ledgerOf(store);

    // The same transition the binding performs, keyed on the UNSUFFIXED commandId — the key the
    // activation itself already decided under "activation.commit". answerBudgetReplay refuses a
    // prior decision carrying a foreign commandKind, so without the suffix this transition is
    // permanently unreachable rather than merely untidy.
    const collided = activateBudgetReservation(store, {
      attemptRef: committedAttemptRef(store),
      context: {
        commandId: COMMAND_ID,
        correlationId: "corr-activate",
        decidedAt: DECIDED_AT,
        principalId: PRINCIPAL_ID,
      },
      goalRef: GOAL_ID,
      projectId: PROJECT_ID,
      reservationId: reservation.reservationId,
    });
    expect(collided.ok).toBe(false);
    if (collided.ok) throw new Error("unreachable: the collision asserted a refusal");
    expect(collided.code).toBe("BUDGET_LEDGER_IDEMPOTENCY_CONFLICT");
  });

  it("is idempotent: replaying the activation writes no second budget event and does not re-version the hold", () => {
    const store = readyStore("replay");
    runEffectActivateCommand(store, activateBytes());
    const first = ledgerOf(store);

    const replayed = runEffectActivateCommand(store, activateBytes());
    expect(replayed).toMatchObject({ ok: true });

    const second = ledgerOf(store);
    expect(second.headVersion).toBe(first.headVersion);
    expect(second.reservation.version).toBe(first.reservation.version);
    expect(second.reservation.attemptRef).toBe(first.reservation.attemptRef);
  });

  it("fails closed: a refused binding leaves the ACTIVATION committed and the hold unbound", () => {
    const store = readyStore("failclosed");

    // The attempt is already durable when the binding runs, so reporting the activation as
    // refused would be a false claim about a committed decision.
    const outcome = runEffectActivateCommand(refuseBudgetCommit(store), activateBytes());
    expect(outcome).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(store.readEvents(AGGREGATE_ID)).toHaveLength(1);

    // The failure surfaces DOWNSTREAM as a refusal, never as a silent settle.
    const { reservation } = ledgerOf(store);
    expect(reservation.state).toBe("RESERVED");
    expect(reservation.attemptRef).toBeNull();
    expect(store.getCommandDecision(decisionKey(`${COMMAND_ID}:BUDGET_ACTIVATE`))).toBeNull();
  });

  it("RE-POINTED — a production-shaped providerRunRef now CORRELATES and settles", () => {
    const store = readyStore("uncorrelated");
    runEffectActivateCommand(store, activateBytes());

    const { reservation } = ledgerOf(store);
    const attemptRef = committedAttemptRef(store);
    const composite = productionRunRef(attemptRef);

    // THE SHAPES ARE STILL ASYMMETRIC — the reading carries a COMPOSITE, the reservation a BARE
    // attempt id — and that asymmetry is exactly what used to refuse. task-763c24cf made the
    // reducer decode the attempt segment instead of comparing whole strings, so the disclosure
    // this arm was written to record is now the ACCEPTED path. RE-POINTED rather than deleted:
    // the world is unchanged, only the expected outcome moved.
    expect(composite).toContain(`${attemptRef.length}:${attemptRef}`);
    expect(composite).not.toBe(attemptRef);

    expect(settle(store, reservation, composite).ok).toBe(true);
  });

  it("and a FOREIGN attempt inside a well-formed composite is still refused", () => {
    const store = readyStore("foreign-attempt");
    runEffectActivateCommand(store, activateBytes());

    const { reservation } = ledgerOf(store);
    // The anti-relaxation sibling: same production shape, same dispatch ref, different attempt.
    // A fix that made the gate pass for everything would satisfy the arm above and fail here.
    const settled = settle(store, reservation, productionRunRef("attempt-someone-else"));
    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error("unreachable: the foreign attempt asserted a refusal");
    expect(settled.sourceCode).toBe("BUDGET_SETTLEMENT_UNCORRELATED_MEASUREMENT");
    expect(settled.sourceLayer).toBe("BUDGET_SETTLEMENT");
  });

  it("RE-POINTED — the composite is what settles now, where only the bare ref used to", () => {
    const store = readyStore("correlated");
    runEffectActivateCommand(store, activateBytes());

    const { reservation } = ledgerOf(store);

    // Same reservation, same observation shape — only the run IDENTITY differs. Before
    // task-763c24cf the composite refused and only a bare ref settled; the composite is what
    // production actually emits, and it is now the shape that commits.
    expect(settle(store, reservation, productionRunRef(committedAttemptRef(store))).ok).toBe(true);
  });

  it("and the BARE attempt ref now fails closed AT THE CORRELATION GATE", () => {
    // A FRESH store, not the arm above's: two settles on one store cannot measure this. The
    // helper's commandId is fixed, so a second call replays into BUDGET_LEDGER_IDEMPOTENCY_CONFLICT
    // at the daemon's ledger; and even under a distinct commandId the reservation is SETTLED by
    // then, and NOT_ACTIVATED is decided BEFORE the correlation gate (budget-settlement.ts:163
    // precedes :165). Either way the gate this arm is about is never reached.
    const store = readyStore("bare-fails-closed");
    runEffectActivateCommand(store, activateBytes());

    const { reservation } = ledgerOf(store);
    const settled = settle(store, reservation, committedAttemptRef(store));

    expect(settled.ok).toBe(false);
    if (settled.ok) throw new Error("unreachable: the bare ref asserted a refusal");
    // WHICH LAYER ANSWERED, and on WHICH code: the scheduler's correlation gate, because the
    // decoder answers null for anything that is not a well-formed composite. A daemon-side code
    // here would mean some other layer refused first and the decoder was never consulted.
    expect(settled.code).toBe("BUDGET_LEDGER_TRANSITION_REFUSED");
    expect(settled.sourceCode).toBe("BUDGET_SETTLEMENT_UNCORRELATED_MEASUREMENT");
    expect(settled.sourceLayer).toBe("BUDGET_SETTLEMENT");
  });
});
