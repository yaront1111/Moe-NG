import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  PROJECT_ID,
  RUN_ID,
  SUBMISSION_HASH,
  approvalCommand,
  approvalRecord,
  closeStores,
  decisionCount,
  driveThrough,
  envelope,
  hex64,
  openStore,
  planningChain,
  send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { PLANNING_HANDLERS } from "./planning-services.js";

/**
 * Plan proposal and approval. Approval is the authority-bearing command in this task, so it
 * carries the strictest arms: an ineligible approver, a mismatched target revision and an
 * unknown policy input must each refuse with a named code, and the layer that refused is
 * asserted alongside it — two of the three arms below would otherwise be satisfied by the
 * daemon's revision gate answering before the core ever ran.
 */

afterEach(closeStores);

describe("planning service surface", () => {
  it("contributes exactly the two planning handlers", () => {
    expect(new Set(Object.keys(PLANNING_HANDLERS)))
      .toEqual(new Set(["approval.decide", "plan.propose"]));
  });
});

describe("plan propose", () => {
  it("folds the caller's command chain through the core and commits one decision", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const before = decisionCount(store);

    const outcome = send(store, envelope("plan.propose", 0, {
      commands: planningChain(),
      runId: RUN_ID,
    }));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(decisionCount(store)).toBe(before + 1);
    const run = readDurableLedger(store, PROJECT_ID).aggregates.get(RUN_ID);
    expect((run?.result as { submissionHash?: string } | undefined)?.submissionHash)
      .toBe(SUBMISSION_HASH);
  });

  it("refuses a chain whose last command is not plan.propose, at the ingress layer", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const before = decisionCount(store);

    const outcome = send(store, envelope("plan.propose", 0, {
      commands: planningChain().slice(0, 3),
      runId: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.has(RUN_ID)).toBe(false);
  });

  it("aborts the whole fold with the core's code when a mid-chain step is illegal", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const before = decisionCount(store);
    // Drop the claim: the run reaches READY, and plan.propose is legal only from PLANNING.
    // The propose step is re-versioned to 2 so the reducer's version check passes and the
    // transition rule is what refuses — otherwise this would prove only a version mismatch.
    const chain = planningChain();
    const broken = [chain[0], chain[1], { ...chain[3], expectedVersion: 2 }];

    const outcome = send(store, envelope("plan.propose", 0, {
      commands: broken,
      runId: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).aggregates.has(RUN_ID)).toBe(false);
  });
});

describe("approval decide", () => {
  it("commits the core's decided record and carries durable authority", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, {
      command: approvalCommand(),
      record: approvalRecord(SUBMISSION_HASH),
      runId: RUN_ID,
    }));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.advisoryOnly).toBe(false);
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(decisionCount(store)).toBe(before + 1);
    const decided = readDurableLedger(store, PROJECT_ID).aggregates.get(`${RUN_ID}-approval`);
    expect((decided?.result as { lifecycle?: string } | undefined)?.lifecycle).toBe("DECIDED");
  });

  it("refuses an ineligible approver with the core's code, not the daemon's", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);
    // The hash matches, so the daemon's revision gate passes and the core must be the layer
    // that answers: a HUMAN record requires a step-up reference on the command.
    const outcome = send(store, envelope("approval.decide", 0, {
      command: { ...approvalCommand(), stepUpAuthRef: null },
      record: approvalRecord(SUBMISSION_HASH),
      runId: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    expect(outcome.code).toBe("ILLEGAL_TRANSITION");
    expect(outcome.advisoryOnly).toBe(true);
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    expect(readDurableLedger(store, PROJECT_ID).kinds.has("approval.decide")).toBe(false);
  });

  it("refuses a target revision hash that does not match the durable proposal", () => {
    const store = openStore();
    driveThrough(store, "approval.decide");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, {
      command: approvalCommand(),
      record: approvalRecord(hex64("bad")),
      runId: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_REVISION_HASH_MISMATCH");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });

  it("refuses an approval before any plan is durably proposed", () => {
    const store = openStore();
    driveThrough(store, "plan.propose");
    const before = decisionCount(store);

    const outcome = send(store, envelope("approval.decide", 0, {
      command: approvalCommand(),
      record: approvalRecord(SUBMISSION_HASH),
      runId: RUN_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PREREQUISITE_MISSING");
    expect(outcome.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(decisionCount(store)).toBe(before);
  });
});
