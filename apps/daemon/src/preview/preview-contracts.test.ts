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
  PREVIEW_START_COMMAND_KIND,
  PREVIEW_START_PAYLOAD_KEYS,
  boundedPreviewText,
  containedPreviewSegment,
  decodePreviewDecidePayload,
  decodePreviewStartPayload,
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
    expect(roster.size).toBe(5);
  });

  it("carries the named codes and no unlisted spelling", () => {
    expect(PREVIEW_CODES).toStrictEqual([
      "PREVIEW_COMMAND_MISSING",
      "PREVIEW_DECISION_INVALID",
      "PREVIEW_GOAL_NOT_LANDED",
      "PREVIEW_START_PAYLOAD_INVALID",
      "PREVIEW_START_TIMEOUT",
    ]);
  });

  it("binds every code to its declared layer, transcribed by hand not read back", () => {
    expect(PREVIEW_CODE_LAYERS.PREVIEW_COMMAND_MISSING).toBe("RUNNER");
    expect(PREVIEW_CODE_LAYERS.PREVIEW_DECISION_INVALID).toBe("REQUEST");
    expect(PREVIEW_CODE_LAYERS.PREVIEW_GOAL_NOT_LANDED).toBe("GOAL_AUTHORITY");
    expect(PREVIEW_CODE_LAYERS.PREVIEW_START_PAYLOAD_INVALID).toBe("REQUEST");
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
    expect(checked).toBe(5);
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
    expect(checked).toBe(5);
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

/**
 * `decodePreviewStartPayload` - the OTHER decoder in this module, and the only gate between
 * operator bytes and a receipt id. Every arm names the CODE and the LAYER: a bare `ok === false`
 * would stay green if a second refusal layer landed above this one (global rail 1).
 *
 * WHY THE TRAVERSAL ARMS MATTER HERE and not only in the runner. `previewReceiptId` HASHES both
 * values and `previewCaptureDirectory` JOINS them, so a separator or a `..` reaching either
 * would put one goal's captures inside another's directory. `preview-runner.ts` has its own
 * containment check one layer down; that is a second gate, and these arms prove THIS one refuses
 * on its own rather than leaning on it.
 */
function expectStartInvalid(result: unknown): void {
  expect(result).toMatchObject({
    code: "PREVIEW_START_PAYLOAD_INVALID",
    layer: PREVIEW_CODE_LAYERS.PREVIEW_START_PAYLOAD_INVALID,
    ok: false,
  });
  expect(result).toMatchObject({ layer: "REQUEST" });
}

const GOOD_SHA = "0123456789abcdef0123456789abcdef01234567";

function startPayload(): Record<string, unknown> {
  return { goalId: "goal-1", sha: GOOD_SHA };
}

describe("preview.start payload contract", () => {
  it("names the kind and EXACTLY the two keys, with `workspace` deliberately absent", () => {
    expect(PREVIEW_START_COMMAND_KIND).toBe("preview.start");
    expect(PREVIEW_START_PAYLOAD_KEYS).toStrictEqual(["goalId", "sha"]);
    expect(Object.isFrozen(PREVIEW_START_PAYLOAD_KEYS)).toBe(true);
    // THE SECURITY DECISION OF THE COMMAND, asserted rather than only commented: the runner
    // reads `<workspace>/package.json` and spawns a script out of it, so a caller-named
    // workspace would be arbitrary command execution on the daemon host.
    expect(PREVIEW_START_PAYLOAD_KEYS).not.toContain("workspace");
  });

  it("accepts the exact two-key shape and copies it into a frozen record", () => {
    // THE POSITIVE CONTROL for every refusal arm below: without it they would all pass against
    // a decoder that refused everything.
    const decoded = decodePreviewStartPayload(startPayload());
    expect(decoded).toStrictEqual({
      ok: true, payload: { goalId: "goal-1", sha: GOOD_SHA },
    });
    if (!decoded.ok) throw new Error("expected an accepted payload");
    expect(Object.isFrozen(decoded.payload)).toBe(true);
  });

  it("refuses a MISSING key and an UNKNOWN key identically, both at REQUEST", () => {
    expectStartInvalid(decodePreviewStartPayload({ goalId: "goal-1" }));
    expectStartInvalid(decodePreviewStartPayload({ sha: GOOD_SHA }));
    expectStartInvalid(decodePreviewStartPayload({}));
    expectStartInvalid(decodePreviewStartPayload({ ...startPayload(), workspace: "C:/tree" }));
    expectStartInvalid(decodePreviewStartPayload({ ...startPayload(), previewRef: "p-1" }));
  });

  it("refuses a non-record, an array and a prototype-bearing object", () => {
    for (const value of [null, undefined, 7, "goal-1", true, [], [startPayload()]]) {
      expectStartInvalid(decodePreviewStartPayload(value));
    }
    class Payload { public goalId = "goal-1"; public sha = GOOD_SHA; }
    expectStartInvalid(decodePreviewStartPayload(new Payload()));
  });

  it("refuses an empty, over-long or non-string member on EITHER key", () => {
    const long = "a".repeat(MAX_PREVIEW_TEXT + 1);
    expectStartInvalid(decodePreviewStartPayload({ goalId: "", sha: GOOD_SHA }));
    expectStartInvalid(decodePreviewStartPayload({ goalId: "goal-1", sha: "" }));
    expectStartInvalid(decodePreviewStartPayload({ goalId: long, sha: GOOD_SHA }));
    expectStartInvalid(decodePreviewStartPayload({ goalId: "goal-1", sha: long }));
    expectStartInvalid(decodePreviewStartPayload({ goalId: 7, sha: GOOD_SHA }));
    expectStartInvalid(decodePreviewStartPayload({ goalId: "goal-1", sha: null }));
    // The bound is INCLUSIVE, so the longest admissible value still decodes - which is what
    // stops the arm above passing against an off-by-one that refused everything long.
    expect(decodePreviewStartPayload({
      goalId: "a".repeat(MAX_PREVIEW_TEXT), sha: GOOD_SHA,
    })).toMatchObject({ ok: true });
  });

  it("refuses every traversal shape on EITHER key, at REQUEST", () => {
    const hostile = [
      "../escape", "..", ".", "a/b", "a\b", "/abs", "C:/tree",
      `goal${String.fromCharCode(0)}a`, "goal 1", "goal	b", "<goal>", "goal:1", "goal|1",
      "goal?1", "goal*1", '"goal"',
    ];
    let checked = 0;
    for (const value of hostile) {
      expectStartInvalid(decodePreviewStartPayload({ goalId: value, sha: GOOD_SHA }));
      expectStartInvalid(decodePreviewStartPayload({ goalId: "goal-1", sha: value }));
      checked += 1;
    }
    // The sweep must have GENERATED cases: a zero-case loop passes vacuously.
    expect(checked).toBe(hostile.length);
    expect(checked).toBe(16);
  });

  it("refuses a non-NFC spelling, because two spellings hash to two receipt ids", () => {
    // Composed vs decomposed e-acute: visually one id, two different `previewReceiptId` hashes,
    // which would defeat the supervisor's in-flight de-duplication and let a second dev server
    // try to bind the port the first already took.
    const decomposed = `goal-e${String.fromCharCode(0x65, 0x301)}`;
    expect(decomposed.normalize("NFC")).not.toBe(decomposed);
    expectStartInvalid(decodePreviewStartPayload({ goalId: decomposed, sha: GOOD_SHA }));
    expectStartInvalid(decodePreviewStartPayload({ goalId: "goal-1", sha: decomposed }));
    // The NFC form of the SAME text is admitted, so the arm above is about normalisation and
    // not about non-ASCII text.
    expect(decodePreviewStartPayload({
      goalId: decomposed.normalize("NFC"), sha: GOOD_SHA,
    })).toMatchObject({ ok: true });
  });

  it("refuses a getter-backed member and a symbol-keyed one", () => {
    const getterBacked: Record<string, unknown> = { goalId: "goal-1" };
    Object.defineProperty(getterBacked, "sha", { enumerable: true, get: () => GOOD_SHA });
    expectStartInvalid(decodePreviewStartPayload(getterBacked));

    const symbolKeyed: Record<string | symbol, unknown> = startPayload();
    symbolKeyed[Symbol("smuggled")] = "value";
    expectStartInvalid(decodePreviewStartPayload(symbolKeyed));
  });

  it("exposes the segment guard the decoder uses, so the runner cannot drift from it", () => {
    expect(containedPreviewSegment("goal-1")).toBe(true);
    expect(containedPreviewSegment(GOOD_SHA)).toBe(true);
    expect(containedPreviewSegment("../escape")).toBe(false);
    expect(containedPreviewSegment("a/b")).toBe(false);
    expect(containedPreviewSegment("")).toBe(false);
    expect(containedPreviewSegment(7)).toBe(false);
  });
});
