/**
 * The N-node producer, graded two ways: unit refusal arms per fence, and the
 * PARITY LANE — a compiled TWO-node chain driven through the REAL `plan.propose`
 * seam in a throwaway store. That lane is the first production exercise of
 * multi-node graph admission anywhere in this repo (every shipped path seals a
 * single-node zero-edge graph), so its green is a discovery, not a formality.
 * `journey-authority-bodies.ts` and `dev-payload-parity.test.ts` stay untouched.
 */
import { describe, expect, it, afterEach } from "vitest";

import {
  GOAL_ID,
  GRAPH_REVISION_REF,
  RUN_ID,
  closeStores,
  driveThrough,
  envelope,
  openStore,
  planningChain,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { compiledPlanAuthority } from "./compiled-authority-bodies.js";
import type { CompiledPlanInput } from "./compiled-authority-contracts.js";

afterEach(closeStores);

const CRITERIA = Object.freeze([
  { criterionId: "crit-api", statement: "The API answers a signed request with the record." },
  { criterionId: "crit-ui", statement: "The page renders the record the API answered." },
]);

function inputOf(overrides: Partial<CompiledPlanInput> = {}): CompiledPlanInput {
  return {
    authorRef: "compiler-agent-1",
    completionNodeKey: "node-ui",
    criteria: CRITERIA,
    graphRevisionRef: GRAPH_REVISION_REF,
    idPrefix: RUN_ID,
    knownCapabilities: ["capability-implement"],
    nodes: [
      {
        capability: "capability-implement",
        criterionIds: ["crit-api"],
        dependsOn: [],
        nodeKey: "node-api",
        objective: "Land the API read.",
        readScopes: ["services/api/src"],
        resources: ["resource-a"],
        verificationRecipeRefs: ["recipe-a"],
        writeScopes: ["services/api/src/read"],
      },
      {
        capability: "capability-implement",
        criterionIds: ["crit-ui"],
        dependsOn: ["node-api"],
        nodeKey: "node-ui",
        objective: "Render the record.",
        readScopes: ["apps/web/src"],
        resources: ["resource-a"],
        verificationRecipeRefs: ["recipe-a"],
        writeScopes: ["apps/web/src/record"],
      },
    ],
    ...overrides,
  };
}

function compiledOrThrow(input: CompiledPlanInput) {
  const compiled = compiledPlanAuthority(input);
  if (!compiled.ok) throw new Error(`compile refused: ${compiled.code} ${compiled.detail}`);
  return compiled;
}

describe("compiledPlanAuthority", () => {
  it("seals a two-node graph with an advisory edge, every digest derived", () => {
    const compiled = compiledOrThrow(inputOf());
    expect(compiled.graphContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(compiled.submissionHash).toMatch(/^[0-9a-f]{64}$/u);
    // Deterministic: two compiles over one input are byte-identical, which is
    // what makes a dispatcher's derived commandIds crash-restart idempotent.
    const again = compiledOrThrow(inputOf());
    expect(again.graphContentHash).toBe(compiled.graphContentHash);
    expect(again.graphContentBytesBase64).toBe(compiled.graphContentBytesBase64);
    expect(again.submissionHash).toBe(compiled.submissionHash);
  });

  it("carries criterion statements BYTE-EQUAL into the acceptance contract", () => {
    const compiled = compiledOrThrow(inputOf());
    const contract = compiled.authority["acceptanceContract"] as {
      obligations: readonly { criterionId: string; statement: string }[];
    };
    for (const criterion of CRITERIA) {
      const obligation = contract.obligations.find(
        (entry) => entry.criterionId === criterion.criterionId,
      );
      expect(obligation?.statement).toBe(criterion.statement);
    }
    // The prettify drill: a normalised spelling is a DIFFERENT statement.
    const prettified = compiledOrThrow(inputOf({
      criteria: [
        { ...CRITERIA[0]!, statement: `${CRITERIA[0]!.statement} ` },
        CRITERIA[1]!,
      ],
    }));
    const prettifiedContract = prettified.authority["acceptanceContract"] as {
      obligations: readonly { criterionId: string; statement: string }[];
    };
    expect(prettifiedContract.obligations[0]?.statement).not.toBe(CRITERIA[0]!.statement);
  });

  it("refuses each fence with its own code", () => {
    expect(compiledPlanAuthority(inputOf({ nodes: [] })))
      .toMatchObject({ code: "COMPILED_PLAN_MALFORMED", ok: false });
    expect(compiledPlanAuthority(inputOf({ completionNodeKey: "node-ghost" })))
      .toMatchObject({ code: "COMPILED_PLAN_MALFORMED", ok: false });
    const nodes = inputOf().nodes;
    expect(compiledPlanAuthority(inputOf({
      nodes: [nodes[0]!, { ...nodes[1]!, criterionIds: ["crit-ghost"] }],
    }))).toMatchObject({ code: "COMPILED_PLAN_CRITERION_UNBOUND", ok: false });
    expect(compiledPlanAuthority(inputOf({
      nodes: [nodes[0]!, { ...nodes[1]!, criterionIds: ["crit-api"] }],
    }))).toMatchObject({ code: "COMPILED_PLAN_CRITERION_UNBOUND", ok: false });
    expect(compiledPlanAuthority(inputOf({ knownCapabilities: ["capability-other"] })))
      .toMatchObject({ code: "COMPILED_PLAN_CAPABILITY_UNCATALOGED", ok: false });
    expect(compiledPlanAuthority(inputOf({
      nodes: [nodes[0]!, { ...nodes[1]!, dependsOn: ["node-ghost"] }],
    }))).toMatchObject({ code: "COMPILED_PLAN_MALFORMED", ok: false });
    const many = Array.from({ length: 25 }, (_, index) => ({
      ...nodes[0]!, criterionIds: ["crit-api"], dependsOn: [], nodeKey: `node-${index}`,
    }));
    expect(compiledPlanAuthority(inputOf({
      completionNodeKey: "node-0",
      nodes: many,
    }))).toMatchObject({ code: "COMPILED_PLAN_BUDGET_EXCEEDED", ok: false });
  });

  it("PARITY LANE: the real plan.propose seam admits the compiled two-node chain", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const compiled = compiledOrThrow(inputOf());
    const chain = [...planningChain()];
    const propose = chain[chain.length - 1]!;
    chain[chain.length - 1] = {
      ...propose,
      authority: compiled.authority,
      graphContentBytesBase64: compiled.graphContentBytesBase64,
      submissionHash: compiled.submissionHash,
    };
    const outcome = send(
      store, envelope("plan.propose", 0, { commands: chain, runId: RUN_ID }),
    );
    // The seam re-derives every digest (authority leg, graph body leg): an
    // accepted outcome here IS the first multi-node admission this repo has run.
    if (!outcome.ok) throw new Error(`propose refused: ${outcome.code}`);
    expect(outcome.ok).toBe(true);
    expect(GOAL_ID.length).toBeGreaterThan(0);
  });
});
