import { describe, expect, it } from "vitest";

import { mapGoalSourceAnswer, readGoalSource } from "./live-goal-source.js";

const SOURCE = Object.freeze({
  byteLength: 42, contentSha256: "a".repeat(64), displayPath: "docs/PRD.md", mediaType: "text/markdown",
  outcome: "GOAL_SOURCE", sourceRef: "prd", text: "# UnAI\n\nThe product.\n",
});
const response = (status: number, body: unknown): Response => ({ json: async () => body, status } as unknown as Response);

describe("mapGoalSourceAnswer", () => {
  it("maps an exact GOAL_SOURCE frame and refuses every other shape", () => {
    expect(mapGoalSourceAnswer(200, SOURCE)).toStrictEqual({
      byteLength: 42, contentSha256: "a".repeat(64), displayPath: "docs/PRD.md", mediaType: "text/markdown",
      sourceRef: "prd", status: "GOAL_SOURCE", text: SOURCE.text,
    });
    const invalid = { code: "GOAL_SOURCE_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_GOAL_SOURCE", status: "ERROR" };
    expect(mapGoalSourceAnswer(200, { ...SOURCE, extra: 1 })).toStrictEqual(invalid);
    expect(mapGoalSourceAnswer(200, { ...SOURCE, text: 7 })).toStrictEqual(invalid);
    expect(mapGoalSourceAnswer(500, SOURCE)).toStrictEqual(invalid);
    expect(mapGoalSourceAnswer(200, { code: "GOAL_SOURCE_UNBOUND", layer: "DAEMON_READ_MODEL", outcome: "REFUSED" }))
      .toStrictEqual({ code: "GOAL_SOURCE_UNBOUND", layer: "DAEMON_READ_MODEL", status: "REFUSED" });
    expect(mapGoalSourceAnswer(503, { code: "LISTENER_GOAL_SOURCE_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER" }))
      .toStrictEqual({ code: "LISTENER_GOAL_SOURCE_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER", status: "REFUSED" });
  });
});

describe("readGoalSource", () => {
  it("posts exactly { goalRef } and maps transport and body failures", async () => {
    const bodies: string[] = [];
    const read = await readGoalSource({}, "goal-1", async (body) => { bodies.push(body); return response(200, SOURCE); });
    expect(read.status).toBe("GOAL_SOURCE");
    expect(bodies).toEqual([JSON.stringify({ goalRef: "goal-1" })]);
    expect(await readGoalSource({}, "goal-1", () => Promise.reject(new Error("down")))).toMatchObject({ code: "TRANSPORT_REQUEST_FAILED", status: "ERROR" });
    expect(await readGoalSource({}, "goal-1", async () => ({ json: async () => { throw new Error("x"); }, status: 200 } as unknown as Response)))
      .toMatchObject({ code: "GOAL_SOURCE_RESPONSE_INVALID", status: "ERROR" });
  });
});
