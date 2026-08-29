import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGoalCatalogFeed,
  mapGoalCatalogAnswer,
  readGoalCatalog,
} from "./live-goal-catalog.js";

afterEach(() => { vi.unstubAllGlobals(); });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" }, status,
  });
}

const GOALS = Object.freeze({
  goals: Object.freeze([
    Object.freeze({
      brief: Object.freeze({ instructions: "First durable instructions", title: "First goal" }),
      goalId: "goal-random-7f3", planningRunRef: "run-cafe\u0301", prd: null,
    }),
    Object.freeze({
      brief: null, goalId: "goal-random-91b", planningRunRef: "planning/a:b", prd: null,
    }),
  ]),
  nextCursor: null,
  observedCursor: "2",
  outcome: "GOALS",
});

describe("mapGoalCatalogAnswer", () => {
  it("copies every durable goal identity and planning run spelling without rewriting it", () => {
    const frame = mapGoalCatalogAnswer(200, GOALS);

    expect(frame).toStrictEqual({
      connection: "CONNECTED",
      detail: "",
      goals: [
        {
          brief: { instructions: "First durable instructions", title: "First goal" },
          goalId: "goal-random-7f3", planningRunRef: "run-cafe\u0301", prd: null,
        },
        { brief: null, goalId: "goal-random-91b", planningRunRef: "planning/a:b", prd: null },
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
    expect(mapGoalCatalogAnswer(200, {
      goals: [], nextCursor: null, observedCursor: "0", outcome: "GOALS",
    })).toStrictEqual({
      connection: "CONNECTED", detail: "", goals: [], outcome: "GOALS",
    });
  });

  it.each([
    ["extra success key", { ...GOALS, projectId: "project-attacker" }],
    ["missing goals", { outcome: "GOALS" }],
    ["extra row key", {
      goals: [{
        brief: null, goalId: "goal-1", planningRunRef: "run-1",
        prd: null, projectId: "project-attacker",
      }],
      nextCursor: null, outcome: "GOALS",
    }],
    ["empty goal id", { goals: [{
      brief: null, goalId: "", planningRunRef: "run-1", prd: null,
    }], nextCursor: null, outcome: "GOALS" }],
    ["empty planning run", {
      goals: [{ brief: null, goalId: "goal-1", planningRunRef: "", prd: null }],
      nextCursor: null, outcome: "GOALS",
    }],
    ["duplicate durable identity", {
      goals: [
        { brief: null, goalId: "goal-1", planningRunRef: "run-1", prd: null },
        { brief: null, goalId: "goal-1", planningRunRef: "run-2", prd: null },
      ],
      nextCursor: null, outcome: "GOALS",
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
      brief: { enumerable: true, value: null },
      goalId: { enumerable: true, get: getter },
      planningRunRef: { enumerable: true, value: "run-1" },
      prd: { enumerable: true, value: null },
    });

    expect(mapGoalCatalogAnswer(200, {
      goals: [row], nextCursor: null, outcome: "GOALS",
    })).toMatchObject({
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

  it("rejects a delivered page whose admitted goal prose exceeds the response byte budget", () => {
    const goals = Array.from({ length: 65 }, (_, index) => ({
      brief: { instructions: "x".repeat(32 * 1_024), title: `Goal ${String(index)}` },
      goalId: `goal-large-${String(index)}`,
      planningRunRef: `run-large-${String(index)}`,
      prd: null,
    }));
    expect(mapGoalCatalogAnswer(200, {
      goals, nextCursor: null, observedCursor: "65", outcome: "GOALS",
    })).toMatchObject({ detail: "LIVE_GOAL_CATALOG_UNREADABLE", outcome: "UNREADABLE" });
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

  it("returns one cursor page without eagerly accumulating the rest of the catalog", async () => {
    const calls: string[] = [];
    const row = (index: number) => ({
      brief: { instructions: `Instructions ${String(index)}`, title: `Goal ${String(index)}` },
      goalId: `goal-${String(index)}`, planningRunRef: `run-${String(index)}`, prd: null,
    });
    const first = Array.from({ length: 256 }, (_, index) => row(index));
    const second = [row(256), row(257)];

    const frame = await readGoalCatalog({
      fetchImpl: async (_input, init) => {
        calls.push(String(init.body));
        return calls.length === 1
          ? jsonResponse({
            goals: first, nextCursor: "256", observedCursor: "256", outcome: "GOALS",
          })
          : jsonResponse({
            goals: second, nextCursor: null, observedCursor: "258", outcome: "GOALS",
          });
      },
      headers: {},
    });

    expect(frame.outcome).toBe("GOALS");
    expect(frame.goals).toHaveLength(256);
    expect(calls).toStrictEqual(["{}"]);
  });

  it("fails closed when a page offers a cursor different from its observed position", async () => {
    const frame = await readGoalCatalog({
      fetchImpl: async () => jsonResponse({
        goals: GOALS.goals, nextCursor: "8", observedCursor: "7", outcome: "GOALS",
      }),
      headers: {},
    });
    expect(frame).toMatchObject({ outcome: "UNREADABLE" });
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

  it.each(["absent", "lying-small"] as const)(
    "rejects an oversized raw body with %s Content-Length before JSON parsing",
    async (contentLength) => {
      const body = `${" ".repeat((2 * 1_024 * 1_024) + 1)}${JSON.stringify(GOALS)}`;
      const headers = contentLength === "lying-small" ? { "content-length": "1" } : undefined;
      const frame = await readGoalCatalog({
        fetchImpl: async () => new Response(body, {
          ...(headers === undefined ? {} : { headers }), status: 200,
        }),
        headers: {},
      });

      expect(frame).toMatchObject({
        connection: "CONNECTED", detail: "LIVE_GOAL_CATALOG_UNREADABLE", outcome: "UNREADABLE",
      });
    },
  );
});

describe("createGoalCatalogFeed", () => {
  it("holds one bounded page until Next and lets First return to the first page", async () => {
    const requests: string[] = [];
    const frames: Array<ReturnType<typeof mapGoalCatalogAnswer>> = [];
    const windows: Array<{
      readonly currentPage: number; readonly hasEarlier: boolean; readonly hasMore: boolean;
    }> = [];
    const scheduled: Array<{ readonly delay: number; readonly run: () => void }> = [];
    const row = (index: number) => ({
      brief: { instructions: `Instructions ${String(index)}`, title: `Goal ${String(index)}` },
      goalId: `goal-${String(index)}`, planningRunRef: `run-${String(index)}`, prd: null,
    });
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(String(init?.body));
      return String(init?.body) === "{}"
        ? jsonResponse({
          goals: [row(0), row(1)], nextCursor: "8", observedCursor: "8", outcome: "GOALS",
        })
        : jsonResponse({
          goals: [row(2)], nextCursor: null, observedCursor: "9", outcome: "GOALS",
        });
    });
    vi.stubGlobal("fetch", fetch);

    const feed = createGoalCatalogFeed({
      headers: {},
      intervalMs: 2_000,
      onFrame: (next, window) => { frames.push(next); windows.push(window); },
      schedule: (run, delay) => {
        scheduled.push({ delay, run });
        return () => undefined;
      },
    });
    feed.start();

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(requests).toStrictEqual(["{}"]);
    expect(frames[0]?.goals.map((goal) => goal.goalId)).toStrictEqual(["goal-0", "goal-1"]);
    expect(windows[0]).toStrictEqual({ currentPage: 1, hasEarlier: false, hasMore: true });
    expect(scheduled[0]?.delay).toBe(2_000);

    feed.next();
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(requests).toStrictEqual(["{}", "{\"after\":\"8\"}"]);
    expect(frames[1]?.goals.map((goal) => goal.goalId))
      .toStrictEqual(["goal-2"]);
    expect(windows[1]).toStrictEqual({ currentPage: 2, hasEarlier: true, hasMore: false });

    feed.first();
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(requests).toStrictEqual(["{}", "{\"after\":\"8\"}", "{}"]);
    expect(frames[2]?.goals.map((goal) => goal.goalId))
      .toStrictEqual(["goal-0", "goal-1"]);
    expect(windows[2]).toStrictEqual({ currentPage: 1, hasEarlier: false, hasMore: true });
    feed.first();
    expect(requests).toHaveLength(3);
    feed.stop();
  });

  it("returns goal zero after operator traversal beyond 256 rows without retaining every page", async () => {
    const frames: Array<ReturnType<typeof mapGoalCatalogAnswer>> = [];
    const row = (index: number) => ({
      brief: { instructions: `Instructions ${String(index)}`, title: `Goal ${String(index)}` },
      goalId: `goal-${String(index)}`,
      planningRunRef: `run-${String(index)}`,
      prd: null,
    });
    const readPage = vi.fn(async (after: string | null) => {
      const start = Number(after ?? "0");
      const end = Math.min(start + 32, 320);
      return {
        frame: mapGoalCatalogAnswer(200, {
          goals: Array.from({ length: end - start }, (_, offset) => row(start + offset)),
          nextCursor: end < 320 ? String(end) : null,
          observedCursor: String(end),
          outcome: "GOALS",
        }),
        nextCursor: end < 320 ? String(end) : null,
        observedCursor: String(end),
      };
    });
    const feed = createGoalCatalogFeed({
      headers: {},
      intervalMs: 2_000,
      onFrame: (next) => frames.push(next),
      readPage,
      schedule: () => () => undefined,
    });
    feed.start();
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]?.goals[0]?.goalId).toBe("goal-0");
    for (let page = 2; page <= 10; page += 1) {
      feed.next();
      await vi.waitFor(() => expect(frames).toHaveLength(page));
      expect(frames.at(-1)?.goals.length).toBeLessThanOrEqual(32);
    }
    expect(frames.at(-1)?.goals[0]?.goalId).toBe("goal-288");
    feed.first();
    await vi.waitFor(() => expect(frames).toHaveLength(11));
    expect(frames.at(-1)?.goals[0]?.goalId).toBe("goal-0");
    expect(readPage).toHaveBeenCalledTimes(11);
    feed.stop();
  });
});
