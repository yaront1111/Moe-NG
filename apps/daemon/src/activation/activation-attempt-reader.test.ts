/**
 * `readFoundationActivationByAttempt` — the durable activation binding for one
 * attempt, derived from committed evidence and nothing else.
 *
 * EVERY ACCEPTED ACTIVATION HERE IS COMMITTED BY `runEffectActivateCommand`.
 * `activation-ledger-fixtures.record()` is deliberately unused: its grant is
 * codec-legal but `validateActivationCommit`-incoherent, so a suite seeded from
 * it could only ever exercise refusals — and a refusal-only suite is passed by a
 * reader that refuses everything, which is the worst bug here wearing the safest
 * mask. The accepted controls are what make the refusal table mean anything.
 *
 * THE READER IS PROVEN READ-ONLY BY MEASUREMENT, not by its port's shape. Every
 * non-race case snapshots the raw event horizon, the raw event count, the raw
 * command-decision count, the queried aggregate's version and receipt, and the
 * database file's size and mtime, then asserts the read moved none of them. The
 * raw counts are asserted POSITIVE first: a snapshot comparison over two empty
 * measurements proves nothing at all.
 *
 * `principalId` is deliberately never the lease's `ownerSessionRef`. The whole
 * point of this reader is that the owner session comes from the durable lease,
 * so a fixture that let the two coincide could not tell the two apart.
 */

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readFoundationActivationByAttempt } from "./activation-attempt-reader.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import { runEffectActivateCommand } from "./activation-ingress.js";
import { deriveActivationAggregateId } from "./activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "./activation-ledger-reader.js";
import {
  FOUNDATION_ACTIVATION_BINDING_LAYER,
  foundationBindingAbsent,
} from "./foundation-activation-transition.js";
import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";

const encoder = new TextEncoder();
const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-16T00:00:00.000Z";
/** Wall SECONDS; the scheduler's overdue rule is `seconds > deadline`. */
const LIVE_DEADLINE = Math.floor(Date.parse(DECIDED_AT) / 1_000) + 3_600;

interface ActivationSpec {
  /** Free of every other identity, which is exactly why it needs a reader. */
  readonly attemptId: string;
  readonly epoch: number;
  readonly sessionId: string;
  readonly slug: string;
}

/**
 * The exact `effect.activate` request body the daemon ingress accepts, with the
 * four fields this suite varies threaded through it. Nothing here computes a
 * grant, a digest or an aggregate id: the ingress does, which is what makes the
 * committed bytes real evidence rather than a fixture agreeing with itself.
 */
function activationBytes(spec: ActivationSpec): Uint8Array {
  const { attemptId, epoch, sessionId, slug } = spec;
  const lease = {
    authorityHashRef: DIGEST, bootId: "boot-1", epoch, kind: "ASSIGNMENT",
    leaseId: `lease-${slug}`, leaseToken: `token-${slug}`, monotonicObservation: 500,
    ownerSessionRef: sessionId, serverWallDeadline: LIVE_DEADLINE, state: "ACTIVE", version: 7,
  } as const;
  const proof = {
    authorityHashRef: DIGEST, epoch, expectedVersion: 7, leaseToken: `token-${slug}`,
    ownerSessionRef: sessionId,
  } as const;
  const claim = {
    claimId: `claim-${slug}`, claimedAt: DECIDED_AT, intentId: `intent-${slug}`,
    lockIdentity: `lock-${slug}`, wrapperIdentity: `wrapper-${slug}`,
  } as const;
  return encoder.encode(JSON.stringify({
    commandId: `cmd-activate-${slug}`, correlationId: `corr-${slug}`, decidedAt: DECIDED_AT,
    expectedVersion: 0, kind: EFFECT_ACTIVATE_COMMAND_KIND,
    payload: {
      activation: {
        attempt: {
          aggregateId: `agg-${slug}`, attemptId, intentId: `intent-${slug}`,
          state: "LAUNCH_REQUESTED", version: 0,
        },
        claim, dependencyWitnesses: [], desiredState: "ACTIVE", leaseProof: proof,
        lockIdentity: `lock-${slug}`, observedGraphEpoch: 4, observedRuntimeDigest: DIGEST,
        tombstone: null, wrapperIdentity: `wrapper-${slug}`,
      },
      budget: {
        admission: {
          admissionRef: `adm-${slug}`,
          amounts: [
            { meter: "usd", purpose: "EXECUTION", quantity: 10 },
            { meter: "usd", purpose: "VERIFICATION", quantity: 5 },
            { meter: "usd", purpose: "INDEPENDENT_REVIEW", quantity: 5 },
            { meter: "usd", purpose: "FINAL_ACCEPTANCE", quantity: 5 },
            { meter: "usd", purpose: "CONTINGENCY", quantity: 5 },
          ],
          expectedVersion: 2,
        },
        gate: { allowance: { decisionRef: `dec-${slug}`, outcome: "ALLOW" }, approval: null },
        view: {
          accountId: `acct-${slug}`,
          meters: [{ available: 100, committed: 0, meter: "usd", quarantined: 0, reserved: 0 }],
          state: "OPEN", version: 2,
        },
      },
      effect: {
        command: { kind: "claim" },
        intent: {
          aggregateId: `agg-${slug}`, desiredState: "ACTIVE", expectedGraphEpoch: 4,
          idempotencyKey: `idem-${slug}`, inputBinding: DIGEST, intentId: `intent-${slug}`,
          leaseBinding: lease, predecessorCursor: `cursor-${slug}`,
          protocolVersion: "moe-effect-intent/1", runtimeObservationDigest: DIGEST,
          state: "PENDING", version: 0,
        },
      },
      lease: { proof, record: lease },
      liveClaims: [{ dimension: slug, slotRef: `held-${slug}`, state: "RESERVED" }],
      slot: {
        dimension: slug, requestId: `req-${slug}`, slotRef: `slot-${slug}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
        }],
      },
    },
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

interface Activated {
  readonly aggregateId: string;
  readonly commandId: string;
  readonly spec: ActivationSpec;
}

/** Commits one activation through production ingress and refuses to guess. */
function activate(store: SqliteEventStore, spec: ActivationSpec): Activated {
  const outcome = runEffectActivateCommand(store, activationBytes(spec));
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
  return {
    aggregateId: deriveActivationAggregateId(`agg-${spec.slug}`, `idem-${spec.slug}`),
    commandId: `cmd-activate-${spec.slug}`,
    spec,
  };
}

function openStore(label: string): SqliteEventStore {
  const root = mkdtempSync(join(tmpdir(), `moe-attempt-reader-${label}-`));
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

/** The durable digest, read back through the production history reader. */
function digestOf(store: SqliteEventStore, aggregateId: string): string {
  const history = readFoundationActivationHistory(
    aggregateId, store.readEvents(aggregateId), PROJECT_ID);
  if (!history.ok) throw new Error(`activation unreadable: ${history.result.status}`);
  return history.history.record.activationDigest;
}

interface Snapshot {
  readonly databaseBytes: number;
  readonly databaseMtimeMs: number;
  readonly decisions: number;
  readonly events: number;
  readonly horizon: string;
}

function snapshot(store: SqliteEventStore): Snapshot {
  const path = store.getHealth().databasePath;
  if (path === null) throw new Error("this suite requires a file-backed store");
  const stat = statSync(path);
  let events = 0;
  for (let cursor = 0n; ; ) {
    const page = store.readEventsAfter(cursor, 200);
    events += page.items.length;
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  let decisions = 0;
  for (let cursor = 0n; ; ) {
    const page = store.readCommandDecisionsAfter(cursor, 200);
    decisions += page.items.length;
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return {
    databaseBytes: stat.size, databaseMtimeMs: stat.mtimeMs, decisions, events,
    horizon: store.readEventHorizon().toString(),
  };
}

/** Positive by assertion, not by hope: an all-zero snapshot compares equal to
 *  itself and would let a WRITING reader pass this suite unnoticed. */
function positiveSnapshot(store: SqliteEventStore): Snapshot {
  const taken = snapshot(store);
  expect(taken.events).toBeGreaterThan(0);
  expect(taken.decisions).toBeGreaterThan(0);
  expect(BigInt(taken.horizon)).toBeGreaterThan(0n);
  expect(taken.databaseBytes).toBeGreaterThan(0);
  return taken;
}

const BOUND_KEYS = Object.freeze([
  "activationAggregateId", "activationDigest", "attemptId", "effectIntentId", "epoch",
  "ownerSessionRef", "projectId", "status",
]);

afterEach(cleanupRestoreHarnesses);

describe("readFoundationActivationByAttempt accepts a committed activation", () => {
  it("returns the durable binding for the queried attempt and moves nothing", () => {
    const store = openStore("bound");
    const target = activate(store, {
      attemptId: "attempt-target", epoch: 41, sessionId: "session-owner", slug: "target",
    });
    activate(store, {
      attemptId: "attempt-other", epoch: 9, sessionId: "session-other", slug: "other",
    });
    // The owner session is the DURABLE lease's, never the requesting principal.
    expect(target.spec.sessionId).not.toBe(PRINCIPAL_ID);
    const before = positiveSnapshot(store);
    const versionBefore = store.getAggregateVersion(target.aggregateId);
    const receiptBefore = store.getCommandReceipt(target.commandId);
    expect(receiptBefore).not.toBeNull();

    const result = readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-target");

    expect(result).toEqual({
      activationAggregateId: target.aggregateId,
      activationDigest: digestOf(store, target.aggregateId),
      attemptId: "attempt-target",
      effectIntentId: "intent-target",
      epoch: 41,
      ownerSessionRef: "session-owner",
      projectId: PROJECT_ID,
      status: "BOUND",
    });
    expect(Object.keys(result).sort()).toEqual([...BOUND_KEYS]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.values(result).every((value) => Object(value) !== value)).toBe(true);
    // A repeated read of unchanged bytes is the same answer, byte for byte.
    expect(JSON.stringify(readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-target")))
      .toBe(JSON.stringify(result));
    expect(snapshot(store)).toEqual(before);
    expect(store.getAggregateVersion(target.aggregateId)).toBe(versionBefore);
    expect(store.getCommandReceipt(target.commandId)).toEqual(receiptBefore);
  });

  it("distinguishes two committed attempts instead of answering the first", () => {
    const store = openStore("distinct");
    const first = activate(store, {
      attemptId: "attempt-first", epoch: 2, sessionId: "session-first", slug: "first",
    });
    const second = activate(store, {
      attemptId: "attempt-second", epoch: 77, sessionId: "session-second", slug: "second",
    });
    const before = positiveSnapshot(store);

    const answer = readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-second");

    expect(answer).toEqual({
      activationAggregateId: second.aggregateId,
      activationDigest: digestOf(store, second.aggregateId),
      attemptId: "attempt-second",
      effectIntentId: "intent-second",
      epoch: 77,
      ownerSessionRef: "session-second",
      projectId: PROJECT_ID,
      status: "BOUND",
    });
    expect(answer).not.toMatchObject({ activationAggregateId: first.aggregateId });
    expect(snapshot(store)).toEqual(before);
  });
});

describe("readFoundationActivationByAttempt reports a durable absence", () => {
  it("answers the existing exact ABSENT bytes while other activations exist", () => {
    const store = openStore("absent");
    activate(store, {
      attemptId: "attempt-present", epoch: 5, sessionId: "session-present", slug: "present",
    });
    const before = positiveSnapshot(store);

    const missing = readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-missing");

    expect(missing).toEqual(foundationBindingAbsent("FOUNDATION_BINDING_NOT_FOUND"));
    expect(missing).toEqual({
      code: "FOUNDATION_BINDING_NOT_FOUND",
      layer: FOUNDATION_ACTIVATION_BINDING_LAYER,
      status: "ABSENT",
    });
    expect(Object.keys(missing).sort()).toEqual(["code", "layer", "status"]);
    expect(Object.isFrozen(missing)).toBe(true);
    // An always-ABSENT reader cannot pass: the same store answers BOUND here.
    expect(readFoundationActivationByAttempt(store, PROJECT_ID, "attempt-present").status)
      .toBe("BOUND");
    expect(snapshot(store)).toEqual(before);
  });
});
