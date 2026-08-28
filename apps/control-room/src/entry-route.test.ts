import { describe, expect, it } from "vitest";

import { gateDevelopmentQuery } from "./entry-route.js";

describe("production entry routing", () => {
  it("removes every development-only view selector while preserving the manager route", () => {
    expect(gateDevelopmentQuery("?projects=1&v1=1&fixtures=1&view=health", false))
      .toBe("?projects=1&view=health");
  });

  it("removes a development-only selector even without a leading question mark", () => {
    expect(gateDevelopmentQuery("fixtures=1", false)).toBe("");
    expect(gateDevelopmentQuery("v1=1", false)).toBe("");
  });

  it("leaves development queries byte-for-byte unchanged", () => {
    const search = "?fixtures=1&v1=1&view=board";
    expect(gateDevelopmentQuery(search, true)).toBe(search);
  });
});
