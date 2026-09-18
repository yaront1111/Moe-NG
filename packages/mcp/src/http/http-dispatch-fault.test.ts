import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_KIND,
  CONFORMANCE_COMMAND_LABEL,
  CONFORMANCE_COMMAND_RESPONSE_BYTES,
} from "../dispatch-conformance.js";
import type { McpDispatchFault } from "../dispatch-fault.js";
import { createHttpMcpAdapter } from "./http-server.js";
import type { HttpDispatchPort } from "./http-server.js";
import {
  BEARER, INITIALIZE_BODY, build, readPayload, sessionPortFor, toolCallBody,
} from "./http-server-test-helpers.js";
import { MCP_SESSION_ID_HEADER } from "./http-session.js";

/**
 * The observer, reached through the PUBLISHED adapter options rather than the bridge function:
 * `createHttpMcpAdapter({ onDispatchFault })` is what `mcp-http-host.ts` composes, and a bridge
 * that reported faults to a parameter the adapter never threaded would pass the bridge suite
 * and still leave the daemon blind.
 */
describe("http adapter dispatch fault disclosure", () => {
  const secret = "SQLITE_BUSY: database is locked at /var/lib/moe/events.db";

  async function callThroughAdapter(port: HttpDispatchPort): Promise<{
    readonly faults: readonly McpDispatchFault[];
    readonly payload: Record<string, unknown>;
  }> {
    const faults: McpDispatchFault[] = [];
    const adapter = createHttpMcpAdapter({
      dispatchPort: port,
      enableJsonResponse: true,
      onDispatchFault: (fault) => { faults.push(fault); },
      sessionPort: sessionPortFor(BEARER),
    });
    try {
      const opened = await adapter.handleRequest(build({ body: INITIALIZE_BODY }));
      const sessionId = opened.headers.get(MCP_SESSION_ID_HEADER);
      if (sessionId === null) throw new Error(`initialize did not mint a session: ${opened.status}`);
      if (opened.body !== null) await opened.text();
      const response = await adapter.handleRequest(build({
        body: toolCallBody(2, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS), sessionId,
      }));
      return { faults, payload: await readPayload(response) };
    } finally {
      await adapter.close();
    }
  }

  it("reports a throwing dispatch to the host while the client still sees exactly UNKNOWN_ERROR", async () => {
    const port: HttpDispatchPort = {
      authenticate: () => ({ ok: true }),
      dispatchCommandBytes(): never {
        throw Object.assign(new Error(secret), { code: "SQLITE_BUSY" });
      },
      dispatchQueryBytes: () => CONFORMANCE_COMMAND_RESPONSE_BYTES,
    };

    const { faults, payload } = await callThroughAdapter(port);

    expect(payload["error"]).toMatchObject({ code: -32603, data: { code: "UNKNOWN_ERROR" } });
    expect(JSON.stringify(payload)).not.toContain("SQLITE_BUSY");
    expect(JSON.stringify(payload)).not.toContain(BEARER);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      stage: "dispatch",
      surface: "command",
      thrown: { code: "SQLITE_BUSY", message: secret, name: "Error" },
      toolKind: CONFORMANCE_COMMAND_KIND,
      transport: "http",
    });
  });

  it("reports a throwing authenticate at its own stage", async () => {
    const port: HttpDispatchPort = {
      authenticate(): never {
        throw new Error("credential store is closed");
      },
      dispatchCommandBytes: () => CONFORMANCE_COMMAND_RESPONSE_BYTES,
      dispatchQueryBytes: () => CONFORMANCE_COMMAND_RESPONSE_BYTES,
    };

    const { faults, payload } = await callThroughAdapter(port);

    expect(payload["error"]).toMatchObject({ data: { code: "UNKNOWN_ERROR" } });
    expect(faults.map((fault) => fault.stage)).toEqual(["authenticate"]);
  });

  it("reports nothing for a clean call", async () => {
    const port: HttpDispatchPort = {
      authenticate: () => ({ ok: true }),
      dispatchCommandBytes: () => CONFORMANCE_COMMAND_RESPONSE_BYTES,
      dispatchQueryBytes: () => CONFORMANCE_COMMAND_RESPONSE_BYTES,
    };

    const { faults, payload } = await callThroughAdapter(port);

    expect(payload["error"]).toBeUndefined();
    expect(faults).toEqual([]);
  });
});
