import { createRuntimeError } from "@moe/contracts";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { containDispatchThrow } from "./dispatch-fault.js";
import type { McpDispatchFault, McpDispatchFaultSite } from "./dispatch-fault.js";

const SITE: McpDispatchFaultSite = {
  stage: "dispatch", surface: "command", toolKind: "work.claim", transport: "http",
};

function thrownBy(run: () => never): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("containDispatchThrow", () => {
  it("reports what was thrown to the observer and refuses UNKNOWN_ERROR to the client", () => {
    // Before this the seat saw UNKNOWN_ERROR and the daemon saw nothing at all: a locked store
    // behind a tool call left no trace an operator could read.
    const faults: McpDispatchFault[] = [];
    const secret = "SQLITE_BUSY: database is locked at /var/lib/moe/events.db";
    const cause = Object.assign(new Error(secret), { code: "SQLITE_BUSY" });

    const refusal = thrownBy(() => containDispatchThrow(cause, SITE, (fault) => { faults.push(fault); }));

    expect(refusal).toBeInstanceOf(McpError);
    expect((refusal as McpError).data).toMatchObject({ code: "UNKNOWN_ERROR" });
    expect(JSON.stringify((refusal as McpError).data)).not.toContain("SQLITE_BUSY");
    expect((refusal as McpError).message).not.toContain(secret);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      ...SITE, thrown: { code: "SQLITE_BUSY", message: secret, name: "Error" },
    });
    // The stack names the throw's CREATION site: host-side facts the client must never see.
    expect(faults[0]?.thrown.stack).toContain("dispatch-fault.test");
  });

  it("passes a refusal the port RETURNED through untouched and reports nothing", () => {
    // An McpError is a verdict the registry already produced; reporting it would double-count
    // every refusal as a fault and drown the log in SESSION_EXPIRED.
    const faults: McpDispatchFault[] = [];
    const verdict = createRuntimeError({ code: "SESSION_EXPIRED" });
    const refusal = new McpError(verdict.transport.mcpCode, verdict.code, verdict);

    const rethrown = thrownBy(() => containDispatchThrow(refusal, SITE, (fault) => { faults.push(fault); }));

    expect(rethrown).toBe(refusal);
    expect(faults).toEqual([]);
  });

  it("still refuses UNKNOWN_ERROR when the observer itself throws", () => {
    // The observer is a log; a broken log must not turn a contained refusal into a raw throw
    // that carries the observer's own message to the client.
    const refusal = thrownBy(() => containDispatchThrow(new Error("port died"), SITE, () => {
      throw new Error("diagnostics sink is closed");
    }));

    expect(refusal).toBeInstanceOf(McpError);
    expect((refusal as McpError).data).toMatchObject({ code: "UNKNOWN_ERROR" });
    expect((refusal as McpError).message).not.toContain("diagnostics sink is closed");
  });

  it("refuses identically with no observer, so an unwired host changes nothing for the client", () => {
    const refusal = thrownBy(() => containDispatchThrow("not even an Error", SITE, undefined));
    expect(refusal).toBeInstanceOf(McpError);
    expect((refusal as McpError).code).toBe(-32603);
    expect((refusal as McpError).data).toMatchObject({ code: "UNKNOWN_ERROR" });
  });

  it("describes a non-Error throw rather than refusing to describe it", () => {
    const faults: McpDispatchFault[] = [];
    thrownBy(() => containDispatchThrow({ reason: "plain object" }, SITE, (fault) => { faults.push(fault); }));
    expect(faults).toHaveLength(1);
    expect(faults[0]?.thrown.name).toBe("Object");
  });
});
