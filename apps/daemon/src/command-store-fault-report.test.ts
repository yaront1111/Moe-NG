import { createDiagnosticEmitter } from "@moe/contracts";
import type { DiagnosticRecord } from "@moe/contracts";
import { describe, expect, it } from "vitest";

import { COMMAND_STORE_FAULT, commandStoreFaultReporter } from "./command-store-fault-report.js";

describe("commandStoreFaultReporter", () => {
  it("lands one error record under COMMAND_STORE_FAULT, correlated by the command id", () => {
    const records: DiagnosticRecord[] = [];
    const emitter = createDiagnosticEmitter({
      clock: () => "2026-09-18T09:00:00.000Z",
      component: "command",
      sink: { emit: (record) => { records.push(record); } },
    });

    commandStoreFaultReporter(emitter)({
      code: "OUTCOME_UNKNOWN",
      detail: "OUTCOME_UNKNOWN: disk I/O error at /var/lib/moe/events.db",
      key: { commandId: "cmd-7", principalId: "operator-local", projectId: "project-1" },
      thrown: {
        causes: ["EIO: i/o error, write"], code: "OUTCOME_UNKNOWN",
        message: "OUTCOME_UNKNOWN: disk I/O error at /var/lib/moe/events.db", name: "DurableStoreError",
        stack: "DurableStoreError: OUTCOME_UNKNOWN\n    at commit (decision-ledger-transaction.ts:128:11)",
      },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      component: "command",
      correlation: "cmd-7",
      event: COMMAND_STORE_FAULT,
      fields: {
        code: "OUTCOME_UNKNOWN",
        commandId: "cmd-7",
        detail: "OUTCOME_UNKNOWN: disk I/O error at /var/lib/moe/events.db",
        principalId: "operator-local",
        projectId: "project-1",
        thrownCauses: "EIO: i/o error, write",
        thrownCode: "OUTCOME_UNKNOWN",
        thrownName: "DurableStoreError",
      },
      level: "error",
    });
    expect(records[0]?.fields?.["thrownStack"]).toContain("decision-ledger-transaction.ts");
  });
});
