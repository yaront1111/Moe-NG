/**
 * DoD 1 — a crash at EVERY install boundary exposes either the old authority or
 * one verified quiesced restore, and never a blend of the two.
 *
 * The boundary list below is written OUT BY HAND and then set-compared against
 * the production enum in both directions. That redundancy is deliberate: a table
 * derived from the enum cannot police the enum, and a hand list alone silently
 * under-sweeps the day production grows a ninth boundary.
 *
 * Every verdict here is read off a production reader. `inspectRecoveryAnchor`
 * runs the production `verifySlot` over the current slot and publishes the
 * answer as `slotVerified`, so nothing in this file re-derives a digest or
 * decides for itself whether a slot is intact.
 */
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  RECOVERY_ANCHOR_ALLOWED_OPERATIONS,
  RECOVERY_ANCHOR_FAULT_POINTS,
  RECOVERY_ANCHOR_LAYER,
  RECOVERY_ANCHOR_REASON_CODES,
  RECOVERY_BINDING_SLOTS,
  inspectRecoveryAnchor,
  installRecoveryAnchor,
  resumeRecoveryAnchor,
  selectInactiveSlot,
} from "../../../packages/store/src/index.js";
import type {
  RecoveryAnchorFaultPoint,
  RecoveryAnchorInspectResult,
  RecoveryBindingSlot,
} from "../../../packages/store/src/index.js";

import { CrashSignal, anchorRequest, cleanupDisasterRoots, crashAt, seedGeneration } from "./disaster-harness.js";

/** Hand-written. Compared against production below; never derived from it. */
const HAND_WRITTEN_FAULT_POINTS = Object.freeze([
  "PREPARE",
  "INACTIVE_INSTALL",
  "TRANSACTION",
  "FILE_FSYNC",
  "DIRECTORY_PERSISTENCE",
  "VERIFICATION",
  "SWITCH",
  "INSTALLED_MARKER",
] as const);

/**
 * What the world must look like AFTER the crash at each boundary, stated per
 * point rather than as an or-of-eight, so a boundary that silently changes side
 * turns this file red instead of sliding into the other admissible arm.
 *
 * `OLD_AUTHORITY` — the pointer never moved; the prior slot is still current and
 * still verifies. `SWITCHED_UNMARKED` — the one atomic switch landed and the new
 * slot verifies, but the INSTALLED marker did not; the restore is durable and
 * quiesced, and only its state label lags.
 */
type Admissible = "OLD_AUTHORITY" | "SWITCHED_UNMARKED";

interface BoundaryExpectation {
  readonly admissible: Admissible;
  /** REFUSED means the resume is answered, with this code, at RECOVERY_ANCHOR. */
  readonly resume: "INSTALLED" | "RECOVERY_ANCHOR_COMMAND_MISMATCH";
}

const EXPECTED: Readonly<Record<RecoveryAnchorFaultPoint, BoundaryExpectation>> = Object.freeze({
  // Nothing has been published yet, so the anchor still belongs to the FIRST
  // command and a resume of the second is refused rather than adopted.
  PREPARE: { admissible: "OLD_AUTHORITY", resume: "RECOVERY_ANCHOR_COMMAND_MISMATCH" },
  INACTIVE_INSTALL: { admissible: "OLD_AUTHORITY", resume: "INSTALLED" },
  TRANSACTION: { admissible: "OLD_AUTHORITY", resume: "INSTALLED" },
  FILE_FSYNC: { admissible: "OLD_AUTHORITY", resume: "INSTALLED" },
  DIRECTORY_PERSISTENCE: { admissible: "OLD_AUTHORITY", resume: "INSTALLED" },
  VERIFICATION: { admissible: "OLD_AUTHORITY", resume: "INSTALLED" },
  SWITCH: { admissible: "OLD_AUTHORITY", resume: "INSTALLED" },
  INSTALLED_MARKER: { admissible: "SWITCHED_UNMARKED", resume: "INSTALLED" },
});

type Inspected = Extract<RecoveryAnchorInspectResult, { readonly outcome: "INSPECTED" }>;

/** Narrowing plus an assertion. It grades nothing; the reader already did. */
function expectInspected(result: RecoveryAnchorInspectResult): Inspected {
  expect(result.ok).toBe(true);
  expect(result.outcome).toBe("INSPECTED");
  return result as Inspected;
}

interface CrashWorld {
  readonly anchorRoot: string;
  readonly baselineDigest: string;
  readonly baselineSlot: RecoveryBindingSlot;
  readonly crash: unknown;
  readonly inspected: Inspected;
  readonly restoreRequest: Record<string, unknown>;
  readonly switchedSlot: RecoveryBindingSlot;
}

/**
 * Both refs are 64-hex: `encodeRecoveryBinding` refuses anything else with
 * RECOVERY_BINDING_FIELD_INVALID, and a fixture that tripped that guard would
 * never reach the boundary this file is about.
 */
const FIRST = Object.freeze({
  incarnationRef: "1a".repeat(32),
  keyEpochRef: "1b".repeat(32),
  restoreCommandId: "restore-command-first",
});

const SECOND = Object.freeze({
  incarnationRef: "2a".repeat(32),
  keyEpochRef: "2b".repeat(32),
  restoreCommandId: "restore-command-second",
});

/**
 * Install one anchor cleanly so an OLD authority genuinely exists, then attempt
 * a SECOND same-project restore that dies at `point`.
 */
async function crashAtBoundary(point: RecoveryAnchorFaultPoint): Promise<CrashWorld> {
  const generation = await seedGeneration(`anchor-${point.toLowerCase()}`);
  const anchorRoot = join(generation.root, "anchor");

  const first = await installRecoveryAnchor(anchorRequest({ anchorRoot, generation, ...FIRST }));
  if (!first.ok) throw new Error(`baseline install refused: ${first.code}`);
  expect(first.outcome).toBe("INSTALLED");

  const restoreRequest = anchorRequest({ anchorRoot, generation, ...SECOND });
  let crash: unknown = null;
  try {
    await installRecoveryAnchor({ ...restoreRequest, injectFault: crashAt(point) });
  } catch (error) {
    crash = error;
  }

  return Object.freeze({
    anchorRoot,
    baselineDigest: first.anchor.anchorDigest,
    baselineSlot: first.anchor.currentSlot,
    crash,
    inspected: expectInspected(await inspectRecoveryAnchor(anchorRoot)),
    restoreRequest,
    switchedSlot: selectInactiveSlot(first.anchor.currentSlot),
  });
}

describe("a crash at any recovery-anchor install boundary never blends two authorities", () => {
  afterAll(cleanupDisasterRoots);

  it("sweeps exactly the boundaries production enumerates, in both directions", () => {
    const hand = new Set<string>(HAND_WRITTEN_FAULT_POINTS);
    const production = new Set<string>(RECOVERY_ANCHOR_FAULT_POINTS);
    expect([...hand].filter((point) => !production.has(point))).toEqual([]);
    expect([...production].filter((point) => !hand.has(point))).toEqual([]);
    // A sweep that silently generated zero cases would pass every assertion in
    // this file, so the generated count is pinned outright.
    expect(HAND_WRITTEN_FAULT_POINTS.length).toBe(8);
    expect(Object.keys(EXPECTED)).toHaveLength(8);
    expect(new Set(Object.keys(EXPECTED))).toEqual(production);
    expect(RECOVERY_BINDING_SLOTS).toEqual(["ACTIVE", "PENDING"]);
  });

  it.each(HAND_WRITTEN_FAULT_POINTS)(
    "crashing at %s leaves exactly one admissible world",
    async (point) => {
      const expected = EXPECTED[point];
      const world = await crashAtBoundary(point);

      // The boundary must genuinely be injected, not merely named: a deleted
      // `fault?.(...)` call site completes the install and throws nothing.
      expect(world.crash).toBeInstanceOf(CrashSignal);
      expect((world.crash as CrashSignal).point).toBe(point);

      const { anchor, currentSlot, slotVerified } = world.inspected;
      const moved = currentSlot !== world.baselineSlot;

      // The mixture is refused explicitly, not by omission.
      expect(moved && !slotVerified).toBe(false);
      expect(anchor.state === "INSTALLED" && !slotVerified).toBe(false);
      expect(slotVerified).toBe(true);

      if (expected.admissible === "OLD_AUTHORITY") {
        expect(currentSlot).toBe(world.baselineSlot);
        expect(moved).toBe(false);
      } else {
        expect(currentSlot).toBe(world.switchedSlot);
        expect(moved).toBe(true);
      }

      // Only PREPARE dies before anything at all is published.
      expect(anchor.anchorDigest === world.baselineDigest).toBe(point === "PREPARE");

      // Whatever is exposed, it is exposed as a revoked, quiesced,
      // recovery-required world. The anchor selects a database; it never
      // reinstates authority.
      expect(anchor.restoredLifecycle).toBe("QUIESCED");
      expect(anchor.restoredReadiness).toBe("RECOVERY_REQUIRED");
      expect(anchor.restoredAuthorityRevoked).toBe(true);
      expect(world.inspected.mutatingOpenAllowed).toBe(false);
      expect(world.inspected.allowedOperations).toEqual(RECOVERY_ANCHOR_ALLOWED_OPERATIONS);
      expect([...RECOVERY_ANCHOR_ALLOWED_OPERATIONS]).toEqual(["INSPECT", "RESUME", "DISCARD"]);

      const resumed = await resumeRecoveryAnchor(world.restoreRequest);
      if (expected.resume === "INSTALLED") {
        if (!resumed.ok) throw new Error(`resume refused at ${resumed.layer}: ${resumed.code}`);
        expect(resumed.outcome).toBe("INSTALLED");
        const settled = expectInspected(await inspectRecoveryAnchor(world.anchorRoot));
        expect(settled.anchor.state).toBe("INSTALLED");
        expect(settled.currentSlot).toBe(world.switchedSlot);
        expect(settled.slotVerified).toBe(true);
        expect(settled.anchor.incarnationRef).toBe(SECOND.incarnationRef);
        expect(settled.anchor.keyEpochRef).toBe(SECOND.keyEpochRef);
      } else {
        expect(resumed.ok).toBe(false);
        if (resumed.ok) throw new Error("a resume of a foreign command must be refused");
        // The code AND the layer that answered, never merely "not ok".
        expect(resumed.code).toBe(expected.resume);
        expect(RECOVERY_ANCHOR_REASON_CODES).toContain(resumed.code);
        expect(resumed.layer).toBe(RECOVERY_ANCHOR_LAYER);
        expect(RECOVERY_ANCHOR_LAYER).toBe("RECOVERY_ANCHOR");
        expect(resumed.truth).toBe("UNKNOWN");
        expect(resumed.authority).toBe("NONE");
      }
    },
    60_000,
  );
});
