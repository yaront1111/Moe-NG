import { createDiagnosticEmitter } from "@moe/contracts";
import type { DiagnosticRecord, DiagnosticThrown } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { containCaptureAnswer } from "./foundation-attempt-settlement.js";
import { FOUNDATION_CAPTURE_THREW, foundationCaptureFaultReporter } from "./foundation-capture-fault-report.js";

describe("containCaptureAnswer", () => {
  it("answers null for a throwing producer and hands the described throw to the observer", async () => {
    const seen: DiagnosticThrown[] = [];
    const answer = await containCaptureAnswer(() => {
      throw Object.assign(new Error("capture workspace vanished"), { code: "ENOENT" });
    }, (thrown) => { seen.push(thrown); });

    expect(answer).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ code: "ENOENT", message: "capture workspace vanished", name: "Error" });
  });

  it("answers null for a rejecting native promise the same way", async () => {
    const seen: DiagnosticThrown[] = [];
    const answer = await containCaptureAnswer(
      () => Promise.reject(new Error("runner died")), (thrown) => { seen.push(thrown); },
    );
    expect(answer).toBeNull();
    expect(seen.map((thrown) => thrown.message)).toEqual(["runner died"]);
  });

  it("reports nothing for an answer, and keeps answering null when the observer throws", async () => {
    const seen: DiagnosticThrown[] = [];
    expect(await containCaptureAnswer(() => ({ ok: true }), (thrown) => { seen.push(thrown); })).toEqual({ ok: true });
    expect(seen).toEqual([]);
    expect(await containCaptureAnswer(() => { throw new Error("x"); }, () => { throw new Error("sink closed"); }))
      .toBeNull();
    expect(await containCaptureAnswer(() => { throw new Error("x"); }, undefined)).toBeNull();
  });
});

describe("foundationCaptureFaultReporter", () => {
  it("lands one error record under FOUNDATION_CAPTURE_THREW carrying the throw", () => {
    const records: DiagnosticRecord[] = [];
    const emitter = createDiagnosticEmitter({
      clock: () => "2026-09-18T10:00:00.000Z",
      component: "command",
      sink: { emit: (record) => { records.push(record); } },
    });

    foundationCaptureFaultReporter(emitter)({
      causes: [], code: "ENOENT", message: "capture workspace vanished", name: "Error",
      stack: "Error: capture workspace vanished\n    at capture (foundation-capture-producer.ts:40:9)",
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: FOUNDATION_CAPTURE_THREW,
      fields: { thrownCode: "ENOENT", thrownMessage: "capture workspace vanished", thrownName: "Error" },
      level: "error",
    });
    expect(records[0]?.fields?.["thrownStack"]).toContain("foundation-capture-producer.ts");
  });
});
