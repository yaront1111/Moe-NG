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
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";

afterEach(closeStores);
const encoder = new TextEncoder();
const PRD = "# Watch me\n\nA PRD whose decisions the activity read lists.\n";

function activity(result: ReturnType<ActivityReadPort["readActivity"]>): ActivityView {
  if (result.outcome !== "ACTIVITY") throw new Error(`expected ACTIVITY, got ${result.code}`);
  return result;
}

describe("createActivityReadPort", () => {
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
    // approval.decide_intent commits a GoalState, not a decision word: it is APPROVE by construction.
    expect(verdictOf("approval.decide_intent", bytes({ decision: "APPROVE" }))).toBeNull();
    expect(verdictOf("integration.accept_output", bytes({ decision: "REPLAN" }))).toBeNull();
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
