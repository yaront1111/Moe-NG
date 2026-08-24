import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReservationRecord } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { GOAL_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  ACTIVATION_INGRESS_LAYER,
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import { activationAdmissionRef } from "./activation-admission-identity.js";
import { deriveActivationAggregateId } from "./activation-ledger-contracts.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";
import { runEffectActivateCommand } from "./activation-ingress.js";

/**
 * DoD 2 of task-8be27625: the budget section the fence now TOLERATES is DEAD
 * INPUT — an activation carrying a hostile one commits the same durable hold as
 * the identical activation sent without it. The fence widening is asserted at its
 * own layer in `activation-ingress-contracts.test.ts`; this file is the reason
 * the widening is HARMLESS, driven through production `runEffectActivateCommand`.
 *
 * WHY A SEPARATE FILE RATHER THAN TWO CASES IN `activation-ingress.test.ts`,
 * where this payload fixture already exists: that file is being rewritten
 * concurrently by the task-03049148 seat, and an earlier version of these cases
 * was overwritten wholesale there. A deliverable cannot live in a file another
 * live session rewrites from a HEAD-based copy. The duplicated fixture is the
 * price of owning the evidence; if the two ever drift, THIS file is the one that
 * pins the tolerance, and the other pins the accepted path.
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
  const root = mkdtempSync(join(tmpdir(), `moe-dead-input-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const ADMISSION_REF = activationAdmissionRef(PROJECT_ID, PRINCIPAL_ID, "cmd-activate-1");

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

/** The ONE accepted shape since task-b8b69e74: five sections, no caller budget. */
function activationPayload(): Record<string, unknown> {
  return structuredClone({
    activation: ACTIVATION_SECTION,
    effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
    lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
    liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
    slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
  });
}

function activateBytes(payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: "cmd-activate-1",
    correlationId: "corr-activate",
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload,
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

describe("effect.activate ingress — the caller budget section is UNREPRESENTABLE", () => {
  /** Foreign account, foreign meter, inflated balance, a COMPLETE coverage claim
   *  and a forged ALLOW gate: every lever a caller could hope to pull. */
  const HOSTILE_BUDGET = {
    admission: {
      admissionRef: "adm-hostile",
      amounts: [{ meter: "eur", purpose: "EXECUTION", quantity: 1 }],
      expectedVersion: 99,
    },
    coverage: "COMPLETE",
    gate: { allowance: { decisionRef: "dec-hostile", outcome: "ALLOW" }, approval: null },
    view: {
      accountId: "acct-hostile",
      meters: [{ available: 999_999_999, committed: 0, meter: "eur", quarantined: 0, reserved: 0 }],
      state: "OPEN",
      version: 99,
    },
  } as const;

  interface CommittedBudget {
    /** The snapshot the ACTIVATION aggregate embedded when the legs committed. */
    readonly embedded: ReservationRecord;
    /** The same reservation as the BUDGET ledger's own head folds it. */
    readonly head: ReservationRecord | undefined;
  }

  /**
   * Drives ONE activation through production on its own seeded store and returns
   * the committed hold from BOTH durable views. Separate stores, same `commandId`:
   * `deriveReservationId(accountId, admissionRef)` is a pure derivation over the
   * durable account and the AUTHENTICATED command, so two independent worlds mint
   * the same identity and the comparison is a real one.
   */
  function committedBudget(label: string, payload: Record<string, unknown>): CommittedBudget {
    const store = readyStore(label);
    const outcome = runEffectActivateCommand(store, activateBytes(payload));
    expect(outcome).toMatchObject({ disposition: "DECIDED", ok: true });
    const durable = readActivationLedgerRecord(AGGREGATE_ID, store.readEvents(AGGREGATE_ID));
    if (!durable.ok) throw new Error(`the durable record must read back: ${durable.code}`);
    const ledger = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
    if (!ledger.ok) throw new Error(`the durable ledger must read back: ${ledger.code}`);
    const embedded = durable.record.budgetReservation;
    // BOTH VIEWS, because they need not carry the same bytes: the activation
    // aggregate embeds the hold as it stood when the legs committed, while the
    // budget ledger folds every transition on that aggregate — including a later
    // decision that binds an attempt to it (task-03049148). Asserting only one
    // would leave the other free to vary with the caller's section, which is the
    // whole property this file exists to deny.
    return {
      embedded,
      head: ledger.reservations.find((entry) => entry.reservationId === embedded.reservationId),
    };
  }

  it("REFUSES a hostile budget section outright, and writes nothing", () => {
    // WHAT THIS ARM USED TO SAY, and why it is re-pointed rather than deleted: while
    // task-8be27625's window was open, this file proved the tolerated section was DEAD
    // INPUT — the same hold committed with a hostile section as with none at all. Link 4
    // (task-b8b69e74) retires the key, so the stronger property replaces the weaker one:
    // the section cannot be SENT, and the refusal is the fence's pre-existing code and
    // layer rather than any new vocabulary.
    const store = readyStore("hostile-refused");
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const hostile = activationPayload();
    hostile["budget"] = structuredClone(HOSTILE_BUDGET);

    const outcome = runEffectActivateCommand(store, activateBytes(hostile));

    expect(outcome).toMatchObject({
      advisoryOnly: true,
      authority: "NONE",
      code: "ACTIVATION_INGRESS_REQUEST_MALFORMED",
      ok: false,
      refusedBy: ACTIVATION_INGRESS_LAYER,
    });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
    expect(store.readEvents(AGGREGATE_ID)).toHaveLength(0);
  });

  it("derives the hold from DURABLE authority for the one accepted shape", () => {
    // The positive half a refusal arm cannot carry: refusing the hostile section proves
    // nothing about what the accepted shape commits. Every lever the retired section used
    // to offer is named here as a NEGATIVE against the durable hold, so this cannot pass
    // by committing an empty or degenerate one.
    const committed = committedBudget("absent", activationPayload());

    expect(committed.embedded).toMatchObject({
      admissionRef: ADMISSION_REF, state: "RESERVED",
    });
    expect(committed.embedded.accountId).not.toBe(HOSTILE_BUDGET.view.accountId);
    expect(committed.embedded.admissionRef).not.toBe(HOSTILE_BUDGET.admission.admissionRef);
    expect(committed.embedded.lines.map((line) => line.meter)).not.toContain("eur");
    expect(committed.embedded.lines.length).toBeGreaterThan(0);
    // A `find` returning undefined would make the head half of this arm vacuous.
    expect(committed.head).toBeDefined();
  });

  it("keeps the fence's own refusal code and layer for every other cardinality", () => {
    // DoD 1's "refusing LAYER unchanged", asserted through PRODUCTION rather than
    // at the decoder: the decode result carries only a code, and the layer is
    // stamped at `activation-ingress.ts`'s refusal seam. A payload one section
    // SHORT of the accepted shape must refuse exactly as a payload one section
    // OVER it does — the arm above is the over case, this is the under case.
    const store = readyStore("fence-layer");
    // The seeded project has already committed its own decisions, so the
    // zero-authority measure is "unchanged", never "zero".
    const before = readDurableLedger(store, PROJECT_ID).decisionCount;
    const short = activationPayload();
    delete short["slot"];

    const outcome = runEffectActivateCommand(store, activateBytes(short));

    expect(outcome).toMatchObject({
      advisoryOnly: true,
      authority: "NONE",
      code: "ACTIVATION_INGRESS_REQUEST_MALFORMED",
      ok: false,
      refusedBy: ACTIVATION_INGRESS_LAYER,
    });
    expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
    expect(store.readEvents(AGGREGATE_ID)).toHaveLength(0);
  });
});
