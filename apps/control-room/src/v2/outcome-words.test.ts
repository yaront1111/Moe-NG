import { describe, expect, it } from "vitest";

import { readFailedSaid, writeFailedSaid } from "./outcome-words.js";

describe("outcome words", () => {
  it("speaks a write failure without a code", () => {
    expect(writeFailedSaid()).toBe("That didn't go through.");
  });

  it("names the surface a read failure belongs to", () => {
    expect(readFailedSaid("contract")).toBe("The contract could not be read right now.");
    expect(readFailedSaid("plan")).toBe("The plan could not be read right now.");
  });
});
