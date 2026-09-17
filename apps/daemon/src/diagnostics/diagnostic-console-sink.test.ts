import { describe, expect, it } from "vitest";

import { createDiagnosticConsoleSink } from "./diagnostic-console-sink.js";
import { describeThrown } from "@moe/contracts";
import type { DiagnosticRecord } from "@moe/contracts";

function capture(): { readonly lines: string[]; readonly write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => { lines.push(line); } };
}

const base: DiagnosticRecord = {
  at: "2026-09-17T22:00:00.000Z",
  component: "wrapper",
  event: "SEAT_SPAWN_REFUSED",
  level: "error",
};

describe("createDiagnosticConsoleSink", () => {
  it("writes one compact human line, not JSON", () => {
    const out = capture();

    createDiagnosticConsoleSink({ write: out.write }).emit(base);

    expect(out.lines[0]).toBe("[22:00:00.000] ERROR wrapper SEAT_SPAWN_REFUSED\n");
  });

  it("names the correlation, the fields and the errno code an operator acts on", () => {
    const out = capture();

    createDiagnosticConsoleSink({ write: out.write }).emit({
      ...base,
      correlation: "wi-7",
      fields: { provider: "claude" },
      thrown: describeThrown(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })),
    });

    const line = out.lines[0] ?? "";

    expect(line).toContain("wi-7");
    expect(line).toContain("provider=claude");
    expect(line).toContain("SQLITE_BUSY");
    expect(line).toContain("database is locked");
  });

  it("redacts a declared secret from the console too", () => {
    const out = capture();

    createDiagnosticConsoleSink({ secrets: ["sk-live-abc"], write: out.write })
      .emit({ ...base, fields: { detail: "sk-live-abc" } });

    expect(out.lines[0]).not.toContain("sk-live-abc");
  });

  it("emits exactly one line however many newlines the payload carries", () => {
    const out = capture();

    createDiagnosticConsoleSink({ write: out.write })
      .emit({ ...base, fields: { detail: "first\nsecond\nthird" } });

    expect((out.lines[0] ?? "").split("\n").filter((part) => part !== "").length).toBe(1);
  });

  it("NEVER throws when the stream does", () => {
    const sink = createDiagnosticConsoleSink({
      write: () => { throw new Error("EPIPE"); },
    });

    expect(() => { sink.emit(base); }).not.toThrow();
  });
});
