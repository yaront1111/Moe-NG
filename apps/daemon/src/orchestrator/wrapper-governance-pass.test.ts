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
const silent: GovernanceAdvisor = () => null;

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
  it("decides the exhausted node the rest of the loop cannot move", () => {
    const store = openStore();
    driveRounds(store, 3);
    const { lines, pass } = passOver(store, OPEN);

    pass();

    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("replanned into a successor");
  });

  it("is inert with no policy stated, and reads nothing on the way to doing nothing", () => {
    const store = openStore();
    driveRounds(store, 3);
    let asked = 0;
    const counting: GovernanceAdvisor = () => { asked += 1; return null; };

    const closed = passOver(store, CLOSED, counting);
    closed.pass();
    const unstated = passOver(store, undefined, counting);
    unstated.pass();

    expect(asked).toBe(0);
    expect(closed.lines).toEqual([]);
    expect(unstated.lines).toEqual([]);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(false);
  });

  it("says nothing about the nodes it had no reason to touch", () => {
    // The quiet outcomes are the overwhelming majority of every pass. A line each would bury
    // the decisions the owner actually needs to see.
    const store = openStore();
    driveRounds(store, 1);
    const { lines, pass } = passOver(store, OPEN);

    pass();

    expect(lines).toEqual([]);
  });

  it("answers every other node when one of them cannot be read", () => {
    const store = openStore();
    driveRounds(store, 3);
    const { lines, pass } = passOver(store, OPEN, silent, [
      { nodeRef: "node-that-has-no-review" },
      { nodeRef: SUBJECT_REF },
    ]);

    pass();

    // The unknown node is simply not due; the real one is still decided.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(SUBJECT_REF);
    expect(readReviewLedger(store, PROJECT_ID, SUBJECT_REF).replanned).toBe(true);
  });

  it("does nothing before the store is open", () => {
    // The wrapper's handle is undefined until well into startup, and a pass that ran then would
    // decide on behalf of a project whose durable state it could not read.
    const { lines, pass } = passOver(undefined, OPEN);

    expect(() => pass()).not.toThrow();
    expect(lines).toEqual([]);
  });

  it("survives a node listing that throws", () => {
    const store = openStore();
    driveRounds(store, 3);
    const lines: string[] = [];
    const pass = createGovernancePass({
      advisor: silent, clock, log: (line) => lines.push(line),
      nodes: () => { throw new Error("the graph read died"); },
      policy: OPEN, projectId: PROJECT_ID, store: () => store,
    });

    expect(() => pass()).not.toThrow();
    expect(lines).toEqual([]);
  });
});
