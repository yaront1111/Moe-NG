import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_COMMAND_ENVELOPE_VERSION } from "@moe/contracts";
import type { NextAllowedCommand } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { BOOTSTRAP_SCHEMA_VERSION } from "../bootstrap/bootstrap-contracts.js";
import { createStoreDependencies } from "../daemon-store-dependencies.js";
import type {
  AffordancePort, AffordanceSurface, AffordanceSurfaceResult, ChainStep,
} from "../http/affordance-contract.js";
import { DEFAULT_RUN_SUBJECT, workItemIdFor } from "../http/affordance-read.js";
import { HUMAN_ONLY_STEPS, OPERATOR_ACTIVATION_STEPS } from "./agent-spawn-contract.js";
import { staffableSteps, staffingSurfaceOf } from "./agent-staffing-surface.js";
import { createAgentWrapper } from "./agent-wrapper.js";
import type { SpawnRequest } from "./agent-wrapper.js";

/**
 * THE WRAPPER'S READ OF THE OFFER SURFACE, held through the production consumer.
 *
 * The staffing arms drive `createAgentWrapper().runOnce()` over a real store, because the loop
 * is what spends a seat: a test that only read `staffableSteps()` would prove the filter and
 * nothing about whether the wrapper is handed its answer. The raw port is run beside the view
 * on the same store as the positive control -- the ONLY difference between "two seats" and
 * "none" is this view.
 */

const OPERATOR = "staffing-view-operator-credential";
const PROJECT = "proj-staffing-view";
/** A stand-in child pid; never this process's own, for the reason agent-wrapper.test.ts gives. */
const CHILD_PID = 909_091;
// Real time base: the session authenticator judges expiry against the real clock.
const NOW = Date.now();

const LEGACY_PLANNING_ITEM = workItemIdFor("plan.propose", DEFAULT_RUN_SUBJECT);
const REGISTER_ITEM = workItemIdFor("project.register", PROJECT);

const readyStep = (kind: string, aggregateId: string, version = 0): ChainStep => Object.freeze({
  aggregateId, claim: null, claimAggregateVersion: 0, kind, missing: [],
  status: "READY" as const, version,
});

const offerOf = (kind: string, aggregateId: string, version = 0): NextAllowedCommand =>
  Object.freeze({
    commandEnvelopeVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
    commandId: `offer-${kind}-${aggregateId}`,
    commandKind: kind as NextAllowedCommand["commandKind"],
    expectedVersion: version,
    inputSchemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    targetAggregateId: aggregateId,
  });

function surfaceOf(
  steps: readonly ChainStep[], offers: readonly NextAllowedCommand[],
  planningGoalRefs: Readonly<Record<string, string>>,
): AffordanceSurface {
  return Object.freeze({
    nextAllowedCommands: Object.freeze([...offers]),
    outcome: "SURFACE" as const,
    planningAuthorityByRun: {},
    planningGoalRef: planningGoalRefs[DEFAULT_RUN_SUBJECT] ?? null,
    planningGoalRefs,
    steps: Object.freeze([...steps]),
  });
}

const portOf = (answer: AffordanceSurfaceResult): AffordancePort =>
  Object.freeze({ boundProjectId: PROJECT, readSurface: () => answer });

/**
 * THE MEASURED SURFACE, in miniature: the activation chain's first step READY with its offer,
 * exactly as affordance-read.ts pushes one for every unblocked bootstrap kind, and the legacy
 * planning row READY at the default subject with NO offer, because the goal that exists
 * (`goal-7`, run `run-goal-7`) does not own `run-live-1`.
 */
const MEASURED = surfaceOf(
  [readyStep("project.register", PROJECT), readyStep("plan.propose", DEFAULT_RUN_SUBJECT)],
  [offerOf("project.register", PROJECT)],
  { "run-goal-7": "goal-7" },
);

interface Harness {
  readonly dispose: () => void;
  readonly provider: ReturnType<typeof createStoreDependencies>;
}

function openHarness(): Harness {
  const sandbox = mkdtempSync(join(tmpdir(), "moe-staffing-view-"));
  const provider = createStoreDependencies({
    credential: OPERATOR, principalId: "operator-local", projectId: PROJECT,
    storePath: join(sandbox, "store.db"),
  });
  return {
    dispose: () => {
      provider.close();
      rmSync(sandbox, { force: true, recursive: true });
    },
    provider,
  };
}

/** A wrapper over `port` on the harness store, recording every admitted spawn request. */
function wrapperOver(
  harness: Harness, port: AffordancePort, prefix: string, started: SpawnRequest[],
): ReturnType<typeof createAgentWrapper> {
  let suffix = 0;
  return createAgentWrapper({
    affordances: port,
    claimTtlMs: 60_000,
    clock: () => NOW,
    deps: harness.provider.provide(),
    maxAgents: 2,
    mintSecret: () => `${prefix}-${String(suffix += 1).padStart(4, "0")}${"0".repeat(32)}`,
    operatorCredential: OPERATOR,
    projectId: PROJECT,
    // Held open for the whole case, so every assertion reads a pass whose children live.
    spawnAgent: async (request) => {
      started.push(request);
      return { exit: new Promise<void>(() => undefined), ok: true, pid: CHILD_PID };
    },
  });
}

describe("the staffing view withholds the measured seats from the wrapper", () => {
  it("staffs NEITHER a READY project.register nor an unoffered READY plan.propose@run-live-1 when a durable goal exists", async () => {
    const harness = openHarness();
    try {
      const started: SpawnRequest[] = [];
      const viewed = wrapperOver(harness, staffingSurfaceOf(portOf(MEASURED)), "view", started);

      const report = await viewed.runOnce();

      expect(report).toEqual({ active: 0, spawned: [], surfaceOutcome: "SURFACE" });
      expect(started).toEqual([]);

      // VACUITY CONTROLS. The raw surface really did present both as READY and UNCLAIMED, a
      // durable goal really does exist, and neither kind is in the loop's own fence -- so the
      // empty pass is THIS view's answer, not the human-only roster's and not an absent offer's.
      expect(MEASURED.steps.map((step) => workItemIdFor(step.kind, step.aggregateId)))
        .toEqual([REGISTER_ITEM, LEGACY_PLANNING_ITEM]);
      expect(MEASURED.steps.every((step) => step.status === "READY" && step.claim === null))
        .toBe(true);
      expect(Object.keys(MEASURED.planningGoalRefs)).toHaveLength(1);
      expect(HUMAN_ONLY_STEPS.has("project.register")).toBe(false);
      expect(HUMAN_ONLY_STEPS.has("plan.propose")).toBe(false);

      // THE POSITIVE CONTROL, on the SAME store: over the raw port the wrapper spends both
      // seats, which is the 2026-09-13 measurement this view exists to end.
      const raw = wrapperOver(harness, portOf(MEASURED), "raw", started);
      const measured = await raw.runOnce();
      expect(measured.spawned.map((entry) => [entry.workItemId, entry.outcome]))
        .toEqual([[REGISTER_ITEM, "SPAWNED"], [LEGACY_PLANNING_ITEM, "SPAWNED"]]);
      expect(started.map((request) => request.workItemId))
        .toEqual([REGISTER_ITEM, LEGACY_PLANNING_ITEM]);
    } finally {
      harness.dispose();
    }
  });

  it("keeps the legacy planning row where the ladder OFFERS it, so the seeded demo goal is staffed as before", async () => {
    // goal-live-1 owns run-live-1 (`refsOfGoal`), is not source-bound, and its plan is not yet
    // reviewable: the ladder mints `plan.propose@run-live-1` and the wrapper must still take it.
    const seeded = surfaceOf(
      [readyStep("plan.propose", DEFAULT_RUN_SUBJECT)],
      [offerOf("plan.propose", DEFAULT_RUN_SUBJECT)],
      { [DEFAULT_RUN_SUBJECT]: "goal-live-1" },
    );
    const harness = openHarness();
    try {
      const started: SpawnRequest[] = [];
      const viewed = wrapperOver(harness, staffingSurfaceOf(portOf(seeded)), "seed", started);

      const report = await viewed.runOnce();

      expect(report.spawned.map((entry) => [entry.workItemId, entry.outcome]))
        .toEqual([[LEGACY_PLANNING_ITEM, "SPAWNED"]]);
      expect(started.map((request) => request.workItemId)).toEqual([LEGACY_PLANNING_ITEM]);
    } finally {
      harness.dispose();
    }
  });
});

describe("staffableSteps", () => {
  it("pins the activation chain roster to exactly the six kinds the browser commits", () => {
    // Strict equality against a hand list, so a deletion from the roster reds here rather than
    // silently shrinking the sweep below.
    expect([...OPERATOR_ACTIVATION_STEPS].sort()).toStrictEqual([
      "policy.install", "policy.validate", "project.activate", "project.bind_repository",
      "project.register", "provider.probe",
    ]);
  });

  it("withholds every activation-chain kind, READY and offered, and proves the sweep ran", () => {
    const seen: string[] = [];
    for (const kind of [...OPERATOR_ACTIVATION_STEPS].sort()) {
      const surface = surfaceOf([readyStep(kind, PROJECT)], [offerOf(kind, PROJECT)], {});
      expect({ kind, staffable: staffableSteps(surface) }).toEqual({ kind, staffable: [] });
      seen.push(kind);
    }
    expect(seen).toHaveLength(6);
  });

  it("keys the legacy planning row on the OFFER, not on the goal refs: a source-bound goal's run is withheld", () => {
    // The compiler ladder withholds `plan.propose` for a source-bound goal and offers the
    // decomposition instead, yet the chain step can still sit READY at that goal's run.
    const compiled = surfaceOf(
      [readyStep("plan.propose", "run-goal-7"), readyStep("planning.submit_decomposition", "goal-7")],
      [offerOf("planning.submit_decomposition", "goal-7")],
      { "run-goal-7": "goal-7" },
    );
    expect(staffableSteps(compiled)).toEqual([readyStep("planning.submit_decomposition", "goal-7")]);
  });

  it("passes every other step through untouched, including a non-READY legacy planning row", () => {
    const committedPlan: ChainStep = Object.freeze({
      aggregateId: DEFAULT_RUN_SUBJECT, claim: null, claimAggregateVersion: 0,
      kind: "plan.propose", missing: [], status: "COMMITTED" as const, version: 2,
    });
    const kept = [
      readyStep("node.deliver", "node-1"),
      readyStep("design.submit", "design:goal-7"),
      readyStep("planning.submit_decomposition", "goal-7"),
      readyStep("product_contract.propose_revision", "goal-7"),
      readyStep("approval.decide", "run-goal-7"),
      committedPlan,
    ];
    const surface = surfaceOf(
      [readyStep("project.activate", PROJECT), ...kept],
      [offerOf("review.submit", "node-1")],
      { "run-goal-7": "goal-7" },
    );
    expect(staffableSteps(surface)).toEqual(kept);
  });
});

describe("staffingSurfaceOf", () => {
  it("rewrites only `steps`: project, offers and planning material are the raw port's own", () => {
    const view = staffingSurfaceOf(portOf(MEASURED));
    expect(view.boundProjectId).toBe(PROJECT);
    expect(view.readSurface()).toEqual({ ...MEASURED, steps: [] });
  });

  it("passes a refused read through untouched", () => {
    const refusal: AffordanceSurfaceResult = Object.freeze({
      code: "SESSION_LEDGER_UNREADABLE", detail: "unreadable", layer: "AFFORDANCE_SURFACE",
      outcome: "REFUSED" as const,
    });
    expect(staffingSurfaceOf(portOf(refusal)).readSurface()).toBe(refusal);
  });
});
