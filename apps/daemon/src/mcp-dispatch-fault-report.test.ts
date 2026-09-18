import { createDiagnosticEmitter } from "@moe/contracts";
import type { DiagnosticRecord } from "@moe/contracts";
import type { McpDispatchFault } from "@moe/mcp";
import { describe, expect, it } from "vitest";

import {
  MCP_DISPATCH_THREW, MCP_SESSION_SCREEN_THREW, mcpDispatchFaultReporter, mcpSessionFaultReporter,
} from "./mcp-dispatch-fault-report.js";

const FAULT: McpDispatchFault = {
  stage: "dispatch",
  surface: "query",
  thrown: {
    causes: ["disk I/O error", "EIO: i/o error, read"],
    code: "SQLITE_IOERR",
    message: "disk I/O error at /var/lib/moe/events.db",
    name: "SqliteError",
    stack: "SqliteError: disk I/O error\n    at readPage (event-stream.ts:41:9)",
  },
  toolKind: "events.read",
  transport: "http",
};

function harness(): { readonly records: DiagnosticRecord[]; readonly report: (fault: McpDispatchFault) => void } {
  const records: DiagnosticRecord[] = [];
  const emitter = createDiagnosticEmitter({
    clock: () => "2026-09-18T08:00:00.000Z",
    component: "mcp",
    sink: { emit: (record) => { records.push(record); } },
  });
  return { records, report: mcpDispatchFaultReporter(emitter) };
}

describe("mcpDispatchFaultReporter", () => {
  it("lands one error record under MCP_DISPATCH_THREW carrying every fact of the fault", () => {
    // The seat saw UNKNOWN_ERROR. This record is the ONLY place the daemon says what happened.
    const { records, report } = harness();

    report(FAULT);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      at: "2026-09-18T08:00:00.000Z",
      component: "mcp",
      event: MCP_DISPATCH_THREW,
      fields: {
        stage: "dispatch",
        surface: "query",
        thrownCauses: "disk I/O error <- EIO: i/o error, read",
        thrownCode: "SQLITE_IOERR",
        thrownMessage: "disk I/O error at /var/lib/moe/events.db",
        thrownName: "SqliteError",
        thrownStack: "SqliteError: disk I/O error\n    at readPage (event-stream.ts:41:9)",
        toolKind: "events.read",
        transport: "http",
      },
      level: "error",
    });
  });

  it("keeps a null errno code and a null stack as null, never as the string 'null' or absent", () => {
    const { records, report } = harness();

    report({ ...FAULT, thrown: { ...FAULT.thrown, causes: [], code: null, stack: null } });

    expect(records[0]?.fields).toMatchObject({ thrownCauses: "", thrownCode: null, thrownStack: null });
  });

  it("is the same observer shape both transports accept, so one function serves every entry", () => {
    const { records, report } = harness();
    report({ ...FAULT, stage: "authenticate", surface: "command", toolKind: "work.claim", transport: "stdio" });
    expect(records[0]?.fields).toMatchObject({
      stage: "authenticate", surface: "command", toolKind: "work.claim", transport: "stdio",
    });
  });
});

describe("mcpSessionFaultReporter", () => {
  it("lands one error record under MCP_SESSION_SCREEN_THREW carrying the throw", () => {
    const records: DiagnosticRecord[] = [];
    const emitter = createDiagnosticEmitter({
      clock: () => "2026-09-18T08:00:00.000Z",
      component: "mcp",
      sink: { emit: (record) => { records.push(record); } },
    });

    mcpSessionFaultReporter(emitter)({
      stage: "validate-bearer",
      thrown: {
        causes: [], code: "SQLITE_BUSY", message: "database is locked", name: "SqliteError",
        stack: "SqliteError: database is locked\n    at authenticate (session-authenticator.ts:12:5)",
      },
      transport: "http",
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      component: "mcp",
      event: MCP_SESSION_SCREEN_THREW,
      fields: {
        stage: "validate-bearer",
        thrownCauses: "",
        thrownCode: "SQLITE_BUSY",
        thrownMessage: "database is locked",
        thrownName: "SqliteError",
        transport: "http",
      },
      level: "error",
    });
    expect(records[0]?.fields?.["thrownStack"]).toContain("session-authenticator.ts");
  });
});
