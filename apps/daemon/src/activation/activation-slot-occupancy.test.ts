import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore, StoredEvent } from "@moe/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  PRINCIPAL_ID,
  PROJECT_ID,
  cleanupRestoreHarnesses,
  openHarnessStore,
  seedReadyProject,
} from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RELEASE_COMMAND_KIND,
  ATTEMPT_RELEASE_EVENT_TYPE,
  ATTEMPT_RELEASE_RECORD_VERSION,
  deriveAttemptReleaseAggregateId,
} from "../work/attempt-release-disposition.js";
import { encodeFoundationPayload } from "../work/foundation-attempt-codec.js";
import {
  ACTIVATION_INGRESS_SCHEMA_VERSION,
  EFFECT_ACTIVATE_COMMAND_KIND,
} from "./activation-ingress-contracts.js";
import { runEffectActivateCommand } from "./activation-ingress.js";
import {
  ACTIVATION_LEDGER_EVENT_TYPE,
  deriveActivationAggregateId,
} from "./activation-ledger-contracts.js";
import { DAEMON_SLOT_OCCUPANCY, deriveSlotOccupancy } from "./activation-slot-occupancy.js";
import type { SlotOccupancyStore } from "./activation-slot-occupancy.js";

/**
 * `deriveSlotOccupancy` against evidence PRODUCTION wrote: every counted
 * activation is committed by `runEffectActivateCommand` — a hand-forged grant
 * cannot pass `parseActivationGrant`, so the strict reader path is exercised by
 * real bytes, not by fixtures that agree with themselves. Release rows are the
 * one plant: `recordAttemptRelease` needs the whole boundary/terminality chain,
 * so rows land the way `attempt-release-disposition.test.ts` already plants
 * them — canonical bytes on the derived release aggregate — and the drifted
 * arms plant exactly the bytes the production writer would never emit.
 *
 * FAIL-CLOSED IS THE HEADLINE CONTRACT: every refusal arm asserts the exact
 * code AND layer, never just "it refused", and no arm may answer an empty
 * table — an unreadable ledger read as zero occupancy IS the design-427 bypass.
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
  const root = mkdtempSync(join(tmpdir(), `moe-occupancy-${label}-`));
  scratchRoots.push(root);
  const store = openHarnessStore(join(root, "project.db"));
  seedReadyProject(store);
  return store;
}

const DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-15T00:00:00.000Z";

/** Distinct identities per slug, so several activations coexist in one store. */
function activationBytes(slug: string, dimension = "default"): Uint8Array {
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
      // Inert for the decision by design; kept empty so nothing here can hide a
      // caller-counted regression behind a fixture that happened to agree.
      liveClaims: [],
      slot: {
        dimension, requestId: `req-${slug}`,
        rows: [{
          capacityUnits: 1, effectIntentRef: `intent-ref-${slug}`, epoch: 1, external: false,
          fenceable: true, resourceId: `res-${slug}`, state: "ACTIVE",
        }],
        slotRef: `slot-${slug}`,
      },
    }),
    principalId: PRINCIPAL_ID, projectId: PROJECT_ID,
    schemaVersion: ACTIVATION_INGRESS_SCHEMA_VERSION,
  }));
}

const aggregateOf = (slug: string): string =>
  deriveActivationAggregateId(`agg-${slug}`, `idem-${slug}`);

function activate(store: SqliteEventStore, slug: string, dimension = "default"): string {
  const outcome = runEffectActivateCommand(store, activationBytes(slug, dimension));
  if (!outcome.ok) throw new Error(`activation refused: ${outcome.code}`);
  return aggregateOf(slug);
}

/** Appends bytes the production writers would never emit, so the walk's own
 *  guards are reached by evidence rather than by a stub. */
function plantEvent(
  store: SqliteEventStore, targetAggregateId: string, eventType: string, payload: Uint8Array,
  label: string, expectedVersion = 0,
): void {
  const committed = store.commitExpectedVersionDecision({
    commandKind: ATTEMPT_RELEASE_COMMAND_KIND, committedResultBytes: payload,
    correlationId: `corr-plant-${label}`, decidedAt: DECIDED_AT,
    events: [{ eventId: `plant-${label}`, eventType, payload }],
    expectedVersion,
    key: { commandId: `cmd-plant-${label}`, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
    requestBytes: payload, targetAggregateId,
  });
  if (committed.decision.effectDisposition !== "EFFECTS_COMMITTED") {
    throw new Error(`planting refused: ${committed.decision.effectDisposition}`);
  }
}

/** Exactly what the production release writer would emit for this outcome. */
function releaseBytes(activationAggregateId: string, outcome: string): Uint8Array {
  const encoded = encodeFoundationPayload({
    attemptAggregateId: activationAggregateId, outcome,
    recordVersion: ATTEMPT_RELEASE_RECORD_VERSION,
  });
  if (!encoded.ok) throw new Error(`release fixture is not encodable: ${encoded.code}`);
  return encoded.bytes;
}

function plantRelease(
  store: SqliteEventStore, activationAggregateId: string, outcome: string, label: string,
  expectedVersion = 0,
): void {
  plantEvent(store, deriveAttemptReleaseAggregateId(activationAggregateId),
    ATTEMPT_RELEASE_EVENT_TYPE, releaseBytes(activationAggregateId, outcome), label,
    expectedVersion);
}

function heldOf(store: SlotOccupancyStore): readonly unknown[] {
  const derived = deriveSlotOccupancy(store, PROJECT_ID);
  if (!derived.ok) throw new Error(`derivation refused: ${derived.code}`);
  return derived.held;
}

function refusalOf(store: SlotOccupancyStore): { code: string; layer: string } {
  const derived = deriveSlotOccupancy(store, PROJECT_ID);
  if (derived.ok) {
    throw new Error(`the derivation must refuse, not answer ${derived.held.length} entries`);
  }
  return { code: derived.code, layer: derived.layer };
}

describe("deriveSlotOccupancy — the held table", () => {
  it("answers an empty table for a project with no committed activations", () => {
    expect(heldOf(readyStore("empty"))).toEqual([]);
  });

  it("collects every default-dimension activation with its committed slotRef and state", () => {
    const store = readyStore("three");
    for (const slug of ["a", "b", "c"]) activate(store, slug);

    // The committed record's OWN slot facts: the ingress ran the scheduler's
    // sole RESERVED -> ACTIVE transition before the commit, so ACTIVE is what
    // the durable evidence holds, in commit order.
    expect(heldOf(store)).toEqual([
      { dimension: "default", slotRef: "slot-a", state: "ACTIVE" },
      { dimension: "default", slotRef: "slot-b", state: "ACTIVE" },
      { dimension: "default", slotRef: "slot-c", state: "ACTIVE" },
    ]);
  });

  it("does not count a slot held in another dimension", () => {
    const store = readyStore("dimension");
    activate(store, "d1");
    activate(store, "d2", "gpu");

    expect(heldOf(store)).toEqual([
      { dimension: "default", slotRef: "slot-d1", state: "ACTIVE" },
    ]);
  });

  it("subtracts exactly the attempt whose durable release row records RELEASED", () => {
    const store = readyStore("released");
    const first = activate(store, "r1");
    activate(store, "r2");
    plantRelease(store, first, "RELEASED", "released-r1");

    // r1 is matched via deriveAttemptReleaseAggregateId and drops out; r2 has
    // no row at all and stays held.
    expect(heldOf(store)).toEqual([
      { dimension: "default", slotRef: "slot-r2", state: "ACTIVE" },
    ]);
  });

  it("still counts DRAINING and NO_OP rows — a slot released mid-drain would claim a boundary the kernel declined to certify", () => {
    const store = readyStore("draining");
    const first = activate(store, "n1");
    const second = activate(store, "n2");
    plantRelease(store, first, "DRAINING", "draining-n1");
    plantRelease(store, second, "NO_OP", "noop-n2");

    // attempt-release-disposition.ts:225-231: only a SETTLED boundary releases
    // the slot; a draining release keeps the durable slot fact untouched, so
    // the occupancy table may not subtract it either.
    expect(heldOf(store)).toEqual([
      { dimension: "default", slotRef: "slot-n1", state: "ACTIVE" },
      { dimension: "default", slotRef: "slot-n2", state: "ACTIVE" },
    ]);
  });
});

describe("deriveSlotOccupancy — fail closed, never an empty table", () => {
  it("refuses the whole derivation over one undecodable activation row", () => {
    const store = readyStore("malformed");
    activate(store, "good");
    plantEvent(store, aggregateOf("poison"), ACTIVATION_LEDGER_EVENT_TYPE,
      encoder.encode("not an activation record"), "poison-activation");

    // The good activation does NOT survive as a partial answer: an unreadable
    // neighbour makes the whole count unknowable, and unknown never admits.
    expect(refusalOf(store)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_RECORD_MALFORMED", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });

  it("refuses a second ledger row on one activation aggregate", () => {
    const store = readyStore("ambiguous");
    const aggregateId = activate(store, "twice");
    plantEvent(store, aggregateId, ACTIVATION_LEDGER_EVENT_TYPE,
      encoder.encode("a second activation row"), "second-activation", 1);

    expect(refusalOf(store)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_RECORD_AMBIGUOUS", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });

  it("refuses a release row whose bytes no longer re-encode", () => {
    const store = readyStore("drift");
    const aggregateId = activate(store, "drifted");
    // Decodes fine, but JSON.stringify keeps insertion order while the
    // canonical form sorts keys, so the byte compare is the guard that answers.
    plantEvent(store, deriveAttemptReleaseAggregateId(aggregateId), ATTEMPT_RELEASE_EVENT_TYPE,
      encoder.encode(`{"outcome":"RELEASED","attemptAggregateId":"${aggregateId}"}`),
      "drifted-release");

    expect(refusalOf(store)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_RELEASE_DRIFT", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });

  it("refuses a release row recording an outcome outside the frozen vocabulary", () => {
    const store = readyStore("outcome");
    const aggregateId = activate(store, "vocab");
    // Canonically encoded, so ONLY the outcome guard can refuse it — a reader
    // that trusted the stored string would subtract on a word no kernel said.
    plantRelease(store, aggregateId, "SUCCEEDED", "alien-outcome");

    expect(refusalOf(store)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_RELEASE_DRIFT", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });

  it("refuses two release rows on one release aggregate", () => {
    const store = readyStore("tworows");
    const aggregateId = activate(store, "double");
    plantRelease(store, aggregateId, "RELEASED", "double-first");
    plantRelease(store, aggregateId, "DRAINING", "double-second", 1);

    expect(refusalOf(store)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_RELEASE_AMBIGUOUS", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });

  it("refuses a release row that no committed activation explains", () => {
    const store = readyStore("orphan");
    activate(store, "present");
    plantRelease(store, aggregateOf("never-activated"), "RELEASED", "orphan-release");

    expect(refusalOf(store)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_RELEASE_ORPHANED", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });

  it("refuses evidence traced to another project", () => {
    const store = readyStore("foreign");
    activate(store, "traced");
    // Both port methods are declared, so nothing falls through to a production
    // read the case did not mean to run; only the trace is stripped.
    const stripped: SlotOccupancyStore = {
      readEventHorizon: () => store.readEventHorizon(),
      readEventsByTypeAfter: (eventType, after, limit) => {
        const page = store.readEventsByTypeAfter(eventType, after, limit);
        return {
          ...page,
          items: page.items.map((event): StoredEvent => {
            const { decisionTrace, ...rest } = event;
            void decisionTrace;
            return rest;
          }),
        };
      },
    };

    expect(refusalOf(stripped)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_PROJECT_MISMATCH", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });

  it("refuses when the horizon read throws, and when a page read throws", () => {
    const store = readyStore("throws");
    activate(store, "t1");
    const horizonThrows: SlotOccupancyStore = {
      readEventHorizon: () => { throw new Error("horizon io fault"); },
      readEventsByTypeAfter: (eventType, after, limit) =>
        store.readEventsByTypeAfter(eventType, after, limit),
    };
    const pageThrows: SlotOccupancyStore = {
      readEventHorizon: () => store.readEventHorizon(),
      readEventsByTypeAfter: () => { throw new Error("page io fault"); },
    };

    expect(refusalOf(horizonThrows)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_UNREADABLE", layer: DAEMON_SLOT_OCCUPANCY,
    });
    expect(refusalOf(pageThrows)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_UNREADABLE", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });

  it("refuses a horizon that is not a nonnegative bigint", () => {
    const store = readyStore("horizon");
    activate(store, "h1");
    const malformedHorizon: SlotOccupancyStore = {
      readEventHorizon: () => 5 as unknown as bigint,
      readEventsByTypeAfter: (eventType, after, limit) =>
        store.readEventsByTypeAfter(eventType, after, limit),
    };

    expect(refusalOf(malformedHorizon)).toEqual({
      code: "ACTIVATION_SLOT_OCCUPANCY_SCAN_INCOMPLETE", layer: DAEMON_SLOT_OCCUPANCY,
    });
  });
});
