import { describe, expect, it, vi } from "vitest";

import {
  NULL_DIAGNOSTIC_SINK, createDiagnosticEmitter, fanOutDiagnostics, filterDiagnostics,
} from "./diagnostic-sink.js";
import type { DiagnosticRecord } from "./diagnostic-record.js";

function collector(): { readonly records: DiagnosticRecord[]; readonly emit: (r: DiagnosticRecord) => void } {
  const records: DiagnosticRecord[] = [];
  return { emit: (record) => { records.push(record); }, records };
}

const clock = (): string => "2026-09-17T22:00:00.000Z";

describe("filterDiagnostics", () => {
  it("passes records at or above the threshold", () => {
    const sink = collector();
    const filtered = filterDiagnostics("warn", sink);
    const at = (level: DiagnosticRecord["level"]): DiagnosticRecord =>
      ({ at: "t", component: "store", event: "E_ONE", level });

    for (const level of ["debug", "info", "warn", "error"] as const) filtered.emit(at(level));

    expect(sink.records.map((record) => record.level)).toEqual(["warn", "error"]);
  });
});

describe("fanOutDiagnostics", () => {
  it("delivers to every sink", () => {
    const first = collector();
    const second = collector();

    fanOutDiagnostics([first, second])
      .emit({ at: "t", component: "store", event: "E_ONE", level: "info" });

    expect(first.records.length).toBe(1);
    expect(second.records.length).toBe(1);
  });

  it("keeps delivering when one sink throws, and never rethrows", () => {
    const good = collector();
    const bad = { emit: (): void => { throw new Error("disk full"); } };

    const fan = fanOutDiagnostics([bad, good]);

    expect(() => { fan.emit({ at: "t", component: "store", event: "E_ONE", level: "error" }); })
      .not.toThrow();
    expect(good.records.length).toBe(1);
  });
});

describe("createDiagnosticEmitter", () => {
  it("stamps the instant, component and level", () => {
    const sink = collector();
    const log = createDiagnosticEmitter({ clock, component: "wrapper", sink });

    log.warn("SEAT_QUIET");

    expect(sink.records[0]).toMatchObject({
      at: "2026-09-17T22:00:00.000Z", component: "wrapper", event: "SEAT_QUIET", level: "warn",
    });
  });

  it("describes a raw thrown value handed to it", () => {
    const sink = collector();
    const log = createDiagnosticEmitter({ clock, component: "store", sink });

    log.error("STORE_READ_FAILED", { error: Object.assign(new Error("locked"), { code: "SQLITE_BUSY" }) });

    expect(sink.records[0]?.thrown).toMatchObject({ code: "SQLITE_BUSY", message: "locked" });
  });

  it("carries fields and a correlation key", () => {
    const sink = collector();
    const log = createDiagnosticEmitter({ clock, component: "wrapper", sink });

    log.info("SEAT_STAFFED", { correlation: "wi-7", fields: { provider: "claude" } });

    expect(sink.records[0]).toMatchObject({ correlation: "wi-7", fields: { provider: "claude" } });
  });

  it("binds a correlation for every record a child emits", () => {
    const sink = collector();
    const log = createDiagnosticEmitter({ clock, component: "wrapper", sink })
      .forCorrelation("session-3");

    log.debug("SEAT_OUTPUT_SEEN");

    expect(sink.records[0]?.correlation).toBe("session-3");
  });

  it("NEVER throws when the sink does: the logger cannot take down the caller", () => {
    const log = createDiagnosticEmitter({
      clock, component: "boot", sink: { emit: (): void => { throw new Error("no disk"); } },
    });

    expect(() => { log.error("BOOT_STEP_FAILED"); }).not.toThrow();
  });

  it("never throws when the clock itself throws", () => {
    const sink = collector();
    const log = createDiagnosticEmitter({
      clock: (): string => { throw new Error("no clock"); }, component: "boot", sink,
    });

    expect(() => { log.error("BOOT_STEP_FAILED"); }).not.toThrow();
  });

  it("the null sink accepts everything and does nothing", () => {
    const spy = vi.fn();

    expect(() => { NULL_DIAGNOSTIC_SINK.emit({ at: "t", component: "x", event: "E_ONE", level: "error" }); })
      .not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
