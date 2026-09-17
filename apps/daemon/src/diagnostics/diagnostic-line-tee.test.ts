import { describe, expect, it } from "vitest";

import { createDiagnosticEmitter } from "@moe/contracts";
import type { DiagnosticRecord } from "@moe/contracts";

import { teeDiagnosticLine } from "./diagnostic-line-tee.js";

function harness(level?: DiagnosticRecord["level"]): {
  readonly records: DiagnosticRecord[];
  readonly tee: (line: string) => void;
  readonly written: string[];
} {
  const records: DiagnosticRecord[] = [];
  const written: string[] = [];
  const emitter = createDiagnosticEmitter({
    clock: () => "2026-09-17T22:00:00.000Z",
    component: "wrapper",
    sink: { emit: (record) => { records.push(record); } },
  });
  const tee = teeDiagnosticLine({
    emitter,
    event: "WRAPPER_LINE",
    ...(level === undefined ? {} : { level }),
    write: (line) => { written.push(line); },
  });
  return { records, tee, written };
}

describe("teeDiagnosticLine", () => {
  it("passes the original bytes to the original sink, unchanged", () => {
    const { tee, written } = harness();

    tee("[wrapper] nothing to staff (surface OK, active 0)");

    expect(written).toEqual(["[wrapper] nothing to staff (surface OK, active 0)"]);
  });

  it("preserves a trailing newline on the console, where it is the stream convention", () => {
    const { tee, written } = harness();

    tee("[wrapper] staffing exhausted: wi-1\n");

    expect(written).toEqual(["[wrapper] staffing exhausted: wi-1\n"]);
  });

  it("files the line whole under a stable event code", () => {
    const { records, tee } = harness();

    tee("[wrapper] wi-7 agent exited 1 (signal none, output none)");

    expect(records[0]).toMatchObject({
      component: "wrapper",
      event: "WRAPPER_LINE",
      fields: { line: "[wrapper] wi-7 agent exited 1 (signal none, output none)" },
      level: "info",
    });
  });

  it("strips the stream's newline from the record, which is not part of the fact", () => {
    const { records, tee } = harness();

    tee("[wrapper] staffing exhausted: wi-1\n");

    expect(records[0]?.fields).toEqual({ line: "[wrapper] staffing exhausted: wi-1" });
  });

  it("takes the level the call site chose", () => {
    const { records, tee } = harness("warn");

    tee("[wrapper] pass failed: STORE_BUSY");

    expect(records[0]?.level).toBe("warn");
  });

  it("writes to the console even when the diagnostic plane is broken", () => {
    const written: string[] = [];
    const tee = teeDiagnosticLine({
      emitter: createDiagnosticEmitter({
        clock: () => { throw new Error("no clock"); },
        component: "wrapper",
        sink: { emit: () => { throw new Error("no disk"); } },
      }),
      event: "WRAPPER_LINE",
      write: (line) => { written.push(line); },
    });

    expect(() => { tee("[wrapper] still here"); }).not.toThrow();
    expect(written).toEqual(["[wrapper] still here"]);
  });
});
