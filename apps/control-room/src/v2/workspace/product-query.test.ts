import { describe, expect, it } from "vitest";
import { readProductQuery, writeProductQuery } from "./product-query.js";

describe("product location", () => {
  it("round trips only public selection state and keeps unrelated selectors", () => {
    const query = { goalId: "goal/a b", artifactId: "preview:123", inspector: "requirements" as const };
    const search = writeProductQuery("?fixtures=1&v2=1", query);
    expect(readProductQuery(search)).toEqual(query);
    expect(new URLSearchParams(search).get("fixtures")).toBe("1");
  });
  it("refuses duplicate subjects instead of selecting the first", () => {
    expect(readProductQuery("?product=a&product=b")).toEqual({ kind: "invalid" });
  });
  it("refuses malformed or oversized selection", () => {
    expect(readProductQuery("?product=%00")).toEqual({ kind: "invalid" });
    expect(readProductQuery(`?product=${"a".repeat(513)}`)).toEqual({ kind: "invalid" });
    expect(readProductQuery("?product=a&inspect=approve")).toEqual({ kind: "invalid" });
  });
  it("clears all workspace selection when returning home", () => {
    expect(writeProductQuery("?product=a&artifact=x&inspect=record&fixtures=1", null)).toBe("?fixtures=1");
    expect(readProductQuery("?fixtures=1")).toBeNull();
  });
});
