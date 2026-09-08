import { expect } from "vitest";

import { mapDeploymentsHealthAnswer } from "../../live/live-deployments-health.js";
import type { DeploymentsHealthOutcome } from "../../live/live-deployments-health.js";
import type { SurfaceFrame } from "../../live/live-board-feed.js";

/**
 * THE INCIDENT FRAMES, shared by the model arms and the card arms so both are shown the SAME
 * bytes. Every health view is produced by putting a WIRE BODY through the production decoder
 * `mapDeploymentsHealthAnswer` rather than hand-shaping a view: a hand-shaped view would let a
 * test assert a property the real wire never produces, and the error line is precisely the field
 * a re-shaped fixture would quietly tidy on the way in.
 */

export const OPENED_AT = "2026-09-08T01:14:52.000Z";
export const LAST_PROBE_AT = "2026-09-08T02:44:00.000Z";
/** The sha the daemon resolved off the RECEIPT it would spend, and the one a confirm must name. */
export const TARGET_SHA = "0b9c1f2a3d4e5f60718293a4b5c6d7e8f9012345";
export const TO_RECEIPT_REF = "c".repeat(64);
/** Leading whitespace, punctuation, an address and mixed case ON PURPOSE: a decoder or a
 *  renderer that trims, truncates or re-cases the operator's one real clue is caught by this. */
export const ERROR_LINE = "  Error: connect ECONNREFUSED 10.4.19.7:8443 (attempt 3/3)";

export function healthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: "production",
    incident: { id: 7, openedAt: OPENED_AT },
    lastError: {
      at: "2026-09-08T01:14:51.000Z", code: "DEPLOY_HEALTHCHECK_FAILED",
      layer: "DAEMON_DEPLOY_RUNNER", line: ERROR_LINE, source: "DEPLOY_RECEIPT",
    },
    lastProbe: { at: LAST_PROBE_AT, latencyMs: 12, status: "FAILURE" },
    latencySeries: { points: [{ at: OPENED_AT, latencyMs: 12 }], windowMinutes: 60 },
    ok: true,
    probeIntervalMs: 30_000,
    probeRefusal: null,
    rollbackSha: TARGET_SHA,
    rollbackTarget: {
      imageDigest: `sha256:${"a".repeat(64)}`, sha: TARGET_SHA, toReceiptRef: TO_RECEIPT_REF,
    },
    state: "DOWN",
    ...overrides,
  };
}

/** A DECODED health view. Asserts the fixture really decoded: an ERROR would make arms vacuous. */
export function health(overrides: Record<string, unknown> = {}): DeploymentsHealthOutcome {
  const outcome = mapDeploymentsHealthAnswer(200, healthBody(overrides));
  expect(outcome.status).toBe("DEPLOYMENTS_HEALTH");
  return outcome;
}

export const healthMap = (
  ...outcomes: readonly DeploymentsHealthOutcome[]
): ReadonlyMap<string, DeploymentsHealthOutcome> => new Map(outcomes.map((outcome, index) =>
  [outcome.status === "DEPLOYMENTS_HEALTH" ? outcome.environment : `unreadable-${String(index)}`,
    outcome]));

/** The daemon's `deployment.rollback` offer: the six keys `affordance-read.ts` `offer()` emits,
 *  at the PROJECT aggregate the handler fences (rollback-command.ts refuses anything else). */
export const rollbackOffer = (): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1",
  commandId: "2f1d6b0e-7a45-4c1e-9d38-5b2ac0e41f77",
  commandKind: "deployment.rollback",
  expectedVersion: 41,
  inputSchemaVersion: "deployment.rollback/1",
  targetAggregateId: "proj-unai",
});

export const approvalOffer = (): Record<string, unknown> => ({
  commandEnvelopeVersion: "moe-runtime-command/1", commandId: "cmd-run-goal-a",
  commandKind: "approval.decide_intent", expectedVersion: 2,
  inputSchemaVersion: "moe-bootstrap-command/1", targetAggregateId: "run-goal-a",
});

export function surface(offers: readonly Record<string, unknown>[]): SurfaceFrame {
  return {
    connection: "CONNECTED", detail: "", offers, outcome: "SURFACE", planningGoalRefs: {}, steps: [],
  };
}

export const refusedSurface = (): SurfaceFrame => ({
  connection: "CONNECTED", detail: "DENIED", offers: [], outcome: "REFUSED",
  planningGoalRefs: {}, steps: [],
});
