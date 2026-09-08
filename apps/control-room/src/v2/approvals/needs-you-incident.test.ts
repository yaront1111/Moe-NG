import { describe, expect, it } from "vitest";

import { mapDeploymentsHealthAnswer } from "../../live/live-deployments-health.js";
import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import type { DocumentCoverageOutcome } from "../../live/live-document-coverage.js";
import type { GoalCatalogFrame } from "../../live/live-goal-catalog.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";
import { NEEDS_YOU_KINDS, deriveNeedsYou } from "./needs-you-model.js";
import { incidentKeyOf } from "./needs-you-incident.js";

/**
 * THE INCIDENT KIND at the model seam. Every health fixture here is built by POSTing a wire body
 * through the PRODUCTION decoder `mapDeploymentsHealthAnswer` rather than hand-shaping a view:
 * a hand-shaped view would let this file assert a property the real wire never produces, and the
 * error line is exactly the field a re-shaped fixture would quietly tidy.
 */

const OPENED_AT = "2026-09-08T01:14:52.000Z";
/** Leading whitespace, punctuation and mixed case ON PURPOSE: a decoder or renderer that trims,
 *  truncates or re-cases the operator's one real clue fails DoD 1 and this literal catches it. */
export const ERROR_LINE = "  Error: connect ECONNREFUSED 10.4.19.7:8443 (attempt 3/3)";

export function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: "production",
    incident: { id: 7, openedAt: OPENED_AT },
    lastError: {
      at: "2026-09-08T01:14:51.000Z", code: "DEPLOY_HEALTHCHECK_FAILED",
      layer: "DAEMON_DEPLOY_RUNNER", line: ERROR_LINE, source: "DEPLOY_RECEIPT",
    },
    lastProbe: { at: "2026-09-08T02:44:00.000Z", latencyMs: 12, status: "FAILURE" },
    latencySeries: { points: [{ at: OPENED_AT, latencyMs: 12 }], windowMinutes: 60 },
    ok: true,
    probeIntervalMs: 30_000,
    probeRefusal: null,
    rollbackSha: "0b9c1f2a3d4e5f60718293a4b5c6d7e8f9012345",
    rollbackTarget: {
      imageDigest: `sha256:${"a".repeat(64)}`,
      sha: "0b9c1f2a3d4e5f60718293a4b5c6d7e8f9012345", toReceiptRef: "c".repeat(64),
    },
    state: "DOWN",
    ...overrides,
  };
}

export function health(overrides: Record<string, unknown> = {}): DeploymentsHealthOutcome {
  const outcome = mapDeploymentsHealthAnswer(200, healthBody(overrides));
  // A fixture that silently decoded to an ERROR would make every arm below vacuously pass.
  expect(outcome.status).toBe("DEPLOYMENTS_HEALTH");
  return outcome;
}

export const healthMap = (
  ...outcomes: readonly DeploymentsHealthOutcome[]
): ReadonlyMap<string, DeploymentsHealthOutcome> => new Map(outcomes.map((outcome, index) =>
  [outcome.status === "DEPLOYMENTS_HEALTH" ? outcome.environment : `unreadable-${String(index)}`,
    outcome]));

/** The daemon's `deployment.rollback` offer: the six keys `affordance-read.ts` `offer()` emits. */
export const rollbackOffer = (): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "2f1d6b0e-7a45-4c1e-9d38-5b2ac0e41f77",
  commandKind: "deployment.rollback",
  expectedVersion: 41,
  inputSchemaVersion: "deployment.rollback/1",
  targetAggregateId: "proj-unai",
});

export function surface(offers: readonly Record<string, unknown>[]): SurfaceFrame {
  return {
    connection: "CONNECTED", detail: "", offers, outcome: "SURFACE", planningGoalRefs: {}, steps: [],
  };
}
const catalog = (): GoalCatalogFrame => ({
  connection: "CONNECTED", detail: "",
  goals: [{
    binding: null, brief: { instructions: "build", title: "Alpha" }, goalId: "goal-a",
    planningRunRef: "run-goal-a", truthClass: "DAEMON_VERIFIED",
  }],
  outcome: "GOALS",
});

const approvalOffer = (): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-run-goal-a",
  commandKind: "approval.decide_intent", expectedVersion: 2,
  inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "run-goal-a",
});

/** A contract still PENDING at Gate 1, which is what puts a GATE_1 item in the queue. */
const pendingCoverage = (): DocumentCoverageOutcome => ({
  contracts: [{
    contractId: "contract-goal-a", gate1: "PENDING", plane: "V1",
    requirements: [{
      criteria: [{ criterionId: "crit-0", nodeKey: null, nodeTestStatus: null, statement: "s",
        status: "PLANNED" }],
      requirementId: "req-1", statement: "r",
    }],
    revisionDigest: "d".repeat(64), revisionId: "rev-1",
  }],
  document: { byteLength: 10, contentSha256: "b".repeat(64), displayPath: "PRD.md" },
  goals: [{ goalId: "goal-a", lastActivityAt: null, lifecycle: "EXECUTION_ENABLED",
    planningRunRef: "run-goal-a", title: "Alpha" }],
  sections: null,
  status: "COVERAGE",
  totals: { contracts: 1, criteria: 1, goals: 1, planned: 1, requirements: 1, unattributable: 0,
    verified: 0 },
});

const derive = (
  input: Partial<Parameters<typeof deriveNeedsYou>[0]> = {},
): ReturnType<typeof deriveNeedsYou> => deriveNeedsYou({
  catalog: catalog(), coverage: new Map(), health: healthMap(health()),
  surface: surface([rollbackOffer()]), ...input,
});

describe("the incident kind joins the roster without disturbing the others", () => {
  // MEMBERSHIP, NOT A COUNT: peer rows are adding kinds to this roster concurrently, so a frozen
  // length would red on their landing rather than on a defect of this one.
  it("keeps every kind that existed and adds INCIDENT", () => {
    for (const kind of ["PLAN_APPROVAL", "PLAN_REJECTED", "PREVIEW", "RELEASE", "DEPLOY",
      "ESCALATION", "GATE_1", "READY_TO_CLOSE", "INCIDENT"]) {
      expect(NEEDS_YOU_KINDS).toContain(kind);
    }
  });

  // THROUGH THE PRODUCTION COMPARATOR, not a reimplementation of it: the risk this row carries is
  // that renumbering KIND_ORDER permuted the kinds that were already there.
  it("sorts an incident above every other kind and leaves their order untouched", () => {
    const withIncident = deriveNeedsYou({
      catalog: catalog(), coverage: new Map([["goal-a", pendingCoverage()]]),
      health: healthMap(health()), surface: surface([rollbackOffer(), approvalOffer()]),
    });
    expect(withIncident.items.map((item) => item.kind))
      .toEqual(["INCIDENT", "PLAN_APPROVAL", "GATE_1"]);
    // The SAME board with no incident: the other kinds keep exactly the order they had before
    // this row existed, so the renumbering moved nothing but the new entry.
    const withoutIncident = deriveNeedsYou({
      catalog: catalog(), coverage: new Map([["goal-a", pendingCoverage()]]),
      health: healthMap(health({ incident: null, state: "UP" })),
      surface: surface([rollbackOffer(), approvalOffer()]),
    });
    expect(withoutIncident.items.map((item) => item.kind)).toEqual(["PLAN_APPROVAL", "GATE_1"]);
  });
});

describe("an incident item is derived from the daemon's open incident", () => {
  it("lists one item per environment the daemon holds an open incident for", () => {
    const data = derive();
    const incident = data.items.find((item) => item.kind === "INCIDENT");
    expect(incident?.incident?.environment).toBe("production");
    expect(incident?.incident?.incidentId).toBe(7);
    // ROUTES TO AN ENVIRONMENT, SO IT CARRIES NO GOAL ID AT ALL - never an environment id in a
    // goal's field, which is what every other consumer of goalId would then be reading.
    expect(incident?.goalId).toBe("");
    expect(incident?.planningRunRef).toBe("");
    expect(incident?.headline).toBe(`production unhealthy since ${OPENED_AT}`);
  });

  it("carries the last error line VERBATIM, with its leading whitespace and case intact", () => {
    expect(derive().items.find((item) => item.kind === "INCIDENT")?.incident?.lastError?.line)
      .toBe(ERROR_LINE);
  });

  it("SINCE is the incident's own openedAt, not the last probe instant", () => {
    const incident = derive().items.find((item) => item.kind === "INCIDENT");
    expect(incident?.incident?.openedAt).toBe(OPENED_AT);
    expect(incident?.headline).not.toContain("2026-09-08T02:44:00.000Z");
  });

  it("lists nothing once the daemon closes the incident, and nothing for a refused read", () => {
    expect(derive({ health: healthMap(health({ incident: null, state: "UP" })) }).items)
      .toEqual([]);
    expect(derive({
      health: new Map([["production",
        mapDeploymentsHealthAnswer(200, { code: "PROBE_STORE_UNAVAILABLE", layer: "L", ok: false })]]),
    }).items).toEqual([]);
  });
});

describe("the rollback control exists only when the daemon offers it", () => {
  it("carries the daemon's offer and this environment's receipt-bound target", () => {
    const incident = derive().items.find((item) => item.kind === "INCIDENT");
    expect(incident?.incident?.rollback?.affordance).toEqual(rollbackOffer());
    expect(incident?.incident?.rollback?.target.toReceiptRef).toBe("c".repeat(64));
  });

  it("has NO rollback facts when the surface offers no rollback", () => {
    expect(derive({ surface: surface([]) }).items[0]?.incident?.rollback).toBeNull();
  });

  it("has NO rollback facts when THIS environment has no target to roll back to", () => {
    expect(derive({ health: healthMap(health({ rollbackTarget: null })) })
      .items[0]?.incident?.rollback).toBeNull();
  });

  it("has NO rollback facts when the surface itself is refused", () => {
    expect(derive({
      surface: { connection: "CONNECTED", detail: "DENIED", offers: [], outcome: "REFUSED",
        planningGoalRefs: {}, steps: [] },
    }).items[0]?.incident?.rollback).toBeNull();
  });
});

describe("dismissing an incident is not resolving it", () => {
  it("drops the dismissed incident from the queue", () => {
    expect(derive({ dismissedIncidents: new Set([incidentKeyOf("production", 7)]) }).items)
      .toEqual([]);
  });

  // DIRECTION 2, at the model seam. The probe row opens a NEW incident with a NEW id at the next
  // failure threshold, so a dismissal keyed on the incident cannot silence the next outage.
  it("returns at the next failure threshold, which the daemon raises under a new id", () => {
    const dismissed = new Set([incidentKeyOf("production", 7)]);
    const next = derive({
      dismissedIncidents: dismissed,
      health: healthMap(health({ incident: { id: 8, openedAt: "2026-09-08T03:02:00.000Z" } })),
    });
    expect(next.items.map((item) => item.incident?.incidentId)).toEqual([8]);
  });

  it("does not dismiss another environment's incident under the same id", () => {
    const other = health({ environment: "staging" });
    const data = derive({
      dismissedIncidents: new Set([incidentKeyOf("production", 7)]),
      health: healthMap(health(), other),
    });
    expect(data.items.map((item) => item.incident?.environment)).toEqual(["staging"]);
  });
});
