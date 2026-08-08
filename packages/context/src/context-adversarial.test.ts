import { describe, expect, it } from "vitest";

import { renderContext } from "./context-render.js";
import { selectContext } from "./context-selection.js";

const mandatory = (id: string, content: string) => ({
  kind: "MANDATORY" as const,
  id,
  section: "authority",
  content,
});

function requireSelection(contents: readonly [string, string]) {
  const result = selectContext({
    mandatory: [mandatory("first", contents[0]), mandatory("second", contents[1])],
    optional: [],
    exclusions: [],
    byteBudget: 1_000,
  });
  if (result.kind !== "ADMITTED") throw new Error("expected admission");
  return result.selection;
}

describe("hostile context inputs", () => {
  it("refuses non-finite, negative, and fractional byte budgets at the selection layer", () => {
    const invalidBudgets = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5];
    expect(invalidBudgets).toHaveLength(4);
    expect(invalidBudgets.length).toBeGreaterThan(0);

    for (const byteBudget of invalidBudgets) {
      expect(
        selectContext({
          mandatory: [],
          optional: [],
          exclusions: [],
          byteBudget,
        }),
      ).toEqual({
        kind: "REFUSED",
        code: "INVALID_CONTEXT_BUDGET",
        layer: "CONTEXT_SELECTION",
        byteBudget,
      });
    }
  });

  it("frames mandatory items so shifted content boundaries change bytes and digest", () => {
    const left = renderContext(requireSelection(["ab", "c"]));
    const right = renderContext(requireSelection(["a", "bc"]));

    expect(right.bytes).not.toEqual(left.bytes);
    expect(right.manifest.digest).not.toBe(left.manifest.digest);
  });
});
