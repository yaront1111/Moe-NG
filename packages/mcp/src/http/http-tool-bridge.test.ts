/**
 * Direct drive of the HTTP bridge's `decodeAndDispatch`, the function every tool call on the
 * Streamable HTTP transport funnels through. The full-stack proofs (session screen, SDK
 * transport, parity with stdio) live in `http-parity.test.ts` and `http-server.test.ts`; this
 * file targets the containment boundary itself, where a port fault can be aimed at the function
 * without a session or a request in the way.
 */
import { createRuntimeError } from "@moe/contracts";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_KIND,
  CONFORMANCE_COMMAND_RESPONSE_BYTES,
  CONFORMANCE_QUERY_ARGS,
  CONFORMANCE_QUERY_KIND,
  CONFORMANCE_QUERY_RESPONSE_BYTES,
} from "../dispatch-conformance.js";
import { STDIO_TOOL_ENTRIES } from "../stdio/stdio-tool-schemas.js";
import type { StdioToolEntry } from "../stdio/stdio-tool-schemas.js";
import { buildEnvelopeBytes, decodeAndDispatch } from "./http-tool-bridge.js";
import type { HttpDispatchPort } from "./http-tool-bridge.js";

const CREDENTIAL = "bridge-credential-DO-NOT-LOG-9e4d2c";

function entryFor(kind: string): StdioToolEntry {
  const entry = STDIO_TOOL_ENTRIES.find((candidate) => candidate.kind === kind);
  if (entry === undefined) throw new Error(`no generated entry for ${kind}`);
  return entry;
}

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("http tool bridge authenticate containment", () => {
  it.each([
    ["command", CONFORMANCE_COMMAND_KIND, CONFORMANCE_COMMAND_ARGS],
    ["query", CONFORMANCE_QUERY_KIND, CONFORMANCE_QUERY_ARGS],
  ])("contains a throwing authenticate on the %s surface as UNKNOWN_ERROR with zero dispatch", async (
    _surface,
    kind,
    args,
  ) => {
    // A store throw is not a verdict: it must leave as the registry's UNKNOWN_ERROR and never
    // as the raw Error, whose message would carry the store's own text to the client.
    const secret = "STORE_BUSY: credential store at /var/lib/moe/sessions.db is locked";
    const calls: string[] = [];
    const port: HttpDispatchPort = {
      authenticate(): never {
        throw new Error(secret);
      },
      dispatchCommandBytes(): Uint8Array {
        calls.push("dispatchCommandBytes");
        return CONFORMANCE_COMMAND_RESPONSE_BYTES;
      },
      dispatchQueryBytes(): Uint8Array {
        calls.push("dispatchQueryBytes");
        return CONFORMANCE_QUERY_RESPONSE_BYTES;
      },
    };
    const entry = entryFor(kind);
    const thrown = await thrownBy(() =>
      decodeAndDispatch(port, entry, buildEnvelopeBytes(entry, CREDENTIAL, args), undefined),
    );
    expect(calls).toEqual([]);
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(-32603);
    expect((thrown as McpError).data).toMatchObject({ code: "UNKNOWN_ERROR" });
    expect(JSON.stringify((thrown as McpError).data)).not.toContain(secret);
    expect((thrown as McpError).message).not.toContain(secret);
    expect((thrown as McpError).message).not.toContain(CREDENTIAL);
  });

  it("passes a registry refusal the port RETURNS through the same containment intact", async () => {
    // The containment must not flatten a real verdict: the catch rethrows an McpError, so the
    // refusal's own code, JSON-RPC code, and recovery affordance survive.
    const calls: string[] = [];
    const port: HttpDispatchPort = {
      authenticate: () => ({ error: createRuntimeError({ code: "SESSION_EXPIRED" }), ok: false }),
      dispatchCommandBytes(): Uint8Array {
        calls.push("dispatchCommandBytes");
        return CONFORMANCE_COMMAND_RESPONSE_BYTES;
      },
      dispatchQueryBytes(): Uint8Array {
        calls.push("dispatchQueryBytes");
        return CONFORMANCE_QUERY_RESPONSE_BYTES;
      },
    };
    const entry = entryFor(CONFORMANCE_COMMAND_KIND);
    const thrown = await thrownBy(() =>
      decodeAndDispatch(
        port, entry, buildEnvelopeBytes(entry, CREDENTIAL, CONFORMANCE_COMMAND_ARGS), undefined,
      ),
    );
    expect(calls).toEqual([]);
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(-32001);
    expect((thrown as McpError).data).toMatchObject({
      code: "SESSION_EXPIRED",
      recoveryCommands: ["session.renew", "session.rotate"],
    });
  });
});
