/**
 * The design revision's SHAPE refusals and its closed code->layer map.
 *
 * EVERY ARM ASSERTS CODE **AND** LAYER. Several surfaces can refuse a malformed design payload —
 * the exact-arity record, the nested section decoders, and later the store's own fence — so an
 * arm that asserted only `ok === false` would stay green while a different layer started
 * answering first and the arm stopped testing its subject.
 *
 * THE ROSTER IS COMPARED AGAINST THE MAP'S KEYS, NOT AGAINST A LIST RESTATED HERE. A restated
 * roster is a second source of truth: deleting a code from production would shrink both the map
 * and this file's expectation together and the test would never notice.
 */

import { describe, expect, it } from "vitest";

import {
  DESIGN_AGGREGATE_PREFIX,
  DESIGN_CODES,
  DESIGN_CODE_LAYERS,
  DESIGN_LAYERS,
  DESIGN_NON_FUNCTIONAL_KEYS,
  DESIGN_REVISION_KEYS,
  DESIGN_SECTION_KEYS,
  DESIGN_SKIP_KEYS,
  MAX_DESIGN_TEXT,
  decodeDesignRevision,
  decodeDesignRevisionBytes,
  designAggregateId,
  designRefusal,
  isDesignSkip,
  type DesignCode,
} from "./design-contracts.js";
import { designRevisionFixture, designSkipFixture } from "./design-test-fixtures.js";

const encoder = new TextEncoder();

/** One revision with exactly one member replaced, built from the good fixture every time. */
function revisionWith(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...designRevisionFixture(), ...overrides };
}

describe("the design refusal vocabulary", () => {
  it("derives the code roster from the layer map's keys and nothing else", () => {
    expect([...DESIGN_CODES]).toEqual(Object.keys(DESIGN_CODE_LAYERS).sort());
    expect(DESIGN_CODES).toHaveLength(Object.keys(DESIGN_CODE_LAYERS).length);
  });

  it("maps every code to a layer inside the closed layer roster", () => {
    expect(DESIGN_CODES.length).toBeGreaterThan(0);
    for (const code of DESIGN_CODES) {
      expect(DESIGN_LAYERS).toContain(DESIGN_CODE_LAYERS[code]);
    }
  });

  it.each([
    ["DESIGN_CONTRACT_NOT_APPROVED", "CONTRACT_AUTHORITY"],
    ["DESIGN_RECORD_MALFORMED", "LEDGER"],
    ["DESIGN_REVISION_ABSENT", "LEDGER"],
    ["DESIGN_REVISION_CONFLICT", "LEDGER"],
    ["DESIGN_SHAPE_INVALID", "REQUEST"],
    ["DESIGN_STORE_UNAVAILABLE", "LEDGER"],
  ] as const)("mints %s at layer %s and at no other", (code, layer) => {
    expect(DESIGN_CODE_LAYERS[code]).toBe(layer);
    const refusal = designRefusal(code);
    expect(refusal.code).toBe(code);
    expect(refusal.layer).toBe(layer);
    expect(refusal.ok).toBe(false);
  });

  it("cannot be handed a layer by its call site", () => {
    // The factory's arity is (code, sourceCode?, sourceLayer?): a delegated surface's OWN layer
    // is copied verbatim into `sourceLayer` and never becomes this refusal's `layer`.
    const refusal = designRefusal("DESIGN_SHAPE_INVALID", "FOREIGN_CODE", "FOREIGN_LAYER");
    expect(refusal.layer).toBe("REQUEST");
    expect(refusal.sourceLayer).toBe("FOREIGN_LAYER");
    expect(refusal.sourceCode).toBe("FOREIGN_CODE");
  });

  it("names five sections plus the open-decisions list", () => {
    expect([...DESIGN_SECTION_KEYS]).toHaveLength(5);
    expect([...DESIGN_REVISION_KEYS].sort()).toEqual(
      [...DESIGN_SECTION_KEYS, "openDecisions"].sort(),
    );
    expect(designAggregateId("goal-7")).toBe(`${DESIGN_AGGREGATE_PREFIX}goal-7`);
  });
});

describe("decodeDesignRevision", () => {
  it("admits the complete revision and returns every section", () => {
    const decoded = decodeDesignRevision(designRevisionFixture());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("fixture must decode");
    // The six-key path now shares a decoder with the two-key skip, so the arm pins WHICH branch
    // answered before it compares sections; without this a skip returned here would compare as
    // six undefineds against six undefineds and pass.
    expect(isDesignSkip(decoded.revision)).toBe(false);
    if (isDesignSkip(decoded.revision)) throw new Error("a six-key revision is not a skip");
    for (const key of DESIGN_REVISION_KEYS) {
      expect(decoded.revision[key]).toEqual(designRevisionFixture()[key]);
    }
  });

  it.each([...DESIGN_REVISION_KEYS])(
    "refuses DESIGN_SHAPE_INVALID at REQUEST when the %s member is missing",
    (missing) => {
      const partial = { ...designRevisionFixture() } as Record<string, unknown>;
      delete partial[missing];
      const decoded = decodeDesignRevision(partial);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error(`a revision without ${missing} must be refused`);
      expect(decoded.code).toBe("DESIGN_SHAPE_INVALID");
      expect(decoded.layer).toBe("REQUEST");
    },
  );

  it("refuses an UNKNOWN EXTRA key rather than ignoring it", () => {
    const decoded = decodeDesignRevision({
      ...designRevisionFixture(), telemetryBudget: "p99 under 1s",
    });
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("an extra member must be refused, never dropped");
    expect(decoded.code).toBe("DESIGN_SHAPE_INVALID");
    expect(decoded.layer).toBe("REQUEST");
  });

  it.each([
    ["screens", "a journey map that is a string"],
    ["dataModel", { entity: "User", fields: [], relations: [] }],
    ["apiSurface", [{ payload: "{}", route: 7 }]],
    ["componentList", [{ name: "AppShell" }]],
    ["nonFunctional", { accessibility: "AA", auth: "session" }],
    ["openDecisions", "one open decision"],
  ] as const)(
    "refuses DESIGN_SHAPE_INVALID at REQUEST when %s is the wrong type",
    (section, wrong) => {
      const decoded = decodeDesignRevision(revisionWith({ [section]: wrong }));
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error(`a wrong-typed ${section} must be refused`);
      expect(decoded.code).toBe("DESIGN_SHAPE_INVALID");
      expect(decoded.layer).toBe("REQUEST");
    },
  );

  it("refuses an unknown extra key nested inside a section", () => {
    const decoded = decodeDesignRevision(revisionWith({
      nonFunctional: {
        ...designRevisionFixture().nonFunctional, observability: "OpenTelemetry",
      },
    }));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("a nested extra member must be refused");
    expect(decoded.code).toBe("DESIGN_SHAPE_INVALID");
    expect(decoded.layer).toBe("REQUEST");
    expect([...DESIGN_NON_FUNCTIONAL_KEYS]).not.toContain("observability");
  });

  it("refuses a member carried on the prototype rather than owned", () => {
    const decoded = decodeDesignRevision(
      Object.create({ openDecisions: [] }, Object.fromEntries(
        DESIGN_SECTION_KEYS.map((key) => [key, {
          configurable: true, enumerable: true, value: designRevisionFixture()[key],
        }]),
      )),
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("an inherited member must not satisfy the roster");
    expect(decoded.code).toBe("DESIGN_SHAPE_INVALID");
    expect(decoded.layer).toBe("REQUEST");
  });
});

/**
 * THE DECLARED SKIP. Two arities are admitted and the discriminator is an OWN `skipped` marker, so
 * every arm here names the OUTCOME rather than "did not throw": a skip that decoded as a design,
 * or a design that decoded as a skip, would both be silent corruptions of what the seat submitted.
 *
 * HALF-SKIPPED IS UNREPRESENTABLE BY ARITY, NOT BY A CHECK. `{skipped, reason, ...six sections}`
 * is eight keys and satisfies NEITHER roster; `{skipped: false, reason}` fails the literal. Both
 * refuse through `designRefusal("DESIGN_SHAPE_INVALID")`, which reads REQUEST out of the closed
 * layer map — no arm below writes a layer literal into production, and every arm reads code AND
 * layer off the result, so a different layer answering first would fail these rather than pass.
 */
describe("decodeDesignRevision on a declared skip", () => {
  it("admits the two-key skip and narrows it with isDesignSkip", () => {
    const decoded = decodeDesignRevision(designSkipFixture());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("the skip fixture must decode");
    expect(isDesignSkip(decoded.revision)).toBe(true);
    if (!isDesignSkip(decoded.revision)) throw new Error("a skip must narrow to a skip");
    expect(decoded.revision.skipped).toBe(true);
    expect(decoded.revision.reason).toBe(designSkipFixture().reason);
    expect(Object.keys(decoded.revision).sort()).toEqual([...DESIGN_SKIP_KEYS].sort());
    expect(Object.isFrozen(decoded.revision)).toBe(true);
  });

  it("still round trips the SIX-KEY revision unchanged, and does not call it a skip", () => {
    // DoD-2's clause, by name: the whole justification for admitting two arities is that the
    // existing payload's outcome did not move. An `ok === false` here would mean it did.
    const decoded = decodeDesignRevision(designRevisionFixture());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(`a six-key revision must still decode: ${decoded.code}`);
    expect(isDesignSkip(decoded.revision)).toBe(false);
    expect(Object.keys(decoded.revision).sort()).toEqual([...DESIGN_REVISION_KEYS].sort());
    expect(decoded.revision).toEqual(designRevisionFixture());
  });

  it.each([
    ["a skip that still carries all six sections", {
      ...designRevisionFixture(), ...designSkipFixture(),
    }],
    ["a skip that carries one section", {
      ...designSkipFixture(), openDecisions: ["Does the operator want SSO in v1?"],
    }],
    ["an un-skipped marker carrying no sections", { reason: "changed my mind", skipped: false }],
    ["a skipped marker with no reason", { skipped: true }],
    ["a reason that is absent but keyed", { reason: undefined, skipped: true }],
    ["a skipped marker that is not a boolean", { reason: "why", skipped: "true" }],
    ["a skipped marker that is truthy but not true", { reason: "why", skipped: 1 }],
    ["an empty reason", { reason: "", skipped: true }],
    ["a reason with a NUL byte", { reason: "skip\u0000ped", skipped: true }],
    ["a reason over MAX_DESIGN_TEXT", { reason: "s".repeat(MAX_DESIGN_TEXT + 1), skipped: true }],
    ["a reason that is a String object rather than a primitive", {
      reason: new String("boxed"), skipped: true,
    }],
  ])("refuses DESIGN_SHAPE_INVALID at REQUEST for %s", (_label, value) => {
    const decoded = decodeDesignRevision(value);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("a half-skipped or malformed skip must be refused");
    expect(decoded.code).toBe("DESIGN_SHAPE_INVALID");
    expect(decoded.layer).toBe("REQUEST");
  });

  it("refuses a reason exactly one byte over the bound and admits it exactly at the bound", () => {
    const atBound = decodeDesignRevision({ reason: "s".repeat(MAX_DESIGN_TEXT), skipped: true });
    expect(atBound.ok).toBe(true);
    const overBound = decodeDesignRevision({
      reason: "s".repeat(MAX_DESIGN_TEXT + 1), skipped: true,
    });
    expect(overBound.ok).toBe(false);
    if (overBound.ok) throw new Error("an over-long reason must be refused");
    expect(overBound.code).toBe("DESIGN_SHAPE_INVALID");
    expect(overBound.layer).toBe("REQUEST");
  });

  it("refuses a skip whose marker is INHERITED rather than owned", () => {
    // `"skipped" in value` would walk the prototype chain here and route this to the skip path,
    // where `exactDesignRecord` would then see one own key and refuse for the wrong reason. The
    // discriminator uses `Reflect.ownKeys`, so this never reaches the skip path at all.
    const decoded = decodeDesignRevision(Object.create({ skipped: true }, {
      reason: { configurable: true, enumerable: true, value: "inherited marker" },
    }));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("an inherited marker must not mint a skip");
    expect(decoded.code).toBe("DESIGN_SHAPE_INVALID");
    expect(decoded.layer).toBe("REQUEST");
  });

  it("survives the DURABLE round trip as a skip, not as a malformed record", () => {
    // `decodeDesignRevisionBytes` maps ANY decode failure to DESIGN_RECORD_MALFORMED, so a skip
    // that decoded on submit but not on read would be stored and then unreadable — a one-way door.
    const decoded = decodeDesignRevisionBytes(
      encoder.encode(JSON.stringify(designSkipFixture())),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(`an encoded skip must decode: ${decoded.code}`);
    expect(isDesignSkip(decoded.revision)).toBe(true);
    expect(decoded.revision).toEqual(designSkipFixture());
  });

  it("adds no refusal code: the skip reuses the closed map's DESIGN_SHAPE_INVALID", () => {
    // Not a restated roster and not a magic count: the claim is that the skip introduced NO
    // code of its own, so the closed map is asked whether any code names the skip at all.
    const refused = decodeDesignRevision({ reason: "why", skipped: false });
    if (refused.ok) throw new Error("the probe must refuse");
    expect(DESIGN_CODES).toContain(refused.code);
    expect(DESIGN_CODE_LAYERS[refused.code]).toBe(refused.layer);
    expect(DESIGN_CODES.filter((code) => code.includes("SKIP"))).toEqual([]);
    expect([...DESIGN_SKIP_KEYS]).toEqual([...DESIGN_SKIP_KEYS].sort());
  });
});

describe("decodeDesignRevisionBytes", () => {
  it("round trips the fixture through JSON bytes", () => {
    const decoded = decodeDesignRevisionBytes(
      encoder.encode(JSON.stringify(designRevisionFixture())),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("encoded fixture must decode");
    expect(decoded.revision).toEqual(designRevisionFixture());
  });

  it("refuses DESIGN_RECORD_MALFORMED at LEDGER for bytes it did not write", () => {
    const decoded = decodeDesignRevisionBytes(encoder.encode(JSON.stringify({ screens: [] })));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("foreign bytes must be refused");
    expect(decoded.code).toBe("DESIGN_RECORD_MALFORMED");
    expect(decoded.layer).toBe("LEDGER");
  });

  it("carries the bounded-json code verbatim when the bytes are not JSON", () => {
    const decoded = decodeDesignRevisionBytes(encoder.encode("{not json"));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("non-JSON bytes must be refused");
    expect(decoded.code).toBe("DESIGN_RECORD_MALFORMED");
    expect(decoded.layer).toBe("LEDGER");
    expect(decoded.sourceCode).toBe("JSON_SYNTAX_INVALID");
    expect(decoded.sourceLayer).toBe("BOUNDED_JSON");
  });
});

// The map is only closed if a code cannot be minted outside it. TypeScript refuses the literal
// below at compile time; the runtime arm proves the lookup yields nothing rather than a default.
it("has no layer for a code outside the map", () => {
  const outsider = "DESIGN_NOT_A_CODE" as unknown as DesignCode;
  expect(DESIGN_CODE_LAYERS[outsider]).toBeUndefined();
});
