import { describe, expect, it, vi } from "vitest";

import {
  mapGoalCatalogAnswer,
  readGoalCatalog,
} from "./live-goal-catalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

const GOALS = Object.freeze({
  goals: Object.freeze([
    Object.freeze({ goalId: "goal-random-7f3", planningRunRef: "run-cafe\u0301" }),
    Object.freeze({ goalId: "goal-random-91b", planningRunRef: "planning/a:b" }),
  ]),
  outcome: "GOALS",
});

describe("mapGoalCatalogAnswer", () => {
  it("copies every durable goal identity and planning run spelling without rewriting it", () => {
    const frame = mapGoalCatalogAnswer(200, GOALS);

    expect(frame).toStrictEqual({
      connection: "CONNECTED",
      detail: "",
      goals: [
        { brief: null, goalId: "goal-random-7f3", planningRunRef: "run-cafe\u0301" },
        { brief: null, goalId: "goal-random-91b", planningRunRef: "planning/a:b" },
      ],
      outcome: "GOALS",
    });
    expect(frame.goals[0]?.planningRunRef.normalize("NFC"))
      .not.toBe(frame.goals[0]?.planningRunRef);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.goals)).toBe(true);
    expect(Object.isFrozen(frame.goals[0])).toBe(true);
  });

  it("accepts the daemon's exact empty durable catalog", () => {
    expect(mapGoalCatalogAnswer(200, { goals: [], outcome: "GOALS" })).toStrictEqual({
      connection: "CONNECTED", detail: "", goals: [], outcome: "GOALS",
    });
  });

  /**
   * BOTH WIRE GENERATIONS. The daemon's catalog entry gained `brief` in task-e10e1627, so a
   * Control Room that decodes only the two-key shape refuses the live answer, and one that
   * decodes only the three-key shape refuses every row written before that change. The roster
   * is exact: a shape added or removed without an arm changes the first assertion's count.
   */
  const ACCEPTED_ENTRY_SHAPES = Object.freeze([
    Object.freeze({
      brief: null,
      label: "legacy two-key row",
      row: Object.freeze({ goalId: "goal-legacy-1", planningRunRef: "run-legacy-1" }),
    }),
    Object.freeze({
      brief: null,
      label: "explicit brief-unknown row",
      row: Object.freeze({
        brief: null, goalId: "goal-null-1", planningRunRef: "run-null-1",
      }),
    }),
    Object.freeze({
      brief: Object.freeze({
        instructions: "Behind bearer credentials", title: "Ship stdio entry",
      }),
      label: "brief-bearing row",
      row: Object.freeze({
        brief: Object.freeze({
          instructions: "Behind bearer credentials", title: "Ship stdio entry",
        }),
        goalId: "goal-brief-1",
        planningRunRef: "run-brief-1",
      }),
    }),
  ] as const);

  it("names exactly three accepted catalog entry shapes", () => {
    expect(ACCEPTED_ENTRY_SHAPES).toHaveLength(3);
  });

  it.each(ACCEPTED_ENTRY_SHAPES)(
    "decodes the $label into an entry carrying its own brief",
    ({ brief, row }) => {
      expect(mapGoalCatalogAnswer(200, { goals: [row], outcome: "GOALS" })).toStrictEqual({
        connection: "CONNECTED",
        detail: "",
        goals: [{
          brief,
          goalId: row.goalId,
          planningRunRef: row.planningRunRef,
        }],
        outcome: "GOALS",
      });
    },
  );

  it.each([
    ["a brief carrying an extra key", {
      brief: { instructions: "i", title: "t", urgency: "high" },
      goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a brief missing title", {
      brief: { instructions: "i" }, goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a non-string brief instructions", {
      brief: { instructions: 7, title: "t" }, goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["an empty brief title", {
      brief: { instructions: "i", title: "" }, goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a brief that is a string", {
      brief: "text", goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a brief-bearing row with a fourth unknown key", {
      brief: null, goalId: "goal-1", planningRunRef: "run-1", projectId: "project-attacker",
    }],
  ])("fails the whole delivered catalog closed for %s", (_label, row) => {
    expect(mapGoalCatalogAnswer(200, { goals: [row], outcome: "GOALS" })).toStrictEqual({
      connection: "CONNECTED",
      detail: "LIVE_GOAL_CATALOG_UNREADABLE",
      goals: [],
      outcome: "UNREADABLE",
    });
  });

  it("rejects accessor-backed briefs without invoking attacker code", () => {
    const briefGetter = vi.fn(() => ({ instructions: "i", title: "t" }));
    const titleGetter = vi.fn(() => "attacker title");
    const accessorBrief = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessorBrief, {
      instructions: { enumerable: true, value: "i" },
      title: { enumerable: true, get: titleGetter },
    });
    const rowWithAccessorBrief = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(rowWithAccessorBrief, {
      brief: { enumerable: true, get: briefGetter },
      goalId: { enumerable: true, value: "goal-1" },
      planningRunRef: { enumerable: true, value: "run-1" },
    });

    for (const row of [
      rowWithAccessorBrief,
      { brief: accessorBrief, goalId: "goal-1", planningRunRef: "run-1" },
    ]) {
      expect(mapGoalCatalogAnswer(200, { goals: [row], outcome: "GOALS" })).toMatchObject({
        connection: "CONNECTED", detail: "LIVE_GOAL_CATALOG_UNREADABLE", outcome: "UNREADABLE",
      });
    }
    expect(briefGetter).not.toHaveBeenCalled();
    expect(titleGetter).not.toHaveBeenCalled();
  });

  it.each([
    ["extra success key", { ...GOALS, projectId: "project-attacker" }],
    ["missing goals", { outcome: "GOALS" }],
    ["extra row key", {
      goals: [{ goalId: "goal-1", planningRunRef: "run-1", projectId: "project-attacker" }],
      outcome: "GOALS",
    }],
    ["empty goal id", { goals: [{ goalId: "", planningRunRef: "run-1" }], outcome: "GOALS" }],
    ["empty planning run", {
      goals: [{ goalId: "goal-1", planningRunRef: "" }], outcome: "GOALS",
    }],
    ["duplicate durable identity", {
      goals: [
        { goalId: "goal-1", planningRunRef: "run-1" },
        { goalId: "goal-1", planningRunRef: "run-2" },
      ],
      outcome: "GOALS",
    }],
  ])("fails the whole delivered catalog closed for %s", (_label, answer) => {
    expect(mapGoalCatalogAnswer(200, answer)).toStrictEqual({
      connection: "CONNECTED",
      detail: "LIVE_GOAL_CATALOG_UNREADABLE",
      goals: [],
      outcome: "UNREADABLE",
    });
  });

  it("rejects accessor-backed rows without invoking attacker code", () => {
    const getter = vi.fn(() => "goal-attacker");
    const row = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(row, {
      goalId: { enumerable: true, get: getter },
      planningRunRef: { enumerable: true, value: "run-1" },
    });

    expect(mapGoalCatalogAnswer(200, { goals: [row], outcome: "GOALS" })).toMatchObject({
      connection: "CONNECTED", detail: "LIVE_GOAL_CATALOG_UNREADABLE", outcome: "UNREADABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    [200, {
      code: "GOAL_CATALOG_READ_PROJECT_MISMATCH",
      layer: "GOAL_CATALOG_READ",
      outcome: "REFUSED",
    }, "GOAL_CATALOG_READ_PROJECT_MISMATCH"],
    [503, {
      code: "LISTENER_GOAL_CATALOG_UNAVAILABLE",
      layer: "CONTROL_ROOM_LISTENER",
    }, "LISTENER_GOAL_CATALOG_UNAVAILABLE"],
    [401, {
      error: { code: "AUTHENTICATION_FAILED" },
      httpStatus: 401,
      ok: false,
      outcome: "REFUSED",
      stage: "AUTHENTICATE",
    }, "AUTHENTICATION_FAILED"],
    [401, {
      httpStatus: 401,
      ok: false,
      outcome: "PORT_REFUSED",
      refusal: { code: "SESSION_CREDENTIAL_REVOKED" },
      stage: "AUTHENTICATE",
    }, "SESSION_CREDENTIAL_REVOKED"],
  ])("carries an exact daemon refusal at status %i", (status, answer, detail) => {
    expect(mapGoalCatalogAnswer(status, answer)).toStrictEqual({
      connection: "CONNECTED", detail, goals: [], outcome: "REFUSED",
    });
  });

  it("does not accept a refusal envelope with an unvouched extra field", () => {
    expect(mapGoalCatalogAnswer(200, {
      code: "GOAL_CATALOG_READ_PROJECT_MISMATCH",
      layer: "GOAL_CATALOG_READ",
      outcome: "REFUSED",
      projectId: "project-attacker",
    })).toMatchObject({
      connection: "CONNECTED", detail: "LIVE_GOAL_CATALOG_UNREADABLE", outcome: "UNREADABLE",
    });
  });

  it("rejects a non-200 answer that is not an exact daemon refusal", () => {
    expect(mapGoalCatalogAnswer(500, GOALS)).toStrictEqual({
      connection: "CONNECTED",
      detail: "LIVE_GOAL_CATALOG_UNREADABLE",
      goals: [],
      outcome: "UNREADABLE",
    });
  });
});

describe("readGoalCatalog", () => {
  it("posts exact empty JSON through the supplied authenticated headers and fetch", async () => {
    const calls: Array<{ readonly init: RequestInit; readonly input: string }> = [];
    const headers = Object.freeze({
      "content-type": "application/json",
      "x-moe-csrf": "csrf-1",
      "x-moe-protocol-version": "wire-1",
      "x-moe-session-credential": "credential-1",
    });

    const frame = await readGoalCatalog({
      fetchImpl: async (input, init) => {
        calls.push({ init, input });
        return jsonResponse(GOALS);
      },
      headers,
    });

    expect(frame.outcome).toBe("GOALS");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/goals/read");
    expect(calls[0]?.init).toMatchObject({ body: "{}", headers, method: "POST" });
    expect(Object.keys(JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>))
      .toStrictEqual([]);
  });

  it("maps an unparseable delivered answer to CONNECTED / UNREADABLE", async () => {
    const frame = await readGoalCatalog({
      fetchImpl: async () => ({
        json: () => Promise.reject(new Error("not json")), status: 200,
      } as unknown as Response),
      headers: {},
    });

    expect(frame).toStrictEqual({
      connection: "CONNECTED",
      detail: "LIVE_GOAL_CATALOG_UNREADABLE",
      goals: [],
      outcome: "UNREADABLE",
    });
  });

  it("maps an undelivered request to DISCONNECTED / UNDELIVERED", async () => {
    const frame = await readGoalCatalog({
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
      headers: {},
    });

    expect(frame).toStrictEqual({
      connection: "DISCONNECTED",
      detail: "TRANSPORT_REQUEST_FAILED",
      goals: [],
      outcome: "UNDELIVERED",
    });
  });
});
