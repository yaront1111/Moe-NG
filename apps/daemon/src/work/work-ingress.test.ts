import { BOUNDED_JSON_ERROR_CODES, MAX_JSON_BODY_BYTES } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { isExactWorkRequest, parseWorkRequest } from "./work-ingress.js";
import { WORK_COMMANDS, WORK_SCHEMA_VERSION } from "./work-kernel.js";
import type { WorkRefused, WorkResult } from "./work-kernel.js";

const encoder = new TextEncoder();

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function validRequest(command: string = "claim", payload: unknown = { any: "value" }) {
  return { command, payload, schemaVersion: WORK_SCHEMA_VERSION };
}

/** Narrows to the refusal arm, failing loudly instead of silently skipping. */
function refusalOf(result: WorkResult): WorkRefused {
  if (result.ok !== false) throw new Error("expected a refusal, received an ok result");
  if (!("failure" in result)) throw new Error("expected a WorkRefused carrying a failure");
  return result;
}

function parseResult(input: unknown): WorkResult {
  const parsed = parseWorkRequest(input);
  if (parsed.ok) throw new Error("expected the request to be refused at ingress");
  return parsed.result;
}

describe("work ingress — decode runs before anything else", () => {
  it("rejects a non-byte input with the decoder's own JSON_INPUT_TYPE_INVALID", () => {
    const result = parseResult({ not: "bytes" });
    expect(result.outcome).toBe("INPUT_REJECTED");
    expect(result).toMatchObject({ authority: "NONE", ok: false });
    if (result.outcome !== "INPUT_REJECTED") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "JSON_INPUT_TYPE_INVALID", ok: false });
  });

  it("rejects oversized bytes with JSON_BODY_LIMIT_EXCEEDED", () => {
    const oversized = new Uint8Array(MAX_JSON_BODY_BYTES + 1).fill(0x20);
    const result = parseResult(oversized);
    expect(result.outcome).toBe("INPUT_REJECTED");
    if (result.outcome !== "INPUT_REJECTED") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "JSON_BODY_LIMIT_EXCEEDED" });
  });

  it("rejects invalid UTF-8 with JSON_UTF8_INVALID", () => {
    const result = parseResult(new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(result.outcome).toBe("INPUT_REJECTED");
    if (result.outcome !== "INPUT_REJECTED") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "JSON_UTF8_INVALID" });
  });

  it("rejects malformed JSON with JSON_SYNTAX_INVALID", () => {
    const result = parseResult(encoder.encode("{\"schemaVersion\":"));
    expect(result.outcome).toBe("INPUT_REJECTED");
    if (result.outcome !== "INPUT_REJECTED") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "JSON_SYNTAX_INVALID" });
  });

  it("never invents a code — every INPUT_REJECTED code belongs to the decoder", () => {
    const inputs: readonly unknown[] = [
      { not: "bytes" },
      new Uint8Array(MAX_JSON_BODY_BYTES + 1).fill(0x20),
      new Uint8Array([0xff, 0xfe, 0xfd]),
      encoder.encode("{"),
    ];
    expect(inputs.length).toBe(4);
    const observed = inputs.map((input) => {
      const result = parseResult(input);
      if (result.outcome !== "INPUT_REJECTED") throw new Error("expected INPUT_REJECTED");
      return (result.error as { readonly code: string }).code;
    });
    expect(observed.length).toBe(4);
    for (const code of observed) {
      expect(BOUNDED_JSON_ERROR_CODES as readonly string[]).toContain(code);
    }
  });
});

describe("work ingress — exact envelope validation", () => {
  it("accepts the exact three-key envelope for every declared command", () => {
    expect(WORK_COMMANDS.length).toBe(6);
    for (const command of WORK_COMMANDS) {
      const parsed = parseWorkRequest(bytes(validRequest(command)));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(`command ${command} must parse`);
      expect(parsed.envelope.command).toBe(command);
      expect(parsed.envelope.schemaVersion).toBe(WORK_SCHEMA_VERSION);
    }
  });

  const invalidCases: ReadonlyArray<readonly [string, unknown]> = [
    ["a missing key", { command: "claim", schemaVersion: WORK_SCHEMA_VERSION }],
    ["an extra key", { ...validRequest(), extra: 1 }],
    ["an own __proto__ key", { ...validRequest(), ["__proto__"]: { polluted: true } }],
    ["a wrong schemaVersion", { ...validRequest(), schemaVersion: "moe-work-request/2" }],
    ["a command outside WORK_COMMANDS", validRequest("promote")],
    ["a non-object envelope", [1, 2, 3]],
    ["a null envelope", null],
    ["a string envelope", "claim"],
  ];

  it("covers every declared invalid-envelope case", () => {
    expect(invalidCases.length).toBe(8);
  });

  it.each(invalidCases)("refuses %s with WORK_REQUEST_INVALID at INGRESS", (_label, value) => {
    const refusal = refusalOf(parseResult(bytes(value)));
    expect(refusal.outcome).toBe("REQUEST_INVALID");
    expect(refusal.authority).toBe("NONE");
    expect(refusal.failure.code).toBe("WORK_REQUEST_INVALID");
    expect(refusal.failure.layer).toBe("INGRESS");
    expect(refusal.failure.leg).toBeNull();
  });

  it("refuses a non-null-prototype envelope", () => {
    const hostile = { command: "claim", payload: {}, schemaVersion: WORK_SCHEMA_VERSION };
    expect(Object.getPrototypeOf(hostile)).not.toBeNull();
    expect(isExactWorkRequest(hostile)).toBe(false);
  });
});

describe("work ingress — freezing and authority labeling", () => {
  it("freezes the result and its nested error", () => {
    const result = parseResult({ not: "bytes" });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== "INPUT_REJECTED") throw new Error("unreachable");
    expect(Object.isFrozen(result.error)).toBe(true);
  });

  it("freezes the refusal and its nested failure", () => {
    const refusal = refusalOf(parseResult(bytes({ bad: true })));
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(Object.isFrozen(refusal.failure)).toBe(true);
  });

  it("labels every ingress refusal as conferring no authority", () => {
    const results = [parseResult({ not: "bytes" }), parseResult(bytes({ bad: true }))];
    expect(results.length).toBe(2);
    for (const result of results) {
      expect(result.authority).toBe("NONE");
      expect(result.ok).toBe(false);
    }
  });

  it("carries no successor field on any ingress refusal", () => {
    const refusal = refusalOf(parseResult(bytes({ bad: true })));
    expect(Object.keys(refusal)).not.toContain("successors");
    expect(Object.keys(refusal)).not.toContain("successor");
  });
});

describe("work ingress — the ordering proof", () => {
  it("returns the decoder's code for an authority-refusing payload in oversized bytes", () => {
    // A payload that WOULD be refused by the authority layer: an unparseable
    // lease with a command that exists. Wrapped in bytes over the limit, the
    // decoder must answer first, proving no authority path ran before decode.
    const authorityRefusing = validRequest("claim", { leaseRecord: null, proof: null });
    const padded = {
      ...authorityRefusing,
      pad: "x".repeat(MAX_JSON_BODY_BYTES),
    };
    const encoded = bytes(padded);
    expect(encoded.byteLength).toBeGreaterThan(MAX_JSON_BODY_BYTES);

    const result = parseResult(encoded);
    expect(result.outcome).toBe("INPUT_REJECTED");
    if (result.outcome !== "INPUT_REJECTED") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "JSON_BODY_LIMIT_EXCEEDED" });

    // The decisive half: the AUTHORITY layer never spoke.
    expect(JSON.stringify(result)).not.toContain("AUTHORITY");
  });

  it("refuses an unknown command before reading its payload at all", () => {
    const refusal = refusalOf(parseResult(bytes(validRequest("promote", { leaseRecord: null }))));
    expect(refusal.failure.layer).toBe("INGRESS");
    expect(refusal.failure.code).toBe("WORK_REQUEST_INVALID");
  });
});
