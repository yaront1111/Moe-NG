import { createDiagnosticEmitter } from "@moe/contracts";
import type { DiagnosticRecord } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { SCHEDULE_FAULT, scheduleFaultReporter } from "./schedule-fault-report.js";

function harness(): { readonly records: DiagnosticRecord[]; readonly report: ReturnType<typeof scheduleFaultReporter> } {
  const records: DiagnosticRecord[] = [];
  const emitter = createDiagnosticEmitter({
    clock: () => "2026-09-18T11:00:00.000Z",
    component: "schedule",
    sink: { emit: (record) => { records.push(record); } },
  });
  return { records, report: scheduleFaultReporter(emitter) };
}

describe("scheduleFaultReporter", () => {
  it("lands a refusal that carried a throw as an error record with the throw's facts", () => {
    const { records, report } = harness();
    report({
      code: "SCHEDULE_CALLBACK_FAILED", id: "backups/nightly",
      thrown: { causes: [], code: "EACCES", message: "cannot write backup", name: "Error", stack: "Error: cannot write backup\n    at tick" },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: SCHEDULE_FAULT,
      fields: { code: "SCHEDULE_CALLBACK_FAILED", id: "backups/nightly", thrownCode: "EACCES", thrownMessage: "cannot write backup" },
      level: "error",
    });
  });

  it("lands a refusal without a throw as a warning naming the id and the code", () => {
    const { records, report } = harness();
    report({ code: "SCHEDULE_TARGET_UNRESOLVED", id: "release/auto-decide", thrown: null });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: SCHEDULE_FAULT, fields: { code: "SCHEDULE_TARGET_UNRESOLVED", id: "release/auto-decide" }, level: "warn",
    });
    expect(records[0]?.fields).not.toHaveProperty("thrownMessage");
  });
});
