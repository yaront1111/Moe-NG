/**
 * The activity read over a REAL store driven by the production bootstrap sequence. Every
 * entry is a decision record's own facts; the goal scope is proven by a second goal whose
 * decisions must not leak into the first goal's list.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { activitySelectorOf, createActivityReadPort, handleActivityReadRequest, isSeatRecord, verdictOf } from "./activity-read.js";
import type { ActivityReadPort, ActivityView } from "./activity-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { activeCompiledGraphs } from "../orchestrator/compiled-node-source.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { seedVerifierReceipt } from "../review/review-test-fixtures.js";
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";
import type { SqliteEventStore } from "@moe/store";
import {
  approveGate1, approvePlan, boundWorld, committedRevision, rejectedWorld, submit,
} from "../planning/plan-reject-test-fixtures.js";

afterEach(closeStores);
const encoder = new TextEncoder();
const PRD = "# Watch me\n\nA PRD whose decisions the activity read lists.\n";

function activity(result: ReturnType<ActivityReadPort["readActivity"]>): ActivityView {
  if (result.outcome !== "ACTIVITY") throw new Error(`expected ACTIVITY, got ${result.code}`);
  return result;
}

describe("createActivityReadPort", () => {
  it("attributes node activity by scoped execution subject and excludes bare and sibling records", () => {
    const store = boundWorld();
    const contract = committedRevision(store);
    approveGate1(store, contract);
    const sealed = submit(store, contract);
    if (!sealed.ok) throw new Error(sealed.code);
    approvePlan(store, sealed.runId);
    const graph = activeCompiledGraphs(store, PROJECT_ID)[0]!;
    const key = graph.content.snapshot.nodes[0]!.nodeKey;
    const own = compiledExecutionRef(PROJECT_ID, graph, key);
    const sibling = compiledExecutionRef(PROJECT_ID, { ...graph, goalRef: "another-goal" }, key);
    seedVerifierReceipt(store, own, PROJECT_ID);
    seedVerifierReceipt(store, sibling, PROJECT_ID);
    seedVerifierReceipt(store, key, PROJECT_ID);
    const view = activity(createActivityReadPort({ projectId: PROJECT_ID, store }).readActivity({ goalRef: GOAL_ID }));
    const reviews = view.entries.filter((row) => row.commandKind === "review.submit");
    expect(reviews.map((row) => row.targetAggregateId)).toEqual([own]);
  });
  it("lists the project's committed decisions latest first with the record's own facts", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const view = activity(createActivityReadPort({ projectId: PROJECT_ID, store }).readActivity({}));
    expect(view.totalDecisions).toBeGreaterThan(3);
    expect(view.entries.length).toBe(view.totalDecisions);
    expect(view.refusalsRecorded).toBe(false);
    expect(view.scope).toEqual({ goalId: null, targets: 0 });
    // Latest first: the bootstrap sequence ends with project.activate before goal.create.
    expect(view.entries[0]?.commandKind).toBe("project.activate");
    expect(view.entries[view.entries.length - 1]?.commandKind).toBe("project.register");
    for (const entry of view.entries) {
      expect(entry).toMatchObject({ disposition: "COMMITTED", principalId: expect.any(String) });
      expect(entry.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(entry.version).toBeTypeOf("number");
      // No bootstrap kind carries a verdict word; the key is present and null, never absent.
      expect(Object.hasOwn(entry, "verdict")).toBe(true);
      expect(entry.verdict).toBeNull();
    }
    // Instants never go up the list: latest first is a property, not the seed's luck.
    for (let index = 1; index < view.entries.length; index += 1) {
      expect(view.entries[index - 1]!.decidedAt >= view.entries[index]!.decidedAt).toBe(true);
    }
  });

  it("scopes a goal's activity to the goal, its run and its nodes, and refuses an unknown goal", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const first = send(store, envelope("goal.create_with_source", 0, {
      instructions: "Build it.", source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
      title: "Watched goal",
    }, GOAL_CREATE_COMMAND_ID));
    if (!first.ok) throw new Error(`fixture bind refused: ${first.code}`);
    const second = send(store, envelope("goal.create_with_source", 0, {
      instructions: "Build the other.", source: { displayPath: "docs/other.md", mediaType: "text/markdown", text: `${PRD}other` },
      title: "Other goal",
    }, "2"));
    if (!second.ok) throw new Error(`fixture second bind refused: ${second.code}`);
    const port = createActivityReadPort({ projectId: PROJECT_ID, store, readActive: () => [] });
    const view = activity(port.readActivity({ goalRef: GOAL_ID }));
    expect(view.scope.goalId).toBe(GOAL_ID);
    expect(view.scope.targets).toBe(2);
    expect(view.entries.length).toBeGreaterThan(0);
    expect(view.entries.every((entry) => [GOAL_ID, `run-${GOAL_ID}`].includes(entry.targetAggregateId)
      || entry.targetAggregateId.startsWith("run-"))).toBe(true);
    expect(view.entries.some((entry) => entry.targetAggregateId === "goal-2")).toBe(false);
    expect(port.readActivity({ goalRef: "goal-never" })).toMatchObject({ code: "ACTIVITY_READ_GOAL_UNKNOWN" });
  });

  it("answers UNREADABLE, not GOAL_UNKNOWN, when the goal catalog cannot be decoded", () => {
    const store = openStore();
    driveThrough(store, "goal.create");
    const first = send(store, envelope("goal.create_with_source", 0, {
      instructions: "Build it.", source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
      title: "Watched goal",
    }, GOAL_CREATE_COMMAND_ID));
    if (!first.ok) throw new Error(`fixture bind refused: ${first.code}`);
    // A GoalCreated row whose payload is not the catalog's one-element array: the catalog walk
    // refuses it, and the goal-scoped read used to report every goal — this real one included —
    // as unknown, absence claimed on evidence that was never read.
    const bytes = encoder.encode("{}");
    const response = store.commitExpectedVersionDecision({
      commandKind: "goal.create", committedResultBytes: bytes, correlationId: "corr-broken-goal",
      decidedAt: "2026-09-05T12:00:00.000Z",
      events: [{ eventId: "evt-broken-goal", eventType: "GoalCreated", payload: bytes }],
      expectedVersion: 0, key: { commandId: "cmd-broken-goal", principalId: "operator-local", projectId: PROJECT_ID },
      requestBytes: bytes, targetAggregateId: "goal-broken",
    });
    if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") throw new Error("fixture row refused");
    const port = createActivityReadPort({ projectId: PROJECT_ID, store, readActive: () => [] });
    expect(port.readActivity({ goalRef: GOAL_ID })).toMatchObject({ code: "ACTIVITY_READ_UNREADABLE" });
    expect(port.readActivity({ goalRef: "goal-never" })).toMatchObject({ code: "ACTIVITY_READ_UNREADABLE" });
  });
});

describe("handleActivityReadRequest", () => {
  const port: ActivityReadPort = { boundProjectId: "proj-0001", readActivity: () => ({ code: "ACTIVITY_READ_UNREADABLE", layer: "ACTIVITY_READ", outcome: "REFUSED" }) };
  const request = (body: Uint8Array) => ({ body, credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });

  it("admits an empty selector or exactly one goalRef", () => {
    expect(activitySelectorOf(new Uint8Array())).toEqual({});
    expect(activitySelectorOf(encoder.encode("{}"))).toEqual({});
    expect(activitySelectorOf(encoder.encode('{"goalRef":"goal-1"}'))).toEqual({ goalRef: "goal-1" });
    expect(activitySelectorOf(encoder.encode('{"goalRef":""}'))).toBeNull();
    expect(activitySelectorOf(encoder.encode('{"goalRef":"g","limit":5}'))).toBeNull();
  });

  it("gates on capability, port presence, project and body, then forwards", () => {
    expect(handleActivityReadRequest({ activity: port, authenticator: authenticator([CAPABILITIES.PLANNING]) }, request(encoder.encode("{}"))))
      .toMatchObject({ body: { code: "ACTIVITY_READ_CAPABILITY_DENIED" } });
    expect(handleActivityReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]) }, request(encoder.encode("{}"))))
      .toEqual({ code: "LISTENER_ACTIVITY_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
    expect(handleActivityReadRequest({ activity: { ...port, boundProjectId: "elsewhere" }, authenticator: authenticator([CAPABILITIES.GOAL]) }, request(encoder.encode("{}"))))
      .toMatchObject({ body: { code: "ACTIVITY_READ_PROJECT_MISMATCH" } });
    expect(handleActivityReadRequest({ activity: port, authenticator: authenticator([CAPABILITIES.GOAL]) }, request(encoder.encode('{"projectId":"p"}'))))
      .toEqual({ code: "LISTENER_ACTIVITY_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
    expect(handleActivityReadRequest({ activity: port, authenticator: authenticator([CAPABILITIES.GOAL]) }, request(new Uint8Array())))
      .toEqual({ body: { code: "ACTIVITY_READ_UNREADABLE", layer: "ACTIVITY_READ", outcome: "REFUSED" }, httpStatus: 200, kind: "REPLY" });
  });
});

describe("isSeatRecord", () => {
  it("names the handshake's own decisions and every session command, and nothing else", () => {
    expect(isSeatRecord("OPEN_SESSION", "moe.session-authority.v1/session/s")).toBe(true);
    expect(isSeatRecord("CREATE_PRINCIPAL", "moe.session-authority.v1/principal/p")).toBe(true);
    expect(isSeatRecord("session.renew", "session/x")).toBe(true);
    expect(isSeatRecord("work.claim", "work/x")).toBe(false);
    expect(isSeatRecord("integration.accept_output", "node-a")).toBe(false);
  });
});

describe("verdictOf", () => {
  const bytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

  it("reads the escalation answer and the review route, and nothing from any other kind", () => {
    expect(verdictOf("escalation.decide", bytes({ decision: "REPLAN", escalationRef: "esc-1" }))).toBe("REPLAN");
    expect(verdictOf("escalation.decide", bytes({ decision: "ALLOW_MORE_ATTEMPTS" }))).toBe("ALLOW_MORE_ATTEMPTS");
    expect(verdictOf("review.submit", bytes({ lineage: {}, routing: { layer: "REVIEW", route: "REJECT_IMPLEMENTATION" } }))).toBe("REJECT_IMPLEMENTATION");
    expect(verdictOf("review.submit", bytes({ routing: { route: "ACCEPT" } }))).toBe("ACCEPT");
    expect(verdictOf("integration.accept_output", bytes({ decision: "REPLAN" }))).toBeNull();
  });

  it("reads the approval verdict from the committed result of BOTH approval kinds", () => {
    // A REJECT commits the run's whole record with the decision word on it
    // (approval-intent-rejection.ts `rejectionRecord`), so the word is read, never inferred.
    expect(verdictOf("approval.decide_intent", bytes({
      decision: "REJECT", decisionReason: "needs two nodes", findingsRef: "f".repeat(64),
      runId: "run-1", successorRunId: "run-2",
    }))).toBe("REJECT");
    expect(verdictOf("approval.decide_intent", bytes({ decision: "APPROVE" }))).toBe("APPROVE");
    expect(verdictOf("approval.decide", bytes({ decision: "APPROVE" }))).toBe("APPROVE");
    // An APPROVE commits a GoalState, which carries a lifecycle and NO decision word: the seam
    // admits APPROVE only (planning-services.ts:290), so the lifecycle IS the verdict. Asserted
    // with a real goal lifecycle, not a placeholder, because that is the shape on disk.
    expect(verdictOf("approval.decide", bytes({
      goalId: "goal-1", lifecycle: "EXECUTION_ENABLED", planningRunRef: "run-1",
    }))).toBe("APPROVE");
    expect(verdictOf("approval.decide_intent", bytes({
      goalId: "goal-1", lifecycle: "EXECUTION_ENABLED", planningRunRef: "run-1",
    }))).toBe("APPROVE");
  });

  it("answers null for an approval result that carries neither a decision nor a lifecycle", () => {
    // The fallback is a LIFECYCLE, not a bare "it decoded": a result with neither field must not
    // be read as an approval, or an unrelated record would render as one in the feed.
    for (const kind of ["approval.decide", "approval.decide_intent"]) {
      expect(verdictOf(kind, bytes({}))).toBeNull();
      expect(verdictOf(kind, bytes({ decision: "" }))).toBeNull();
      expect(verdictOf(kind, bytes({ decision: 7 }))).toBeNull();
      expect(verdictOf(kind, bytes({ lifecycle: 7 }))).toBeNull();
      expect(verdictOf(kind, bytes({ lifecycle: "" }))).toBeNull();
      expect(verdictOf(kind, bytes("x"))).toBeNull();
      expect(verdictOf(kind, bytes([1, 2]))).toBeNull();
      expect(verdictOf(kind, encoder.encode("{not json"))).toBeNull();
      expect(verdictOf(kind, new Uint8Array())).toBeNull();
    }
  });

  it("answers null, never throws, for a result that carries no word or does not decode", () => {
    expect(verdictOf("escalation.decide", bytes({}))).toBeNull();
    expect(verdictOf("escalation.decide", bytes({ decision: "" }))).toBeNull();
    expect(verdictOf("escalation.decide", bytes({ decision: 7 }))).toBeNull();
    expect(verdictOf("review.submit", bytes({ routing: "ACCEPT" }))).toBeNull();
    expect(verdictOf("review.submit", bytes([1, 2]))).toBeNull();
    expect(verdictOf("review.submit", encoder.encode("{not json"))).toBeNull();
    expect(verdictOf("escalation.decide", new Uint8Array())).toBeNull();
  });
});

/**
 * The verdict words the feed renders, read off REAL decisions rather than hand-built bytes:
 * `activity-words.ts` turns them into "rejected the plan" / "approved the plan", so a verdict
 * that stopped being read would silently downgrade every approval row to a bare command name.
 */
describe("approval verdicts over a real store", () => {
  const rowsFor = (world: { readonly store: SqliteEventStore }): readonly {
    readonly commandKind: string; readonly targetAggregateId: string;
    readonly verdict: string | null;
  }[] => activity(
    createActivityReadPort({ projectId: PROJECT_ID, store: world.store }).readActivity({}),
  ).entries.filter((entry) => entry.commandKind.startsWith("approval."));

  it("carries REJECT on the row for the run the operator rejected", () => {
    const world = rejectedWorld("needs two nodes, not one");
    expect(rowsFor(world)).toEqual([{
      commandKind: "approval.decide_intent",
      decidedAt: expect.any(String),
      disposition: "COMMITTED",
      principalId: expect.any(String),
      targetAggregateId: world.originalRunId,
      verdict: "REJECT",
      version: expect.any(Number),
    }]);
  });

  it("carries APPROVE on the row for a run the operator approved", () => {
    // Same seam, same fixture, opposite word: a rule that hard-coded REJECT would pass the arm
    // above and fail here.
    const store = boundWorld();
    const ref = committedRevision(store);
    approveGate1(store, ref);
    const sealed = submit(store, ref);
    if (!sealed.ok) throw new Error(`submit refused: ${sealed.code} @ ${sealed.layer}`);
    approvePlan(store, sealed.runId);
    expect(rowsFor({ store }).map((row) => `${row.commandKind}=${row.verdict ?? "null"}`))
      .toEqual(["approval.decide_intent=APPROVE"]);
  });
});
