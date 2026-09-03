import { afterEach, describe, expect, it } from "vitest";

import type { SqliteEventStore, StoredEvent } from "@moe/store";

import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses,
} from "../recovery/restore-test-harness.js";
import {
  FINAL_ATTEMPT_REF, finalizationWorld, withStoreOverride,
} from "./attempt-finalization-test-harness.js";
import { carriesBoundaryClaim, deriveSafeBoundary } from "./attempt-release-boundary.js";
import { SAFE_BOUNDARY_LOOKUP_LAYER } from "./attempt-safe-boundary-lookup.js";
import {
  SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, SAFE_BOUNDARY_OBSERVATION_LAYER,
  recordSafeBoundaryObservation,
} from "./safe-boundary-observation.js";

/**
 * TASK-RB: `deriveSafeBoundary` ASKS BEFORE IT WRITES.
 *
 * THE DEFECT THESE ARMS PIN. The producer commits at `expectedVersion: 0` on a
 * ref-derived aggregate, so the FIRST decision key owns that row for good. A
 * second release over one attempt necessarily carries a different `commandId`,
 * so a derivation that asks the producer UNCONDITIONALLY is refused
 * `SAFE_BOUNDARY_COMMIT_CONFLICT` — and the whole release refuses with it. The
 * producer's ownership rule is CORRECT and this file must not weaken it (ARM D);
 * what is wrong is asking twice.
 *
 * WHY EVERY ARM CALLS `deriveSafeBoundary` DIRECTLY, and not through a release.
 * `attempt-finalization-sources.ts:155-175` carries an IDENTICAL lookup-first
 * fence over the same delegate. Any scenario routed through `reReadSources`
 * therefore stays GREEN with this module's guard deleted — the sibling answers
 * first, and the suite would report that the SYSTEM refuses, not that THIS guard
 * does. The direct call is the only input where this module's own lookup is the
 * sole mechanism that can answer, which is the divergence the epic rail demands.
 * The sibling fence is deliberately RETAINED: deleting it to sharpen a drill
 * would make a mutant of this guard green and read as "no guard needed".
 *
 * Every arm drives real production over a real file-backed store seeded through
 * the production writers. No hand-built refusal stands in for a production call.
 */

const decoder = new TextDecoder(), encoder = new TextEncoder();

/** The durable row count for ONE attempt, read back from the store's own event
 *  stream rather than from any helper's bookkeeping. `attemptRef` is taken off
 *  the committed payload, which is the only place it durably exists. */
function observedRowsFor(store: SqliteEventStore, attemptRef: string): number {
  const page = store.readEventsByTypeAfter(SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, 0n, 200);
  return page.items.filter((event) => {
    const parsed = JSON.parse(decoder.decode(event.payload)) as { attemptRef?: unknown };
    return parsed.attemptRef === attemptRef;
  }).length;
}

/** The SECOND releaser's bound attempt: identical in every field the derivation
 *  reads EXCEPT the command id, which is exactly what a re-release varies. */
const reReleased = (
  bound: Parameters<typeof deriveSafeBoundary>[1], commandId: string,
): Parameters<typeof deriveSafeBoundary>[1] => Object.freeze({ ...bound, commandId });

afterEach(cleanupRestoreHarnesses);

describe("TASK-RB attempt release boundary — a second derivation is not a second write", () => {
  /**
   * ARM A — THE DIVERGENCE ARM. One base world, one attempt, one durable
   * provider-run record; two derivations varying ONLY `bound.commandId`. Both
   * must answer, both must answer the SAME boundary, and the store must still
   * hold exactly ONE observation row for that attempt.
   */
  it("TASK-RB answers a re-derivation from the standing row, writing nothing twice", () => {
    const world = finalizationWorld("rb-divergence");
    expect(observedRowsFor(world.store, FINAL_ATTEMPT_REF)).toBe(0);

    const first = deriveSafeBoundary(world.store, world.bound, world.record);
    if (!first.ok) throw new Error(`first derivation refused: ${first.code}`);
    const second = deriveSafeBoundary(
      world.store, reReleased(world.bound, "cmd-final-release-2"), world.record);
    if (!second.ok) throw new Error(`re-derivation refused: ${second.code}`);

    expect(first.safeBoundaryObserved).toBe(true);
    // The SAME durable fact, not a second opinion re-derived over the same run.
    expect(second.safeBoundaryObserved).toBe(first.safeBoundaryObserved);
    // Counted from the store itself: the second call asked, it did not write.
    expect(observedRowsFor(world.store, FINAL_ATTEMPT_REF)).toBe(1);
  });
});

describe("TASK-RB attempt release boundary — the lookup keeps its own provenance", () => {
  /**
   * ARM B1. The standing row is present but its stored bytes no longer decode,
   * so the DELEGATE refuses. That refusal must travel out under the LOOKUP's own
   * code and layer with the delegate's code as the message — never restamped as
   * the producer's `SAFE_BOUNDARY_COMMIT_CONFLICT`, and never a silent
   * fall-through that lets the producer answer over a corrupted observation.
   */
  it("TASK-RB carries UNRESOLVED at the lookup layer when the standing row will not decode", () => {
    const world = finalizationWorld("rb-unresolved");
    const seeded = deriveSafeBoundary(world.store, world.bound, world.record);
    if (!seeded.ok) throw new Error(`seed derivation refused: ${seeded.code}`);

    // ONLY the observation rows are tampered: a blanket throw would break the
    // provider-run read first and refuse for a different reason entirely. A
    // leading space still parses as JSON but no longer re-encodes to the durable
    // bytes, which is precisely what the delegate byte-compares.
    const tampered = withStoreOverride(world.store, {
      readEvents: (aggregateId: string): unknown =>
        world.store.readEvents(aggregateId).map((event: StoredEvent) =>
          event.eventType === SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE
            ? { ...event, payload: encoder.encode(` ${decoder.decode(event.payload)}`) }
            : event),
    });
    const refused = deriveSafeBoundary(
      tampered, reReleased(world.bound, "cmd-final-release-2"), world.record);

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("a corrupted standing observation was answered");
    expect(refused.code).toBe("SAFE_BOUNDARY_LOOKUP_UNRESOLVED");
    expect(refused.refusedBy).toBe(SAFE_BOUNDARY_LOOKUP_LAYER);
    // The DELEGATE's own code, kept verbatim so the original refuser survives.
    expect(refused.message).toBe("SAFE_BOUNDARY_OBSERVATION_UNREADABLE");
    // NOT the producer's conflict, which is what an unconditional write answers.
    expect(refused.code).not.toBe("SAFE_BOUNDARY_COMMIT_CONFLICT");
    expect(refused.refusedBy).not.toBe(SAFE_BOUNDARY_OBSERVATION_LAYER);
  });

  /**
   * ARM B2. A store that cannot report its horizon is an UNKNOWN, and an unknown
   * must not be answered by writing a fresh observation over it.
   */
  it("TASK-RB carries SCAN_UNREADABLE at the lookup layer when the horizon read throws", () => {
    const world = finalizationWorld("rb-scan-unreadable");
    const blind = withStoreOverride(world.store, {
      readEventHorizon: (): never => { throw new Error("HORIZON_DENIED"); },
    });
    const refused = deriveSafeBoundary(blind, world.bound, world.record);

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("an unreadable scan was answered");
    expect(refused.code).toBe("SAFE_BOUNDARY_LOOKUP_SCAN_UNREADABLE");
    expect(refused.refusedBy).toBe(SAFE_BOUNDARY_LOOKUP_LAYER);
    // Nothing upstream was consulted, so nothing upstream is quoted.
    expect(refused.message).toBeNull();
  });
});

describe("TASK-RB attempt release boundary — controls that must not regress", () => {
  /**
   * ARM C1. Asking first must not turn the producer OFF: a first-ever derivation
   * still WRITES. Without this control, a guard that carried EVERY lookup
   * refusal — ABSENT included — would satisfy ARM A while recording nothing.
   */
  it("TASK-RB still writes exactly one observation on a first-ever derivation", () => {
    const world = finalizationWorld("rb-first-write");
    expect(observedRowsFor(world.store, FINAL_ATTEMPT_REF)).toBe(0);
    const derived = deriveSafeBoundary(world.store, world.bound, world.record);
    if (!derived.ok) throw new Error(`first derivation refused: ${derived.code}`);
    expect(derived.safeBoundaryObserved).toBe(true);
    expect(observedRowsFor(world.store, FINAL_ATTEMPT_REF)).toBe(1);
  });

  /**
   * ARM C2. Lookup-first must not convert a fail-closed refusal into a pass. An
   * attempt the host recorded no run for reaches the PRODUCER and refuses under
   * the producer's own code and layer, exactly as before.
   */
  it("TASK-RB still refuses an unrecorded run under the producer's own layer", () => {
    const world = finalizationWorld("rb-no-run", { providerRun: false, terminal: false });
    const refused = deriveSafeBoundary(world.store, world.bound, world.record);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("an attempt with no durable run answered a boundary");
    expect(refused.code).toBe("SAFE_BOUNDARY_RUN_UNREADABLE");
    expect(refused.refusedBy).toBe(SAFE_BOUNDARY_OBSERVATION_LAYER);
    expect(observedRowsFor(world.store, FINAL_ATTEMPT_REF)).toBe(0);
  });

  /** ARM C3. The exact-record admission is untouched by this row. */
  it("TASK-RB still refuses any request that speaks about the boundary", () => {
    for (const request of [
      { safeBoundaryObserved: undefined }, { safeBoundaryObserved: false },
      { safeBoundaryObserved: true }, null, "not-a-request", 7,
    ]) {
      expect(carriesBoundaryClaim(request)).toBe(true);
    }
    // The discriminating control: an admission that answered `true` for
    // everything would satisfy the loop above while admitting nothing.
    expect(carriesBoundaryClaim({})).toBe(false);
    expect(carriesBoundaryClaim({ nodeKey: "dev-done" })).toBe(false);
  });
});

describe("TASK-RB attempt release boundary — the producer's ownership rule survives", () => {
  /**
   * ARM D — PARENT DoD 2. This row stops the release asking twice; it must not
   * weaken WHO owns an observation. Called DIRECTLY on the producer, a second
   * decision key over identical derived bytes is still a CONFLICT, still at the
   * producer's layer, and the store's own upstream code is still retained.
   */
  it("TASK-RB still refuses a different-key re-observation at the producer", () => {
    const world = finalizationWorld("rb-parent-dod2");
    const input = (commandId: string): unknown => ({
      attemptRef: FINAL_ATTEMPT_REF, correlationId: `corr-${commandId}`,
      key: { commandId, principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      projectId: PROJECT_ID, requestBytes: encoder.encode("rb-parent-dod2"),
    });
    const first = recordSafeBoundaryObservation(world.store, input("cmd-rb-d-1"));
    if (!first.ok) throw new Error(`first observation refused: ${first.code}`);
    const loser = recordSafeBoundaryObservation(world.store, input("cmd-rb-d-2"));

    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("a different-key re-observation was admitted");
    expect(loser.code).toBe("SAFE_BOUNDARY_COMMIT_CONFLICT");
    expect(loser.layer).toBe(SAFE_BOUNDARY_OBSERVATION_LAYER);
    expect(loser.upstreamCode).toBe("EXPECTED_VERSION_CONFLICT");
    expect(observedRowsFor(world.store, FINAL_ATTEMPT_REF)).toBe(1);
  });
});
