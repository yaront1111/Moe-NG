import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "@moe/control-room-client";

import {
  MAX_GOAL_CATALOG_PAGES,
  mapGoalCatalogAnswer,
  mapGoalCatalogPage,
  readGoalCatalog,
} from "./live-goal-catalog.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

/**
 * The exact four-key binding /goals/read projects for a `goal.create_with_source` row, landed by
 * task-221fa0c3. Every binding arm below reads THIS value rather than re-spelling it, so an arm
 * cannot silently agree with a decoder that hands back some other row's binding.
 */
const SOURCE_BINDING = Object.freeze({
  byteLength: 37,
  contentSha256: "ab".repeat(32),
  sourceAggregateId:
    "document-source/4201f358379dfb4e5fca8dacd963e7a533dcb9d31770dc6ae69e6225353e432e",
  sourceRef: "source:task-daf-frozen-binding",
});

const GOALS = Object.freeze({
  goals: Object.freeze([
    Object.freeze({ goalId: "goal-random-7f3", planningRunRef: "run-cafe\u0301" }),
    Object.freeze({ goalId: "goal-random-91b", planningRunRef: "planning/a:b" }),
  ]),
  nextCursor: null,
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
          binding: null, brief: null,
          goalId: "goal-random-7f3", planningRunRef: "run-cafe\u0301",
        },
        {
          binding: null, brief: null,
          goalId: "goal-random-91b", planningRunRef: "planning/a:b",
        },
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
    expect(mapGoalCatalogAnswer(200, { goals: [], nextCursor: null, outcome: "GOALS" })).toStrictEqual({
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
    Object.freeze({
      binding: SOURCE_BINDING,
      brief: Object.freeze({
        instructions: "Behind bearer credentials", title: "Ship from the selected PRD",
      }),
      label: "source-bound four-key row",
      row: Object.freeze({
        binding: SOURCE_BINDING,
        brief: Object.freeze({
          instructions: "Behind bearer credentials", title: "Ship from the selected PRD",
        }),
        goalId: "goal-source-1",
        planningRunRef: "run-source-1",
      }),
    }),
  ] as const);

  it("names exactly four accepted catalog entry shapes", () => {
    expect(ACCEPTED_ENTRY_SHAPES).toHaveLength(4);
  });

  it.each(ACCEPTED_ENTRY_SHAPES)(
    "decodes the $label into an entry carrying its own brief and binding",
    (shape) => {
      const { brief, row } = shape;
      expect(mapGoalCatalogAnswer(200, { goals: [row], nextCursor: null, outcome: "GOALS" })).toStrictEqual({
        connection: "CONNECTED",
        detail: "",
        goals: [{
          binding: "binding" in shape ? shape.binding : null,
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
    expect(mapGoalCatalogAnswer(200, { goals: [row], nextCursor: null, outcome: "GOALS" })).toStrictEqual({
      connection: "CONNECTED",
      detail: "LIVE_GOAL_CATALOG_UNREADABLE",
      goals: [],
      outcome: "UNREADABLE",
    });
  });

  /**
   * DoD 3, THE UI HALF OF THE CROSS-PACKAGE SHAPE CHANGE. A real decode of the widened
   * /goals/read answer must carry the binding through for the source-bound row and hand back
   * `null` for the ordinary one - the null half is what proves the field is read FROM the row
   * rather than stamped onto every row by the decoder.
   */
  it("decodes a source-bound row's binding beside an ordinary row's null", () => {
    const frame = mapGoalCatalogAnswer(200, {
      goals: [
        { binding: null, brief: null, goalId: "goal-plain", planningRunRef: "run-plain" },
        {
          binding: SOURCE_BINDING,
          brief: null,
          goalId: "goal-bound",
          planningRunRef: "run-bound",
        },
      ],
      nextCursor: null,
      outcome: "GOALS",
    });

    expect(frame).toStrictEqual({
      connection: "CONNECTED",
      detail: "",
      goals: [
        { binding: null, brief: null, goalId: "goal-plain", planningRunRef: "run-plain" },
        {
          binding: SOURCE_BINDING,
          brief: null,
          goalId: "goal-bound",
          planningRunRef: "run-bound",
        },
      ],
      outcome: "GOALS",
    });
    expect(Object.isFrozen(frame.goals[1]?.binding)).toBe(true);
  });

  /**
   * DoD 3, EXACTNESS WIDENED AND NOT ABANDONED (taskRail 2). The roster grew by ONE key; it did
   * not grow tolerance. Every case here must reach the SAME refusal path - CONNECTED /
   * UNREADABLE / LIVE_GOAL_CATALOG_UNREADABLE, the decoder's own stable code, not merely "not
   * the row I sent". A fifth key is refused at the ENTRY level, and an over-wide or malformed
   * binding is refused at the BINDING level, so admitting `binding` did not admit it opaquely.
   */
  it.each([
    ["a fifth unknown key beside the binding", {
      binding: SOURCE_BINDING, brief: null, goalId: "goal-1",
      planningRunRef: "run-1", projectId: "project-attacker",
    }],
    ["a binding carrying a fifth key", {
      binding: { ...SOURCE_BINDING, displayPath: "PRD.md" },
      brief: null, goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a binding missing sourceRef", {
      binding: {
        byteLength: SOURCE_BINDING.byteLength,
        contentSha256: SOURCE_BINDING.contentSha256,
        sourceAggregateId: SOURCE_BINDING.sourceAggregateId,
      },
      brief: null, goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a binding with an empty content digest", {
      binding: { ...SOURCE_BINDING, contentSha256: "" },
      brief: null, goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a binding with a fractional byte length", {
      binding: { ...SOURCE_BINDING, byteLength: 1.5 },
      brief: null, goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a binding with a negative byte length", {
      binding: { ...SOURCE_BINDING, byteLength: -1 },
      brief: null, goalId: "goal-1", planningRunRef: "run-1",
    }],
    ["a binding that is a string", {
      binding: "document-source/deadbeef", brief: null,
      goalId: "goal-1", planningRunRef: "run-1",
    }],
  ])("fails the whole delivered catalog closed for %s", (_label, row) => {
    expect(mapGoalCatalogAnswer(200, { goals: [row], nextCursor: null, outcome: "GOALS" })).toStrictEqual({
      connection: "CONNECTED",
      detail: "LIVE_GOAL_CATALOG_UNREADABLE",
      goals: [],
      outcome: "UNREADABLE",
    });
  });

  it("refuses an accessor-backed binding without invoking attacker code", () => {
    const refGetter = vi.fn(() => "source:attacker");
    const accessorBinding = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessorBinding, {
      byteLength: { enumerable: true, value: SOURCE_BINDING.byteLength },
      contentSha256: { enumerable: true, value: SOURCE_BINDING.contentSha256 },
      sourceAggregateId: { enumerable: true, value: SOURCE_BINDING.sourceAggregateId },
      sourceRef: { enumerable: true, get: refGetter },
    });

    expect(mapGoalCatalogAnswer(200, {
      goals: [{
        binding: accessorBinding, brief: null, goalId: "goal-1", planningRunRef: "run-1",
      }],
      nextCursor: null,
      outcome: "GOALS",
    })).toStrictEqual({
      connection: "CONNECTED",
      detail: "LIVE_GOAL_CATALOG_UNREADABLE",
      goals: [],
      outcome: "UNREADABLE",
    });
    expect(refGetter).not.toHaveBeenCalled();
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
      expect(mapGoalCatalogAnswer(200, { goals: [row], nextCursor: null, outcome: "GOALS" })).toMatchObject({
        connection: "CONNECTED", detail: "LIVE_GOAL_CATALOG_UNREADABLE", outcome: "UNREADABLE",
      });
    }
    expect(briefGetter).not.toHaveBeenCalled();
    expect(titleGetter).not.toHaveBeenCalled();
  });

  it.each([
    ["extra success key", { ...GOALS, projectId: "project-attacker" }],
    ["missing goals", { nextCursor: null, outcome: "GOALS" }],
    ["extra row key", {
      goals: [{ goalId: "goal-1", planningRunRef: "run-1", projectId: "project-attacker" }],
      nextCursor: null,
      outcome: "GOALS",
    }],
    ["empty goal id", {
      goals: [{ goalId: "", planningRunRef: "run-1" }], nextCursor: null, outcome: "GOALS",
    }],
    ["empty planning run", {
      goals: [{ goalId: "goal-1", planningRunRef: "" }], nextCursor: null, outcome: "GOALS",
    }],
    ["duplicate durable identity", {
      goals: [
        { goalId: "goal-1", planningRunRef: "run-1" },
        { goalId: "goal-1", planningRunRef: "run-2" },
      ],
      nextCursor: null,
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

  it.each([
    ["an answer with no nextCursor key", { goals: [], outcome: "GOALS" }],
    ["an answer with a fourth key", {
      goals: [], nextCursor: null, outcome: "GOALS", projectId: "project-attacker",
    }],
    ["a numeric cursor", { goals: [], nextCursor: 7, outcome: "GOALS" }],
    ["an empty-string cursor", { goals: [], nextCursor: "", outcome: "GOALS" }],
  ])("fails the whole delivered catalog closed for %s", (_label, answer) => {
    expect(mapGoalCatalogAnswer(200, answer)).toStrictEqual({
      connection: "CONNECTED",
      detail: "LIVE_GOAL_CATALOG_UNREADABLE",
      goals: [],
      outcome: "UNREADABLE",
    });
  });

  /**
   * The FRAME never carries the cursor: it is transport bookkeeping, and the shell renders
   * frames. `mapGoalCatalogPage` is the seam the drain reads it from, so the two are asserted
   * together — a frame that leaked the cursor, or a page that dropped it, fails here.
   */
  it("keeps the continuation cursor out of the frame and on the page", () => {
    const answer = {
      goals: [{ binding: null, brief: null, goalId: "goal-1", planningRunRef: "run-1" }],
      nextCursor: "cursor-1",
      outcome: "GOALS",
    };
    const frame = {
      connection: "CONNECTED",
      detail: "",
      goals: [{ binding: null, brief: null, goalId: "goal-1", planningRunRef: "run-1" }],
      outcome: "GOALS",
    };

    expect(mapGoalCatalogAnswer(200, answer)).toStrictEqual(frame);
    expect(mapGoalCatalogPage(200, answer)).toStrictEqual({ frame, nextCursor: "cursor-1" });
    expect(mapGoalCatalogPage(200, { ...answer, nextCursor: null }))
      .toStrictEqual({ frame, nextCursor: null });
  });

  it("rejects accessor-backed rows without invoking attacker code", () => {
    const getter = vi.fn(() => "goal-attacker");
    const row = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(row, {
      goalId: { enumerable: true, get: getter },
      planningRunRef: { enumerable: true, value: "run-1" },
    });

    expect(mapGoalCatalogAnswer(200, { goals: [row], nextCursor: null, outcome: "GOALS" })).toMatchObject({
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

describe("readGoalCatalog draining pages", () => {
  function pageOf(count: number, offset: number, nextCursor: string | null): unknown {
    return {
      goals: Array.from({ length: count }, (_unused, index) => ({
        brief: null,
        goalId: `goal-${String(offset + index).padStart(4, "0")}`,
        planningRunRef: `run-${String(offset + index).padStart(4, "0")}`,
      })),
      nextCursor,
      outcome: "GOALS",
    };
  }

  /** Answers a scripted sequence of pages and records the exact request bodies it was sent. */
  function scriptedFetch(pages: readonly unknown[]): {
    readonly bodies: string[]; readonly fetchImpl: FetchLike;
  } {
    const bodies: string[] = [];
    let index = 0;
    return {
      bodies,
      fetchImpl: async (_input, init) => {
        bodies.push(String(init.body));
        const page = pages[index];
        index += 1;
        if (page === undefined) throw new Error("the drain asked for more pages than scripted");
        return jsonResponse(page);
      },
    };
  }

  it("drains every page into one frame and forwards the cursor verbatim", async () => {
    const { bodies, fetchImpl } = scriptedFetch([
      pageOf(256, 0, "cursor-page-1"), pageOf(44, 256, null),
    ]);

    const frame = await readGoalCatalog({ fetchImpl, headers: {} });

    expect(frame.outcome).toBe("GOALS");
    expect(frame.goals).toHaveLength(300);
    expect(frame.goals[0]?.goalId).toBe("goal-0000");
    expect(frame.goals[299]?.goalId).toBe("goal-0299");
    expect(bodies).toStrictEqual(["{}", '{"cursor":"cursor-page-1"}']);
  });

  it("refuses rather than rendering a partial catalog when a later page is refused", async () => {
    const { bodies, fetchImpl } = scriptedFetch([
      pageOf(256, 0, "cursor-page-1"),
      { code: "GOAL_CATALOG_CURSOR_STALE", layer: "GOAL_CATALOG_READ", outcome: "REFUSED" },
    ]);

    const frame = await readGoalCatalog({ fetchImpl, headers: {} });

    expect(frame).toStrictEqual({
      connection: "CONNECTED",
      detail: "GOAL_CATALOG_CURSOR_STALE",
      goals: [],
      outcome: "REFUSED",
    });
    expect(bodies).toHaveLength(2);
  });

  it("refuses a catalog that never stops paging, with its own bounded-drain detail", async () => {
    const bodies: string[] = [];
    const frame = await readGoalCatalog({
      fetchImpl: async (_input, init) => {
        bodies.push(String(init.body));
        return jsonResponse(pageOf(1, bodies.length, `cursor-${String(bodies.length)}`));
      },
      headers: {},
    });

    expect(frame).toStrictEqual({
      connection: "CONNECTED",
      detail: "GOAL_CATALOG_DRAIN_BOUND_EXCEEDED",
      goals: [],
      outcome: "REFUSED",
    });
    expect(bodies).toHaveLength(MAX_GOAL_CATALOG_PAGES);
  });

  it("refuses a catalog whose pages repeat a durable identity", async () => {
    const { fetchImpl } = scriptedFetch([pageOf(1, 0, "cursor-page-1"), pageOf(1, 0, null)]);

    expect(await readGoalCatalog({ fetchImpl, headers: {} })).toStrictEqual({
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
