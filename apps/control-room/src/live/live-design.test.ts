import { afterEach, describe, expect, it, vi } from "vitest";

import { mapDesignAnswer, readDesign } from "./live-design.js";

// The raw HTTP frame: design-read.ts forwards DesignReadResult without a wrapper.
const frame = () => ({
  ok: true,
  record: {
    contractRef: { contractId: "contract-1", revisionDigest: "a".repeat(64), revisionId: "revision-1" },
    goalRef: "goal-1", profile: "typescript-web-app/react-node-postgresql", projectId: "project-1",
    revision: {
      apiSurface: [{ payload: "{ id }", route: "GET /orders/:id" }], componentList: ["OrderList"],
      dataModel: [{ entity: "Order", fields: ["id"], relations: ["Customer.id"] }],
      nonFunctional: { accessibility: "Keyboard support", auth: "Session cookie", performance: "p95 200ms" },
      openDecisions: ["Allow exports?"],
      screens: [{ journey: "Read orders", screens: [{ screen: "Orders", states: ["LOADED"] }] }],
    },
    schemaVersion: "moe-design-revision/1", submittedAt: "2026-09-05T09:00:00.000Z", version: 1,
  },
  versions: [1],
});
const invalid = { code: "DESIGN_RESPONSE_INVALID", layer: "CONTROL_ROOM_LIVE_DESIGN", status: "ERROR" };
const response = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe("mapDesignAnswer", () => {
  it("copies the exact HTTP record, including the named data model entity", () => {
    const input = frame();
    const result = mapDesignAnswer(200, input);
    expect(result).toStrictEqual({ status: "DESIGN", record: input.record, versions: [1] });
    input.record.revision.dataModel[0]!.entity = "Changed";
    expect(result).toMatchObject({ record: { revision: { dataModel: [{ entity: "Order" }] } } });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects extra and missing keys at every nested record", () => {
    const input = frame();
    const records = [input, input.record, input.record.contractRef, input.record.revision,
      input.record.revision.dataModel[0]!, input.record.revision.apiSurface[0]!,
      input.record.revision.nonFunctional, input.record.revision.screens[0]!,
      input.record.revision.screens[0]!.screens[0]!];
    for (const record of records) {
      Object.defineProperty(record, "extra", { configurable: true, value: 1, enumerable: true });
      expect(mapDesignAnswer(200, input), "extra key").toStrictEqual(invalid);
      Reflect.deleteProperty(record, "extra");
      const key = Object.keys(record)[0]!;
      const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
      Reflect.deleteProperty(record, key);
      expect(mapDesignAnswer(200, input), `missing ${key}`).toStrictEqual(invalid);
      Object.defineProperty(record, key, descriptor);
    }
    expect(records).toHaveLength(9);
  });

  it("rejects invalid types, versions, prototypes and accessors without invoking getters", () => {
    const base = frame();
    const getter = vi.fn(() => true);
    const accessor = Object.defineProperty({ ...base }, "ok", { get: getter });
    const sparse = Array(1) as unknown[];
    const values = [null, [], { ...base, ok: false }, { ...base, versions: [0] },
      { ...base, versions: sparse }, { ...base, versions: [1, 1] },
      { ...base, record: { ...base.record, version: 1.5 } },
      { ...base, record: { ...base.record, schemaVersion: "future" } },
      { ...base, record: { ...base.record, profile: "future" } },
      { ...base, record: { ...base.record, revision: { ...base.record.revision, componentList: [7] } } },
      Object.assign(Object.create({ inherited: true }), base), accessor,
      Object.defineProperty({ ...base }, "hidden", { value: 1 }),
      { ...base, [Symbol("extra")]: true }];
    for (const value of values) expect(mapDesignAnswer(200, value)).toStrictEqual(invalid);
    expect(getter).not.toHaveBeenCalled();
    expect(mapDesignAnswer(500, base)).toStrictEqual(invalid);
  });

  it("accepts the landed declared-skip frame, not a half-skipped design", () => {
    const base = frame();
    const revision = { skipped: true, reason: "Internal CLI tool" };
    expect(mapDesignAnswer(200, { ...base, record: { ...base.record, revision } }))
      .toMatchObject({ status: "DESIGN", record: { revision } });
    for (const bad of [{ ...revision, skipped: false }, { ...revision, reason: "" },
      { ...revision, ...base.record.revision }]) {
      expect(mapDesignAnswer(200, { ...base, record: { ...base.record, revision: bad } })).toStrictEqual(invalid);
    }
  });

  it("preserves the code and refusing layer on daemon and listener frames", () => {
    const absent = { code: "DESIGN_REVISION_ABSENT", layer: "LEDGER" };
    for (const value of [absent, { ...absent, outcome: "REFUSED" },
      { ...absent, ok: false, sourceCode: null, sourceLayer: null }]) {
      expect(mapDesignAnswer(200, value)).toStrictEqual({ ...absent, status: "REFUSED" });
      expect(mapDesignAnswer(200, { ...value, extra: true })).toStrictEqual(invalid);
    }
    const listener = { code: "LISTENER_DESIGN_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER" };
    expect(mapDesignAnswer(503, listener)).toStrictEqual({ ...listener, status: "REFUSED" });
    expect(mapDesignAnswer(200, { ...absent, ok: false, sourceCode: 7, sourceLayer: null })).toStrictEqual(invalid);
  });
});

describe("readDesign", () => {
  it("posts only the goal reference to the session-authenticated route with a timeout", async () => {
    const fetcher = vi.fn(async () => response(200, frame()));
    vi.stubGlobal("fetch", fetcher);
    const headers = { "x-session": "session-fixture" };
    expect(await readDesign(headers, "goal-1")).toMatchObject({ status: "DESIGN" });
    expect(fetcher).toHaveBeenCalledWith("/design/read", {
      body: JSON.stringify({ goalRef: "goal-1" }), headers, method: "POST", signal: expect.any(AbortSignal),
    });
  });

  it("uses the injectable post and names transport and malformed-JSON failures", async () => {
    const post = vi.fn(async (_body: string) => response(200, frame()));
    expect(await readDesign({}, "goal-1", post)).toMatchObject({ status: "DESIGN" });
    expect(post).toHaveBeenCalledWith(JSON.stringify({ goalRef: "goal-1" }));
    expect(await readDesign({}, "goal-1", async () => { throw new Error("offline"); }))
      .toStrictEqual({ code: "TRANSPORT_REQUEST_FAILED", layer: "CONTROL_ROOM_LIVE_DESIGN", status: "ERROR" });
    expect(await readDesign({}, "goal-1", async () => new Response("not json"))).toStrictEqual(invalid);
  });
});
