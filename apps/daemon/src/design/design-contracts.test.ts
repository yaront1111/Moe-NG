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
  decodeDesignRevision,
  decodeDesignRevisionBytes,
  designAggregateId,
  designRefusal,
  type DesignCode,
} from "./design-contracts.js";
import { designRevisionFixture } from "./design-test-fixtures.js";

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
