import { afterEach, describe, expect, it } from "vitest";

import {
  PRINCIPAL_ID, PROJECT_ID, cleanupRestoreHarnesses,
} from "../recovery/restore-test-harness.js";
import {
  SAFE_BOUNDARY_LOOKUP_CODES, SAFE_BOUNDARY_LOOKUP_LAYER, readCurrentSafeBoundaryObservation,
} from "./attempt-safe-boundary-lookup.js";
import {
  SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, SAFE_BOUNDARY_OBSERVATION_LAYER,
  readSafeBoundaryObservation, recordSafeBoundaryObservation,
} from "./safe-boundary-observation.js";
import {
  FINAL_ACTIVATION_AGGREGATE, FINAL_ATTEMPT_REF, finalizationWorld, withStoreOverride,
} from "./attempt-finalization-test-harness.js";

/**
 * DoD 3 (task-48c79a29): the strict project+attempt CURRENT safe-boundary lookup.
 *
 * The gap it closes is measured, not assumed: the safe-boundary event DOES carry
 * `observationRef` (`safe-boundary-observation.ts:184/:203`) but the release
 * carrier keeps only `safeBoundaryObserved` (`attempt-release-boundary.ts:97-99`),
 * and `readSafeBoundaryObservation` is keyed by that ref alone — so no
 * attempt-keyed selector existed anywhere.
 *
 * THE SCAN LOCATES; THE DELEGATE DECIDES. Every arm below grades that division:
 * the scan filters by ATTEMPT only, and PROJECT OWNERSHIP is
 * `readSafeBoundaryObservation`'s call. A lookup that answered from the bytes it
 * scanned would hand back a foreign project's observation and redden the
 * cross-project arm.
 */

const encoder = new TextEncoder();

afterEach(cleanupRestoreHarnesses);

function observe(
  store: Parameters<typeof recordSafeBoundaryObservation>[0], label: string,
  attemptRef = FINAL_ATTEMPT_REF, projectId = PROJECT_ID,
): string {
  const written = recordSafeBoundaryObservation(store, {
    attemptRef, correlationId: `corr-${label}`,
    key: { commandId: `cmd-${label}`, principalId: PRINCIPAL_ID, projectId },
    projectId,
    requestBytes: encoder.encode(JSON.stringify([projectId, attemptRef, label])),
  });
  if (!written.ok) throw new Error(`observation refused: ${written.code}/${written.upstreamCode}`);
  return written.observation.observationRef;
}

describe("attempt safe-boundary lookup (task-48c79a29) — vocabulary", () => {
  it("declares a closed code set and one layer, with no producer code restated", () => {
    expect([...SAFE_BOUNDARY_LOOKUP_CODES]).toEqual([
      "SAFE_BOUNDARY_LOOKUP_ABSENT", "SAFE_BOUNDARY_LOOKUP_QUERY_MALFORMED",
      "SAFE_BOUNDARY_LOOKUP_SCAN_UNREADABLE", "SAFE_BOUNDARY_LOOKUP_UNRESOLVED",
    ]);
    expect(SAFE_BOUNDARY_LOOKUP_LAYER).toBe("DAEMON_SAFE_BOUNDARY_LOOKUP");
    expect(SAFE_BOUNDARY_LOOKUP_LAYER).not.toBe(SAFE_BOUNDARY_OBSERVATION_LAYER);
    expect(Object.isFrozen(SAFE_BOUNDARY_LOOKUP_CODES)).toBe(true);
  });
});

describe("attempt safe-boundary lookup (task-48c79a29) — the producer-owned ref", () => {
  it("answers the ref the producer derived, and the observation the delegate certified", () => {
    const { store } = finalizationWorld("lookup-hit");
    const ref = observe(store, "lookup-hit");
    const found = readCurrentSafeBoundaryObservation(
      store, { attemptRef: FINAL_ATTEMPT_REF, projectId: PROJECT_ID });
    if (!found.ok) throw new Error(`lookup refused: ${found.code}`);

    // The ref is the PRODUCER's, byte for byte — never recomputed here.
    expect(found.observationRef).toBe(ref);
    // And it is read off the DELEGATE's answer, not off the scanned bytes.
    expect(found.observationRef).toBe(found.observation.observationRef);
    const delegated = readSafeBoundaryObservation(store, { observationRef: ref, projectId: PROJECT_ID });
    if (!delegated.ok) throw new Error("the delegate refused its own ref");
    expect(found.observation).toEqual(delegated.observation);
    expect(found.observation.safeBoundaryObserved).toBe(true);
    expect(found.observation.attemptRef).toBe(FINAL_ATTEMPT_REF);
    expect(Object.isFrozen(found.observation)).toBe(true);
  });

  /**
   * MEASURED, NOT ASSUMED: the producer pins `expectedVersion: 0` on a ref-derived
   * aggregate, so the FIRST observation of a run is the only row that aggregate
   * can ever hold. A re-observation under a DIFFERENT decision key — which is what
   * the dispatch-time release and the post-verification finalization necessarily
   * are — derives byte-for-byte the same record and REPLAYS onto it rather than
   * conflicting. Exactly ONE raw row either way, which is what makes "the current
   * observation" a single answer rather than a choice between two.
   */
  it("replays a different-key re-observation onto the one standing row", () => {
    const { store } = finalizationWorld("lookup-replay");
    const first = observe(store, "lookup-replay");
    expect(observe(store, "lookup-replay")).toBe(first);
    const again = recordSafeBoundaryObservation(store, {
      attemptRef: FINAL_ATTEMPT_REF, correlationId: "corr-lookup-replay-2",
      key: { commandId: "cmd-lookup-replay-2", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      projectId: PROJECT_ID, requestBytes: encoder.encode("second"),
    });
    if (!again.ok) throw new Error(`an agreeing re-observation was refused: ${again.code}`);
    // REPLAYED, not COMMITTED: nothing was written, the standing row answered.
    expect(again.disposition).toBe("REPLAYED");
    expect(again.observation.observationRef).toBe(first);

    const rows = store.readEventsByTypeAfter(SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, 0n, 200);
    expect(rows.items).toHaveLength(1);
    const found = readCurrentSafeBoundaryObservation(
      store, { attemptRef: FINAL_ATTEMPT_REF, projectId: PROJECT_ID });
    expect(found.ok && found.observationRef).toBe(first);
  });

  /**
   * AND THE CONFLICT REFUSAL IS STILL ALIVE. The replay above is byte equality
   * against the STANDING row, so a store that cannot hand that row back has not
   * agreed with anything: it refuses COMMIT_CONFLICT exactly as before. Without
   * this arm the replay would have quietly retired the refusal.
   */
  it("still refuses COMMIT_CONFLICT when the standing row cannot be read back", () => {
    const { store } = finalizationWorld("lookup-conflict");
    const standing = recordSafeBoundaryObservation(store, {
      attemptRef: FINAL_ATTEMPT_REF, correlationId: "corr-lookup-conflict",
      key: { commandId: "cmd-lookup-conflict", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      projectId: PROJECT_ID, requestBytes: encoder.encode("first"),
    });
    if (!standing.ok) throw new Error(`observation refused: ${standing.code}`);
    // ONLY the observation aggregate is unreadable: a blanket throw would break the
    // provider-run read first and refuse for a different reason entirely.
    const blind = withStoreOverride(store, {
      readEvents: (aggregateId: string): unknown => {
        if (aggregateId === standing.aggregateId) throw new Error("READBACK_DENIED");
        return store.readEvents(aggregateId);
      },
    });
    const conflicting = recordSafeBoundaryObservation(blind, {
      attemptRef: FINAL_ATTEMPT_REF, correlationId: "corr-lookup-conflict-2",
      key: { commandId: "cmd-lookup-conflict-2", principalId: PRINCIPAL_ID, projectId: PROJECT_ID },
      projectId: PROJECT_ID, requestBytes: encoder.encode("second"),
    });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error("an unverifiable re-observation was admitted");
    expect(conflicting.code).toBe("SAFE_BOUNDARY_COMMIT_CONFLICT");
    expect(conflicting.layer).toBe(SAFE_BOUNDARY_OBSERVATION_LAYER);
  });
});

describe("attempt safe-boundary lookup (task-48c79a29) — fail-closed", () => {
  it("refuses ABSENT under its own layer when the attempt observed nothing", () => {
    const { store } = finalizationWorld("lookup-absent");
    const found = readCurrentSafeBoundaryObservation(
      store, { attemptRef: FINAL_ATTEMPT_REF, projectId: PROJECT_ID });
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("an unobserved attempt answered a boundary");
    expect(found.code).toBe("SAFE_BOUNDARY_LOOKUP_ABSENT");
    expect(found.layer).toBe(SAFE_BOUNDARY_LOOKUP_LAYER);
    // Nothing upstream was consulted, so nothing upstream is quoted.
    expect(found.source).toBeNull();
  });

  it("refuses ABSENT for a foreign attempt while another attempt's row stands", () => {
    const { store } = finalizationWorld("lookup-foreign-attempt");
    observe(store, "lookup-foreign-attempt");
    const found = readCurrentSafeBoundaryObservation(
      store, { attemptRef: "attempt-someone-else", projectId: PROJECT_ID });
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("a foreign attempt was answered");
    expect(found.code).toBe("SAFE_BOUNDARY_LOOKUP_ABSENT");
  });

  /**
   * THE DELEGATION ARM. The scan locates this row by ATTEMPT and never judges the
   * project; `readSafeBoundaryObservation` does, and its PROJECT_MISMATCH arrives
   * verbatim with its own layer. A lookup that answered from the bytes it scanned
   * would return the observation and this case would go green while the strictness
   * it is named for had vanished.
   */
  it("carries the delegate's own PROJECT_MISMATCH refusal rather than deciding it", () => {
    const { store } = finalizationWorld("lookup-foreign-project");
    observe(store, "lookup-foreign-project");
    const found = readCurrentSafeBoundaryObservation(
      store, { attemptRef: FINAL_ATTEMPT_REF, projectId: "proj-not-this-one" });
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("a foreign project was answered");
    expect(found.code).toBe("SAFE_BOUNDARY_LOOKUP_UNRESOLVED");
    expect(found.layer).toBe(SAFE_BOUNDARY_LOOKUP_LAYER);
    expect(found.source).toEqual({
      code: "SAFE_BOUNDARY_OBSERVATION_ABSENT", layer: SAFE_BOUNDARY_OBSERVATION_LAYER,
    });
  });

  it("refuses a malformed query before reading anything", () => {
    const { store } = finalizationWorld("lookup-malformed");
    for (const query of [
      { attemptRef: "", projectId: PROJECT_ID },
      { attemptRef: FINAL_ATTEMPT_REF, projectId: "" },
    ]) {
      const found = readCurrentSafeBoundaryObservation(store, query);
      expect(found.ok).toBe(false);
      if (found.ok) throw new Error("a malformed query was answered");
      expect(found.code).toBe("SAFE_BOUNDARY_LOOKUP_QUERY_MALFORMED");
      expect(found.layer).toBe(SAFE_BOUNDARY_LOOKUP_LAYER);
    }
  });

  it("carries the store's own failure as SCAN_UNREADABLE, never as an absence", () => {
    const { store } = finalizationWorld("lookup-scan-throw");
    observe(store, "lookup-scan-throw");
    const hostile = new Proxy(store, {
      get(target, key, receiver): unknown {
        if (key === "readEventsByTypeAfter") {
          return (): never => { throw new Error("SCAN_DENIED"); };
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const found = readCurrentSafeBoundaryObservation(
      hostile, { attemptRef: FINAL_ATTEMPT_REF, projectId: PROJECT_ID });
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("an unreadable scan was answered");
    expect(found.code).toBe("SAFE_BOUNDARY_LOOKUP_SCAN_UNREADABLE");
    expect(found.layer).toBe(SAFE_BOUNDARY_LOOKUP_LAYER);
  });
});

describe("attempt safe-boundary lookup (task-48c79a29) — the scanned vocabulary", () => {
  it("scans the producer's own event type, imported rather than restated", () => {
    const { store } = finalizationWorld("lookup-vocabulary");
    observe(store, "lookup-vocabulary");
    expect(SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE).toBe("SafeBoundaryObserved");
    const page = store.readEventsByTypeAfter(SAFE_BOUNDARY_OBSERVATION_EVENT_TYPE, 0n, 200);
    // A NONZERO swept set: a scan that silently produced no rows would make every
    // arm above pass for the wrong reason.
    expect(page.items.length).toBeGreaterThan(0);
    expect(store.readEvents(FINAL_ACTIVATION_AGGREGATE).length).toBeGreaterThan(0);
  });
});
