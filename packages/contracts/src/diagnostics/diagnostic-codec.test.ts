import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_REDACTED, encodeDiagnosticLine } from "./diagnostic-codec.js";
import { describeThrown } from "./diagnostic-error.js";
import { MAX_DIAGNOSTIC_FIELDS, MAX_DIAGNOSTIC_LINE_BYTES } from "./diagnostic-record.js";
import type { DiagnosticRecord } from "./diagnostic-record.js";

const base: DiagnosticRecord = {
  at: "2026-09-17T22:00:00.000Z",
  component: "wrapper",
  event: "SEAT_SPAWN_REFUSED",
  level: "error",
};

function decode(line: string): Record<string, unknown> {
  return JSON.parse(line.trimEnd()) as Record<string, unknown>;
}

describe("encodeDiagnosticLine", () => {
  it("encodes one newline-terminated JSON object", () => {
    const line = encodeDiagnosticLine(base);

    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(decode(line)).toMatchObject({
      at: "2026-09-17T22:00:00.000Z",
      component: "wrapper",
      event: "SEAT_SPAWN_REFUSED",
      level: "error",
    });
  });

  it("orders keys deterministically so two runs diff cleanly", () => {
    const first = encodeDiagnosticLine({ ...base, fields: { b: 2, a: 1 } });
    const second = encodeDiagnosticLine({ ...base, fields: { a: 1, b: 2 } });

    expect(first).toBe(second);
  });

  it("redacts a supplied secret value wherever it appears", () => {
    const line = encodeDiagnosticLine(
      { ...base, fields: { url: "http://x/?t=sk-live-abc", who: "sk-live-abc" } },
      { secrets: ["sk-live-abc"] },
    );

    expect(line).not.toContain("sk-live-abc");
    expect(line).toContain(DIAGNOSTIC_REDACTED);
  });

  it("redacts a secret-named field even when no secret list was supplied", () => {
    const line = encodeDiagnosticLine({
      ...base,
      fields: { authorization: "Bearer zzz", credential: "op-1", sessionToken: "t-9" },
    });

    expect(line).not.toContain("zzz");
    expect(line).not.toContain("op-1");
    expect(line).not.toContain("t-9");
  });

  it("does not redact an ordinary field whose name merely contains a safe word", () => {
    const line = encodeDiagnosticLine({ ...base, fields: { workItemId: "wi-1" } });

    expect(line).toContain("wi-1");
  });

  it("redacts a secret that reached the thrown message or stack", () => {
    const thrown = describeThrown(new Error("auth failed for sk-live-abc"));
    const line = encodeDiagnosticLine({ ...base, thrown }, { secrets: ["sk-live-abc"] });

    expect(line).not.toContain("sk-live-abc");
  });

  it("drops fields past the bound rather than growing the line", () => {
    const fields: Record<string, number> = {};
    for (let at = 0; at < MAX_DIAGNOSTIC_FIELDS * 3; at += 1) fields[`f${String(at)}`] = at;

    const decoded = decode(encodeDiagnosticLine({ ...base, fields }));
    const kept = decoded["fields"] as Record<string, unknown>;

    expect(Object.keys(kept).length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_FIELDS);
  });

  it("keeps the line inside its byte bound and still parses", () => {
    const line = encodeDiagnosticLine({
      ...base,
      fields: { huge: "x".repeat(MAX_DIAGNOSTIC_LINE_BYTES * 4) },
    });

    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTIC_LINE_BYTES);
    expect(() => decode(line)).not.toThrow();
  });

  it("never emits an embedded newline, which would forge a second record", () => {
    const line = encodeDiagnosticLine({
      ...base,
      correlation: "wi-1\n{\"event\":\"FORGED\"}",
      fields: { note: "line one\nline two" },
    });

    expect(line.split("\n").filter((part) => part !== "").length).toBe(1);
  });

  it("refuses nothing: a malformed event code still encodes, flagged", () => {
    const decoded = decode(encodeDiagnosticLine({ ...base, event: "not a code" }));

    expect(decoded["event"]).toBe("not a code");
    expect(decoded["malformed"]).toBe(true);
  });
});
