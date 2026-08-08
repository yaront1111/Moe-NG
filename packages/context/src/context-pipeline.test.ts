import { describe, expect, it } from "vitest";

import {
  CONTEXT_SELECTION_OUTCOME_KINDS,
  selectContext,
} from "./context-selection.js";
import {
  digestContextManifest,
  renderContext,
  type ContextDigestBinding,
  type ContextDigestBoundField,
} from "./context-render.js";

const mandatory = (id: string, content: string) => ({
  kind: "MANDATORY" as const,
  id,
  section: "authority",
  content,
});

const optional = (id: string, content: string, priority: number) => ({
  kind: "OPTIONAL" as const,
  id,
  section: "journal",
  content,
  priority,
});

describe("mandatory context admission", () => {
  it("admits fitting mandatory content without dropping any item", () => {
    const result = selectContext({
      mandatory: [mandatory("required-b", "beta"), mandatory("required-a", "alpha")],
      optional: [],
      exclusions: [],
      byteBudget: 9,
    });

    expect(result.kind).toBe("ADMITTED");
    if (result.kind !== "ADMITTED") throw new Error("expected admission");
    expect(result.selection.mandatory.map(({ id }) => id)).toEqual([
      "required-a",
      "required-b",
    ]);
    expect(result.selection.mandatory.map(({ content }) => content)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.selection.selectedBytes).toBe(9);
  });

  it("refuses oversized mandatory content with the selection-layer reason code", () => {
    expect(
      selectContext({
        mandatory: [mandatory("required", "required")],
        optional: [],
        exclusions: [],
        byteBudget: 7,
      }),
    ).toEqual({
      kind: "REFUSED",
      code: "CONTEXT_TOO_LARGE",
      layer: "CONTEXT_SELECTION",
      mandatoryBytes: 8,
      byteBudget: 7,
    });
  });

  it("measures the mandatory budget in canonical UTF-8 bytes", () => {
    expect(
      selectContext({
        mandatory: [mandatory("required", "😀")],
        optional: [],
        exclusions: [],
        byteBudget: 3,
      }),
    ).toEqual({
      kind: "REFUSED",
      code: "CONTEXT_TOO_LARGE",
      layer: "CONTEXT_SELECTION",
      mandatoryBytes: 4,
      byteBudget: 3,
    });
  });

  it("refuses rather than trimming a mandatory item to fit", () => {
    const result = selectContext({
      mandatory: [mandatory("required", "AB")],
      optional: [],
      exclusions: [],
      byteBudget: 1,
    });

    expect(result).toEqual({
      kind: "REFUSED",
      code: "CONTEXT_TOO_LARGE",
      layer: "CONTEXT_SELECTION",
      mandatoryBytes: 2,
      byteBudget: 1,
    });
    expect("selection" in result).toBe(false);
  });

  it("declares only admitted and refused outcome kinds", () => {
    expect(new Set(CONTEXT_SELECTION_OUTCOME_KINDS)).toEqual(
      new Set(["ADMITTED", "REFUSED"]),
    );
  });
});

describe("optional context selection", () => {
  it("is insertion-order independent, priority ordered, and honours exclusions", () => {
    const candidates = [
      optional("low", "L", 10),
      optional("excluded", "MM", 20),
      optional("high", "HH", 30),
    ];
    const input = {
      mandatory: [mandatory("required", "M")],
      exclusions: [{ itemId: "excluded", reason: "SECRET_POLICY" }],
      byteBudget: 4,
    } as const;

    const forward = selectContext({ ...input, optional: candidates });
    const reverse = selectContext({ ...input, optional: [...candidates].reverse() });
    expect(forward.kind).toBe("ADMITTED");
    expect(reverse.kind).toBe("ADMITTED");
    if (forward.kind !== "ADMITTED" || reverse.kind !== "ADMITTED") {
      throw new Error("expected both selections to admit");
    }

    expect(forward.selection.optional.map(({ id }) => id)).toEqual(["high", "low"]);
    expect(reverse.selection.optional).toEqual(forward.selection.optional);
    expect(reverse.selection.exclusions).toEqual([
      { itemId: "excluded", reason: "SECRET_POLICY" },
    ]);
    expect(reverse.selection.selectedBytes).toBe(4);
  });
});

const DIGEST_BOUND_FIELDS = [
  "optionalSelection",
  "journalCountLimit",
  "journalTextLimit",
  "ordering",
  "rendererVersion",
  "exclusions",
  "exactBytes",
] as const satisfies readonly ContextDigestBoundField[];

function mutateBinding(
  binding: ContextDigestBinding,
  field: ContextDigestBoundField,
): ContextDigestBinding {
  switch (field) {
    case "optionalSelection":
      return {
        ...binding,
        optionalSelection: binding.optionalSelection.map((item, index) =>
          index === 0 ? { ...item, content: `${item.content}!` } : item,
        ),
      };
    case "journalCountLimit":
      return { ...binding, journalCountLimit: binding.journalCountLimit + 1 };
    case "journalTextLimit":
      return { ...binding, journalTextLimit: binding.journalTextLimit + 1 };
    case "ordering":
      return { ...binding, ordering: `${binding.ordering}!` };
    case "rendererVersion":
      return { ...binding, rendererVersion: `${binding.rendererVersion}!` };
    case "exclusions":
      return {
        ...binding,
        exclusions: [...binding.exclusions, { itemId: "extra", reason: "POLICY" }],
      };
    case "exactBytes":
      return { ...binding, exactBytes: [...binding.exactBytes, 0] };
  }
}

function admittedSelection() {
  const result = selectContext({
    mandatory: [mandatory("required", "MANDATORY")],
    optional: [optional("selected", "OPTIONAL", 10)],
    exclusions: [{ itemId: "secret", reason: "SECRET_POLICY" }],
    byteBudget: 100,
  });
  if (result.kind !== "ADMITTED") throw new Error("expected admission");
  return result.selection;
}

describe("context rendering manifest", () => {
  it("renders byte-identically and contains every mandatory content chunk", () => {
    const selection = admittedSelection();
    const first = renderContext(selection);
    const second = renderContext(selection);

    expect(second).toEqual(first);
    const output = Buffer.from(first.bytes).toString("utf8");
    for (const item of selection.mandatory) {
      expect(output).toContain(item.content);
    }
    expect(first.manifest.binding.exactBytes).toEqual(first.bytes);
    expect(first.bytes).toHaveLength(selection.selectedBytes);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.bytes)).toBe(true);
    expect(Object.isFrozen(first.manifest)).toBe(true);
    expect(Object.isFrozen(first.manifest.binding)).toBe(true);
  });

  it("binds exactly the seven declared determinism fields", () => {
    const rendered = renderContext(admittedSelection());
    expect(new Set(Object.keys(rendered.manifest.binding))).toEqual(
      new Set(DIGEST_BOUND_FIELDS),
    );
  });

  it("changes the digest when each declared bound field changes", () => {
    const rendered = renderContext(admittedSelection());
    const changedDigests = DIGEST_BOUND_FIELDS.map((field) =>
      digestContextManifest(mutateBinding(rendered.manifest.binding, field)),
    );

    expect(changedDigests).toHaveLength(DIGEST_BOUND_FIELDS.length);
    expect(changedDigests.length).toBeGreaterThan(0);
    for (const digest of changedDigests) {
      expect(digest).not.toBe(rendered.manifest.digest);
    }
  });

  it("canonicalizes key insertion order and distinguishes framed fields and negative zero", () => {
    const rendered = renderContext(admittedSelection());
    const normal = rendered.manifest.binding.optionalSelection[0];
    if (normal === undefined) throw new Error("expected optional fixture");
    const reordered = {
      priority: normal.priority,
      content: normal.content,
      section: normal.section,
      id: normal.id,
      kind: normal.kind,
    };
    expect(
      digestContextManifest({
        ...rendered.manifest.binding,
        optionalSelection: [reordered],
      }),
    ).toBe(rendered.manifest.digest);

    const shifted = {
      ...rendered.manifest.binding,
      optionalSelection: [{ ...normal, id: "a", section: "bselectedjournal" }],
    };
    const framed = {
      ...rendered.manifest.binding,
      optionalSelection: [{ ...normal, id: "ab", section: "selectedjournal" }],
    };
    expect(digestContextManifest(shifted)).not.toBe(digestContextManifest(framed));
    expect(
      digestContextManifest({ ...rendered.manifest.binding, journalCountLimit: -0 }),
    ).not.toBe(
      digestContextManifest({ ...rendered.manifest.binding, journalCountLimit: 0 }),
    );
  });
});
