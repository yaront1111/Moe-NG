import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { RECOVERY_INVENTORY_LAYER } from "../recovery/recovery-inventory-contract.js";
import { runRestoreQuiesce } from "../recovery/restore-controller.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  anchoredIncarnation,
  cleanupRestoreHarnesses,
  openHarnessStore,
  projectLifecycle,
  restoreHarness,
  restoreRequest,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";
import { WORK_CLAIM_SCHEMA_VERSION } from "../work/work-claim-contracts.js";
import { runWorkClaimCommand } from "../work/work-claim-services.js";
import { deriveActivationAggregateId } from "./activation-ledger-contracts.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import type { ActivationIngressOutcome } from "./activation-ingress-contracts.js";
import { runEffectActivateCommand } from "./activation-ingress.js";

/**
 * `effect.activate` end to end through PRODUCTION code: the four-leg claim
 * kernel, the supervisor arm and activation, the scheduler's sole
 * RESERVED -> ACTIVE slot transition, the budget activation, and one atomic
 * durable commit — fenced by the persisted recovery embargo.
 *
 * NOTHING HERE HAND-FORGES A GRANT. `parseActivationGrant` demands a hex64
 * grantId equal to `deriveGrantId(intentId, canonicalDigest(...))` and
 * `canonicalDigest` is not exported, so a coherent activation record can only
 * come out of the production chain (mem:gotcha-coherent-activation-fixture-needs-activateeffect).
 * `activation-ledger-fixtures.ts` is deliberately NOT reused: its
 * `GRANT_ID "grant-0001"` is codec-legal and parser-illegal.
 *
 * ACTIVATION_LEDGER_GRANT_ID_CONFLICT is NOT reachable from this ingress and is
 * therefore not asserted here. The grant id derives from the whole successor
 * intent, and the ledger aggregate derives from that same intent's
 * `aggregateId`/`idempotencyKey`, so two DIFFERENT aggregates can never carry
 * one grant id. The code is covered where it is reachable — against a
 * hand-built record in `activation-ledger-commit.test.ts` — and inventing an
 * unreachable path for it here would assert only that the fixture was forged.
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
  const root = mkdtempSync(join(tmpdir(), `moe-activate-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";

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

const BUDGET_VIEW = {
  accountId: "acct-1",
  meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
  state: "OPEN",
  version: 2,
} as const;

const ADMISSION = {
  admissionRef: "adm-1",
  amounts: [
    { meter: "usd", purpose: "EXECUTION", quantity: 10 },
    { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
    { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
    { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
    { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
  ],
  expectedVersion: 2,
} as const;

const GATE = { allowance: { decisionRef: "dec-1", outcome: "ALLOW" }, approval: null } as const;

/** PENDING v0. The chain bumps it: claim -> CLAIMED v1, arm -> ARMED v2, activate -> ACTIVE v3. */
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

/** Every field mirrors the intent it must agree with; `intent` is absent on purpose. */
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

/** The version the ARMED intent carries when `activateEffect` observes it. */
const PREDECESSOR_INTENT_VERSION = 2;
const PREDECESSOR_ATTEMPT_VERSION = 0;

function activationPayload(): Record<string, unknown> {
  return structuredClone({
    activation: ACTIVATION_SECTION,
    budget: { admission: ADMISSION, gate: GATE, view: BUDGET_VIEW },
    effect: { command: { kind: "claim" }, intent: EFFECT_INTENT },
    lease: { proof: LEASE_PROOF, record: LEASE_RECORD },
    liveClaims: [{ dimension: "default", slotRef: "held-0", state: "RESERVED" }],
    slot: { dimension: "default", requestId: "req-1", rows: [RESOURCE_ROW], slotRef: "slot-1" },
  });
}

interface RequestOverrides {
  readonly commandId?: string;
  readonly payload?: Record<string, unknown>;
}

function activateBytes(overrides: RequestOverrides = {}): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId: overrides.commandId ?? "cmd-activate-1",
    correlationId: "corr-activate",
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: overrides.payload ?? activationPayload(),
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

/** A well-formed envelope whose effect leg names a transition `work.claim` never causes. */
function domainBrokenPayload(): Record<string, unknown> {
  const payload = activationPayload();
  payload["effect"] = { command: { kind: "requestCancel" }, intent: EFFECT_INTENT };
  return payload;
}

function workClaimBytes(kind: string, commandId: string): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId,
    correlationId: "corr-work",
    decidedAt: DECIDED_AT,
    expectedVersion: 0,
    kind,
    payload: kind === "work.release"
      ? { workItemId: "item-1" }
      : { expiresAt: "2027-01-01T00:00:00.000Z", workItemId: "item-1" },
    principalId: PRINCIPAL_ID,
    projectId: PROJECT_ID,
    schemaVersion: WORK_CLAIM_SCHEMA_VERSION,
  }));
}

interface Counts {
  readonly decisions: number;
  readonly events: number;
}

/**
 * The zero-authority measure. Counting BOTH the ledger aggregate's events and
 * every committed decision for the project is what makes "no attempt, slot,
 * lease, effect, grant or spend row was created" a measurement rather than a
 * claim: this ingress writes all six inside one decision, so one unchanged pair
 * of counts covers all of them.
 */
function countsOf(store: SqliteEventStore): Counts {
  return {
    decisions: readDurableLedger(store, PROJECT_ID).decisionCount,
    events: store.readEvents(AGGREGATE_ID).length,
  };
}

function expectRefusal(
  outcome: ActivationIngressOutcome,
  code: string,
  refusedBy: string,
): void {
  expect(outcome).toMatchObject({ advisoryOnly: true, authority: "NONE", code, ok: false, refusedBy });
}

describe("effect.activate ingress — the accepted path", () => {
  it("commits attempt, slot, lease, effect, grant and spend authority together", () => {
    const store = readyStore("accepted");

    const outcome = runEffectActivateCommand(store, activateBytes());

    expect(outcome).toMatchObject({
      advisoryOnly: false,
      authority: "DURABLE_DECISION",
      disposition: "DECIDED",
      kind: EFFECT_ACTIVATE_COMMAND_KIND,
      ok: true,
    });
    const events = store.readEvents(AGGREGATE_ID);
    expect(events).toHaveLength(1);
    const durable = readActivationLedgerRecord(AGGREGATE_ID, events);
    expect(durable.ok).toBe(true);
    if (!durable.ok) throw new Error(`the durable record must read back: ${durable.code}`);
    const { record } = durable;
    expect(record.providerSlot).toMatchObject({ attemptRef: "attempt-1", state: "ACTIVE" });
    expect(record.budgetReservation).toMatchObject({
      attemptRef: "attempt-1",
      state: "ACTIVATED",
    });
    expect(record.effectIntent).toMatchObject({ intentId: "intent-1", state: "ACTIVE" });
    expect(record.attempt).toMatchObject({ attemptId: "attempt-1", state: "RUNNING" });
    expect(record.grant).toMatchObject({ intentId: "intent-1", state: "UNUSED" });
    expect(record.lease).toMatchObject({ leaseId: "lease-1", state: "ACTIVE" });
    // The budget view is `reserveForAdmission`'s own post-reservation view: 30
    // usd moved available -> reserved and the version advanced 2 -> 3.
    expect(record.budgetView).toMatchObject({ accountId: "acct-1", version: 3 });
    expect(record.predecessorIntentVersion).toBe(PREDECESSOR_INTENT_VERSION);
    expect(record.predecessorAttemptVersion).toBe(PREDECESSOR_ATTEMPT_VERSION);
    expect(record.effectIntent.version).toBe(record.predecessorIntentVersion + 1);
    expect(record.attempt.version).toBe(record.predecessorAttemptVersion + 1);
  });

  it("replays an identical command from the durable bytes, writing nothing new", () => {
    const store = readyStore("replay");

    const first = runEffectActivateCommand(store, activateBytes());
    const second = runEffectActivateCommand(store, activateBytes());

    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(second).toMatchObject({ disposition: "REPLAYED", ok: true });
    const events = store.readEvents(AGGREGATE_ID);
    expect(events).toHaveLength(1);
    const durable = readActivationLedgerRecord(AGGREGATE_ID, events);
    if (!durable.ok) throw new Error(`the durable record must read back: ${durable.code}`);
    expect(durable.record.grant.grantId).toBe(events[0]?.eventId);
  });

  it("accepts exactly one of two distinct commands on the same activation identity", () => {
    const store = readyStore("concurrent");

    const first = runEffectActivateCommand(store, activateBytes({ commandId: "cmd-a" }));
    const second = runEffectActivateCommand(store, activateBytes({ commandId: "cmd-b" }));

    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
    expectRefusal(second, "ACTIVATION_LEDGER_EXPECTED_VERSION_CONFLICT", "ACTIVATION_LEDGER");
    expect(store.readEvents(AGGREGATE_ID)).toHaveLength(1);
  });
});

describe("effect.activate ingress — the recovery embargo fences allocation", () => {
  it("creates zero attempt, slot, lease, effect, grant or spend authority when embargoed",
    async () => {
      const harness = await restoreHarness("activate-embargo");
      const binding = await anchoredIncarnation(harness, "restore-cmd-1");
      const quiesced = runRestoreQuiesce(harness.store, restoreRequest(harness, binding));
      expect(quiesced).toMatchObject({ disposition: "QUIESCED", ok: true });
      expect(projectLifecycle(harness.store)).toBe("QUIESCED");
      const before = countsOf(harness.store);

      const outcome = runEffectActivateCommand(harness.store, activateBytes());

      // ONE assertion over the code, the refusing layer AND both counts. Split
      // into three, the first failure would stop the case and the zero-authority
      // measurement would never run — a drill could then bypass the fence, commit
      // the whole activation, and this test would still only report the code.
      expect({
        after: countsOf(harness.store),
        code: outcome.ok ? "ACCEPTED" : outcome.code,
        refusedBy: outcome.ok ? "DURABLE_DECISION" : outcome.refusedBy,
      }).toEqual({
        after: { decisions: before.decisions, events: 0 },
        code: "RECOVERY_RECONCILIATION_REQUIRED",
        refusedBy: RECOVERY_INVENTORY_LAYER,
      });
      expect(before.events).toBe(0);
      if (outcome.ok) throw new Error("an embargoed activation must never be accepted");
      expect(outcome.embargo).toMatchObject({
        cause: "PROJECT_RECOVERY_REQUIRED",
        code: "RECOVERY_RECONCILIATION_REQUIRED",
        layer: RECOVERY_INVENTORY_LAYER,
        upstream: null,
      });
    });

  it("still lets an existing claim be released while the embargo holds", async () => {
    const harness = await restoreHarness("activate-drain");
    const claimed = runWorkClaimCommand(harness.store, workClaimBytes("work.claim", "cmd-claim"));
    expect(claimed).toMatchObject({ ok: true });
    const binding = await anchoredIncarnation(harness, "restore-cmd-1");
    expect(runRestoreQuiesce(harness.store, restoreRequest(harness, binding)))
      .toMatchObject({ ok: true });

    const released = runWorkClaimCommand(
      harness.store,
      workClaimBytes("work.release", "cmd-release"),
    );

    // Allocation is fenced; drain is not. The same store refuses the activation.
    expect(released).toMatchObject({ kind: "work.release", ok: true });
    expectRefusal(
      runEffectActivateCommand(harness.store, activateBytes()),
      "RECOVERY_RECONCILIATION_REQUIRED",
      RECOVERY_INVENTORY_LAYER,
    );
  });

  it("lets a structurally broken envelope refuse before the embargo is consulted",
    async () => {
      const harness = await restoreHarness("activate-structural");
      const binding = await anchoredIncarnation(harness, "restore-cmd-1");
      expect(runRestoreQuiesce(harness.store, restoreRequest(harness, binding)))
        .toMatchObject({ ok: true });
      const before = countsOf(harness.store);

      const outcome = runEffectActivateCommand(
        harness.store,
        encoder.encode(JSON.stringify({ kind: EFFECT_ACTIVATE_COMMAND_KIND })),
      );

      expectRefusal(outcome, "ACTIVATION_INGRESS_REQUEST_MALFORMED", "DAEMON_INGRESS");
      if (outcome.ok) throw new Error("a malformed envelope must never be accepted");
      expect(outcome.embargo).toBeNull();
      expect(countsOf(harness.store)).toEqual(before);
    });

  it("keeps the embargo code for a well-formed request whose domain payload is broken",
    async () => {
      const harness = await restoreHarness("activate-precedence");
      const binding = await anchoredIncarnation(harness, "restore-cmd-1");
      expect(runRestoreQuiesce(harness.store, restoreRequest(harness, binding)))
        .toMatchObject({ ok: true });
      const before = countsOf(harness.store);

      const outcome = runEffectActivateCommand(
        harness.store,
        activateBytes({ payload: domainBrokenPayload() }),
      );

      // NOT flattened into a generic code, and NOT the WORK_* code the same
      // payload earns once the fence lifts.
      expectRefusal(outcome, "RECOVERY_RECONCILIATION_REQUIRED", RECOVERY_INVENTORY_LAYER);
      expect(countsOf(harness.store)).toEqual(before);
    });

  it("returns the work kernel's own code for that same payload once unembargoed", () => {
    const store = readyStore("domain-broken");
    const before = countsOf(store);

    const outcome = runEffectActivateCommand(
      store,
      activateBytes({ payload: domainBrokenPayload() }),
    );

    expectRefusal(outcome, "WORK_INTENT_COMMAND_MISMATCH", "AUTHORITY");
    if (outcome.ok) throw new Error("a domain-broken payload must never be accepted");
    expect(outcome.embargo).toBeNull();
    expect(countsOf(store)).toEqual(before);
  });

  it("refuses an activation section carrying a smuggled server-derived key", () => {
    const store = readyStore("smuggled-intent");
    const payload = activationPayload();
    payload["activation"] = { ...ACTIVATION_SECTION, intent: EFFECT_INTENT };
    const before = countsOf(store);

    const outcome = runEffectActivateCommand(store, activateBytes({ payload }));

    expectRefusal(outcome, "ACTIVATION_INGRESS_PAYLOAD_MALFORMED", "DAEMON_INGRESS");
    expect(countsOf(store)).toEqual(before);
  });
});
