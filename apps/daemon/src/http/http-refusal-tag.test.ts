import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";

import { refusalTagOf, tagRefusal } from "./http-refusal-tag.js";

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
