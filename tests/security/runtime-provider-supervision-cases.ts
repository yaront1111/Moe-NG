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

import { expect } from "vitest";

import { classifyCrash } from "../../packages/runner/src/recovery/crash-classification.js";
import { admitResume, admitSuccessorOverlap } from "../../packages/runner/src/recovery/safe-boundary.js";
import {
  collectRecoveryInventory, createRecoveryInventoryRegistry,
} from "../../packages/runner/src/recovery-inventory/recovery-inventory.js";
import {
  consumeActivationGrant, validateActivationCommit,
} from "../../packages/runner/src/supervisor/effect-grant.js";
import {
  settleEffectFromProviderObservation,
} from "../../packages/runner/src/supervisor/provider-effect-settlement.js";
import { probeAfter, probeBefore, probeRacing } from "./hostile-harness.js";
import {
  describeRuntimeProviderCases as describe,
  itRuntimeProviderCase as it,
} from "./runtime-provider-case-capture.js";
import { POISON_PATH } from "./runtime-provider-evidence-fixtures.js";
import { RUNTIME_BOUND as BOUND, hostile } from "./runtime-provider-ledger.js";
import type { Ledger } from "./runtime-provider-ledger.js";

export interface SupervisionLayers {
  readonly kernel: string;
  readonly safeBoundary: string;
  readonly classification: string;
  readonly inventory: string;
  readonly settlement: string;
}

/** A well-formed intent and observation, so every arm below is refused for the ONE hostile
 *  fact it introduces rather than by an earlier shape guard answering first. */
const SETTLEMENT_DIGEST = "b".repeat(64);
const SETTLEMENT_INTENT = {
  protocolVersion: "moe-effect-intent/1", intentId: "intent:settle", aggregateId: "aggregate:1",
  expectedGraphEpoch: 3,
  leaseBinding: {
    leaseId: "lease:1", kind: "ASSIGNMENT", ownerSessionRef: "session:1", leaseToken: "token:1",
    epoch: 3, state: "ACTIVE", serverWallDeadline: 90, bootId: "boot:1",
    monotonicObservation: 12, authorityHashRef: SETTLEMENT_DIGEST, version: 7,
  },
  inputBinding: SETTLEMENT_DIGEST, predecessorCursor: "cursor:1", desiredState: "RUNNING",
  idempotencyKey: "idem:1", runtimeObservationDigest: SETTLEMENT_DIGEST, state: "ACTIVE",
  version: 7,
};

function settlementRunRef(effectIntentId: string): Record<string, unknown> {
  return {
    provider: "claude", runRef: "run:1", effectIntentId, attemptRef: "attempt:1", epoch: 3,
  };
}

function settlementObservation(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    sourceVersion: "moe-provider-telemetry/1", sourceDigest: SETTLEMENT_DIGEST,
    runRef: settlementRunRef("intent:settle"), terminal: "COMPLETED", infrastructure: "NONE",
    upstreamRefusal: null, completedAt: { known: true, value: "2026-08-08T00:00:00.000Z" },
    ...overrides,
  };
}

export function describeSupervisionBoundaries(ledger: Ledger, layers: SupervisionLayers): void {
  const KERNEL = layers.kernel;
  const SAFE_BOUNDARY = layers.safeBoundary;
  const CLASSIFICATION = layers.classification;
  const INVENTORY = layers.inventory;
  const SETTLEMENT = layers.settlement;

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

  // ── PROVIDER_EFFECT_SETTLEMENT_LAYER ──────────────────────────────────────────────────────
  // The layer that refuses a provider-run observation BEFORE any effect settlement is derived
  // from it. Its refusals are its own: a refusal the reducer made keeps the reducer's
  // `LIFECYCLE` layer, so a case here answering with `LIFECYCLE` would be pinning the wrong
  // boundary. The outcome's `.failure` is what carries the code and the layer; handing the
  // wrapper straight to the ledger would read as an ADMISSION, which is why every arm unwraps.
  describe("PROVIDER_EFFECT_SETTLEMENT_LAYER", () => {
    const boundary = "PROVIDER_EFFECT_SETTLEMENT_LAYER";
    const settle = (observation: unknown): unknown => {
      const outcome = settleEffectFromProviderObservation(SETTLEMENT_INTENT, observation);
      return (outcome as { failure?: unknown }).failure ?? outcome;
    };
    const binding = { code: "PROVIDER_SETTLEMENT_EFFECT_BINDING_MISMATCH", layer: SETTLEMENT };
    const upstream = { code: "PROVIDER_SETTLEMENT_UPSTREAM_REFUSED", layer: SETTLEMENT };
    const malformed = { code: "PROVIDER_SETTLEMENT_OBSERVATION_MALFORMED", layer: SETTLEMENT };

    it("BEFORE — a foreign or upstream-refused run never reaches the settlement", async () => {
      const outcome = await probeBefore(
        BOUND,
        async () => settle(settlementObservation({ runRef: settlementRunRef("intent:foreign") })),
        async () =>
          settle(
            settlementObservation({
              upstreamRefusal: {
                ok: false, code: "TELEMETRY_RESULT_ABSENT", layer: "TELEMETRY_RESULT",
                message: "the capture holds no terminal result record",
              },
            }),
          ),
      );
      ledger.refused(boundary, "BEFORE", outcome.probe, binding);
      ledger.refused(boundary, "BEFORE", outcome.effect, upstream);
    });

    it("AFTER — an unrecorded and an unknown completion instant refuse apart", async () => {
      const outcome = await probeAfter(
        BOUND,
        async () =>
          settle(
            settlementObservation({
              completedAt: { known: false, code: "TELEMETRY_RESULT_ABSENT", layer: "TELEMETRY_RESULT" },
            }),
          ),
        async () => settle(settlementObservation({ completedAt: null })),
      );
      // Two DISTINCT codes at one layer: folding them would lose the difference between the
      // provider recording that it does not know and nothing being recorded at all.
      ledger.refused(boundary, "AFTER", outcome.effect, {
        code: "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_UNKNOWN", layer: SETTLEMENT,
      });
      ledger.refused(boundary, "AFTER", outcome.probe, {
        code: "PROVIDER_SETTLEMENT_COMPLETION_INSTANT_ABSENT", layer: SETTLEMENT,
      });
    });

    it("RACE — a proxied and an accessor-supplied observation both refuse as malformed", async () => {
      const accessor = settlementObservation();
      Object.defineProperty(accessor, "terminal", { get: () => "COMPLETED", enumerable: true });
      const outcome = await probeRacing(
        BOUND,
        async () => settle(new Proxy(settlementObservation(), {})),
        async () => settle(accessor),
      );
      for (const side of [outcome.left, outcome.right]) {
        expect(side.status).toBe("fulfilled");
        ledger.refused(boundary, "RACE", (side as { value: unknown }).value, malformed);
      }
    });
  });
}
