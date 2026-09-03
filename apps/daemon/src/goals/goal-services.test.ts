import type { SqliteEventStore } from "@moe/store";
import { afterEach, describe, expect, it } from "vitest";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  GRAPH_REVISION_REF,
  GOAL_CREATE_COMMAND_ID,
  GOAL_ID,
  PROJECT_ID,
  RUN_ID,
  acceptancePayload,
  closeStores,
  closureWitness,
  decisionCount,
  driveThrough,
  envelope,
  goalPayload,
  openStore,
  send,
  zeroAuthorityWitness,
} from "../bootstrap/bootstrap-test-fixtures.js";
import {
  GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED,
  GOAL_PREREQUISITE_LAYER,
  GOAL_PREREQUISITE_REFUSAL_CODES,
} from "./goal-close-prerequisite.js";
import {
  approveNodes,
  scanGlobalEvents,
  seedReviewAcceptance,
} from "./goal-closure-test-fixtures.js";
import { GOAL_HANDLERS } from "./goal-services.js";

/**
 * Goal creation and final acceptance. The ingress and sequence rules are not restated here —
 * they are proven once against the shared pipeline — so these assertions concern only what this
 * module contributes: routing to `reduceGoal` and surfacing the core's own verdict.
 *
 * Acceptance is the highest-risk command in the daemon: it is the one that turns work into an
 * accepted terminal state, so a forged or evidence-free acceptance is the worst defect
 * available here. Every refusal arm below therefore reads the goal back out of the store — a
 * handler that mutated and then refused would sail through a return-value-only assertion.
 *
 * NO ARM HERE CLOSES A GOAL, and that is a statement about production rather than about this
 * file. Closing needs a durable Foundation verification receipt, which needs a proven attempt,
 * which needs a committed activation no test world can produce — `runEffectActivateCommand`
 * refuses. Governor ruling comment-937524c83a1945a5afae3ed8ac2405b9 clause 3 forbids rebuilding
 * that world below the admission path, so the seven arms that required it are RETIRED rather
 * than faked. Core's own `EXECUTION_ENABLED -> CLOSING -> COMPLETED` transition, its
 * ILLEGAL_TRANSITION on a second close and its EXPECTED_VERSION_CONFLICT still have an owner in
 * `packages/core/src/goal/goal-reducer.test.ts`; the DAEMON-side composition of a SUCCESSFUL
 * close has NO owner until production can mint an activation. Stated plainly so the absence
 * below reads as a disclosed gap and not as coverage.
 */

interface GoalRow {
  readonly activeGraphRevisionRef?: string | null;
  readonly lifecycle?: string;
  readonly version?: number;
}

const encoder = new TextEncoder();

function goalRow(store: SqliteEventStore): GoalRow | undefined {
  return readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID)?.result as
    GoalRow | undefined;
}

/** The frozen tuple `goal.close` answers while no durable Foundation verification receipt names
 *  an approved node. Restated by hand, in full, so a code, a refusing layer or an authority
 *  quietly changing reddens here instead of passing as "still refused". */
const NO_RECEIPT_REFUSAL = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  code: "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
  ok: false,
  refusedBy: "DAEMON_PREREQUISITE",
});

/** No committed activation ANYWHERE, with the world's own events as the positive control. */
function expectUnactivatedWorld(store: SqliteEventStore): void {
  const scan = scanGlobalEvents(store);
  expect(scan.total).toBeGreaterThan(0);
  expect(scan.exhausted).toBe(true);
  expect(scan.activationRows).toBe(0);
}

function stageUnreadableExecutionApproval(
  store: SqliteEventStore,
  eventPayload: Record<string, unknown>,
): void {
  driveThrough(store, "approval.decide");
  const aggregate = readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID);
  if (aggregate === undefined || aggregate.result === null
    || typeof aggregate.result !== "object" || Array.isArray(aggregate.result)) {
    throw new Error("goal setup did not create a readable draft");
  }
  const enabled = {
    ...aggregate.result,
    activeGraphRevisionRef: GRAPH_REVISION_REF,
    graphEpoch: 1,
    lifecycle: "EXECUTION_ENABLED",
    version: 2,
  };
  const committed = store.commitExpectedVersionDecision({
    commandKind: "approval.decide",
    committedResultBytes: encoder.encode(JSON.stringify(enabled)),
    correlationId: "corr-corrupt-approval",
    decidedAt: "2026-08-10T00:00:00.000Z",
    events: [{
      eventId: "cmd-corrupt-approval-GoalExecutionEnabled",
      eventType: "GoalExecutionEnabled",
      payload: encoder.encode(JSON.stringify(eventPayload)),
    }],
    expectedVersion: aggregate.currentVersion,
    key: {
      commandId: "cmd-corrupt-approval",
      principalId: "principal-1",
      projectId: PROJECT_ID,
    },
    requestBytes: encoder.encode(JSON.stringify({ kind: "approval.decide", payload: {} })),
    targetAggregateId: GOAL_ID,
  });
  expect(committed.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
}

interface DurableCloseSnapshot {
  readonly decisionCount: number;
  readonly goal: GoalRow | undefined;
  readonly goalEventCount: number;
}

function closeSnapshot(store: SqliteEventStore): DurableCloseSnapshot {
  return {
    decisionCount: decisionCount(store),
    goal: goalRow(store),
    goalEventCount: store.readEvents(GOAL_ID).length,
  };
}

function expectNoCloseMutation(store: SqliteEventStore, before: DurableCloseSnapshot): void {
  expect(decisionCount(store)).toBe(before.decisionCount);
  expect(goalRow(store)).toEqual(before.goal);
  expect(store.readEvents(GOAL_ID)).toHaveLength(before.goalEventCount);
}

afterEach(closeStores);

describe("goal service surface", () => {
  it("contributes the create, close, and source-bound handlers in append order", () => {
    expect(Object.keys(GOAL_HANDLERS)).toEqual([
      "goal.create", "goal.close", "goal.create_with_source", "repository.publish",
    ]);
  });

  it("declares the goal-close prerequisites in a stable daemon vocabulary", () => {
    // Restated BY HAND, in order. Deriving this list from the production array would grow on
    // both sides at once and stay green while an unguarded code shipped.
    expect(GOAL_PREREQUISITE_REFUSAL_CODES).toEqual([
      "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      "GOAL_CLOSE_VERIFICATION_RECEIPT_ABSENT",
      "GOAL_CLOSE_VERIFICATION_RECEIPT_AMBIGUOUS",
      "GOAL_CLOSE_VERIFICATION_RECEIPT_UNREADABLE",
      "GOAL_CLOSE_VERIFICATION_NOT_PASSED",
      "GOAL_CLOSE_RESULT_DIGEST_MISMATCH",
      "GOAL_CLOSE_REVIEW_PACKAGE_STALE",
      "GOAL_CLOSE_AUTHORITY_REMAINS",
    ]);
    expect(new Set(GOAL_PREREQUISITE_REFUSAL_CODES).size)
      .toBe(GOAL_PREREQUISITE_REFUSAL_CODES.length);
    expect(GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED)
      .toBe("GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED");
    // All eight refuse at ONE layer, which is why every arm below pins the layer too.
    expect(GOAL_PREREQUISITE_LAYER).toBe("DAEMON_PREREQUISITE");
  });
});

describe("goal create", () => {
  it("commits one durable decision on an active project", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const before = decisionCount(store);

    const outcome = send(
      store, envelope("goal.create", 0, goalPayload(), GOAL_CREATE_COMMAND_ID),
    );

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(decisionCount(store)).toBe(before + 1);

    const goal = readDurableLedger(store, PROJECT_ID).aggregates.get(GOAL_ID);
    expect(goal).toBeDefined();
    expect((goal?.result as { lifecycle?: string } | undefined)?.lifecycle).toBe("DRAFT");
  });

  it("surfaces the core's own reason code for a stale expected version", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    expect(send(
      store, envelope("goal.create", 0, goalPayload(), GOAL_CREATE_COMMAND_ID),
    ).ok).toBe(true);
    const before = decisionCount(store);

    // The SAME command identity under a DIFFERENT principal. The decision key carries the
    // principal, so the replay lookup cannot answer, but the goal is derived from the command
    // identity alone - so this request lands on the goal that already exists and the REDUCER
    // must answer. That is also the fence stopping a second principal from reaching another
    // principal's goal by reusing its command id.
    const outcome = send(store, {
      ...envelope("goal.create", 0, goalPayload(), GOAL_CREATE_COMMAND_ID),
      principalId: "principal-2",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.refusedBy).toBe("CORE_REDUCER");
    // The reducer checks version agreement before the transition table, so a second create at
    // version 0 against a goal already at version 1 is a conflict, not an illegal transition.
    expect(outcome.code).toBe("EXPECTED_VERSION_CONFLICT");
    expect(outcome.advisoryOnly).toBe(true);
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
  });

  it("derives the readiness witness and every identity from durable facts", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const before = decisionCount(store);

    const outcome = send(
      store, envelope("goal.create", 0, goalPayload(), GOAL_CREATE_COMMAND_ID),
    );

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    expect(decisionCount(store)).toBe(before + 1);
    const created = store.readEvents(GOAL_ID)[0];
    const payload = JSON.parse(new TextDecoder().decode(created?.payload)) as [{
      budgetAccountRef: string;
      goalId: string;
      planningRunRef: string;
      witness: { projectReadyRef: string; truthClass: string };
    }];
    // The witness names the project's OWN durable version, which no request field could have
    // supplied: `project-1@3` is read from the activated project aggregate at commit time.
    expect(payload[0]?.witness).toEqual({
      projectReadyRef: `${PROJECT_ID}@3`, truthClass: "DAEMON_VERIFIED",
    });
    // Every identity on the fact is derived from the target goal, never presented.
    expect(payload[0]?.goalId).toBe(GOAL_ID);
    expect(payload[0]?.planningRunRef).toBe(RUN_ID);
    expect(payload[0]?.budgetAccountRef).toBe(`budget-account-${GOAL_CREATE_COMMAND_ID}`);
  });
});

describe("goal close accepts the verified result", () => {
  it("refuses before core when no durable verification receipt names the approved node", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    // The REVIEWED half is present, so the review guard cannot be what answers below.
    seedReviewAcceptance(store, "node-1");
    expectUnactivatedWorld(store);
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject(NO_RECEIPT_REFUSAL);
    expectNoCloseMutation(store, before);
  });

  it.each([
    ["missing", { activation: { graphApprovalRef: "approval-1" }, events: [] }],
    ["unreadable", {
      approval: {
        approvedNodeScope: "node-1",
        decision: "APPROVE",
        lifecycle: "DECIDED",
        validity: "CURRENT",
      },
    }],
  ] as const)("refuses when durable execution approval evidence is %s", (_name, payload) => {
    const store = openStore();
    stageUnreadableExecutionApproval(store, payload);
    seedReviewAcceptance(store, "node-1");
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      ok: false,
      refusedBy: "DAEMON_PREREQUISITE",
    });
    expectNoCloseMutation(store, before);
  });

  it("refuses a decided current approval whose approved node scope is empty", () => {
    const store = openStore();
    approveNodes(store, []);
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload()));

    expect(outcome).toMatchObject({
      code: "GOAL_CLOSE_REVIEW_ACCEPTANCE_REQUIRED",
      ok: false,
      refusedBy: "DAEMON_PREREQUISITE",
    });
    expectNoCloseMutation(store, before);
  });

  /**
   * DoD 1, direction TWO — the half that still has a reachable subject. A perfectly-shaped
   * payload that `validClosure` and `validZeroAuthority` would both accept still refuses, at the
   * DAEMON layer, because no durable record backs it. Direction ONE (garbage payload witnesses
   * that close anyway on durable records) needed a successful close and is retired with the rest.
   */
  it("refuses perfectly-shaped payload witnesses when no durable record backs them", () => {
    const store = openStore();
    approveNodes(store, ["node-1"]);
    seedReviewAcceptance(store, "node-1");
    expectUnactivatedWorld(store);
    const before = closeSnapshot(store);

    const outcome = send(store, envelope("goal.close", 2, acceptancePayload({
      closureWitness: closureWitness({ truthClass: "DAEMON_VERIFIED" }),
      zeroAuthorityWitness: zeroAuthorityWitness(),
    })));

    expect(outcome).toMatchObject(NO_RECEIPT_REFUSAL);
    expectNoCloseMutation(store, before);
  });

  it("refuses an acceptance carrying no closure evidence, at the ingress layer", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.close", 2, {
      goalId: GOAL_ID,
      zeroAuthorityWitness: zeroAuthorityWitness(),
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(outcome.authority).toBe("NONE");
    expect(decisionCount(store)).toBe(before);
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

  it("refuses an acceptance carrying no zero-authority proof, leaving no half-closed goal", () => {
    const store = openStore();
    driveThrough(store, "goal.close");
    const before = decisionCount(store);

    const outcome = send(store, envelope("goal.close", 2, {
      closureWitness: closureWitness(),
      goalId: GOAL_ID,
    }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected refusal");
    expect(outcome.code).toBe("BOOTSTRAP_PAYLOAD_INVALID");
    expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
    expect(decisionCount(store)).toBe(before);
    // Not CLOSING: a goal parked mid-closure would need a fourth human action to escape.
    expect(goalRow(store)?.lifecycle).toBe("EXECUTION_ENABLED");
  });

});

const OK_TITLE = "Bootstrap journey goal";
const OK_INSTRUCTIONS = "Carry J1 from an activated project to an accepted goal.";

/**
 * ROSTER A - MALFORMED ADMITTED FIELDS ONLY (task-9d86234a, DoD 3).
 *
 * DIVERGENCE: every case names ONLY admitted keys, or fewer, so the structural allow-list at
 * PAYLOAD_SHAPE could not refuse any of them even on the seam that runs it - the brief contract
 * is the only mechanism that can answer. Roster B, the former authority keys, lives at the real
 * HTTP seam in `daemon-command-registry.test.ts` for the same reason: no case may be refusable
 * by both fences, or the arm cannot say which one spoke.
 *
 * The oversize cases sit one byte past the contract's own bounds, and no case carries a lone
 * surrogate: that would be refused by the JSON decoder a layer earlier, under another code.
 */
const MALFORMED_BRIEFS: readonly (readonly [string, Record<string, unknown>])[] = Object.freeze([
  ["blank title", { instructions: OK_INSTRUCTIONS, title: "   " }],
  ["whitespace instructions", { instructions: "\n\n", title: OK_TITLE }],
  ["numeric title", { instructions: OK_INSTRUCTIONS, title: 42 }],
  ["object instructions", { instructions: {}, title: OK_TITLE }],
  ["null title", { instructions: OK_INSTRUCTIONS, title: null }],
  ["title one byte over the bound", { instructions: OK_INSTRUCTIONS, title: "t".repeat(1025) }],
  ["instructions one byte over the bound",
    { instructions: "i".repeat(32 * 1024 + 1), title: OK_TITLE }],
  ["missing title", { instructions: OK_INSTRUCTIONS }],
  ["missing instructions", { title: OK_TITLE }],
  ["empty payload", {}],
] as const);

/**
 * THE BRIEF WRITER (task-9d86234a). The command's whole admitted surface is prose: the goal, its
 * planning run, its budget account, the project, the principal and the readiness witness are all
 * derived from facts a caller cannot present.
 */
describe("goal create brief (task-9d86234a)", () => {
  it("records the exact normalized brief on the durable GoalCreated fact", () => {
    const store = openStore();
    driveThrough(store, "goal.create");

    const outcome = send(store, envelope("goal.create", 0, {
      instructions: `  ${OK_INSTRUCTIONS}\r\n`,
      title: ` ${OK_TITLE} `,
    }, GOAL_CREATE_COMMAND_ID));

    expect(outcome.ok, outcome.ok ? "" : outcome.code).toBe(true);
    if (!outcome.ok) throw new Error("expected acceptance");
    // The stable durable decision receipt DoD 3 asks for.
    expect(outcome.authority).toBe("DURABLE_DECISION");
    expect(outcome.disposition).toBe("DECIDED");
    expect(outcome.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
    expect(outcome.decision.targetAggregateId).toBe(GOAL_ID);

    const events = store.readEvents(GOAL_ID);
    expect(events).toHaveLength(1);
    const facts = JSON.parse(
      new TextDecoder().decode(events[0]?.payload),
    ) as readonly Record<string, unknown>[];
    expect(facts).toHaveLength(1);
    // EXACT and NORMALIZED: the CRLF, the padding and the outer whitespace are gone, and the
    // bytes stored are the bytes the contract admitted rather than the bytes sent.
    expect(facts[0]?.["brief"]).toEqual({
      instructions: OK_INSTRUCTIONS, title: OK_TITLE,
    });
  });

  it("carries a nonzero roster of malformed briefs, each of them unique", () => {
    expect(MALFORMED_BRIEFS.length).toBe(10);
    expect(new Set(MALFORMED_BRIEFS.map(([label]) => label)).size)
      .toBe(MALFORMED_BRIEFS.length);
    expect(new Set(MALFORMED_BRIEFS.map(([, payload]) => JSON.stringify(payload))).size)
      .toBe(MALFORMED_BRIEFS.length);
  });

  it.each(MALFORMED_BRIEFS)(
    "refuses %s GOAL_BRIEF_INPUT_INVALID at DAEMON_INGRESS and mutates nothing",
    (label, payload) => {
      const store = openStore();
      driveThrough(store, "goal.create");
      const before = decisionCount(store);

      const outcome = send(
        store, envelope("goal.create", 0, payload, GOAL_CREATE_COMMAND_ID),
      );

      expect(outcome.ok, label).toBe(false);
      if (outcome.ok) throw new Error(`expected refusal for ${label}`);
      expect(outcome.code).toBe("GOAL_BRIEF_INPUT_INVALID");
      expect(outcome.refusedBy).toBe("DAEMON_INGRESS");
      expect(outcome.advisoryOnly).toBe(true);
      expect(outcome.authority).toBe("NONE");
      // Read the STORE back rather than trusting the return value: a handler that mutated and
      // then refused would sail through a return-value-only assertion.
      expect(decisionCount(store)).toBe(before);
      expect(readDurableLedger(store, PROJECT_ID).aggregates.has(GOAL_ID)).toBe(false);
      expect(store.readEvents(GOAL_ID)).toHaveLength(0);
    },
  );
});

/**
 * BYTE-PROVEN REPLAY (task-9d86234a, DoD 5). The replay identity is (commandId, principalId,
 * projectId) fenced by a digest over {kind, payload} — the decided-at reading is deliberately
 * NOT part of it, which is what makes an honest retry after a clock advance a replay rather
 * than a conflict.
 */
describe("goal create replay (task-9d86234a)", () => {
  const briefPayload = (title: string): Record<string, unknown> => ({
    instructions: OK_INSTRUCTIONS, title,
  });

  const created = (store: ReturnType<typeof openStore>): readonly Record<string, unknown>[] => {
    const events = store.readEvents(GOAL_ID);
    return events.map((event) => JSON.parse(
      new TextDecoder().decode(event.payload),
    ) as Record<string, unknown>);
  };

  it("replays a byte-identical retry without a second write when the clock advances", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const request = envelope("goal.create", 0, briefPayload(OK_TITLE), GOAL_CREATE_COMMAND_ID);
    const first = send(store, request);
    expect(first.ok, first.ok ? "" : first.code).toBe(true);
    const afterFirst = decisionCount(store);
    expect(store.readEvents(GOAL_ID)).toHaveLength(1);

    // THE DAEMON CLOCK ADVANCES. Without this the arm would also pass against a writer that
    // deduplicated on the decided-at reading, which would prove nothing about the bytes.
    const retried = send(store, { ...request, decidedAt: "2026-08-09T12:34:56.789Z" });

    expect(retried.ok, retried.ok ? "" : retried.code).toBe(true);
    if (!retried.ok) throw new Error("expected a replay");
    expect(retried.disposition).toBe("REPLAYED");
    expect(retried.authority).toBe("DURABLE_DECISION");
    // NO SECOND WRITE: the durable event count, not the return value, is the evidence.
    expect(store.readEvents(GOAL_ID)).toHaveLength(1);
    expect(decisionCount(store)).toBe(afterFirst);
    expect(retried.decision.decidedAt).toBe(request.decidedAt);
  });

  it("refuses the same command identity carrying changed brief bytes", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const request = envelope("goal.create", 0, briefPayload(OK_TITLE), GOAL_CREATE_COMMAND_ID);
    expect(send(store, request).ok).toBe(true);
    const afterFirst = decisionCount(store);

    const conflicting = send(store, {
      ...request, payload: briefPayload("A different brief entirely"),
    });

    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error("expected a refusal");
    expect(conflicting.code).toBe("BOOTSTRAP_COMMAND_BYTES_CONFLICT");
    expect(conflicting.refusedBy).toBe("DAEMON_PREREQUISITE");
    expect(conflicting.advisoryOnly).toBe(true);
    // No durable mutation, and the stored brief is still the FIRST command's brief: a conflict
    // that quietly overwrote the fact would still leave one event behind.
    expect(decisionCount(store)).toBe(afterFirst);
    expect(store.readEvents(GOAL_ID)).toHaveLength(1);
    const facts = created(store)[0] as unknown as readonly Record<string, unknown>[];
    expect(facts[0]?.["brief"]).toEqual({ instructions: OK_INSTRUCTIONS, title: OK_TITLE });
  });
});
