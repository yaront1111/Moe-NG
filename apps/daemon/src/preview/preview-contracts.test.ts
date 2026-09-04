/**
 * The exact `preview.decide` external contract (task-40e52fa8a85a4921b97bee933b00403f).
 *
 * Every refusal assertion below names the CODE and the LAYER, never merely "not ok" (global
 * rail 1): a second refusal layer landing above this decoder would otherwise keep these green
 * while no longer testing the decoder. The sweeps assert their own generated denominator for the
 * same reason - a sweep that silently produces zero cases passes while testing nothing.
 *
 * WHICH CODES THIS FILE CAN REACH, stated plainly rather than papered over. Only
 * PREVIEW_DECISION_INVALID has a condition this row's production surface raises, and every one of
 * its conditions is exercised below. PREVIEW_COMMAND_MISSING, PREVIEW_START_TIMEOUT and
 * PREVIEW_GOAL_NOT_LANDED are raised by the preview RUNNER in
 * task-f5a74c23f8754665ab9d36cba386e1d0 and are exercised THERE. This file asserts their
 * code->layer binding and their presence in the derived roster - it does NOT manufacture a
 * condition to reach them, because a fake arm proves the constant exists, not that the refusal
 * works.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_PREVIEW_FINDINGS,
  MAX_PREVIEW_TEXT,
  PREVIEW_APPROVE_PAYLOAD_KEYS,
  PREVIEW_CODES,
  PREVIEW_CODE_LAYERS,
  PREVIEW_DECIDE_COMMAND_KIND,
  PREVIEW_DECIDE_PAYLOAD_KEYS,
  PREVIEW_DECISIONS,
  PREVIEW_FINDING_KEYS,
  PREVIEW_LAYERS,
  PREVIEW_REJECT_PAYLOAD_KEYS,
  boundedPreviewText,
  decodePreviewDecidePayload,
  isPreviewRefusal,
  previewRefusal,
} from "./preview-contracts.js";
import type { PreviewRejectDecision } from "./preview-contracts.js";

/** The RUNNER-owned codes, named once so the honesty claim above is machine-checked. */
const RUNNER_OWNED_CODES = ["PREVIEW_COMMAND_MISSING", "PREVIEW_START_TIMEOUT"] as const;

function approvePayload(): Record<string, unknown> {
  return { decision: "APPROVE", previewRef: "preview-1" };
}

function finding(): Record<string, unknown> {
  return { detail: "the header overlaps the nav", nodeRef: "node-a" };
}

function rejectPayload(): Record<string, unknown> {
  return { decision: "REJECT", findings: [finding()], previewRef: "preview-1" };
}

function refusalOf(value: unknown): { readonly code: string; readonly layer: string } {
  expect(isPreviewRefusal(value)).toBe(true);
  const refusal = value as { readonly code: string; readonly layer: string };
  return { code: refusal.code, layer: refusal.layer };
}

/** Both halves of the one refusal this decoder mints, asserted together on every arm. */
function expectDecisionInvalid(value: unknown): void {
  expect(refusalOf(value)).toStrictEqual({
    code: "PREVIEW_DECISION_INVALID",
    layer: "REQUEST",
  });
}

describe("preview.decide rosters (task-40e52fa8a85a4921b97bee933b00403f)", () => {
  it("names the command kind once and never re-spells it", () => {
    expect(PREVIEW_DECIDE_COMMAND_KIND).toBe("preview.decide");
    expect(PREVIEW_DECISIONS).toStrictEqual(["APPROVE", "REJECT"]);
  });

  it("derives the code roster from the layer map in both directions", () => {
    const mapped = new Set(Object.keys(PREVIEW_CODE_LAYERS));
    const roster = new Set<string>(PREVIEW_CODES);
    expect(roster).toStrictEqual(mapped);
    expect(roster.size).toBe(4);
  });

  it("carries the four named codes and no fifth spelling", () => {
    expect(PREVIEW_CODES).toStrictEqual([
      "PREVIEW_COMMAND_MISSING",
      "PREVIEW_DECISION_INVALID",
      "PREVIEW_GOAL_NOT_LANDED",
      "PREVIEW_START_TIMEOUT",
    ]);
  });

  it("binds every code to its declared layer, transcribed by hand not read back", () => {
    expect(PREVIEW_CODE_LAYERS.PREVIEW_COMMAND_MISSING).toBe("RUNNER");
    expect(PREVIEW_CODE_LAYERS.PREVIEW_DECISION_INVALID).toBe("REQUEST");
    expect(PREVIEW_CODE_LAYERS.PREVIEW_GOAL_NOT_LANDED).toBe("GOAL_AUTHORITY");
    expect(PREVIEW_CODE_LAYERS.PREVIEW_START_TIMEOUT).toBe("RUNNER");
  });

  it("maps every code to a member of the closed layer roster", () => {
    const layers = new Set<string>(PREVIEW_LAYERS);
    let checked = 0;
    for (const code of PREVIEW_CODES) {
      expect(layers.has(PREVIEW_CODE_LAYERS[code])).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(PREVIEW_CODES.length);
    expect(checked).toBe(4);
  });

  it("uses every declared layer at least once, so the roster carries no dead member", () => {
    const used = new Set(PREVIEW_CODES.map((code) => PREVIEW_CODE_LAYERS[code]));
    expect(used).toStrictEqual(new Set<string>(PREVIEW_LAYERS));
  });

  it("derives a refusal's layer from its code, with no layer argument to disagree with", () => {
    let checked = 0;
    for (const code of PREVIEW_CODES) {
      const refusal = previewRefusal(code);
      expect(refusal.code).toBe(code);
      expect(refusal.layer).toBe(PREVIEW_CODE_LAYERS[code]);
      expect(refusal.sourceCode).toBeNull();
      expect(refusal.sourceLayer).toBeNull();
      expect(Object.isFrozen(refusal)).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("carries a delegated surface's own code and layer verbatim", () => {
    const refusal = previewRefusal("PREVIEW_COMMAND_MISSING", "ENOENT", "HOST_PROCESS");
    expect(refusal.code).toBe("PREVIEW_COMMAND_MISSING");
    expect(refusal.layer).toBe("RUNNER");
    expect(refusal.sourceCode).toBe("ENOENT");
    expect(refusal.sourceLayer).toBe("HOST_PROCESS");
  });

  it("reserves the runner codes for the runner and raises none of them here", () => {
    let checked = 0;
    for (const code of RUNNER_OWNED_CODES) {
      expect(PREVIEW_CODE_LAYERS[code]).toBe("RUNNER");
      checked += 1;
    }
    expect(checked).toBe(RUNNER_OWNED_CODES.length);
    expect(checked).toBe(2);
    expect(PREVIEW_CODE_LAYERS.PREVIEW_GOAL_NOT_LANDED).toBe("GOAL_AUTHORITY");
  });

  it("freezes every roster so a consumer cannot widen the vocabulary in place", () => {
    expect(Object.isFrozen(PREVIEW_DECISIONS)).toBe(true);
    expect(Object.isFrozen(PREVIEW_LAYERS)).toBe(true);
    expect(Object.isFrozen(PREVIEW_CODE_LAYERS)).toBe(true);
    expect(Object.isFrozen(PREVIEW_CODES)).toBe(true);
    expect(Object.isFrozen(PREVIEW_DECIDE_PAYLOAD_KEYS)).toBe(true);
    expect(Object.isFrozen(PREVIEW_APPROVE_PAYLOAD_KEYS)).toBe(true);
    expect(Object.isFrozen(PREVIEW_REJECT_PAYLOAD_KEYS)).toBe(true);
    expect(Object.isFrozen(PREVIEW_FINDING_KEYS)).toBe(true);
  });
});

describe("preview.decide advertised roster vs the two variant arities", () => {
  it("advertises exactly the union of both variants, in both directions", () => {
    const advertised = new Set<string>(PREVIEW_DECIDE_PAYLOAD_KEYS);
    const union = new Set<string>([
      ...PREVIEW_APPROVE_PAYLOAD_KEYS, ...PREVIEW_REJECT_PAYLOAD_KEYS,
    ]);
    expect(advertised).toStrictEqual(union);
    expect(advertised).toStrictEqual(new Set(["decision", "findings", "previewRef"]));
  });

  it("keeps each variant inside the advertised allow-list the HTTP seam enforces", () => {
    const advertised = new Set<string>(PREVIEW_DECIDE_PAYLOAD_KEYS);
    let checked = 0;
    for (const key of [...PREVIEW_APPROVE_PAYLOAD_KEYS, ...PREVIEW_REJECT_PAYLOAD_KEYS]) {
      expect(advertised.has(key)).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("separates the variants by exactly the findings member", () => {
    expect(PREVIEW_APPROVE_PAYLOAD_KEYS).toStrictEqual(["decision", "previewRef"]);
    expect(PREVIEW_REJECT_PAYLOAD_KEYS).toStrictEqual(["decision", "findings", "previewRef"]);
    expect(PREVIEW_FINDING_KEYS).toStrictEqual(["detail", "nodeRef"]);
  });
});

describe("preview.decide payload decode", () => {
  it("admits an APPROVE that carries no findings, copied into a frozen record", () => {
    const result = decodePreviewDecidePayload(approvePayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toStrictEqual({ decision: "APPROVE", previewRef: "preview-1" });
    expect(Object.isFrozen(result.payload)).toBe(true);
  });

  it("admits a REJECT whose findings name the nodes to rework", () => {
    const result = decodePreviewDecidePayload(rejectPayload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.payload as PreviewRejectDecision;
    expect(payload.decision).toBe("REJECT");
    expect(payload.previewRef).toBe("preview-1");
    expect(payload.findings).toStrictEqual([
      { detail: "the header overlaps the nav", nodeRef: "node-a" },
    ]);
    expect(Object.isFrozen(payload.findings)).toBe(true);
    expect(Object.isFrozen(payload.findings[0])).toBe(true);
  });

  it("copies the findings rather than aliasing the caller's array", () => {
    const input = rejectPayload();
    const result = decodePreviewDecidePayload(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    (input["findings"] as Record<string, unknown>[]).push(finding());
    expect((result.payload as PreviewRejectDecision).findings).toHaveLength(1);
  });

  it("refuses a malformed decision value with PREVIEW_DECISION_INVALID at REQUEST", () => {
    let checked = 0;
    for (const decision of ["approve", "REWORK", "", 7, null, undefined, true]) {
      expectDecisionInvalid(decodePreviewDecidePayload({
        decision, previewRef: "preview-1",
      }));
      checked += 1;
    }
    expect(checked).toBe(7);
  });

  it("refuses a payload that names no decision at all", () => {
    expectDecisionInvalid(decodePreviewDecidePayload({ previewRef: "preview-1" }));
    expectDecisionInvalid(decodePreviewDecidePayload({}));
    expectDecisionInvalid(decodePreviewDecidePayload(null));
    expectDecisionInvalid(decodePreviewDecidePayload("APPROVE"));
    expectDecisionInvalid(decodePreviewDecidePayload([{ decision: "APPROVE" }]));
  });

  it("refuses an unknown extra key rather than ignoring it", () => {
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...approvePayload(), severity: "high",
    }));
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), goalRef: "goal-1",
    }));
  });

  it("refuses an APPROVE that also carries findings, empty roster or not", () => {
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...approvePayload(), findings: [],
    }));
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...approvePayload(), findings: [finding()],
    }));
  });

  it("refuses a REJECT with empty findings rather than recording a silent no-op", () => {
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), findings: [],
    }));
  });

  it("refuses a REJECT that omits findings entirely", () => {
    expectDecisionInvalid(decodePreviewDecidePayload({
      decision: "REJECT", previewRef: "preview-1",
    }));
  });

  it("refuses a REJECT whose findings name no node", () => {
    let checked = 0;
    for (const nodeRef of ["", 7, null, undefined, {}, "a".repeat(MAX_PREVIEW_TEXT + 1)]) {
      expectDecisionInvalid(decodePreviewDecidePayload({
        ...rejectPayload(), findings: [{ detail: "needs rework", nodeRef }],
      }));
      checked += 1;
    }
    // A finding that drops the member entirely fails exact arity, not the text check.
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), findings: [{ detail: "needs rework" }],
    }));
    checked += 1;
    expect(checked).toBe(7);
  });

  it("refuses a finding carrying an unknown key or a missing detail", () => {
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), findings: [{ ...finding(), severity: "high" }],
    }));
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), findings: [{ nodeRef: "node-a" }],
    }));
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), findings: [{ detail: "", nodeRef: "node-a" }],
    }));
  });

  it("refuses findings that are not an array, and a roster past the bound", () => {
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), findings: finding(),
    }));
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), findings: "node-a",
    }));
    const oversized = Array.from({ length: MAX_PREVIEW_FINDINGS + 1 }, () => finding());
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), findings: oversized,
    }));
    const atBound = Array.from({ length: MAX_PREVIEW_FINDINGS }, () => finding());
    expect(decodePreviewDecidePayload({ ...rejectPayload(), findings: atBound }).ok).toBe(true);
  });

  it("refuses a malformed previewRef on either variant", () => {
    expectDecisionInvalid(decodePreviewDecidePayload({
      decision: "APPROVE", previewRef: "",
    }));
    expectDecisionInvalid(decodePreviewDecidePayload({
      decision: "APPROVE", previewRef: "a".repeat(MAX_PREVIEW_TEXT + 1),
    }));
    expectDecisionInvalid(decodePreviewDecidePayload({
      ...rejectPayload(), previewRef: 7,
    }));
  });

  it("refuses a non-plain-object and a prototype-bearing record", () => {
    expectDecisionInvalid(decodePreviewDecidePayload(Object.create(
      { decision: "APPROVE" },
      { previewRef: { enumerable: true, value: "preview-1" } },
    )));
    class Decision {
      readonly decision = "APPROVE";
      readonly previewRef = "preview-1";
    }
    expectDecisionInvalid(decodePreviewDecidePayload(new Decision()));
  });

  it("refuses a getter-backed member, which could answer differently on a second read", () => {
    const hostile: Record<string, unknown> = { decision: "APPROVE" };
    Object.defineProperty(hostile, "previewRef", {
      enumerable: true,
      get: () => "preview-1",
    });
    expectDecisionInvalid(decodePreviewDecidePayload(hostile));
  });

  it("refuses a symbol-keyed member that no string-key sweep would see", () => {
    const hostile: Record<string | symbol, unknown> = approvePayload();
    hostile[Symbol("smuggled")] = "value";
    expectDecisionInvalid(decodePreviewDecidePayload(hostile));
  });
});

describe("preview bounded text", () => {
  it("admits bounded, NUL-free, non-empty text and refuses everything else", () => {
    expect(boundedPreviewText("node-a")).toBe(true);
    expect(boundedPreviewText("the header overlaps the nav")).toBe(true);
    expect(boundedPreviewText("a".repeat(MAX_PREVIEW_TEXT))).toBe(true);
    expect(boundedPreviewText("a".repeat(MAX_PREVIEW_TEXT + 1))).toBe(false);
    expect(boundedPreviewText("")).toBe(false);
    // Built from a char code, never typed as a literal: a raw NUL in this source would
    // make the file binary to every diff tool and would not survive a copy.
    expect(boundedPreviewText(`node${String.fromCharCode(0)}a`)).toBe(false);
    expect(boundedPreviewText(7)).toBe(false);
    expect(boundedPreviewText(null)).toBe(false);
  });
});
