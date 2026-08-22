import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NODE_ADMISSION_METERS } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { GOAL_ID } from "../bootstrap/bootstrap-test-fixtures.js";
import { readCurrentBudgetLedger } from "../budget/budget-current-projection.js";
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
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import { readActivationLedgerRecord } from "./activation-ledger-reader.js";
import { DAEMON_SLOT_OCCUPANCY } from "./activation-slot-occupancy.js";
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

function workClaimBytes(kind: string, commandId: string, expectedVersion = 0): Uint8Array {
  return encoder.encode(JSON.stringify({
    commandId,
    correlationId: "corr-work",
    decidedAt: DECIDED_AT,
    expectedVersion,
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

/** The durable budget aggregate this project's goal spends from, read rather than assumed. */
function budgetAggregateOf(store: SqliteEventStore): string {
  const ledger = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
  if (!ledger.ok) throw new Error(`the seeded ledger must read back: ${ledger.code}`);
  return ledger.aggregateId;
}

/**
 * The REAL store with one seam widened: `before` runs immediately before the legs commit.
 *
 * Not a fake — every method still executes on the real `SqliteEventStore`, and the injected
 * fault is an ordinary durable append. It is the only way to interleave a concurrent write at
 * the exact instant the captured fence is about to be read.
 */
function interceptLegsCommit(store: SqliteEventStore, before: () => void): SqliteEventStore {
  return new Proxy(store, {
    get(target, property): unknown {
      const held: unknown = Reflect.get(target, property, target);
      if (typeof held !== "function") return held;
      const method = held as (...args: unknown[]) => unknown;
      if (property !== "commitExpectedVersionDecisionLegs") return method.bind(target);
      return (...args: unknown[]): unknown => {
        before();
        return method.apply(target, args);
      };
    },
  });
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
    const before = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
    if (!before.ok) throw new Error(`the seeded ledger must read back: ${before.code}`);

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
    expect(record.effectIntent).toMatchObject({ intentId: "intent-1", state: "ACTIVE" });
    expect(record.attempt).toMatchObject({ attemptId: "attempt-1", state: "RUNNING" });
    expect(record.grant).toMatchObject({ intentId: "intent-1", state: "UNUSED" });
    expect(record.lease).toMatchObject({ leaseId: "lease-1", state: "ACTIVE" });

    // THE BUDGET IS DERIVED, NOT RECEIVED. This sender no longer carries a caller budget
    // section at all (task-671585ec, link 2 of the fence-narrowing chain), so every value
    // below comes from durable authority: the account is the goal's own `budgetAccountRef`,
    // the admission identity is the AUTHENTICATED commandId, and the meters are the node
    // definition's. That a HOSTILE section changes none of it is proven where the section is
    // still sent on purpose — `activation-ingress-dead-input.test.ts`, through production.
    const after = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
    if (!after.ok) throw new Error(`the durable ledger must read back: ${after.code}`);
    expect(record.budgetReservation).toMatchObject({
      accountId: after.binding.budgetAccountRef,
      admissionRef: "activation:cmd-activate-1",
      // RESERVED AT COMMIT TIME, and that is a snapshot rather than the end state. One legs
      // commit may name the budget aggregate EXACTLY once, so the unit-MOVING transition rides
      // it and the attempt binding lands in a SUBSEQUENT decision (task-03049148). This record
      // holds what `reserveForAdmission` returned, so it stays RESERVED forever; the LEDGER
      // head is what advances to ACTIVATED. Both are asserted below.
      attemptRef: null,
      state: "RESERVED",
    });
    // The account and admission identities are pinned POSITIVELY in the record above. The
    // meters had no positive counterpart — they were pinned only as "not the caller's `usd`",
    // an operand this sender no longer supplies — so they are re-pointed at the production
    // vocabulary the derivation draws from. `usd` is not a member, so the old claim survives.
    const durableMeters = record.budgetReservation.lines.map((line) => line.meter);
    expect(durableMeters.length).toBeGreaterThan(0);
    for (const meter of durableMeters) expect(NODE_ADMISSION_METERS).toContain(meter);

    // THE SNAPSHOT AND THE HEAD NOW DIVERGE, and the divergence is the point (task-03049148).
    // Until that row the record's reservation was byte-equal to the ledger head; the binding
    // decision that follows this commit moves the head to ACTIVATED and binds the attempt,
    // while this record keeps the RESERVED bytes it committed. Asserting equality again would
    // reject a correctly bound reservation.
    const head = after.reservations.find(
      (entry) => entry.admissionRef === "activation:cmd-activate-1");
    expect(head).toMatchObject({ attemptRef: record.attempt.attemptId, state: "ACTIVATED" });
    // ANTI-TAUTOLOGY: everything the binding does NOT touch is still the ledger module's own
    // committed output, read back out of the durable aggregate rather than hand-built here.
    expect(head).toMatchObject({
      accountId: record.budgetReservation.accountId,
      admissionRef: record.budgetReservation.admissionRef,
      lines: record.budgetReservation.lines,
      reservationId: record.budgetReservation.reservationId,
    });
    expect(record.budgetView).toStrictEqual(after.views.find(
      (entry) => entry.accountId === after.binding.budgetAccountRef));
    // BOTH aggregates moved in the activation decision (one activation event, one budget
    // event), and the binding decision appends ONE more budget event after it. A third
    // movement, or a missing binding, fails here.
    expect(after.headVersion).toBe(before.headVersion + 2);
    expect(record.predecessorIntentVersion).toBe(PREDECESSOR_INTENT_VERSION);
    expect(record.predecessorAttemptVersion).toBe(PREDECESSOR_ATTEMPT_VERSION);
    expect(record.effectIntent.version).toBe(record.predecessorIntentVersion + 1);
    expect(record.attempt.version).toBe(record.predecessorAttemptVersion + 1);
  });

  it("replays an identical command from the durable bytes, writing nothing new", () => {
    const store = readyStore("replay");

    const first = runEffectActivateCommand(store, activateBytes());
    const budget = budgetAggregateOf(store);
    const afterFirst = store.getAggregateVersion(budget);
    const second = runEffectActivateCommand(store, activateBytes());

    expect(first).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(second).toMatchObject({ disposition: "REPLAYED", ok: true });
    const events = store.readEvents(AGGREGATE_ID);
    expect(events).toHaveLength(1);
    const durable = readActivationLedgerRecord(AGGREGATE_ID, events);
    if (!durable.ok) throw new Error(`the durable record must read back: ${durable.code}`);
    expect(durable.record.grant.grantId).toBe(events[0]?.eventId);
    // RAW COUNTS ON BOTH AGGREGATES, unchanged. The refusal-free return value is not evidence
    // that nothing was written; a second reserve would move units again and show up here.
    expect(store.getAggregateVersion(budget)).toBe(afterFirst);
    const ledger = readCurrentBudgetLedger(store, PROJECT_ID, GOAL_ID);
    if (!ledger.ok) throw new Error(`the durable ledger must read back: ${ledger.code}`);
    expect(ledger.reservations.filter(
      (entry) => entry.admissionRef === "activation:cmd-activate-1")).toHaveLength(1);
  });

  it("persists NEITHER aggregate when the budget leg loses an expected-version race", () => {
    // ATOMICITY, forced through the real store. A foreign write lands on the BUDGET aggregate
    // between the hold being captured and the legs commit, so the captured fence is stale by
    // the time `decideLegsUnderLock` reads every leg's version. Nothing is mocked: the fault
    // is a genuine concurrent append to a real aggregate.
    const store = readyStore("legs-race");
    const budget = budgetAggregateOf(store);
    const before = store.getAggregateVersion(budget);
    let raced = false;
    const racing = interceptLegsCommit(store, () => {
      if (raced) return;
      raced = true;
      store.commit({
        aggregateId: budget, commandBytes: encoder.encode("race"), commandId: "cmd-race",
        committedAt: DECIDED_AT,
        events: [{
          eventId: "race-1", eventType: "BudgetLedgerRaceProbe",
          payload: encoder.encode("{}"),
        }],
        expectedVersion: store.getAggregateVersion(budget),
      });
    });

    const outcome = runEffectActivateCommand(racing, activateBytes());

    expect(raced).toBe(true);
    // The STORE's own conflict, carried by the ledger adapter with its own layer.
    expectRefusal(outcome, "ACTIVATION_LEDGER_EXPECTED_VERSION_CONFLICT", "ACTIVATION_LEDGER");
    // BOTH aggregates read back RAW. The activation never appended, and the budget carries the
    // racing write alone — no reservation rode a refused decision.
    expect(store.getAggregateVersion(AGGREGATE_ID)).toBe(0);
    expect(store.getAggregateVersion(budget)).toBe(before + 1);
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
      workClaimBytes("work.release", "cmd-release", 1),
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

/** Distinct identities per slug, so several activations coexist in one store.
 *  `liveClaims` is a parameter BECAUSE it must not matter: the ceiling cases
 *  below hand it the exact tables that used to decide, and assert they no
 *  longer do. */
function slugActivateBytes(slug: string, liveClaims: readonly unknown[]): Uint8Array {
  const intentId = `intent-${slug}`;
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch: 3, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: "session-1", serverWallDeadline: 1_000, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch: 3, expectedVersion: 7, leaseToken: `token-${slug}`,
    ownerSessionRef: "session-1",
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: structuredClone({
      activation: {
        attempt: {
          aggregateId: `agg-${slug}`, attemptId: `attempt-${slug}`, intentId,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim: {
          claimId: `claim-${slug}`, claimedAt: DECIDED_AT, intentId,
          lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
        },
        dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${slug}`,
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId, leaseBinding: lease,
          predecessorCursor: `cursor-${slug}`, protocolVersion: "moe-effect-intent/1",
          runtimeObservationDigest: DIGEST, state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims,
      slot: {
        dimension: "default", requestId: `req-${slug}`, rows: [RESOURCE_ROW],
        slotRef: `slot-${slug}`,
      },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const slugAggregate = (slug: string): string =>
  deriveActivationAggregateId(`agg-${slug}`, `idem-${slug}`);

describe("effect.activate ingress — the design-427 ceiling counts the DURABLE table", () => {
  it("refuses the fifth activation from durable occupancy even when every caller table was empty",
    () => {
      const store = readyStore("durable-ceiling");
      for (const slug of ["c1", "c2", "c3", "c4"]) {
        const seeded = runEffectActivateCommand(store, slugActivateBytes(slug, []));
        expect(seeded).toMatchObject({ disposition: "DECIDED", ok: true });
      }

      const outcome = runEffectActivateCommand(store, slugActivateBytes("c5", []));

      // THE design-427 bypass, closed: four slots are durably held, the caller
      // says nothing about any of them, and the kernel still refuses — because
      // the table it counts is derived from the store, not from the request.
      expectRefusal(outcome, "WORK_SLOT_EXHAUSTED", "AUTHORITY");
      expect(store.readEvents(slugAggregate("c5"))).toHaveLength(0);
    });

  it("admits over a padded caller table when nothing is durably held", () => {
    const store = readyStore("padded-caller");
    const padded = Array.from({ length: 4 }, (_unused, index) => ({
      dimension: "default", slotRef: `fake-${index}`, state: "RESERVED",
    }));

    const outcome = runEffectActivateCommand(store, slugActivateBytes("solo", padded));

    // The inverse bypass: a caller cannot manufacture exhaustion either. Four
    // fake entries used to refuse this claim outright; now they feed nothing.
    expect(outcome).toMatchObject({ disposition: "DECIDED", ok: true });
    expect(store.readEvents(slugAggregate("solo"))).toHaveLength(1);
  });

  it("refuses the activation verbatim when the occupancy derivation refuses, committing nothing",
    () => {
      const store = readyStore("occupancy-refused");
      const poison = encoder.encode("not an activation record");
      store.commitExpectedVersionDecision({
        commandKind: "test.plant_occupancy", committedResultBytes: poison,
        correlationId: "corr-plant-poison", decidedAt: DECIDED_AT,
        events: [{
          eventId: "plant-poison", eventType: ACTIVATION_LEDGER_EVENT_TYPE, payload: poison,
        }],
        expectedVersion: 0,
        key: { commandId: "cmd-plant-poison", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
        requestBytes: poison, targetAggregateId: slugAggregate("poison"),
      });
      const before = readDurableLedger(store, PROJECT_ID).decisionCount;

      const outcome = runEffectActivateCommand(store, slugActivateBytes("after-poison", []));

      // The derivation's own code and layer, unflattened — and no decision or
      // ledger row for the refused activation, because a count that cannot be
      // derived must never be answered as an empty table that admits.
      expectRefusal(outcome, "ACTIVATION_SLOT_OCCUPANCY_RECORD_MALFORMED", DAEMON_SLOT_OCCUPANCY);
      expect(readDurableLedger(store, PROJECT_ID).decisionCount).toBe(before);
      expect(store.readEvents(slugAggregate("after-poison"))).toHaveLength(0);
    });
});
