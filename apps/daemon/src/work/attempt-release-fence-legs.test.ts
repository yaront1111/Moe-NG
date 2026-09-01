import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteEventStore } from "@moe/store";
import { MAX_DECISION_LEGS } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses, openHarnessStore, seedReadyProject,
  trackHarnessRoot,
} from "../recovery/restore-test-harness.js";
import {
  ATTEMPT_RELEASE_FENCE_LEG_CODES, ATTEMPT_RELEASE_FENCE_SLOTS,
  classifyAttemptReleaseFenceConflict, composeAttemptReleaseFenceLegs,
} from "./attempt-release-fence-legs.js";
import type {
  AttemptReleaseFenceObservation, AttemptReleaseFenceSlot,
} from "./attempt-release-fence-legs.js";

/**
 * task-06835dfad0aa4ecd9801d760fc559ee8 — the fence-leg composer.
 *
 * IT IS THE PRODUCTION SURFACE THE ROSTER PROOF IS GRADED ON. @moe/store publishes
 * no leg-roster reader — `SqliteEventStore` exposes `getCommandDecision` only and
 * `CommandDecisionRecord` omits the roster — so the durable leg set cannot be read
 * back. This suite therefore grades the composer's own output, and the sibling
 * disposition suite grades the legs that ACTUALLY REACH the store plus the store's
 * acceptance of that decision. Neither alone is enough; the pair is.
 */

const encoder = new TextEncoder();
const DECIDED_AT = "2026-08-15T00:00:00.000Z";
const RELEASE_AGGREGATE = "attempt-release:agg-1";

afterEach(cleanupRestoreHarnesses);

const observation = (
  slot: AttemptReleaseFenceSlot, version = 1,
): AttemptReleaseFenceObservation =>
  ({ aggregateId: `aggregate-${slot.toLowerCase()}`, slot, version });

/** Every slot the frozen roster names, once. Built FROM the roster so a member
 *  added there without a case here cannot be silently untested. */
const fullRoster = (): AttemptReleaseFenceObservation[] =>
  ATTEMPT_RELEASE_FENCE_SLOTS.map((slot, index) => observation(slot, index + 1));

const primary = (): { aggregateId: string; events: readonly { eventId: string; eventType: string; payload: Uint8Array }[] } => ({
  aggregateId: RELEASE_AGGREGATE,
  events: [{
    eventId: "release-1", eventType: "AttemptReleaseRecorded", payload: encoder.encode("{}"),
  }],
});

function composedOrThrow(
  observations: readonly AttemptReleaseFenceObservation[],
): ReturnType<typeof composeAttemptReleaseFenceLegs> & { ok: true } {
  const composed = composeAttemptReleaseFenceLegs(primary(), observations);
  if (!composed.ok) throw new Error(`composer refused: ${composed.code}`);
  return composed;
}

function refusalCodeOf(observations: readonly AttemptReleaseFenceObservation[]): string {
  const composed = composeAttemptReleaseFenceLegs(primary(), observations);
  if (composed.ok) throw new Error("expected a refusal, the composer accepted");
  return `${composed.code}@${composed.layer}`;
}

describe("attempt release fence legs (task-06835dfa) — the frozen roster", () => {
  it("names exactly SEVEN slots with no duplicate, and one primary fits the leg budget", () => {
    expect([...ATTEMPT_RELEASE_FENCE_SLOTS]).toHaveLength(7);
    expect(new Set(ATTEMPT_RELEASE_FENCE_SLOTS).size).toBe(7);
    // THE BUDGET RECONCILIATION, asserted rather than argued: one appending primary
    // plus seven read-only fences is exactly MAX_DECISION_LEGS, so this row raises
    // no store constant and migrates no schema (the DDL interpolates the same 8).
    expect(ATTEMPT_RELEASE_FENCE_SLOTS.length + 1).toBe(MAX_DECISION_LEGS);
  });

  it("publishes a closed code list with no duplicate member", () => {
    expect([...ATTEMPT_RELEASE_FENCE_LEG_CODES]).toHaveLength(5);
    expect(new Set(ATTEMPT_RELEASE_FENCE_LEG_CODES).size).toBe(5);
    // The resource and source classes are DISTINCT answers, not one code with two
    // meanings: a moved resource set and a moved evidence source demand opposite
    // repairs. Asserted here so a later collapse of the two cannot pass.
    expect(ATTEMPT_RELEASE_FENCE_LEG_CODES).toContain("ATTEMPT_RELEASE_RESOURCE_FENCE_STALE");
    expect(ATTEMPT_RELEASE_FENCE_LEG_CODES).toContain("ATTEMPT_RELEASE_SOURCE_FENCE_STALE");
  });

  it("composes ONE primary append plus SEVEN read-only fences, in roster order", () => {
    const composed = composedOrThrow(fullRoster());
    expect(composed.legs).toHaveLength(MAX_DECISION_LEGS);
    const [head, ...fences] = composed.legs;
    // THE PRIMARY IS THE ONLY LEG THAT APPENDS, and it appends at version zero: the
    // release aggregate stays single-row with no compensating or upgrade path.
    expect(head?.aggregateId).toBe(RELEASE_AGGREGATE);
    expect(head?.expectedVersion).toBe(0);
    expect(head?.events).toHaveLength(1);
    expect(fences).toHaveLength(7);
    // EXACTLY EMPTY `events` is what makes a later leg a read-only FENCE rather than
    // an append, and it is what denies it receipt authority.
    for (const fence of fences) expect(fence.events).toEqual([]);
    // AND EACH FENCE CARRIES THE VERSION IT WAS OBSERVED AT, position by position.
    expect(fences.map((fence) => fence.expectedVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("agrees with the frozen roster in BOTH directions, not just one", () => {
    const composed = composedOrThrow(fullRoster());
    const composedSlots = new Set(composed.roster.map(({ slot }) => slot));
    const declaredSlots = new Set<string>(ATTEMPT_RELEASE_FENCE_SLOTS);
    // FORWARD: every declared slot is composed. A roster that only iterated itself
    // would shrink with a deleted member and stay green while a fence vanished.
    for (const slot of declaredSlots) expect(composedSlots.has(slot as never)).toBe(true);
    // REVERSE: every composed slot is declared. Together these are set-equality.
    for (const slot of composedSlots) expect(declaredSlots.has(slot)).toBe(true);
    expect(composedSlots.size).toBe(declaredSlots.size);
    // Leg aggregate ids are unique across primary and fences: the store refuses a
    // duplicate leg outright, so a collision must never reach it.
    expect(new Set(composed.legs.map(({ aggregateId }) => aggregateId)).size)
      .toBe(MAX_DECISION_LEGS);
  });

  it("REFUSES a roster missing ANY ONE slot — swept over all seven", () => {
    let swept = 0;
    for (const dropped of ATTEMPT_RELEASE_FENCE_SLOTS) {
      swept += 1;
      const narrowed = fullRoster().filter(({ slot }) => slot !== dropped);
      expect(narrowed, dropped).toHaveLength(6);
      expect(refusalCodeOf(narrowed), dropped)
        .toBe("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT@DAEMON_ATTEMPT_RELEASE_FENCE");
    }
    // THE SWEEP REALLY GENERATED ITS CASES. A zero-case sweep passes while proving
    // nothing, so the count is asserted against the roster's own length.
    expect(swept).toBe(ATTEMPT_RELEASE_FENCE_SLOTS.length);
    expect(swept).toBe(7);
  });

  it("REFUSES every other way a roster can be wrong, rather than ignoring it", () => {
    const cases: readonly (readonly [string, AttemptReleaseFenceObservation[]])[] = [
      ["duplicate slot", [...fullRoster(), observation("RESOURCE", 9)]],
      ["unknown slot",
        [...fullRoster(), { aggregateId: "aggregate-x", slot: "ARTIFACT" as never, version: 1 }]],
      ["blank aggregate id",
        fullRoster().map((given) => given.slot === "STEP" ? { ...given, aggregateId: "" } : given)],
      ["aggregate equal to the release primary",
        fullRoster().map((given) =>
          given.slot === "STEP" ? { ...given, aggregateId: RELEASE_AGGREGATE } : given)],
      ["two slots naming one aggregate",
        fullRoster().map((given) =>
          given.slot === "STEP" ? { ...given, aggregateId: "aggregate-journal" } : given)],
      ["negative version",
        fullRoster().map((given) => given.slot === "STEP" ? { ...given, version: -1 } : given)],
      ["fractional version",
        fullRoster().map((given) => given.slot === "STEP" ? { ...given, version: 1.5 } : given)],
    ];
    let swept = 0;
    for (const [label, observations] of cases) {
      swept += 1;
      expect(refusalCodeOf(observations), label)
        .toBe("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT@DAEMON_ATTEMPT_RELEASE_FENCE");
    }
    expect(swept).toBe(cases.length);
    expect(swept).toBeGreaterThan(0);
  });

  it("REFUSES a primary with no event: legs[0] must append", () => {
    const composed = composeAttemptReleaseFenceLegs(
      { aggregateId: RELEASE_AGGREGATE, events: [] }, fullRoster());
    expect(composed.ok).toBe(false);
    if (composed.ok) throw new Error("an eventless primary was composed");
    expect(composed.code).toBe("ATTEMPT_RELEASE_FENCE_ROSTER_INEXACT");
  });
});

describe("attempt release fence legs (task-06835dfa) — the conflict classifier", () => {
  it("answers each slot's OWN fault, swept over all seven", () => {
    const composed = composedOrThrow(fullRoster());
    const expected: Readonly<Record<AttemptReleaseFenceSlot, string>> = Object.freeze({
      ACTIVATION: "ATTEMPT_RELEASE_ATTEMPT_FENCE_STALE",
      BINDING: "ATTEMPT_RELEASE_BINDING_FENCE_STALE",
      DISPATCH: "ATTEMPT_RELEASE_ATTEMPT_FENCE_STALE",
      JOURNAL: "ATTEMPT_RELEASE_SOURCE_FENCE_STALE",
      PROVIDER_RUN: "ATTEMPT_RELEASE_SOURCE_FENCE_STALE",
      RESOURCE: "ATTEMPT_RELEASE_RESOURCE_FENCE_STALE",
      STEP: "ATTEMPT_RELEASE_SOURCE_FENCE_STALE",
    });
    let swept = 0;
    for (const entry of composed.roster) {
      swept += 1;
      const classified =
        classifyAttemptReleaseFenceConflict(composed.roster, entry.aggregateId);
      expect(classified, entry.slot).not.toBeNull();
      expect(classified?.code, entry.slot).toBe(expected[entry.slot]);
      expect(classified?.layer, entry.slot).toBe("DAEMON_ATTEMPT_RELEASE_FENCE");
    }
    expect(swept).toBe(7);
  });

  it("answers NULL for an id the roster does not carry, including the primary's", () => {
    const composed = composedOrThrow(fullRoster());
    // A FABRICATED DIAGNOSIS IS WORSE THAN NONE: answering a neighbouring slot's code
    // would name a fence that did not refuse.
    expect(classifyAttemptReleaseFenceConflict(composed.roster, RELEASE_AGGREGATE)).toBeNull();
    expect(classifyAttemptReleaseFenceConflict(composed.roster, "aggregate-nobody")).toBeNull();
  });
});

describe("attempt release fence legs (task-06835dfa) — the leg budget is the store's", () => {
  function ready(label: string): SqliteEventStore {
    const root = trackHarnessRoot(mkdtempSync(join(tmpdir(), `moe-fence-${label}-`)));
    const store = openHarnessStore(join(root, "project.db"));
    seedReadyProject(store);
    return store;
  }

  /** DRILL (LEG-BUDGET), DoD 1: nine legs is one more than the store admits, and the
   *  refusal must be the store's own stable code with ZERO events landed — not merely
   *  "it threw". Measured: `snapshotDenseArray` answers FIRST, so the reachable
   *  message is "legs cannot exceed 8 elements" and the code is STORE_LIMIT_EXCEEDED. */
  it("REFUSES nine legs under the store's own STORE_LIMIT_EXCEEDED, writing nothing", () => {
    const store = ready("limit");
    const payload = encoder.encode("{}");
    const legs = Array.from({ length: MAX_DECISION_LEGS + 1 }, (_unused, index) => ({
      aggregateId: `fence-budget-${String(index)}`,
      events: index === 0
        ? [{ eventId: "budget-primary", eventType: "TestFenceBudget", payload }]
        : [],
      expectedVersion: 0,
    }));
    expect(legs).toHaveLength(9);
    let code: unknown = null;
    try {
      store.commitExpectedVersionDecisionLegs({
        commandKind: "test.fence_budget", committedResultBytes: payload,
        correlationId: "corr-fence-budget", decidedAt: DECIDED_AT,
        key: { commandId: "cmd-fence-budget", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
        legs, requestBytes: payload,
      });
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe("STORE_LIMIT_EXCEEDED");
    // ZERO EVENTS, read out of the store: a decision that refused after appending its
    // primary would sail through a code assertion alone.
    for (const leg of legs) expect(store.readEvents(leg.aggregateId)).toEqual([]);
  });

  it("ACCEPTS one primary plus seven read-only fences — the shape this row commits", () => {
    const store = ready("accepts-eight");
    const payload = encoder.encode("{}");
    const composed = composedOrThrow(fullRoster().map((given) => ({ ...given, version: 0 })));
    const accepted = store.commitExpectedVersionDecisionLegs({
      commandKind: "test.fence_accepts", committedResultBytes: payload,
      correlationId: "corr-fence-accepts", decidedAt: DECIDED_AT,
      key: { commandId: "cmd-fence-accepts", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      legs: composed.legs, requestBytes: payload,
    });
    expect(accepted.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    // THE PRIMARY APPENDED AND NOT ONE FENCE DID. A fence that appended would have
    // taken receipt authority the store documents it as never granting.
    expect(store.getAggregateVersion(RELEASE_AGGREGATE)).toBe(1);
    for (const fence of composed.roster) {
      expect(store.getAggregateVersion(fence.aggregateId), fence.slot).toBe(0);
    }
  });

  it("REJECTS the whole decision when ONE fence is stale, naming that leg", () => {
    const store = ready("stale-fence");
    const payload = encoder.encode("{}");
    const roster = fullRoster().map((given) => ({ ...given, version: 0 }));
    const moved = roster.find(({ slot }) => slot === "JOURNAL");
    if (moved === undefined) throw new Error("the roster lost its journal slot");
    // A REAL append onto one fenced aggregate, so the leg's expectedVersion 0 is
    // genuinely stale rather than a number this test invented.
    store.commitExpectedVersionDecision({
      commandKind: "test.fence_move", committedResultBytes: payload,
      correlationId: "corr-fence-move", decidedAt: DECIDED_AT,
      events: [{ eventId: "fence-moved", eventType: "TestFenceMoved", payload }],
      expectedVersion: 0,
      key: { commandId: "cmd-fence-move", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      requestBytes: payload, targetAggregateId: moved.aggregateId,
    });
    const composed = composedOrThrow(roster);
    const rejected = store.commitExpectedVersionDecisionLegs({
      commandKind: "test.fence_stale", committedResultBytes: payload,
      correlationId: "corr-fence-stale", decidedAt: DECIDED_AT,
      key: { commandId: "cmd-fence-stale", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      legs: composed.legs, requestBytes: payload,
    });
    expect(rejected.decision.effectDisposition).toBe("NO_BUSINESS_EFFECT");
    expect(rejected.decision.resultCode).toBe("EXPECTED_VERSION_CONFLICT");
    // THE STALE LEG, NOT THE PRIMARY, and this is what the daemon classifies from.
    expect(rejected.decision.targetAggregateId).toBe(moved.aggregateId);
    expect(classifyAttemptReleaseFenceConflict(
      composed.roster, rejected.decision.targetAggregateId)?.code)
      .toBe("ATTEMPT_RELEASE_SOURCE_FENCE_STALE");
    // AND THE RELEASE ROW NEVER LANDED.
    expect(store.readEvents(RELEASE_AGGREGATE)).toEqual([]);
  });
});
