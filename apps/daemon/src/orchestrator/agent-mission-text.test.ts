/**
 * The mission texts are the agents' only briefing — these arms pin the load-
 * bearing sentences: the compiler brief teaches the PRD read and the payload
 * shapes, states the single-slice fence and the policy-park stop rule, and
 * NEVER carries a suggested development payload (the demo `payloadFor` hint
 * proposing a hard-coded graph against a real PRD is the race it retires).
 */
import { describe, expect, it } from "vitest";

import { compilerMission, mission } from "./agent-mission-text.js";

const EXPIRES = "2026-08-30T13:00:00.000Z";

describe("compilerMission", () => {
  it("briefs the contract-authoring step: read the PRD, draft, submit, no hints", () => {
    const text = compilerMission(
      "product_contract.propose_revision@goal-1",
      "product_contract.propose_revision", EXPIRES, "goal-1",
    );
    expect(text).toContain("documents_source_read");
    expect(text).toContain("nextOffset");
    expect(text).toContain('goal "goal-1"');
    expect(text).toContain("Never invent a product decision");
    expect(text).toContain('"draft"');
    expect(text).toContain("lineage must be null");
    expect(text).toContain("work_release");
    expect(text).not.toContain("Suggested development payload");
  });

  it("briefs the decomposition step: structure only, one slice, policy park stops", () => {
    const text = compilerMission(
      "planning.submit_decomposition@run-1",
      "planning.submit_decomposition", EXPIRES, "run-1",
    );
    expect(text).toContain("gateRef");
    expect(text).toContain("product_contract_read");
    expect(text).toContain("SMALLEST COMPLETE SLICE");
    expect(text).toContain("exactly ONE node");
    expect(text).toContain("never authority bytes");
    expect(text).toContain("RUN_POLICY_UNCLASSIFIABLE");
    expect(text).not.toContain("Suggested development payload");
    // No triple supplied: the brief stays generic rather than inventing one.
    expect(text).not.toContain("The Gate 1 approval for this goal");
  });

  it("embeds the daemon-resolved Gate 1 triple when the wrapper supplies it", () => {
    const text = compilerMission(
      "planning.submit_decomposition@goal-1",
      "planning.submit_decomposition", EXPIRES, "goal-1",
      { contractId: "contract-1", revisionDigest: "d".repeat(64), revisionId: "rev-1" },
    );
    expect(text).toContain("The Gate 1 approval for this goal is gateRef ");
    expect(text).toContain('"contractId":"contract-1"');
    expect(text).toContain('"revisionId":"rev-1"');
    expect(text).toContain(`"revisionDigest":"${"d".repeat(64)}"`);
  });

  it("stays distinct from the generic chain mission, which still carries hints", () => {
    const generic = mission("plan.propose@run-1", "plan.propose", EXPIRES, { runId: "run-1" });
    expect(generic).toContain("Suggested development payload");
    expect(generic).not.toContain("documents_source_read");
  });
});
