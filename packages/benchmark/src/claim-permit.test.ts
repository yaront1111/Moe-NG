import { afterAll, describe, expect, it } from "vitest";

import { CLAIM_LADDER, PERMANENTLY_FORBIDDEN } from "./claim-ladder-contract.js";
import type { ClaimRungId } from "./claim-ladder-contract.js";
import { permitClaim } from "./claim-permit.js";

const RUNG_IDS = Object.freeze(["L1", "L2", "L3", "L4", "L5"] as const);
let executedForbiddenCases = 0;

function filled(rungId: ClaimRungId, emptySlot?: string): string {
  const rung = CLAIM_LADDER.find((candidate) => candidate.rungId === rungId);
  if (rung === undefined) throw new Error("missing test rung " + rungId);
  let sentence = rung.template;
  for (const [index, slot] of rung.scopeSlots.entries()) {
    const value = slot === emptySlot ? "" : "scope-" + String(index + 1);
    sentence = sentence.replaceAll("{" + slot + "}", value);
  }
  return sentence;
}

describe("permitClaim", () => {
  it("permits exactly the fully scoped template at every reached rung", () => {
    let executed = 0;
    expect(Object.isFrozen(RUNG_IDS)).toBe(true);
    for (const rungId of RUNG_IDS) {
      expect(permitClaim(filled(rungId), rungId)).toEqual({ ok: true });
      executed += 1;
    }
    expect(executed).toBe(5);
  });

  it("refuses a higher-rung template at the lower reached rung", () => {
    expect(permitClaim(filled("L4"), "L3")).toEqual({
      code: "CLAIM_NOT_PERMITTED_AT_RUNG",
      layer: "BENCHMARK_CLAIM_LADDER",
      ok: false,
    });
  });

  it.each(["endpoint", undefined])(
    "refuses the reached template with an empty or unfilled mandatory scope slot",
    (emptySlot) => {
      const sentence = emptySlot === undefined
        ? CLAIM_LADDER[3]?.template ?? ""
        : filled("L4", emptySlot);
      expect(permitClaim(sentence, "L4")).toEqual({
        code: "CLAIM_SCOPE_INCOMPLETE",
        layer: "BENCHMARK_CLAIM_LADDER",
        ok: false,
      });
    },
  );

  it("refuses an appended unsupported clause rather than substring-matching", () => {
    expect(permitClaim(filled("L4") + " This extra claim has no gate.", "L4")).toEqual({
      code: "CLAIM_NOT_PERMITTED_AT_RUNG",
      layer: "BENCHMARK_CLAIM_LADDER",
      ok: false,
    });
  });

  it("refuses every sentence at L0", () => {
    expect(permitClaim(filled("L1"), "L0")).toEqual({
      code: "CLAIM_NOT_PERMITTED_AT_RUNG",
      layer: "BENCHMARK_CLAIM_LADDER",
      ok: false,
    });
  });

  it.each(PERMANENTLY_FORBIDDEN)(
    "refuses permanently-forbidden member %s at every rung including L5",
    (forbidden) => {
      for (const rungId of RUNG_IDS) {
        expect(permitClaim(filled(rungId) + " " + forbidden, rungId)).toEqual({
          code: "CLAIM_PERMANENTLY_FORBIDDEN",
          layer: "BENCHMARK_CLAIM_LADDER",
          ok: false,
        });
      }
      executedForbiddenCases += 1;
    },
  );
});

afterAll(() => {
  expect(executedForbiddenCases).toBe(PERMANENTLY_FORBIDDEN.length);
  expect(executedForbiddenCases).toBe(16);
  expect(PERMANENTLY_FORBIDDEN).toHaveLength(16);
});
