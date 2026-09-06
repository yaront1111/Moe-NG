/**
 * The mission texts are the agents' only briefing — these arms pin the load-
 * bearing sentences: the compiler brief teaches the PRD read and the payload
 * shapes, states the single-slice fence and the policy-park stop rule, and
 * NEVER carries a suggested development payload (the demo `payloadFor` hint
 * proposing a hard-coded graph against a real PRD is the race it retires).
 */
import { describe, expect, it } from "vitest";

import { COMPILED_NODE_KEY_MAX_CHARS } from "../planning/compiled-authority-contracts.js";
import { DESIGN_SECTION_KEYS } from "../design/design-contracts.js";
import type { DesignBrief } from "./agent-mission-text.js";
import { codeMission, compilerMission, designMission, mission }
  from "./agent-mission-text.js";

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
 * THE ROW'S CENTRAL PROMISE: a design that is SKIPPED is STATED, never omitted.
 *
 * A compiler seat that simply receives no design section cannot tell "the operator decided to
 * plan without one" from "the read failed", and a seat that cannot tell will guess. So the
 * three outcomes are asserted as MUTUALLY DISTINGUISHABLE strings, not merely as three calls
 * that each contain something: the drill in step 5 collapses the skipped branch into the
 * absent branch, and only the cross-assertions below go red when it does.
 */
describe("the design outcome the compiler seat is handed", () => {
  const PRESENT: DesignBrief = {
    entities: ["Account", "Session"], outcome: "PRESENT", ref: "design:goal-1",
    screens: ["Dashboard", "Settings"],
  };
  const SKIPPED: DesignBrief = { outcome: "SKIPPED", reason: "a one-page internal tool" };
  const decomposition = (design: DesignBrief | null): string => compilerMission(
    "planning.submit_decomposition@goal-1", "planning.submit_decomposition", EXPIRES, "goal-1",
    null, null, null, design,
  );

  it("carries the design ref and all five section headings when a design exists", () => {
    const text = decomposition(PRESENT);
    expect(text).toContain("A DESIGN EXISTS for this goal");
    expect(text).toContain('design ref "design:goal-1"');
    expect(text).toContain("design_read");
    for (const section of DESIGN_SECTION_KEYS) expect(text).toContain(section);
    // The sweep's denominator, so a roster deletion cannot shrink this loop silently.
    expect(DESIGN_SECTION_KEYS.length).toBe(5);
  });

  it("STATES that the design step was skipped, and carries the operator's reason", () => {
    const text = decomposition(SKIPPED);
    expect(text).toContain("BECAUSE THE DESIGN STEP WAS SKIPPED");
    expect(text).toContain("a one-page internal tool");
    expect(text).toContain("This is a decision, not a missing read");
  });

  it("says a design neither accompanies the brief nor was declared skipped", () => {
    const text = decomposition({ outcome: "ABSENT" });
    expect(text).toContain("NO DESIGN ACCOMPANIES THIS BRIEF");
    expect(text).toContain("has not declared that it plans without one");
    // The recovery, so an absent design is not a dead end for the seat.
    expect(text).toContain("design_read");
  });

  it("treats an unwired caller exactly as ABSENT rather than omitting the paragraph", () => {
    // A brief that simply said nothing is the failure mode this whole clause exists to remove.
    expect(decomposition(null)).toContain("NO DESIGN ACCOMPANIES THIS BRIEF");
    expect(decomposition(null)).toBe(decomposition({ outcome: "ABSENT" }));
  });

  /**
   * THE ANTI-VACUITY ARM. Each outcome must be readable from the bytes ALONE. Asserted on
   * meaning-bearing words: a substring short enough to match two outcomes would stay green
   * through exactly the collapse the step-5 drill performs.
   */
  it("keeps the three outcomes mutually distinguishable in the produced bytes", () => {
    const present = decomposition(PRESENT);
    const skipped = decomposition(SKIPPED);
    const absent = decomposition({ outcome: "ABSENT" });
    expect(new Set([present, skipped, absent]).size).toBe(3);
    expect(skipped).not.toContain("NO DESIGN ACCOMPANIES THIS BRIEF");
    expect(skipped).not.toContain("A DESIGN EXISTS for this goal");
    expect(absent).not.toContain("SKIPPED");
    expect(absent).not.toContain("skipped");
    expect(absent).not.toContain("A DESIGN EXISTS for this goal");
    expect(present).not.toContain("NO DESIGN");
    expect(present).not.toContain("SKIPPED");
  });
});

/**
 * DoD 5: a node mission cites the screens and entities it implements, drawn from the design it
 * was compiled against — otherwise the design is a form nobody fills in twice.
 */
describe("the design a coding seat implements against", () => {
  const NODE = { instructions: "build the dashboard", test: "pnpm test", title: "T",
    workspace: "/w" };
  const node = (design: DesignBrief | null): string => codeMission(
    "review.submit@node-1", "node-1", EXPIRES, NODE, { accept: null, submit: null }, null, design,
  );

  it("names the screens and entities the design draws", () => {
    const text = node({
      entities: ["Account"], outcome: "PRESENT", ref: "design:goal-1", screens: ["Dashboard"],
    });
    expect(text).toContain('design submitted under "design:goal-1"');
    expect(text).toContain("screens Dashboard");
    expect(text).toContain("entities Account");
    expect(text).toContain("do not invent a screen the design does not draw");
  });

  it("says so deliberately when the design draws no screens or entities yet", () => {
    // An empty list must not produce a dangling "draws ." sentence the seat has to interpret.
    const text = node({
      entities: [], outcome: "PRESENT", ref: "design:goal-1", screens: [],
    });
    expect(text).toContain("names no screens or entities yet");
    expect(text).not.toContain("draws .");
    expect(text).not.toContain("screens .");
  });

  it("distinguishes a skipped design from one that never reached this brief", () => {
    const skipped = node({ outcome: "SKIPPED", reason: "a one-page internal tool" });
    const absent = node({ outcome: "ABSENT" });
    expect(skipped).toContain("plans WITHOUT a design");
    expect(skipped).toContain("a one-page internal tool");
    expect(absent).toContain("No design accompanies this brief");
    expect(absent).not.toContain("plans WITHOUT a design");
    expect(skipped).not.toContain("No design accompanies this brief");
  });

  it("adds no design paragraph at all when the caller wires none", () => {
    // The node lane cannot resolve a nodeRef back to its goal, so `null` here means the
    // wrapper knows nothing — and inventing a claim about the design would be worse than
    // silence. This is the ONE place null differs from ABSENT, and it is asserted, not assumed.
    const text = node(null);
    expect(text).not.toContain("design");
    expect(text).not.toContain("Design");
  });
});

/**
 * THE DESIGN SEAT'S BRIEF — the step between Gate 1 and the decomposition.
 *
 * A seat is staffed from this string and nothing else, so an underspecified brief is not a
 * documentation defect: it is a seat that submits a revision the decoder refuses by exact
 * arity and then guesses at why. These arms pin the five section names one arm each, so a
 * dropped heading fails an assertion that NAMES it rather than a length check that does not.
 */
describe("designMission", () => {
  const DESIGN_ITEM = "design.submit@design:goal-1";
  const brief = (designRef: string | null = "design:goal-1", projectId: string | null = null) =>
    designMission(DESIGN_ITEM, "design.submit", EXPIRES, designRef, projectId);

  it("states the claim, the work item and the expiry the seat holds", () => {
    const text = brief();
    expect(text).toContain(`You hold the durable claim on work item "${DESIGN_ITEM}"`);
    expect(text).toContain("(command kind design.submit)");
    expect(text).toContain(`until ${EXPIRES}`);
    expect(text).toContain("First call work_get_context and find the daemon's offered command");
  });

  it("reads the APPROVED Gate 1 contract and the PRD, paging the PRD to the end", () => {
    const text = brief();
    expect(text).toContain("product_contract_read");
    expect(text).toContain("the APPROVED revision");
    // Copied, not paraphrased: a seat that pages wrong designs against a truncated PRD.
    expect(text).toContain("documents_source_read");
    expect(text).toContain('{"goalRef": "...", "offset": 0, "limit": 30000}');
    expect(text).toContain("follow nextOffset until null");
    expect(text).toContain('a payload of only {"goalRef"} answers the whole text at once');
    expect(text).toContain("Never invent a product decision the text does not state");
  });

  it("derives the bare goalRef from the design aggregate the offer targets", () => {
    // The offer targets `design:<goalId>` but both reads are keyed on the BARE goal ref, so a
    // brief that echoed the aggregate id into documents_source_read would page nothing.
    expect(brief("design:goal-1")).toContain('goal "goal-1"');
    expect(brief("design:goal-1")).not.toContain('goal "design:goal-1"');
    expect(brief("design:goal-1")).toContain('targetAggregateId "design:goal-1"');
    // No ref at all: the brief stays generic rather than interpolating the absence. Asserted
    // on the QUOTED forms, because the copied paging protocol legitimately says "until null".
    expect(brief(null)).toContain("the goal your offer targets");
    expect(brief(null)).not.toContain("undefined");
    expect(brief(null)).not.toContain('"null"');
    expect(brief(null)).not.toContain("design:null");
  });

  it("falls back to the generic phrase for a degenerate or unprefixed aggregate id", () => {
    // `design:` with nothing after it would otherwise render `goal ""` and send the seat to
    // page the PRD for the empty goal; an UNPREFIXED id is not a goal ref either, and must
    // not be mangled into one by a blind strip.
    expect(brief("design:")).toContain("the goal your offer targets");
    expect(brief("design:")).not.toContain('goal ""');
    expect(brief("goal-1")).toContain("the goal your offer targets");
    // Whatever it is, it is still the aggregate the offer named, and is echoed verbatim.
    expect(brief("goal-1")).toContain('targetAggregateId "goal-1"');
    expect(brief("design:")).toContain('targetAggregateId "design:"');
  });

  it("names the exact three payload keys design.submit admits, and no server fact", () => {
    const text = brief();
    expect(text).toContain('{"contractRef": {...}, "goalRef": "...", "revision": {...}}');
    expect(text).toContain("contractId, revisionDigest, revisionId");
    // The six server facts the edge re-attaches; naming one is refused at PAYLOAD_SHAPE.
    expect(text).toContain("never name projectId, principalId, commandId, correlationId");
  });

  /**
   * The DESIGN-SECTIONS clause specifically, sliced out of the produced string.
   *
   * A FLAT `expect(brief()).toContain(section)` IS VACUOUS HERE and the step-5 drill proved
   * it: the brief also names all SIX revision keys a few clauses earlier, so dropping a
   * heading from the sections list left every per-section arm green. Narrowing to the clause
   * is what makes the arm test its own subject. The bounds are asserted before use, so a
   * reworded brief fails loudly instead of silently slicing an empty string that contains
   * nothing and therefore passes nothing.
   */
  const sectionsClause = (text: string): string => {
    const from = text.indexOf("design sections are");
    const to = text.indexOf("openDecisions is REQUIRED");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return text.slice(from, to);
  };

  /**
   * One arm PER SECTION rather than a loop with a count: the step-5 drill drops a single
   * heading, and a length assertion would fail without saying which one went missing.
   */
  for (const section of DESIGN_SECTION_KEYS) {
    it(`names the ${section} section in the design-sections list`, () => {
      expect(sectionsClause(brief())).toContain(section);
    });
  }

  it("names all six revision keys where it states the exact arity", () => {
    // The other place these words appear — pinned separately so neither clause can stand in
    // for the other, which is precisely how the per-section arms went vacuous.
    const text = brief();
    expect(text).toContain("The revision carries EXACTLY these 6 keys:");
    for (const key of ["apiSurface", "componentList", "dataModel", "nonFunctional",
      "openDecisions", "screens"]) {
      expect(text.slice(text.indexOf("EXACTLY these 6 keys:"))).toContain(key);
    }
  });

  it("sweeps exactly the five sections the decoder compares by exact arity", () => {
    // Pins the sweep's DENOMINATOR: a roster deletion would otherwise shrink the loop above
    // to four green arms while the brief silently stopped naming a section.
    expect([...DESIGN_SECTION_KEYS]).toEqual([
      "apiSurface", "componentList", "dataModel", "nonFunctional", "screens",
    ]);
  });

  it("requires openDecisions too and says it may be empty", () => {
    const text = brief();
    expect(text).toContain("openDecisions");
    expect(text).toContain("openDecisions is REQUIRED and may be an empty list");
  });

  it("carries no suggested development payload, on compilerMission's precedent", () => {
    expect(brief()).not.toContain("Suggested development payload");
    expect(brief()).not.toContain("Suggested review.submit payload");
  });

  it("names the project the wrapper serves, so graph_get is callable", () => {
    expect(brief("design:goal-1", "proj-1"))
      .toContain('graph_get takes exactly {"projectId": "proj-1"} and nothing else');
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
    ["designMission", designMission(
      "design.submit@design:goal-1", "design.submit", EXPIRES, "design:goal-1",
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
