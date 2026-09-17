import { describe, expect, it } from "vitest";

import { emptyBody } from "./empty-read-body.js";

const encoder = new TextEncoder();

describe("emptyBody admits only a read that carries no operand", () => {
  it("accepts zero bytes and exactly `{}`", () => {
    expect(emptyBody(new Uint8Array())).toBe(true);
    expect(emptyBody(encoder.encode("{}"))).toBe(true);
  });

  it("refuses an object with any member, even one the read would ignore", () => {
    expect(emptyBody(encoder.encode('{"projectId":"p"}'))).toBe(false);
  });

  it("refuses every other JSON value, including the empty array and null", () => {
    for (const text of ["[]", "null", "0", '""', "false"]) {
      expect(emptyBody(encoder.encode(text))).toBe(false);
    }
  });

  it("refuses malformed bytes and a body that is not bytes at all", () => {
    expect(emptyBody(encoder.encode("{"))).toBe(false);
    expect(emptyBody("{}")).toBe(false);
    expect(emptyBody({})).toBe(false);
    expect(emptyBody(undefined)).toBe(false);
  });
});
