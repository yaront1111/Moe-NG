/**
 * The goal-source route over the PRODUCTION port: a goal bound through
 * `goal.create_with_source` answers its whole text on the wire; a goal without a source and
 * a malformed selector refuse by name; the port's absence is the listener's refusal.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  GOAL_CREATE_COMMAND_ID, GOAL_ID, PROJECT_ID, closeStores, driveThrough, envelope, openStore, send,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { CAPABILITIES } from "../daemon-command-vocabulary.js";
import { createGoalSourceReadPort } from "../documents/document-source-full-read.js";
import { GOAL_SOURCE_READ_PATH, goalRefOf, goalSourceViewOf, handleGoalSourceReadRequest } from "./goal-source-read.js";
import { WIRE_PROTOCOL_VERSION } from "./http-contract.js";
import { GOOD_CREDENTIAL, authenticator } from "./http-test-fixtures.js";

afterEach(closeStores);
const PRD = "# Build the widget\n\nAn operator dropped this PRD in the browser.\n";
const body = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function boundStore() {
  const store = openStore();
  driveThrough(store, "goal.create");
  const outcome = send(store, envelope("goal.create_with_source", 0, {
    instructions: "Bind a PRD and read it back whole.",
    source: { displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD },
    title: "Route journey goal",
  }, GOAL_CREATE_COMMAND_ID));
  if (!outcome.ok) throw new Error(`fixture bind refused: ${outcome.code}`);
  return store;
}

describe("goal source read route", () => {
  it("is routed at /goals/source/read and admits exactly { goalRef }", () => {
    expect(GOAL_SOURCE_READ_PATH).toBe("/goals/source/read");
    expect(goalRefOf(body({ goalRef: "goal-1" }))).toBe("goal-1");
    expect(goalRefOf(body({}))).toBeNull();
    expect(goalRefOf(body({ goalRef: "" }))).toBeNull();
    expect(goalRefOf(body({ goalRef: "goal-1", x: 1 }))).toBeNull();
    expect(goalRefOf(new Uint8Array(0))).toBeNull();
  });

  it("answers the whole bound text through the production port, and UNBOUND for a goal without one", () => {
    const store = boundStore();
    const port = createGoalSourceReadPort({ projectId: PROJECT_ID, store });
    const view = goalSourceViewOf(port, GOAL_ID);
    if (view.outcome !== "GOAL_SOURCE") throw new Error(`refused: ${view.code}`);
    expect(view).toMatchObject({ displayPath: "docs/prd.md", mediaType: "text/markdown", text: PRD });
    expect(view.byteLength).toBe(new TextEncoder().encode(PRD).length);
    expect(goalSourceViewOf(port, "goal-nobody")).toEqual({ code: "GOAL_SOURCE_UNBOUND", layer: "DAEMON_READ_MODEL", outcome: "REFUSED" });
  });

  it("dispatches: capability, port absence, selector, then the port", () => {
    const store = boundStore();
    const goalSource = createGoalSourceReadPort({ projectId: PROJECT_ID, store });
    const request = (value: unknown) => ({ body: body(value), credential: GOOD_CREDENTIAL, protocolVersion: WIRE_PROTOCOL_VERSION });
    expect(handleGoalSourceReadRequest({ authenticator: authenticator([CAPABILITIES.WORK]), goalSource }, request({ goalRef: GOAL_ID })))
      .toEqual({ body: { code: "GOAL_SOURCE_READ_CAPABILITY_DENIED", layer: "GOAL_SOURCE_READ", outcome: "REFUSED" }, httpStatus: 200, kind: "REPLY" });
    expect(handleGoalSourceReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]) }, request({ goalRef: GOAL_ID })))
      .toEqual({ code: "LISTENER_GOAL_SOURCE_UNAVAILABLE", kind: "LISTENER_REFUSAL" });
    expect(handleGoalSourceReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), goalSource }, request({})))
      .toEqual({ code: "LISTENER_GOAL_SOURCE_REQUEST_INVALID", kind: "LISTENER_REFUSAL" });
    const served = handleGoalSourceReadRequest({ authenticator: authenticator([CAPABILITIES.GOAL]), goalSource }, request({ goalRef: GOAL_ID }));
    expect(served.kind).toBe("REPLY");
    if (served.kind !== "REPLY") throw new Error("unreachable");
    expect(served.body).toMatchObject({ outcome: "GOAL_SOURCE", text: PRD });
  });
});
