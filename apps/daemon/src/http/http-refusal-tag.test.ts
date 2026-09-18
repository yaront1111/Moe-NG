import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";

import { faultFrameOf, faultFrameTagOf, refusalTagOf, tagFaultFrame, tagRefusal } from "./http-refusal-tag.js";

const response = (): ServerResponse => ({ statusCode: 200 }) as unknown as ServerResponse;

describe("the listener refusal tag", () => {
  it("answers null for a response nobody refused", () => {
    expect(refusalTagOf(response())).toBeNull();
  });

  it("carries the code back out", () => {
    const outgoing = response();

    tagRefusal(outgoing, "LISTENER_CSRF_INVALID");

    expect(refusalTagOf(outgoing)).toBe("LISTENER_CSRF_INVALID");
  });

  it("keeps the last refusal when a response is tagged twice", () => {
    const outgoing = response();

    tagRefusal(outgoing, "LISTENER_ROUTE_UNKNOWN");
    tagRefusal(outgoing, "LISTENER_METHOD_INVALID");

    expect(refusalTagOf(outgoing)).toBe("LISTENER_METHOD_INVALID");
  });

  it("is invisible to JSON, so no refusal body can ever carry it", () => {
    const outgoing = response();

    tagRefusal(outgoing, "LISTENER_CSRF_INVALID");

    expect(JSON.stringify(outgoing)).not.toContain("LISTENER_CSRF_INVALID");
    expect(JSON.stringify({ ...outgoing })).not.toContain("LISTENER_CSRF_INVALID");
  });

  it("is invisible to anything enumerating the response's keys", () => {
    const outgoing = response();

    tagRefusal(outgoing, "LISTENER_CSRF_INVALID");

    expect(Object.keys(outgoing)).not.toContain("LISTENER_CSRF_INVALID");
    expect(Object.entries(outgoing).flat()).not.toContain("LISTENER_CSRF_INVALID");
  });

  it("NEVER throws on a frozen response: the refusal is the answer the client is owed", () => {
    const frozen = Object.freeze({ statusCode: 200 }) as unknown as ServerResponse;

    expect(() => { tagRefusal(frozen, "LISTENER_CSRF_INVALID"); }).not.toThrow();
    expect(refusalTagOf(frozen)).toBeNull();
  });

  it("NEVER throws on a response whose every access is hostile", () => {
    const hostile = new Proxy({}, {
      get() { throw new Error("trap"); },
      set() { throw new Error("trap"); },
    }) as unknown as ServerResponse;

    expect(() => { tagRefusal(hostile, "LISTENER_CSRF_INVALID"); }).not.toThrow();
    expect(refusalTagOf(hostile)).toBeNull();
  });

  it("does not leak between two responses", () => {
    const first = response();
    const second = response();

    tagRefusal(first, "LISTENER_CSRF_INVALID");

    expect(refusalTagOf(second)).toBeNull();
  });
});

describe("the fault-frame predicate and tag", () => {
  it("recognises a durable-store refusal, nested as a command result nests it and flat as a read frame carries it", () => {
    expect(faultFrameOf({
      httpStatus: 503, ok: false, outcome: "PORT_REFUSED", stage: "DISPATCH",
      refusal: { code: "OUTCOME_UNKNOWN", detail: "database is locked", httpStatus: 503, layer: "DURABLE_STORE" },
    })).toEqual({ code: "OUTCOME_UNKNOWN", layer: "DURABLE_STORE" });
    expect(faultFrameOf({ code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_HEALTH", outcome: "REFUSED" }))
      .toEqual({ code: "PROBE_STORE_UNAVAILABLE", layer: "DAEMON_HEALTH" });
    expect(faultFrameOf({ code: "PLANNING_RUN_READ_AUTHORITY_UNREADABLE", layer: "DAEMON_PLANNING", ok: false }))
      .toEqual({ code: "PLANNING_RUN_READ_AUTHORITY_UNREADABLE", layer: "DAEMON_PLANNING" });
  });

  it("answers null for a verdict, an uncomposed port, a decided command and a non-object", () => {
    expect(faultFrameOf({ code: "GOAL_NOT_FOUND", layer: "DAEMON_GOALS", outcome: "REFUSED" })).toBeNull();
    expect(faultFrameOf({ code: "LISTENER_PAIRING_UNAVAILABLE", layer: "CONTROL_ROOM_LISTENER" })).toBeNull();
    expect(faultFrameOf({ decision: { outcome: "ACCEPTED" }, ok: true, outcome: "DECIDED" })).toBeNull();
    expect(faultFrameOf("OUTCOME_UNKNOWN DURABLE_STORE")).toBeNull();
    expect(faultFrameOf(null)).toBeNull();
  });

  it("carries the frame back out, invisibly to JSON, and never throws on a frozen response", () => {
    const outgoing = response();
    expect(faultFrameTagOf(outgoing)).toBeNull();
    tagFaultFrame(outgoing, { code: "OUTCOME_UNKNOWN", layer: "DURABLE_STORE" });
    expect(faultFrameTagOf(outgoing)).toEqual({ code: "OUTCOME_UNKNOWN", layer: "DURABLE_STORE" });
    expect(JSON.stringify(outgoing)).not.toContain("DURABLE_STORE");

    const frozen = Object.freeze({ statusCode: 200 }) as unknown as ServerResponse;
    expect(() => { tagFaultFrame(frozen, { code: "X_THREW", layer: "Y" }); }).not.toThrow();
    expect(faultFrameTagOf(frozen)).toBeNull();
  });
});
