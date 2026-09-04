import { describe, expect, it } from "vitest";

import { mapHealthAnswer, mapPolicyAnswer, readHealth, readPolicy } from "./live-ops.js";

const POLICY = Object.freeze({
  aggregateVersion: 3,
  evaluations: [{ decidedAt: "2026-09-02T19:00:00.000Z", decision: "ALLOW", policyRef: "f".repeat(64), principalId: "operator-local" }],
  outcome: "POLICY",
  slices: [
    { autoApprovalOptIns: 0, contentDigestMatches: true, installedAt: "2026-09-02T18:00:00.000Z", kind: "EVALUATION", riskClassifications: 7, rules: 0, sliceRef: "f".repeat(64) },
    { autoApprovalOptIns: null, contentDigestMatches: null, installedAt: null, kind: "VERIFIER_POLICY", riskClassifications: null, rules: null, sliceRef: "moe-verifier-policy/1" },
  ],
  standard: [
    { installed: false, kind: "VERIFIER_POLICY", slice: { action: "integration.accept_output", sliceRef: "moe-verifier-policy/1" }, sliceRef: "moe-verifier-policy/1" },
  ],
  verifier: { calibration: true, policy: true },
  waivers: { reason: "No command on this daemon records a policy waiver.", supported: false },
});
/** The daemon's own five-key pause shape, as /health/read serves it. */
const PAUSED = Object.freeze({
  lastLine: "You've hit your weekly limit - resets Sep 8, 10:46am (Asia/Jerusalem)",
  provider: "claude", resetAt: "2026-09-02T20:30:00.000Z", since: "2026-09-02T20:00:00.000Z",
  workItemId: "node.deliver@node-1",
});
const HEALTH = Object.freeze({
  agents: { paused: null },
  daemon: { commandAuthorityPlane: "V1", nodeSpecsDir: null, pid: 4242, projectId: "unai", protocolVersion: "moe-runtime-command/1", startedAt: "2026-09-02T19:00:00.000Z", storePath: "D:/store.sqlite" },
  ledger: { aggregates: 12, commandKinds: 9, decisionCount: 40, goals: 2, lastDecidedAt: "2026-09-02T19:30:00.000Z" },
  outcome: "HEALTH", readAt: "2026-09-02T20:00:00.000Z", verifier: { calibration: true, policy: false },
});
const response = (status: number, body: unknown): Response => ({ json: async () => body, status } as unknown as Response);

describe("mapPolicyAnswer / mapHealthAnswer", () => {
  it("map exact frames verbatim", () => {
    expect(mapPolicyAnswer(200, POLICY)).toStrictEqual({
      aggregateVersion: 3, evaluations: POLICY.evaluations, slices: POLICY.slices, standard: POLICY.standard, status: "POLICY",
      verifier: { calibration: true, policy: true }, waivers: { reason: POLICY.waivers.reason, supported: false },
    });
    expect(mapHealthAnswer(200, HEALTH)).toStrictEqual({
      agents: HEALTH.agents, daemon: HEALTH.daemon, ledger: HEALTH.ledger, readAt: HEALTH.readAt, status: "HEALTH", verifier: HEALTH.verifier,
    });
    expect(mapHealthAnswer(200, { ...HEALTH, agents: { paused: PAUSED } })).toStrictEqual({
      agents: { paused: PAUSED }, daemon: HEALTH.daemon, ledger: HEALTH.ledger, readAt: HEALTH.readAt,
      status: "HEALTH", verifier: HEALTH.verifier,
    });
  });

  it("carry refusals at their layer and redden drifted frames", () => {
    expect(mapPolicyAnswer(503, { code: "LISTENER_POLICY_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER" }))
      .toStrictEqual({ code: "LISTENER_POLICY_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER", status: "REFUSED" });
    expect(mapHealthAnswer(200, { code: "HEALTH_READ_PROJECT_MISMATCH", layer: "HEALTH_READ", outcome: "REFUSED" }))
      .toStrictEqual({ code: "HEALTH_READ_PROJECT_MISMATCH", layer: "HEALTH_READ", status: "REFUSED" });
    const invalid = { code: "OPS_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_OPS", status: "ERROR" };
    expect(mapPolicyAnswer(200, { ...POLICY, slices: [{ ...POLICY.slices[0], kind: "OTHER" }] })).toStrictEqual(invalid);
    expect(mapPolicyAnswer(200, { ...POLICY, waivers: { reason: "r", supported: true } })).toStrictEqual(invalid);
    // A standard body whose sliceRef disagrees with its row is not a body the browser may install.
    expect(mapPolicyAnswer(200, { ...POLICY, standard: [{ ...POLICY.standard[0], slice: { sliceRef: "other" } }] })).toStrictEqual(invalid);
    expect(mapPolicyAnswer(200, { ...POLICY, standard: [{ ...POLICY.standard[0], kind: "ARTIFACT" }] })).toStrictEqual(invalid);
    expect(mapHealthAnswer(200, { ...HEALTH, daemon: { ...HEALTH.daemon, pid: "4242" } })).toStrictEqual(invalid);
    expect(mapHealthAnswer(200, { ...HEALTH, extra: 1 })).toStrictEqual(invalid);
    expect(mapHealthAnswer(500, {})).toStrictEqual(invalid);
    // A daemon too old to state whether the agents are paused may not be read as "not paused".
    const { agents: _dropped, ...withoutAgents } = HEALTH;
    expect(mapHealthAnswer(200, withoutAgents)).toStrictEqual(invalid);
    expect(mapHealthAnswer(200, { ...HEALTH, agents: undefined })).toStrictEqual(invalid);
    expect(mapHealthAnswer(200, { ...HEALTH, agents: { paused: null, extra: 1 } })).toStrictEqual(invalid);
    expect(mapHealthAnswer(200, { ...HEALTH, agents: { paused: { ...PAUSED, extra: 1 } } })).toStrictEqual(invalid);
    expect(mapHealthAnswer(200, { ...HEALTH, agents: { paused: { ...PAUSED, resetAt: 5 } } })).toStrictEqual(invalid);
    const { workItemId: _gone, ...missingKey } = PAUSED;
    expect(mapHealthAnswer(200, { ...HEALTH, agents: { paused: missingKey } })).toStrictEqual(invalid);
    // An empty last line is REAL (a pause whose cause never named one); it must not be refused.
    expect(mapHealthAnswer(200, { ...HEALTH, agents: { paused: { ...PAUSED, lastLine: "" } } }))
      .toMatchObject({ agents: { paused: { lastLine: "" } }, status: "HEALTH" });
  });
});

describe("readPolicy / readHealth", () => {
  it("post exactly {} and map the reply; transport failures are ERROR", async () => {
    const bodies: string[] = [];
    expect((await readPolicy({}, async (body) => { bodies.push(body); return response(200, POLICY); })).status).toBe("POLICY");
    expect((await readHealth({}, async (body) => { bodies.push(body); return response(200, HEALTH); })).status).toBe("HEALTH");
    expect(bodies).toEqual(["{}", "{}"]);
    expect(await readHealth({}, async () => { throw new Error("down"); }))
      .toStrictEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_OPS", status: "ERROR" });
  });
});
