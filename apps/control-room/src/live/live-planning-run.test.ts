import { describe, expect, it } from "vitest";

import { mapPlanningRunAnswer, readPlanningRun } from "./live-planning-run.js";

/**
 * The PLAN-REVIEW read client (UI-6). mapPlanningRunAnswer is exercised over the
 * exact wire frames POST /planning/run/read emits (verified against
 * planning-run-read.ts): a sealed reviewable RUN, an UNSEALED RUN (plan/acceptance
 * null), the route's own three-key refusal, the auth adapter's { error, stage }
 * refusal, the listener's two-key refusal, a non-200 non-refusal, and a RUN whose
 * present plan is malformed (an ERROR, never a half-plan). readPlanningRun is
 * exercised with an injected post so the request body can be asserted EXACTLY.
 */

const AUTHORITY = Object.freeze({
  authorityRef: "planning-authority/run-live-1",
  bodiesDigest: "bd-1",
  envelopeDigest: null,
});

const PLAN = Object.freeze({
  affectedCriterionIds: ["crit-1"],
  affectedNodeIds: ["node-1"],
  planHash: "sub-hash-1",
  steps: [{ description: "Write the recovery contract", kind: "node.deliver", stepId: "step-1" }],
});

const ACCEPTANCE = Object.freeze({
  criteriaDigest: "cd-1",
  obligations: [{
    criterionId: "crit-1",
    evidenceRequirements: [{ evidenceRef: "ev-1", kind: "TEST", requirementId: "req-1" }],
    statement: "The store recovers from a fresh genesis",
    verificationRecipeRefs: ["recipe-1"],
  }],
});

const SEALED_RUN = Object.freeze({
  acceptance: ACCEPTANCE,
  authority: AUTHORITY,
  lifecycle: "PLAN_REVIEW",
  outcome: "RUN",
  plan: PLAN,
  reviewable: true,
  runId: "run-live-1",
  submissionHash: "sub-hash-1",
});

const UNSEALED_RUN = Object.freeze({
  acceptance: null,
  authority: null,
  lifecycle: "PLANNING",
  outcome: "RUN",
  plan: null,
  reviewable: false,
  runId: "run-live-1",
  submissionHash: "sub-hash-1",
});

function response(status: number, body: unknown): Response {
  return { json: async () => body, status } as unknown as Response;
}

describe("mapPlanningRunAnswer shapes the plan-review route's answer", () => {
  it("maps a full sealed reviewable RUN into its plan + acceptance views", () => {
    const outcome = mapPlanningRunAnswer(200, SEALED_RUN);
    expect(outcome).toStrictEqual({
      acceptance: {
        criteriaDigest: "cd-1",
        obligations: [{
          criterionId: "crit-1",
          evidenceRequirements: [{ evidenceRef: "ev-1", kind: "TEST", requirementId: "req-1" }],
          statement: "The store recovers from a fresh genesis",
          verificationRecipeRefs: ["recipe-1"],
        }],
      },
      lifecycle: "PLAN_REVIEW",
      plan: {
        affectedCriterionIds: ["crit-1"],
        affectedNodeIds: ["node-1"],
        planHash: "sub-hash-1",
        steps: [{ description: "Write the recovery contract", kind: "node.deliver", stepId: "step-1" }],
      },
      reviewable: true,
      runId: "run-live-1",
      sealed: true,
      status: "RUN",
      submissionHash: "sub-hash-1",
    });
  });

  it("maps a RUN with plan/acceptance null as an honest UNSEALED run", () => {
    const outcome = mapPlanningRunAnswer(200, UNSEALED_RUN);
    expect(outcome).toStrictEqual({
      acceptance: null,
      lifecycle: "PLANNING",
      plan: null,
      reviewable: false,
      runId: "run-live-1",
      sealed: false,
      status: "RUN",
      submissionHash: "sub-hash-1",
    });
  });

  it("carries the route's own three-key capability refusal at its own layer", () => {
    expect(mapPlanningRunAnswer(200, {
      code: "PLANNING_RUN_READ_CAPABILITY_DENIED",
      layer: "PLANNING_RUN_READ",
      outcome: "REFUSED",
    })).toStrictEqual({
      code: "PLANNING_RUN_READ_CAPABILITY_DENIED",
      layer: "PLANNING_RUN_READ",
      status: "REFUSED",
    });
  });

  it("carries an adapter auth refusal ({error,stage}) out at its stage layer", () => {
    expect(mapPlanningRunAnswer(401, {
      error: { code: "AUTHENTICATION_FAILED" },
      httpStatus: 401,
      ok: false,
      outcome: "REFUSED",
      stage: "AUTHENTICATE",
    })).toStrictEqual({
      code: "AUTHENTICATION_FAILED",
      layer: "AUTHENTICATE",
      status: "REFUSED",
    });
  });

  it("carries a listener refusal (two-key frame) out at its own layer", () => {
    expect(mapPlanningRunAnswer(503, {
      code: "LISTENER_PLANNING_RUN_UNAVAILABLE",
      layer: "CONTROL_ROOM_LISTENER",
    })).toStrictEqual({
      code: "LISTENER_PLANNING_RUN_UNAVAILABLE",
      layer: "CONTROL_ROOM_LISTENER",
      status: "REFUSED",
    });
  });

  it("carries the authenticator's PORT_REFUSED frame out at its stage layer", () => {
    // A credential valid at handshake time that is later revoked/expired: the
    // authenticator answers PORT_REFUSED, a distinct shape from the adapter REFUSED.
    expect(mapPlanningRunAnswer(401, {
      httpStatus: 401,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "SESSION_CREDENTIAL_REVOKED" },
      stage: "AUTHENTICATE",
    })).toStrictEqual({
      code: "SESSION_CREDENTIAL_REVOKED",
      layer: "AUTHENTICATE",
      status: "REFUSED",
    });
  });

  it("errors on a non-200 answer that is not a refusal", () => {
    expect(mapPlanningRunAnswer(500, { ok: true })).toStrictEqual({
      code: "PLANNING_RUN_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PLANNING",
      status: "ERROR",
    });
  });

  it("errors on a 200 RUN whose present plan carries a malformed step (never a half-plan)", () => {
    const malformed = { ...SEALED_RUN, plan: { ...PLAN, steps: [{ kind: "node.deliver", stepId: "step-1" }] } };
    expect(mapPlanningRunAnswer(200, malformed)).toStrictEqual({
      code: "PLANNING_RUN_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PLANNING",
      status: "ERROR",
    });
  });
});

describe("readPlanningRun sends only { runId } and maps the answer", () => {
  it("posts the request body EXACTLY {\"runId\":\"run-live-1\"} - no extra key", async () => {
    let captured: string | undefined;
    const outcome = await readPlanningRun({}, "run-live-1", (body) => {
      captured = body;
      return Promise.resolve(response(200, SEALED_RUN));
    });

    expect(outcome.status).toBe("RUN");
    const parsed = JSON.parse(captured ?? "") as Record<string, unknown>;
    expect(Object.keys(parsed)).toStrictEqual(["runId"]);
    expect(parsed).toStrictEqual({ runId: "run-live-1" });
  });

  it("maps a thrown round trip to a transport ERROR", async () => {
    const outcome = await readPlanningRun({}, "run-live-1", () => Promise.reject(new Error("boom")));
    expect(outcome).toStrictEqual({
      code: "TRANSPORT_REQUEST_FAILED",
      layer: "CONTROL_ROOM_LIVE_PLANNING",
      status: "ERROR",
    });
  });

  it("maps an unparseable body to an invalid-response ERROR", async () => {
    const bad = { json: () => Promise.reject(new Error("not json")), status: 200 } as unknown as Response;
    const outcome = await readPlanningRun({}, "run-live-1", () => Promise.resolve(bad));
    expect(outcome).toStrictEqual({
      code: "PLANNING_RUN_RESPONSE_INVALID",
      layer: "CONTROL_ROOM_LIVE_PLANNING",
      status: "ERROR",
    });
  });
});
