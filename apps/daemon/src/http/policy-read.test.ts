/**
 * The policy read over a REAL store driven by the production bootstrap sequence: two
 * evaluation slices installed (`policy.install` twice) and one evaluated (`policy.validate`),
 * exactly as `driveThrough` replays them. The verifier standing reader is injected in one
 * arm so the wire carries whatever it says, never a recomputation.
 */
import { afterEach, describe, expect, it } from "vitest";

import { PROJECT_ID, closeStores, driveThrough, openStore } from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";
import { createPolicyReadPort, emptyBody, handlePolicyReadRequest, sliceKindOf } from "./policy-read.js";
import type { PolicyReadPort, PolicyView } from "./policy-read.js";

afterEach(closeStores);
const encoder = new TextEncoder();

function policy(result: ReturnType<PolicyReadPort["readPolicy"]>): PolicyView {
  if (result.outcome !== "POLICY") throw new Error(`expected POLICY, got ${result.code}`);
  return result;
}

describe("createPolicyReadPort", () => {
  it("answers an empty policy for a project nothing has been installed on", () => {
    const store = openStore();
    driveThrough(store, "policy.install");
    const view = policy(createPolicyReadPort({ projectId: PROJECT_ID, store, readVerifier: () => ({ calibration: false, policy: false }) }).readPolicy());
    expect(view).toMatchObject({ aggregateVersion: 0, evaluations: [], slices: [], verifier: { calibration: false, policy: false } });
    expect(view.waivers.supported).toBe(false);
  });

  it("lists the installed slices with their kind, digest check and counts, and the evaluations latest first", () => {
    const store = openStore();
    driveThrough(store, "project.activate");
    const view = policy(createPolicyReadPort({ projectId: PROJECT_ID, store, readVerifier: () => ({ calibration: true, policy: false }) }).readPolicy());
    expect(view.aggregateVersion).toBe(3);
    expect(view.slices).toHaveLength(2);
    for (const slice of view.slices) {
      expect(slice.kind).toBe("EVALUATION");
      expect(slice.contentDigestMatches).toBe(true);
      expect(slice.sliceRef).toMatch(/^[0-9a-f]{64}$/u);
      expect(slice.installedAt).toMatch(/^\d{4}-/u);
      expect(slice.rules).toBeTypeOf("number");
    }
    expect(view.evaluations).toHaveLength(1);
    expect(view.slices.map((slice) => slice.sliceRef)).toContain(view.evaluations[0]?.policyRef);
    expect(view.evaluations[0]?.decidedAt).toMatch(/^\d{4}-/u);
    expect(view.evaluations[0]?.principalId).toBeTypeOf("string");
    expect(view.verifier).toEqual({ calibration: true, policy: false });
  });

  it("names each installed ref by what it is: the seed artifacts, an evaluation slice, or an artifact", () => {
    expect(sliceKindOf("moe-verifier-policy/1", { anything: true })).toBe("VERIFIER_POLICY");
    expect(sliceKindOf("moe-reviewer-calibration/1", { sentinelPassed: true })).toBe("REVIEWER_CALIBRATION");
    expect(sliceKindOf("a".repeat(64), { autoApprovalOptIns: [], rules: [], sliceRef: "a".repeat(64) })).toBe("EVALUATION");
    expect(sliceKindOf("a".repeat(64), { corpusRevision: "x" })).toBe("ARTIFACT");
    expect(sliceKindOf("some-artifact/2", { rules: [] })).toBe("ARTIFACT");
  });
});

describe("handlePolicyReadRequest", () => {
  const port: PolicyReadPort = { boundProjectId: "proj-0001", readPolicy: () => ({ code: "POLICY_READ_UNREADABLE", layer: "POLICY_READ", outcome: "REFUSED" }) };
  const request = (body: Uint8Array) => ({ body, credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });

  it("admits only an empty body", () => {
    expect(emptyBody(new Uint8Array())).toBe(true);
    expect(emptyBody(encoder.encode("{}"))).toBe(true);
    expect(emptyBody(encoder.encode('{"projectId":"p"}'))).toBe(false);
    expect(emptyBody(encoder.encode("[]"))).toBe(false);
  });

  it("gates on capability, port presence, project and body, then forwards", () => {
    expect(handlePolicyReadRequest({ authenticator: authenticator([CAPABILITIES.PLANNING]), policy: port }, request(encoder.encode("{}"))))
      .toMatchObject({ body: { code: "POLICY_READ_CAPABILITY_DENIED" }, kind: "REPLY" });
    expect(handlePolicyReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]) }, request(encoder.encode("{}"))))
      .toEqual({ code: "LISTENER_POLICY_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
    expect(handlePolicyReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), policy: { ...port, boundProjectId: "elsewhere" } }, request(encoder.encode("{}"))))
      .toMatchObject({ body: { code: "POLICY_READ_PROJECT_MISMATCH" } });
    expect(handlePolicyReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), policy: port }, request(encoder.encode('{"x":1}'))))
      .toEqual({ code: "LISTENER_POLICY_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
    expect(handlePolicyReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), policy: port }, request(new Uint8Array())))
      .toEqual({ body: { code: "POLICY_READ_UNREADABLE", layer: "POLICY_READ", outcome: "REFUSED" }, httpStatus: 200, kind: "REPLY" });
  });
});
