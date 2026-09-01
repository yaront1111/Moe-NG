/**
 * The exact `graph.request_expansion` external contract (task-738a12a816e8421a96edd84648565a38).
 *
 * Every refusal assertion below names the CODE and the LAYER, never merely "not ok": a second
 * refusal layer landing above this one would otherwise keep these green while no longer testing
 * the decoder. The two sweeps assert their own generated denominator for the same reason — a
 * sweep that silently produces zero cases passes while testing nothing.
 */

import { describe, expect, it } from "vitest";

import {
  EXPANSION_REQUEST_CODES,
  EXPANSION_REQUEST_CODE_LAYERS,
  EXPANSION_REQUEST_ENVELOPE_KEYS,
  EXPANSION_REQUEST_KIND,
  EXPANSION_REQUEST_LAYERS,
  EXPANSION_REQUEST_PAYLOAD_KEYS,
  EXPANSION_REQUEST_SERVER_OWNED_KEYS,
  MAX_EXPANSION_REQUEST_TEXT,
  boundedExpansionText,
  decodeExpansionRequestEnvelope,
  decodeExpansionRequestPayload,
  expansionRequestRefusal,
  isExpansionRequestRefusal,
} from "./expansion-request-contracts.js";
import type { ExpansionRequestCode } from "./expansion-request-contracts.js";

function validPayload(): Record<string, unknown> {
  return {
    goalRef: "goal-1",
    parentNodeRef: "node-a",
    parentRunRef: "run-parent-1",
    rationale: "the parent node needs a decomposition",
  };
}

function validEnvelope(): Record<string, unknown> {
  return {
    commandId: "cmd-1",
    correlationId: "corr-1",
    decidedAt: "2026-08-25T00:00:00.000Z",
    payload: validPayload(),
    principalId: "principal-1",
    projectId: "project-1",
  };
}

function refusalOf(value: unknown): { readonly code: string; readonly layer: string } {
  expect(isExpansionRequestRefusal(value)).toBe(true);
  const refusal = value as { readonly code: string; readonly layer: string };
  return { code: refusal.code, layer: refusal.layer };
}

describe("expansion request contract rosters (task-738a12a816e8421a96edd84648565a38)", () => {
  it("names the frozen runtime kind and never re-spells it", () => {
    expect(EXPANSION_REQUEST_KIND).toBe("graph.request_expansion");
  });

  it("derives the code roster from the layer map in both directions", () => {
    const mapped = new Set(Object.keys(EXPANSION_REQUEST_CODE_LAYERS));
    const roster = new Set<string>(EXPANSION_REQUEST_CODES);
    expect(roster).toStrictEqual(mapped);
    expect(roster.size).toBeGreaterThan(0);
  });

  it("maps every code to a member of the closed layer roster", () => {
    const layers = new Set<string>(EXPANSION_REQUEST_LAYERS);
    for (const code of EXPANSION_REQUEST_CODES) {
      expect(layers.has(EXPANSION_REQUEST_CODE_LAYERS[code])).toBe(true);
    }
  });

  it("uses every declared layer at least once, so the roster carries no dead member", () => {
    const used = new Set(EXPANSION_REQUEST_CODES.map((c) => EXPANSION_REQUEST_CODE_LAYERS[c]));
    expect(used).toStrictEqual(new Set<string>(EXPANSION_REQUEST_LAYERS));
  });

  it("derives a refusal's layer from its code, with no layer argument to disagree with", () => {
    let checked = 0;
    for (const code of EXPANSION_REQUEST_CODES) {
      const refusal = expansionRequestRefusal(code);
      expect(refusal.code).toBe(code);
      expect(refusal.layer).toBe(EXPANSION_REQUEST_CODE_LAYERS[code]);
      expect(refusal.sourceCode).toBeNull();
      expect(refusal.sourceLayer).toBeNull();
      expect(Object.isFrozen(refusal)).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(EXPANSION_REQUEST_CODES.length);
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it("carries a delegated surface's own code and layer verbatim", () => {
    const refusal = expansionRequestRefusal(
      "EXPANSION_REQUEST_HOLD_REFUSED", "EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN", "SAFE_BOUNDARY",
    );
    expect(refusal.code).toBe("EXPANSION_REQUEST_HOLD_REFUSED");
    expect(refusal.layer).toBe("HOLD");
    expect(refusal.sourceCode).toBe("EXPANSION_HOLD_SAFE_BOUNDARY_UNPROVEN");
    expect(refusal.sourceLayer).toBe("SAFE_BOUNDARY");
  });

  it("keeps the server-owned roster disjoint from the payload roster", () => {
    const payload = new Set<string>(EXPANSION_REQUEST_PAYLOAD_KEYS);
    const overlap = EXPANSION_REQUEST_SERVER_OWNED_KEYS.filter((key) => payload.has(key));
    expect(overlap).toStrictEqual([]);
    expect(EXPANSION_REQUEST_SERVER_OWNED_KEYS.length).toBeGreaterThan(0);
  });
});

describe("decodeExpansionRequestPayload (task-738a12a816e8421a96edd84648565a38)", () => {
  it("accepts exactly the four subject members and returns a frozen detached copy", () => {
    const input = validPayload();
    const result = decodeExpansionRequestPayload(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.payload).sort()).toStrictEqual([...EXPANSION_REQUEST_PAYLOAD_KEYS]);
    expect(Object.isFrozen(result.payload)).toBe(true);
    input["goalRef"] = "goal-tampered";
    expect(result.payload.goalRef).toBe("goal-1");
  });

  it("refuses each missing member with the exact code and layer", () => {
    let cases = 0;
    for (const key of EXPANSION_REQUEST_PAYLOAD_KEYS) {
      const input = validPayload();
      delete input[key];
      expect(refusalOf(decodeExpansionRequestPayload(input))).toStrictEqual({
        code: "EXPANSION_REQUEST_PAYLOAD_MALFORMED", layer: "REQUEST",
      });
      cases += 1;
    }
    expect(cases).toBe(EXPANSION_REQUEST_PAYLOAD_KEYS.length);
    expect(cases).toBe(4);
  });

  it("refuses every server-owned member a caller could try to present", () => {
    let cases = 0;
    for (const key of EXPANSION_REQUEST_SERVER_OWNED_KEYS) {
      const input = validPayload();
      input[key] = "caller-supplied";
      expect(refusalOf(decodeExpansionRequestPayload(input))).toStrictEqual({
        code: "EXPANSION_REQUEST_PAYLOAD_MALFORMED", layer: "REQUEST",
      });
      cases += 1;
    }
    expect(cases).toBe(EXPANSION_REQUEST_SERVER_OWNED_KEYS.length);
    expect(cases).toBeGreaterThanOrEqual(17);
  });

  it("refuses a non-string, empty, oversized or NUL-bearing member on every key", () => {
    const hostile: readonly unknown[] = [
      1, true, null, undefined, {}, [], "", "x".repeat(MAX_EXPANSION_REQUEST_TEXT + 1),
      `bad${String.fromCharCode(0)}ref`,
    ];
    let cases = 0;
    for (const key of EXPANSION_REQUEST_PAYLOAD_KEYS) {
      for (const value of hostile) {
        const input = validPayload();
        input[key] = value;
        expect(refusalOf(decodeExpansionRequestPayload(input))).toStrictEqual({
          code: "EXPANSION_REQUEST_PAYLOAD_MALFORMED", layer: "REQUEST",
        });
        cases += 1;
      }
    }
    expect(cases).toBe(EXPANSION_REQUEST_PAYLOAD_KEYS.length * hostile.length);
    expect(cases).toBe(36);
  });

  it("accepts a rationale carrying spaces and one exactly at the bound", () => {
    const input = validPayload();
    input["rationale"] = "a".repeat(MAX_EXPANSION_REQUEST_TEXT);
    const result = decodeExpansionRequestPayload(input);
    expect(result.ok).toBe(true);
    expect(boundedExpansionText("two words here")).toBe(true);
  });

  it("refuses a non-record, an array and a foreign prototype", () => {
    const foreign = Object.create({ goalRef: "goal-1" }) as Record<string, unknown>;
    foreign["parentNodeRef"] = "node-a";
    foreign["parentRunRef"] = "run-parent-1";
    foreign["rationale"] = "why";
    for (const value of [null, undefined, "payload", 7, [], validPayload, foreign]) {
      expect(refusalOf(decodeExpansionRequestPayload(value))).toStrictEqual({
        code: "EXPANSION_REQUEST_PAYLOAD_MALFORMED", layer: "REQUEST",
      });
    }
  });
});

describe("decodeExpansionRequestEnvelope (task-738a12a816e8421a96edd84648565a38)", () => {
  it("accepts the server envelope and leaves the payload unnarrowed", () => {
    const result = decodeExpansionRequestEnvelope(validEnvelope());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.envelope).sort()).toStrictEqual([...EXPANSION_REQUEST_ENVELOPE_KEYS]);
    expect(result.envelope.projectId).toBe("project-1");
    expect(Object.isFrozen(result.envelope)).toBe(true);
  });

  it("refuses each missing envelope member with the exact code and layer", () => {
    let cases = 0;
    for (const key of EXPANSION_REQUEST_ENVELOPE_KEYS) {
      const input = validEnvelope();
      delete input[key];
      expect(refusalOf(decodeExpansionRequestEnvelope(input))).toStrictEqual({
        code: "EXPANSION_REQUEST_ENVELOPE_MALFORMED", layer: "REQUEST",
      });
      cases += 1;
    }
    expect(cases).toBe(6);
  });

  it("refuses a blank principal or project id rather than keying a decision on it", () => {
    for (const key of ["principalId", "projectId"]) {
      const input = validEnvelope();
      input[key] = "";
      expect(refusalOf(decodeExpansionRequestEnvelope(input))).toStrictEqual({
        code: "EXPANSION_REQUEST_ENVELOPE_MALFORMED", layer: "REQUEST",
      });
    }
  });

  it("refuses an extra envelope member", () => {
    const input = validEnvelope();
    input["release"] = { safeBoundaryObserved: true };
    expect(refusalOf(decodeExpansionRequestEnvelope(input))).toStrictEqual({
      code: "EXPANSION_REQUEST_ENVELOPE_MALFORMED", layer: "REQUEST",
    });
  });
});

describe("refusal typing (task-738a12a816e8421a96edd84648565a38)", () => {
  it("keeps every code assignable to the exported union", () => {
    const codes: readonly ExpansionRequestCode[] = EXPANSION_REQUEST_CODES;
    expect(codes.includes("EXPANSION_REQUEST_LEDGER_SPLIT")).toBe(true);
  });
});
