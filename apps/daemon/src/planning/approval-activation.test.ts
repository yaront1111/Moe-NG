/**
 * The approve path's budget half (task-1de7b81a): a durable root, an atomic commit, and a
 * budgetHash nobody supplied.
 *
 * `approval-activation.ts` had no suite of its own, so these arms are ADDITIVE — nothing here
 * edits another suite's world. Every arm drives the SHIPPED command path through
 * `runBootstrapCommand`, so what is asserted is what an operator's approval actually writes.
 *
 * The two arms the governor's Option-B ruling required to be PROVEN rather than argued are named
 * ARM A (atomicity) and ARM B (reader visibility) below.
 */

import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger, stateOf, versionOf } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID,
  PROJECT_ID,
  approvalPayload,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  planningActivation,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import type { Envelope } from "../bootstrap/bootstrap-test-fixtures.js";
import { seedActivationWorldWithGatePolicy } from "../activation/activation-world-fixtures.js";
import { encodeBudgetLedgerRecord } from "../budget/budget-ledger-codec.js";
import { decodeBudgetLedgerRecord } from "../budget/budget-ledger-codec.js";
import {
  BUDGET_LEDGER_EVENT_TYPE,
  deriveBudgetAggregateId,
} from "../budget/budget-ledger-contracts.js";

const BUDGET_ACCOUNT_REF = "budget-account-1";
const BUDGET_AGGREGATE = deriveBudgetAggregateId(PROJECT_ID, BUDGET_ACCOUNT_REF);
const ACTIVATION_EVENT_TYPE = "GoalExecutionEnabled";
const decoder = new TextDecoder();

afterEach(() => {
  closeStores();
});

/** A store driven to the point where the next command is the approval itself. */
function approvableStore(): SqliteEventStore {
  const store = openStore();
  driveThrough(store, "approval.decide");
  return store;
}

const approval = (activationOverrides?: Record<string, unknown>): Envelope =>
  envelope("approval.decide", 0, activationOverrides === undefined
    ? approvalPayload()
    : approvalPayload({ activation: planningActivation(activationOverrides) }));

/** The ROOT record as the store holds it, decoded and re-digested exactly as production does. */
function durableRoot(store: SqliteEventStore): { digest: string; record: ReturnType<typeof decode> } {
  const [first] = store.readEvents(BUDGET_AGGREGATE);
  if (first === undefined) throw new Error("no budget root on the aggregate");
  expect(first.eventType).toBe(BUDGET_LEDGER_EVENT_TYPE);
  const record = decode(first.payload);
  const reencoded = encodeBudgetLedgerRecord(record);
  if (!reencoded.ok) throw new Error(`root does not re-encode: ${reencoded.code}`);
  return { digest: reencoded.digest, record };
}

function decode(payload: Uint8Array) {
  const decoded = decodeBudgetLedgerRecord(payload);
  if (!decoded.ok) throw new Error(`root undecodable: ${decoded.code}`);
  return decoded.record;
}

/** The `activation` section of the goal's single `GoalExecutionEnabled`. */
function activationSection(store: SqliteEventStore): Record<string, unknown> {
  const rows = store.readEvents(GOAL_ID).filter((row) => row.eventType === ACTIVATION_EVENT_TYPE);
  expect(rows).toHaveLength(1);
  const payload = JSON.parse(decoder.decode(rows[0]?.payload)) as Record<string, unknown>;
  return payload["activation"] as Record<string, unknown>;
}

describe("approve mints and binds the project's budget root (task-1de7b81a)", () => {
  it("records a budgetHash NO caller supplied, equal to the durable root's own digest", () => {
    const store = approvableStore();

    const outcome = send(store, approval());

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    const root = durableRoot(store);
    // The witness value is the digest RECOMPUTED from the durable bytes, and the request that
    // produced it carried no budgetHash at all — so the field cannot have been passed through.
    expect(activationSection(store)["budgetHash"]).toBe(root.digest);
    expect(approvalPayload()["activation"]).not.toHaveProperty("budgetHash");
    expect(root.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("binds the genesis root to the approved revision at epoch 1, with a zero denominator", () => {
    const store = approvableStore();

    expect(send(store, approval()).ok).toBe(true);

    const { record } = durableRoot(store);
    expect(record.transition).toBe("ROOT_AUTHORIZED");
    expect(record.binding.graphEpoch).toBe(1);
    expect(record.binding.projectId).toBe(PROJECT_ID);
    expect(record.binding.goalRef).toBe(GOAL_ID);
    expect(record.authorization.amounts.length).toBeGreaterThan(0);
    expect(record.authorization.amounts.every((amount) => amount.amount === 0)).toBe(true);
  });

  it("refuses a caller budgetHash that disagrees with the server's, by exact code and layer", () => {
    const store = approvableStore();

    const outcome = send(store, approval({ budgetHash: "b0".padEnd(64, "0") }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("BOOTSTRAP_BUDGET_HASH_MISMATCH");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
  });

  // ARM A — ATOMICITY (ruling condition 4). Option B's entire safety claim: nothing about the
  // budget is durable before the decision, and a refusal leaves NO root behind. Option A could
  // not offer this, because its root was already committed by the time the approval was judged.
  it("ARM A: a REFUSED approval leaves no budget root at all, read through store events", () => {
    const store = approvableStore();
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);

    const refused = send(store, approval({ budgetHash: "b0".padEnd(64, "0") }));

    expect(refused.ok).toBe(false);
    // The leg was BUILT for this request — the writer ran, the reducer ran, the digest was
    // computed — and none of it reached the store, because a leg is bytes until a decision
    // commits it. A root here would be spend authority surviving a refused approval.
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);
    expect(store.getAggregateVersion(BUDGET_AGGREGATE)).toBe(0);
    expect(store.readEvents(GOAL_ID).filter((row) => row.eventType === ACTIVATION_EVENT_TYPE))
      .toHaveLength(0);
  });

  it("ARM A: a core-refused approval also leaves neither aggregate moved", () => {
    const store = approvableStore();
    const goalVersionBefore = store.getAggregateVersion(GOAL_ID);

    // The core judges `expectedGoalVersion`; 99 is nobody's version, so the reducer refuses
    // before any commit — a DIFFERENT refusal from the hash arm above, and the same invariant.
    const refused = send(store, approval({ expectedGoalVersion: 99 }));

    expect(refused.ok).toBe(false);
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(0);
    expect(store.getAggregateVersion(GOAL_ID)).toBe(goalVersionBefore);
  });

  // ARM B — READER VISIBILITY. A secondary leg commits durable events and advances its
  // aggregate's version, but `readDurableLedger` maps only `decision.targetAggregateId` — the
  // PRIMARY leg — so the ledger view never sees the budget aggregate at all. A verifier written
  // against the ledger would read version 0, conclude the root is absent, and refuse every
  // honest approval: a failure that looks exactly like a correct fail-closed refusal.
  it("ARM B: the committed root is visible to STORE EVENTS and invisible to the ledger view", () => {
    const store = approvableStore();

    expect(send(store, approval()).ok).toBe(true);

    // The reader production uses.
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);
    expect(store.getAggregateVersion(BUDGET_AGGREGATE)).toBe(1);
    // The reader that must NEVER be used for this, pinned so the distinction is deliberate
    // rather than incidental: same store, same moment, and it sees nothing.
    const ledger = readDurableLedger(store, PROJECT_ID);
    expect(ledger.aggregates.get(BUDGET_AGGREGATE)).toBeUndefined();
    expect(versionOf(ledger, BUDGET_AGGREGATE)).toBe(0);
    expect(stateOf(ledger, BUDGET_AGGREGATE)).toBeUndefined();
    // The PRIMARY leg is the goal, and it IS in the ledger — so the arm is measuring the
    // primary/secondary distinction and not a ledger that simply reads nothing.
    expect(versionOf(ledger, GOAL_ID)).toBeGreaterThan(0);
  });

  it("does not mint a SECOND root when the project already holds one", () => {
    const store = approvableStore();
    // The world's own FUNDED root, authorized before the approval — this repository's stand-in
    // for the grant it cannot yet express.
    seedActivationWorldWithGatePolicy(store, "HUMAN_APPROVAL");
    const existing = durableRoot(store);

    expect(send(store, approval()).ok).toBe(true);

    // One root, still the world's, and the witness binds THAT one by its recomputed digest.
    expect(store.readEvents(BUDGET_AGGREGATE)).toHaveLength(1);
    expect(activationSection(store)["budgetHash"]).toBe(existing.digest);
    expect(existing.record.authorization.amounts.some((amount) => amount.amount > 0)).toBe(true);
  });
});
