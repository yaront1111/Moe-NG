/**
 * The mission texts are the agents' only briefing — these arms pin the load-
 * bearing sentences: the compiler brief teaches the PRD read and the payload
 * shapes, states the single-slice fence and the policy-park stop rule, and
 * NEVER carries a suggested development payload (the demo `payloadFor` hint
 * proposing a hard-coded graph against a real PRD is the race it retires).
 */
import { describe, expect, it } from "vitest";

import { COMPILED_NODE_KEY_MAX_CHARS } from "../planning/compiled-authority-contracts.js";
import { codeMission, compilerMission, mission } from "./agent-mission-text.js";

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
    // The draft grammar, stated: a real seat spent fifteen submissions guessing the digest
    // shape and never learned the other required keys (2026-09-05).
    expect(text).toContain("BARE lowercase sha256 hex strings");
    expect(text).toContain("never objects");
    expect(text).toContain("supersedesCriterionId: null");
    expect(text).toContain("retiredRequirementIds: [], retiredCriterionIds: []");
    expect(text).toContain("work_release");
    // The success path takes the step off the surface before the seat releases (measured
    // 2026-09-05): the brief must say what to release with, or the seat has to guess.
    expect(text).toContain("WORK_ITEM_UNKNOWN");
    expect(text).toContain("claimAggregateVersion of your last successful read");
    expect(text).not.toContain("Suggested development payload");
  });

  it("briefs the decomposition step: structure only, the COMPLETE graph, policy park stops", () => {
    const text = compilerMission(
      "planning.submit_decomposition@run-1",
      "planning.submit_decomposition", EXPIRES, "run-1",
    );
    expect(text).toContain("gateRef");
    expect(text).toContain("product_contract_read");
    expect(text).toContain(
      "Plan the COMPLETE GRAPH as a dependency DAG: each criterion of the approved revision"
      + " bound by a single node, none left unbound and none bound twice, and dependsOn naming"
      + " the hard build order",
    );
    expect(text).toContain(
      "No self-edge, no unknown target, and nothing may depend on the completionNodeKey.",
    );
    expect(text).toContain("Every node binds at least one criterion");
    expect(text).toContain(`of at most ${String(COMPILED_NODE_KEY_MAX_CHARS)} characters`);
    expect(text).toContain("the daemon sorts nodes, criterionIds and dependsOn itself");
    // The seat is no longer told to plan one node — the daemon stopped refusing more, so the
    // retired instruction must not creep back in and starve the graph the compiler now seals.
    expect(text).not.toContain("exactly ONE node");
    expect(text).not.toContain("SMALLEST COMPLETE SLICE");
    expect(text).toContain("never authority bytes");
    expect(text).toContain("RUN_POLICY_UNCLASSIFIABLE");
    expect(text).not.toContain("Suggested development payload");
    // No triple supplied: the brief stays generic rather than inventing one.
    expect(text).not.toContain("The Gate 1 approval for this goal");
  });

  it("names the project the wrapper serves in the graph_get payload, for every builder", () => {
    expect(compilerMission(
      "planning.submit_decomposition@goal-1", "planning.submit_decomposition", EXPIRES, "goal-1",
      null, null, "proj-1",
    )).toContain('graph_get takes exactly {"projectId": "proj-1"} and nothing else');
    expect(mission("plan.propose@run-1", "plan.propose", EXPIRES, null, "proj-1"))
      .toContain('{"projectId": "proj-1"}');
    expect(codeMission("review.submit@node-1", "node-1", EXPIRES, {
      instructions: "do the thing", test: "pnpm test", title: "T", workspace: "/w",
    }, { accept: null, submit: null }, "proj-1")).toContain('{"projectId": "proj-1"}');
  });

  it("carries the goal's own operator instructions between markers, and none when absent", () => {
    const withInstructions = compilerMission(
      "planning.submit_decomposition@goal-2", "planning.submit_decomposition", EXPIRES, "goal-2",
      null, "REPLAN of goal-1: node node-a failed review 3 times.\n- [MAJOR verifier-test-failed] tests fail",
    );
    expect(withInstructions).toContain("<<<OPERATOR INSTRUCTIONS");
    expect(withInstructions).toContain("REPLAN of goal-1: node node-a failed review 3 times.");
    expect(withInstructions).toContain("under NEW node keys");
    const without = compilerMission(
      "planning.submit_decomposition@goal-2", "planning.submit_decomposition", EXPIRES, "goal-2", null, "  ",
    );
    expect(without).not.toContain("OPERATOR INSTRUCTIONS");
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

/**
 * The two facts a live seat could not deduce and burned a whole claim on. Asserted PER MISSION
 * rather than over a joined string: every seat spawns from one of these three builders, and a
 * sentence added to only one of them would leave the other two seats exactly as stuck.
 */
describe("every mission carries the seat-facing recovery and read facts", () => {
  const MISSIONS: readonly (readonly [string, string])[] = [
    ["codeMission", codeMission("review.submit@node-1", "node-1", EXPIRES, {
      instructions: "do the thing", test: "pnpm test", title: "T", workspace: "/w",
    }, { accept: null, submit: null })],
    ["compilerMission", compilerMission(
      "planning.submit_decomposition@goal-1", "planning.submit_decomposition", EXPIRES, "goal-1",
    )],
    ["mission", mission("plan.propose@run-1", "plan.propose", EXPIRES, null)],
  ];

  for (const [name, text] of MISSIONS) {
    it(`${name} names the observed version and bounds the retry to one`, () => {
      expect(text).toContain("actualVersion=<n>");
      expect(text).toContain("ONCE with expectedVersion = n");
      expect(text).toContain("then stop and report if it refuses again");
    });

    it(`${name} states the graph_get payload and its role's file permissions`, () => {
      expect(text).toContain('graph_get takes exactly {"projectId"');
      expect(text).toContain("and nothing else");
      if (name === "codeMission") {
        expect(text).toContain("You may edit files in your assigned workspace and run its tests");
        expect(text).not.toContain("no file-write tool");
      } else {
        expect(text).toContain("no file-write tool");
      }
      expect(text).toContain("report findings in your final message");
    });

    /**
     * The seat reported being told to "record a durable memory" — an instruction that is NOT in
     * moe-next's briefs (it came from the target project's own CLAUDE.md) and that this seat
     * cannot obey. The assertion is on the instruction's POLARITY, not on the word: the brief
     * must MENTION memories, because forbidding them is the whole point, so a flat
     * `not.toMatch(/write.*memor/)` would be unsatisfiable against the sentence the same plan
     * requires. Every clause containing "memor" must be the prohibition.
     */
    it(`${name} only ever mentions memories to forbid writing them`, () => {
      const clauses = text.split(/(?<=[.:;])\s+/).filter((clause) => /memor/i.test(clause));
      expect(clauses.length).toBeGreaterThan(0);
      for (const clause of clauses) {
        expect(clause).toContain(name === "codeMission"
          ? "do not try to write memories" : "do not try to write memories or files");
      }
      expect(text).not.toMatch(/(record|store|save|persist) (a |the |your )?(durable )?memor/i);
    });
  }
});
