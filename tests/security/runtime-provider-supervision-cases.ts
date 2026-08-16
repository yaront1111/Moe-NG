/**
 * THE SUPERVISION, RECOVERY AND INVENTORY CASES, registered from one module.
 *
 * NOT a `*.security.ts` file: it registers its suites into the slice that calls it, exactly as
 * `describeSliceInvariants` and the render cases do, so these run inside
 * `runtime-provider-evidence.security.ts` and are counted there. Splitting them out is the
 * 400-line rail, not a scope decision.
 *
 * EVERY LAYER IS SUPPLIED BY THE CALLER, resolved from that boundary's OWN exported constant
 * via `layerOf`. Nothing here invents a layer, so a refusal that started answering with a
 * different boundary's layer reddens rather than passing.
 */

import { describe, expect, it } from "vitest";

import { classifyCrash } from "../../packages/runner/src/recovery/crash-classification.js";
import { admitResume, admitSuccessorOverlap } from "../../packages/runner/src/recovery/safe-boundary.js";
import {
  collectRecoveryInventory, createRecoveryInventoryRegistry,
} from "../../packages/runner/src/recovery-inventory/recovery-inventory.js";
import {
  consumeActivationGrant, validateActivationCommit,
} from "../../packages/runner/src/supervisor/effect-grant.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import { POISON_PATH } from "./runtime-provider-evidence-fixtures.js";
import { RUNTIME_BOUND as BOUND, hostile } from "./runtime-provider-ledger.js";
import type { Ledger } from "./runtime-provider-ledger.js";

export interface SupervisionLayers {
  readonly kernel: string;
  readonly safeBoundary: string;
  readonly classification: string;
  readonly inventory: string;
}

export function describeSupervisionBoundaries(ledger: Ledger, layers: SupervisionLayers): void {
  const KERNEL = layers.kernel;
  const SAFE_BOUNDARY = layers.safeBoundary;
  const CLASSIFICATION = layers.classification;
  const INVENTORY = layers.inventory;

  // ── SUPERVISOR_LAYERS ─────────────────────────────────────────────────────────────────────
  describe("SUPERVISOR_LAYERS", () => {
    const boundary = "SUPERVISOR_LAYERS";
    const intent = { code: "EFFECT_INTENT_MALFORMED", layer: KERNEL };
    const grant = { code: "EFFECT_GRANT_MALFORMED", layer: KERNEL };

    it("BEFORE — an activation commit over unusable records is refused by the kernel", async () => {
      const outcome = await probeBefore(
        BOUND,
        async () => validateActivationCommit(hostile(null), hostile(null), hostile(null)),
        async () => validateActivationCommit(hostile({ intentId: 1 }), hostile(null), hostile(null)),
      );
      ledger.refused(boundary, "BEFORE", (outcome.probe as { failure: unknown }).failure, intent);
      ledger.refused(boundary, "BEFORE", (outcome.effect as { failure: unknown }).failure, intent);
    });

    it("AFTER — a grant presented after it was consumed never yields a second launch", async () => {
      const spent = { grantId: "g", intentId: "i", attemptRef: "a", consumedBy: "someone-else" };
      const outcome = await probeAfter(
        BOUND,
        async () => consumeActivationGrant(hostile(spent), "wrapper"),
        async () => consumeActivationGrant(hostile(spent), "wrapper"),
      );
      // Presented twice, refused twice: replay confers nothing.
      ledger.refused(boundary, "AFTER", (outcome.effect as { failure: unknown }).failure, grant);
      ledger.refused(boundary, "AFTER", (outcome.probe as { failure: unknown }).failure, grant);
    });

    it("RACE — a malformed commit and a spent grant answer with DISTINCT codes", async () => {
      const outcome = await probeRacing(
        BOUND,
        async () => validateActivationCommit(hostile(null), hostile(null), hostile(null)),
        async () => consumeActivationGrant(hostile({ grantId: 1 }), "wrapper"),
      );
      ledger.refusedSide(
        boundary, { status: "fulfilled", value: (outcome.left as { value: { failure: unknown } }).value.failure }, intent,
      );
      ledger.refusedSide(
        boundary, { status: "fulfilled", value: (outcome.right as { value: { failure: unknown } }).value.failure }, grant,
      );
    });
  });

  // ── RECOVERY_LAYERS ───────────────────────────────────────────────────────────────────────
  describe("RECOVERY_LAYERS", () => {
    const boundary = "RECOVERY_LAYERS";
    const malformed = { code: "RECOVERY_BOUNDARY_MALFORMED", layer: SAFE_BOUNDARY };

    it("BEFORE — a resume request that is not a record cannot cross the safe boundary", async () => {
      const outcome = await probeBefore(
        BOUND,
        async () => admitResume(null),
        async () => admitResume(POISON_PATH),
      );
      ledger.refused(boundary, "BEFORE", (outcome.probe as { failure: unknown }).failure, malformed);
      ledger.refused(boundary, "BEFORE", (outcome.effect as { failure: unknown }).failure, malformed);
    });

    it("AFTER — a crash situation missing its authority answers at CLASSIFICATION, not the boundary", async () => {
      const outcome = await probeAfter(
        BOUND,
        async () => classifyCrash(null),
        async () => classifyCrash({ records: [], observation: null }),
      );
      const observationMalformed = { code: "RECOVERY_OBSERVATION_MALFORMED", layer: CLASSIFICATION };
      ledger.refused(boundary, "AFTER", (outcome.effect as { failure: unknown }).failure, observationMalformed);
      ledger.refused(boundary, "AFTER", (outcome.probe as { failure: unknown }).failure, observationMalformed);
    });

    it("RACE — an overlap and a resume contend; each keeps its own layer", async () => {
      const outcome = await probeRacing(
        BOUND,
        async () => admitSuccessorOverlap(null),
        async () => classifyCrash(null),
      );
      ledger.refusedSide(
        boundary, { status: "fulfilled", value: (outcome.left as { value: { failure: unknown } }).value.failure }, malformed,
      );
      ledger.refusedSide(
        boundary,
        { status: "fulfilled", value: (outcome.right as { value: { failure: unknown } }).value.failure },
        { code: "RECOVERY_OBSERVATION_MALFORMED", layer: CLASSIFICATION },
      );
    });
  });

  // ── RECOVERY_INVENTORY_LAYERS ─────────────────────────────────────────────────────────────
  describe("RECOVERY_INVENTORY_LAYERS", () => {
    const boundary = "RECOVERY_INVENTORY_LAYERS";
    const invalid = { code: "RECOVERY_INVENTORY_REQUEST_INVALID", layer: INVENTORY };
    const collect = async (request: unknown, registry: unknown = createRecoveryInventoryRegistry([])): Promise<unknown> =>
      await collectRecoveryInventory(request, hostile(registry));

    it("BEFORE — a request that is not a plain record enumerates nothing", async () => {
      const outcome = await probeBefore(BOUND, async () => await collect(null), async () => await collect(POISON_PATH));
      ledger.refused(boundary, "BEFORE", outcome.probe, invalid);
      ledger.refused(boundary, "BEFORE", outcome.effect, invalid);
    });

    it("AFTER — a request naming the wrong keys is refused rather than partially collected", async () => {
      const outcome = await probeAfter(
        BOUND,
        async () => await collect({ projectTag: "p" }),
        async () => await collect({ projectTag: "p", backup: null, incarnation: null, window: null, configuredClasses: null, extra: 1 }),
      );
      for (const observed of [outcome.effect, outcome.probe]) {
        expect((observed as { items?: unknown }).items).toBeUndefined();
        ledger.refused(boundary, "AFTER", observed, invalid);
      }
    });

    it("RACE — a hostile request and a hostile registry both refuse at INVENTORY_ADAPTER", async () => {
      const outcome = await probeRacing(
        BOUND,
        async () => await collect(null),
        async () => await collect({ projectTag: "p" }, null),
      );
      ledger.refusedSide(boundary, outcome.left, invalid);
      ledger.refusedSide(boundary, outcome.right, invalid);
    });
  });
}
