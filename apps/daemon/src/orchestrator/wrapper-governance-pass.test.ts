import { afterEach, describe, expect, it } from "vitest";

import type { GovernanceAdvisor } from "../review/governance-escalation-decider.js";
import type { GovernancePolicy } from "../review/governance-policy-settings.js";
import { readReviewLedger } from "../review/review-read-model.js";
import {
  PROJECT_ID,
  SUBJECT_REF,
  closeStores,
  driveRounds,
  openStore,
} from "../review/review-test-fixtures.js";
import { createGovernancePass } from "./wrapper-governance-pass.js";

/**
 * The pass that gives governance somewhere to run.
 *
 * The node this exists for is invisible to the rest of the loop: an exhausted review is offered
 * nothing but `escalation.decide` and its step is BLOCKED, so `wrapper.runOnce()` staffs nothing
 * and `delivery.advance()` moves nothing. Without this pass the node waits on a person.
 */

const OPEN: GovernancePolicy = Object.freeze({ kind: "AI_GOVERNOR", maxDecisions: 1 });
const CLOSED: GovernancePolicy = Object.freeze({ kind: "REQUIRE_HUMAN" });
const clock = (): string => "2026-09-16T00:00:00.000Z";
const silent: GovernanceAdvisor = () => Promise.resolve(null);
const answers: GovernanceAdvisor = (brief) => Promise.resolve({
  decisions: brief.questions.map((question) => ({
    answer: "shared.obligation.description is SET.",
    basis: "GOVERNANCE_DECIDED" as const,
    citation: null,
    criterionId: question.criterionId,
    findingId: question.findingId,
    findingSubject: question.subject,
    question: question.detail,
    rationale: "The product record is silent, and SET is the lossless choice.",
    reviewVersion: brief.reviewVersion,
    subjectRef: brief.subjectRef,
    supersedes: null,
  })),
  guidance: "REGISTRY REVIEW - RECORDED DECISION. description is SET.",
});

function passOver(
  store: ReturnType<typeof openStore> | undefined,
  policy: GovernancePolicy | undefined,
  advisor: GovernanceAdvisor = silent,
  nodes: readonly { readonly nodeRef: string }[] = [{ nodeRef: SUBJECT_REF }],
) {
  const lines: string[] = [];
  const pass = createGovernancePass({
    advisor, clock, log: (line) => lines.push(line), nodes: () => nodes,
    policy, projectId: PROJECT_ID, store: () => store,
  });
  return { lines, pass };
}

afterEach(closeStores);

describe("the governance pass", () => {
  it("surfaces the exhausted node the rest of the loop cannot move", async () => {
    const store = openStore();
    driveRounds(store, 3);
    const { lines, pass } = passOver(store, OPEN);

    await pass();

    // It stops and says so. Retiring the node here would destroy work nothing replaces:
    // successor creation lives in the control room's two-phase workflow, not in the daemon.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("needs your decision in the control room");
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });

  it("is inert with no policy stated, and reads nothing on the way to doing nothing", async () => {
    const store = openStore();
    driveRounds(store, 3);
    let asked = 0;
    const counting: GovernanceAdvisor = () => { asked += 1; return Promise.resolve(null); };

    const closed = passOver(store, CLOSED, counting);
    await closed.pass();
    const unstated = passOver(store, undefined, counting);
    await unstated.pass();

    expect(asked).toBe(0);
    expect(closed.lines).toEqual([]);
    expect(unstated.lines).toEqual([]);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });

  it("says nothing about the nodes it had no reason to touch", async () => {
    // The quiet outcomes are the overwhelming majority of every pass. A line each would bury
    // the decisions the owner actually needs to see.
    const store = openStore();
    driveRounds(store, 1);
    const { lines, pass } = passOver(store, OPEN);

    await pass();

    expect(lines).toEqual([]);
  });

  it("answers every other node when one of them cannot be read", async () => {
    const store = openStore();
    driveRounds(store, 3);
    const { lines, pass } = passOver(store, OPEN, silent, [
      { nodeRef: "node-that-has-no-review" },
      { nodeRef: SUBJECT_REF },
    ]);

    await pass();

    // The unknown node is simply not due; the real one is still reached and reported.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(SUBJECT_REF);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });

  it("keeps the pass alive when a node's decision throws underneath the decider", async () => {
    // The decider guards the ADVISOR, and nothing else it touches: the injected clock and the
    // durable commit it makes once an answer arrives both run unguarded. This pass is the only
    // thing that moves an exhausted node, so one escaped throw stranded every node after it in
    // the candidate list, with nothing in the log to say why any of them stopped moving.
    const store = openStore();
    driveRounds(store, 3);
    const lines: string[] = [];
    const pass = createGovernancePass({
      advisor: answers,
      clock: () => { throw new Error("the clock went away"); },
      log: (line) => lines.push(line),
      nodes: () => [{ nodeRef: SUBJECT_REF }],
      policy: OPEN, projectId: PROJECT_ID, store: () => store,
    });

    await expect(pass()).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the clock went away");
    expect(lines[0]).toContain("stays exactly as it was");
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });

  it("walks the decision ledger once for the whole pass, not once per node", async () => {
    // Measured on UnAI 2026-09-16. Reading each node's ledger singly folded the durable decision
    // log once PER NODE: 70 nodes against a 20 MB log every 15 seconds held the wrapper's event
    // loop at ~90% of a core for 54 minutes, during which it logged nothing and the MCP host the
    // seats call stopped answering. `readReviewLedgers` exists for precisely this shape.
    const store = openStore();
    driveRounds(store, 1);
    let reads = 0;
    const counting = new Proxy(store, {
      get(target, property): unknown {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (typeof property === "string" && property.startsWith("read")) reads += 1;
        return (value as (...args: readonly unknown[]) => unknown).bind(target);
      },
    });
    let asked = 0;
    const counted: GovernanceAdvisor = () => { asked += 1; return Promise.resolve(null); };
    // One real node and many that have no ledger at all: the per-node shape pays for every one.
    const nodes = [
      { nodeRef: SUBJECT_REF },
      ...Array.from({ length: 24 }, (_, index) => ({ nodeRef: `node-absent-${String(index)}` })),
    ];

    await passOver(counting, OPEN, counted, nodes).pass();

    // Nothing here is due, so the prefilter alone answers for all 25 — and the advisor, which
    // costs a model call in production, is never reached.
    expect(asked).toBe(0);
    expect(reads).toBeLessThan(6);
  });

  it("does nothing before the store is open", async () => {
    // The wrapper's handle is undefined until well into startup, and a pass that ran then would
    // decide on behalf of a project whose durable state it could not read.
    const { lines, pass } = passOver(undefined, OPEN);

    await expect(pass()).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("survives a node listing that throws", async () => {
    const store = openStore();
    driveRounds(store, 3);
    const lines: string[] = [];
    const pass = createGovernancePass({
      advisor: silent, clock, log: (line) => lines.push(line),
      nodes: () => { throw new Error("the graph read died"); },
      policy: OPEN, projectId: PROJECT_ID, store: () => store,
    });

    await expect(pass()).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });
});
