/**
 * Transport-level tests for the stdio adapter.
 *
 * MALFORMED-BYTES CAVEAT: `InMemoryTransport` hands JSON-RPC objects to the peer by
 * reference and never serialises them, so malformed wire bytes cannot be expressed
 * through a protocol roundtrip. The adapter is also the sole producer of envelope bytes,
 * so a client cannot inject hostile bytes through tool arguments either. The decoder's
 * malformed-bytes branch is therefore exercised by invoking `decodeAndDispatch` DIRECTLY
 * with hostile bytes. The roundtrip tests do not cover that branch and do not pretend to.
 *
 * Byte identity IS genuinely observable here: daemon bytes ride to the client as an
 * opaque string inside a text content block, so a re-serialisation would still show up.
 */
import { createHash } from "node:crypto";

import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  RUNTIME_QUERY_KINDS,
  createRuntimeError,
  decodeRuntimeCommandEnvelopeBytes,
  decodeRuntimeQueryEnvelopeBytes,
} from "@moe/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import * as packageRoot from "../index.js";
import {
  CONFORMANCE_COMMAND_ARGS,
  CONFORMANCE_COMMAND_KIND,
  CONFORMANCE_COMMAND_LABEL,
  CONFORMANCE_COMMAND_RESPONSE_TEXT,
  CONFORMANCE_QUERY_ARGS,
  CONFORMANCE_QUERY_KIND,
  CONFORMANCE_QUERY_LABEL,
  createRecordingPort,
  registerDispatchConformanceSuite,
} from "../dispatch-conformance.js";
import type { ConformanceOutcome, ConformanceSubject } from "../dispatch-conformance.js";
import {
  ADAPTER_SUPPLIED_COMMAND_FIELDS,
  ADAPTER_SUPPLIED_QUERY_FIELDS,
  MCP_TOOL_ALLOWLIST_EMPTY,
  MCP_TOOL_ALLOWLIST_UNKNOWN_KIND,
  STDIO_TOOL_ENTRIES,
  toolLabelForKind,
} from "./stdio-tool-schemas.js";
import {
  MOE_SESSION_CREDENTIAL_ENV,
  createStdioMcpServer,
  decodeAndDispatch,
  readBootstrapCredential,
} from "./stdio-server.js";
import type { StdioDispatchPort } from "./stdio-dispatch-port.js";

const CREDENTIAL = "bootstrap-credential-DO-NOT-LOG-a1b2c3";

async function withClient<T>(
  port: StdioDispatchPort,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createStdioMcpServer({ credential: CREDENTIAL, port });
  const client = new Client({ name: "stdio-conformance-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function textOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const blocks = (result as { readonly content?: unknown }).content;
  const first = Array.isArray(blocks) ? (blocks as readonly unknown[])[0] : undefined;
  if (typeof first !== "object" || first === null) return "";
  const text = (first as { readonly text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function selectFields(value: object, fields: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

const subject: ConformanceSubject = {
  async invoke(port, toolLabel, args): Promise<ConformanceOutcome> {
    return withClient(port, async (client) => {
      try {
        const result = await client.callTool({ arguments: { ...args }, name: toolLabel });
        return { kind: "ok" as const, text: textOf(result) };
      } catch (error) {
        if (error instanceof McpError) {
          return { data: error.data, kind: "error" as const, mcpCode: error.code };
        }
        throw error;
      }
    });
  },
  transportName: "stdio (in-memory transport)",
};

registerDispatchConformanceSuite(subject);

describe("stdio server tool listing", () => {
  it("advertises exactly the generated tools with their schemas", async () => {
    const listed = await withClient(createRecordingPort(), async (client) => client.listTools());
    expect(listed.tools).toHaveLength(
      RUNTIME_COMMAND_KINDS.length + RUNTIME_QUERY_KINDS.length,
    );
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      STDIO_TOOL_ENTRIES.map((entry) => entry.tool.name),
    );
    expect(listed.tools[0]?.inputSchema).toEqual(STDIO_TOOL_ENTRIES[0]?.tool.inputSchema);
  });

  it("never leaks the bootstrap credential through the listing", async () => {
    const listed = await withClient(createRecordingPort(), async (client) => client.listTools());
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain("sessionCredential");
  });
});

describe("stdio server envelope assembly", () => {
  it("injects the credential, kind, version, and payload digest the client never sends", async () => {
    const port = createRecordingPort();
    await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    const bytes = port.dispatched[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = decodeRuntimeCommandEnvelopeBytes(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const expectedDigest = createHash("sha256")
      .update(new TextEncoder().encode(JSON.stringify(CONFORMANCE_COMMAND_ARGS["payload"])))
      .digest("hex");
    expect(decoded.envelope.commandKind).toBe(CONFORMANCE_COMMAND_KIND);
    expect(decoded.envelope.schemaVersion).toBe(RUNTIME_COMMAND_ENVELOPE_VERSION);
    expect(decoded.envelope.sessionCredential).toBe(CREDENTIAL);
    expect(decoded.envelope.requestDigest).toBe(expectedDigest);
    expect(decoded.envelope.commandId).toBe(CONFORMANCE_COMMAND_ARGS["commandId"]);
  });

  it("overwrites every adapter-supplied command field", async () => {
    const port = createRecordingPort();
    const hostileKind = RUNTIME_COMMAND_KINDS.find((kind) => kind !== CONFORMANCE_COMMAND_KIND);
    await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, {
      ...CONFORMANCE_COMMAND_ARGS,
      commandKind: hostileKind,
      requestDigest: "f".repeat(64),
      schemaVersion: 0,
      sessionCredential: "attacker-supplied",
    });
    const decoded = decodeRuntimeCommandEnvelopeBytes(port.dispatched[0]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(selectFields(decoded.envelope, ADAPTER_SUPPLIED_COMMAND_FIELDS)).toEqual({
      commandKind: CONFORMANCE_COMMAND_KIND,
      requestDigest: createHash("sha256")
        .update(new TextEncoder().encode(JSON.stringify(CONFORMANCE_COMMAND_ARGS["payload"])))
        .digest("hex"),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL,
    });
  });

  it("overwrites every adapter-supplied query field", async () => {
    const port = createRecordingPort();
    const hostileKind = RUNTIME_QUERY_KINDS.find((kind) => kind !== CONFORMANCE_QUERY_KIND);
    await subject.invoke(port, CONFORMANCE_QUERY_LABEL, {
      ...CONFORMANCE_QUERY_ARGS,
      queryKind: hostileKind,
      schemaVersion: 0,
      sessionCredential: "attacker-supplied",
    });
    const decoded = decodeRuntimeQueryEnvelopeBytes(port.dispatched[0]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(selectFields(decoded.envelope, ADAPTER_SUPPLIED_QUERY_FIELDS)).toEqual({
      queryKind: CONFORMANCE_QUERY_KIND,
      schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL,
    });
  });

  it("fails closed when a client sends an argument outside the envelope key set", async () => {
    const port = createRecordingPort();
    const outcome = await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, {
      ...CONFORMANCE_COMMAND_ARGS,
      unexpectedKey: "rejected",
    });
    expect(port.calls).toEqual([]);
    expect(outcome.kind === "error" ? outcome.mcpCode : 0).toBe(-32602);
  });

  it("refuses a query that tries to smuggle command-only authority fields", async () => {
    const port = createRecordingPort();
    const outcome = await subject.invoke(port, CONFORMANCE_QUERY_LABEL, {
      ...CONFORMANCE_QUERY_ARGS,
      expectedVersion: 3,
      leaseAuthority: {
        attemptBindingVersion: 0,
        authorityHash: "a".repeat(64),
        epoch: 1,
        graphEpoch: 1,
        leaseToken: "smuggled",
      },
    });
    expect(port.calls).toEqual([]);
    expect(outcome.kind === "error" ? outcome.mcpCode : 0).toBe(-32602);
  });

  it("fails closed on a structurally invalid expectedVersion", async () => {
    const port = createRecordingPort();
    const outcome = await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, {
      ...CONFORMANCE_COMMAND_ARGS,
      expectedVersion: -1,
    });
    expect(port.calls).toEqual([]);
    expect(outcome.kind === "error" ? outcome.mcpCode : 0).toBe(-32602);
  });
});

describe("stdio server error routing", () => {
  it("carries the full stable runtime error in the JSON-RPC error data", async () => {
    const port = createRecordingPort({ authError: createRuntimeError({ code: "SESSION_EXPIRED" }) });
    const outcome = await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.mcpCode).toBe(-32001);
    expect(outcome.data).toMatchObject({
      code: "SESSION_EXPIRED",
      recoveryCategory: "REAUTHENTICATE",
      recoveryCommands: ["session.renew", "session.rotate"],
      retryability: "AFTER_RECOVERY",
    });
    expect(JSON.stringify(outcome.data)).not.toContain(CREDENTIAL);
  });

  it("passes daemon rejection bytes through as result content, not as a protocol error", async () => {
    const rejection = '{"ok":false,"code":"ILLEGAL_TRANSITION","recoveryCommands":["goal.close"]}';
    const port = createRecordingPort({
      commandResponse: new TextEncoder().encode(rejection),
    });
    const outcome = await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(outcome.kind).toBe("ok");
    expect(outcome.kind === "ok" ? outcome.text : "").toBe(rejection);
  });
});

describe("stdio server daemon response handling", () => {
  it("awaits an asynchronous command dispatch and returns its daemon bytes verbatim", async () => {
    const calls: string[] = [];
    let markInvoked!: () => void;
    let resolveResponse!: (bytes: Uint8Array) => void;
    const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
    const response = new Promise<Uint8Array>((resolve) => { resolveResponse = resolve; });
    const port: StdioDispatchPort = {
      authenticate: () => { calls.push("authenticate"); return { ok: true }; },
      dispatchCommandBytes: () => {
        calls.push("dispatchCommandBytes");
        markInvoked();
        return response;
      },
      dispatchQueryBytes: () => { throw new Error("query dispatch was not expected"); },
    };
    await withClient(port, async (client) => {
      const pending = client.callTool({
        arguments: { ...CONFORMANCE_COMMAND_ARGS }, name: CONFORMANCE_COMMAND_LABEL,
      });
      await invoked;
      expect(calls).toEqual(["authenticate", "dispatchCommandBytes"]);
      resolveResponse(new TextEncoder().encode(CONFORMANCE_COMMAND_RESPONSE_TEXT));
      expect(textOf(await pending)).toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
    });
    expect(calls).toEqual(["authenticate", "dispatchCommandBytes"]);
  });

  it("contains a rejected asynchronous command dispatch as UNKNOWN_ERROR", async () => {
    const secret = "async transport secret must not leak";
    const port: StdioDispatchPort = {
      authenticate: () => ({ ok: true }),
      dispatchCommandBytes: async () => { throw new Error(secret); },
      dispatchQueryBytes: () => { throw new Error("query dispatch was not expected"); },
    };
    let thrown: unknown;
    try {
      await withClient(port, (client) => client.callTool({
        arguments: { ...CONFORMANCE_COMMAND_ARGS }, name: CONFORMANCE_COMMAND_LABEL,
      }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(-32603);
    expect((thrown as McpError).data).toMatchObject({ code: "UNKNOWN_ERROR" });
    expect(JSON.stringify((thrown as McpError).data)).not.toContain(secret);
  });

  it("contains a throwing authenticate as UNKNOWN_ERROR with zero dispatch calls", async () => {
    // The store behind `authenticate` can throw (busy, closed) instead of answering. Uncontained,
    // the SDK renders that as its own -32603 whose MESSAGE is the throw's message and whose data
    // is absent, so both the message and the data are checked here.
    const secret = "STORE_CLOSED: credential store at /var/lib/moe/sessions.db is closed";
    const calls: string[] = [];
    const port: StdioDispatchPort = {
      authenticate: () => { throw new Error(secret); },
      dispatchCommandBytes: () => { calls.push("dispatchCommandBytes"); return new Uint8Array(0); },
      dispatchQueryBytes: () => { calls.push("dispatchQueryBytes"); return new Uint8Array(0); },
    };
    let thrown: unknown;
    try {
      await withClient(port, (client) => client.callTool({
        arguments: { ...CONFORMANCE_COMMAND_ARGS }, name: CONFORMANCE_COMMAND_LABEL,
      }));
    } catch (error) {
      thrown = error;
    }
    expect(calls).toEqual([]);
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(-32603);
    expect((thrown as McpError).data).toMatchObject({ code: "UNKNOWN_ERROR" });
    expect(JSON.stringify((thrown as McpError).data)).not.toContain(secret);
    expect((thrown as McpError).message).not.toContain(secret);
  });

  it("refuses daemon bytes that are not valid UTF-8 instead of emitting replacements", async () => {
    const port = createRecordingPort({
      commandResponse: Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]),
    });
    const outcome = await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.mcpCode).toBe(-32603);
    expect(outcome.data).toMatchObject({ code: "UNKNOWN_ERROR" });
  });

  it("converts a port transport failure into a stable error without echoing its message", async () => {
    const secret = "connect ECONNREFUSED 127.0.0.1:65000";
    const port = {
      authenticate: () => ({ ok: true }),
      dispatchCommandBytes: () => {
        throw new Error(secret);
      },
      dispatchQueryBytes: () => {
        throw new Error(secret);
      },
    } satisfies StdioDispatchPort;
    const outcome = await subject.invoke(port, CONFORMANCE_COMMAND_LABEL, CONFORMANCE_COMMAND_ARGS);
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.mcpCode).toBe(-32603);
    expect(outcome.data).toMatchObject({ code: "UNKNOWN_ERROR" });
    expect(JSON.stringify(outcome.data)).not.toContain("ECONNREFUSED");
  });
});

describe("stdio server direct decoder invocation", () => {
  const commandEntry = STDIO_TOOL_ENTRIES.find((entry) => entry.kind === CONFORMANCE_COMMAND_KIND);

  it.each([
    ["truncated json", new TextEncoder().encode('{"commandKind":')],
    ["not json at all", new TextEncoder().encode("definitely not json")],
    ["invalid utf-8", Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d])],
    ["empty body", new Uint8Array(0)],
  ])("refuses %s with a stable error and zero port calls", async (_label, bytes) => {
    const port = createRecordingPort();
    expect(commandEntry).toBeDefined();
    if (commandEntry === undefined) return;
    let thrown: unknown;
    try {
      await decodeAndDispatch(port, commandEntry, bytes);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(-32602);
    expect((thrown as McpError).data).toMatchObject({ code: "INPUT_INVALID" });
    expect(port.calls).toEqual([]);
  });

  it("dispatches verbatim bytes once the envelope decodes", async () => {
    const port = createRecordingPort();
    expect(commandEntry).toBeDefined();
    if (commandEntry === undefined) return;
    const envelope = {
      commandId: "cmd-direct-1",
      commandKind: CONFORMANCE_COMMAND_KIND,
      correlationId: "corr-direct-1",
      expectedVersion: 0,
      payload: {},
      requestDigest: "a".repeat(64),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: CREDENTIAL,
      targetAggregateId: "goal-direct-1",
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const response = await decodeAndDispatch(port, commandEntry, bytes);
    expect(port.calls).toEqual([`authenticate:${CONFORMANCE_COMMAND_KIND}`, "dispatchCommandBytes"]);
    expect(port.dispatched[0]).toBe(bytes);
    expect(new TextDecoder().decode(response)).toBe(CONFORMANCE_COMMAND_RESPONSE_TEXT);
  });
});

describe("package root export surface", () => {
  it("reaches the adapter through the declared package root, not a deep import", () => {
    expect(packageRoot.createStdioMcpServer).toBe(createStdioMcpServer);
    expect(packageRoot.decodeAndDispatch).toBe(decodeAndDispatch);
    expect(packageRoot.readBootstrapCredential).toBe(readBootstrapCredential);
    expect(packageRoot.STDIO_TOOL_ENTRIES).toBe(STDIO_TOOL_ENTRIES);
  });

  it("keeps the test-only conformance suite out of the package root", () => {
    expect(Object.keys(packageRoot)).not.toContain("registerDispatchConformanceSuite");
  });
});

describe("stdio bootstrap credential", () => {
  it("reads the credential from the injected environment exactly once per call", () => {
    expect(readBootstrapCredential({ [MOE_SESSION_CREDENTIAL_ENV]: CREDENTIAL })).toBe(CREDENTIAL);
  });

  it.each([{}, { [MOE_SESSION_CREDENTIAL_ENV]: "" }])(
    "refuses to start without a bootstrap credential",
    (environment) => {
      expect(() => readBootstrapCredential(environment)).toThrow(MOE_SESSION_CREDENTIAL_ENV);
    },
  );

  it("never repeats a credential value in the startup refusal message", () => {
    let message = "";
    try {
      readBootstrapCredential({ [MOE_SESSION_CREDENTIAL_ENV]: "" });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toContain(CREDENTIAL);
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("stdio server tool allowlist", () => {
  const WIRED = Object.freeze(["project.register", "approval.decide", "work.get_context"]);

  it("advertises exactly the allowlisted kinds, by name derived from the input", async () => {
    const server = createStdioMcpServer({
      credential: CREDENTIAL, port: createRecordingPort(), toolAllowlist: WIRED,
    });
    const client = new Client({ name: "allowlist-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();

      // Derived from the input, never a hand-pinned roster: a kind added to the
      // daemon's wired set flows through here without an edit.
      expect(listed.tools.map((tool) => tool.name).sort())
        .toEqual(WIRED.map(toolLabelForKind).sort());
      // The schemas are the generated ones, unchanged by filtering.
      const registerEntry = STDIO_TOOL_ENTRIES.find((entry) => entry.kind === "project.register");
      expect(listed.tools.find((tool) => tool.name === "project_register")?.inputSchema)
        .toEqual(registerEntry?.tool.inputSchema);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("advertises FEWER tools than the unfiltered set, so the filter is doing work", async () => {
    const server = createStdioMcpServer({
      credential: CREDENTIAL, port: createRecordingPort(), toolAllowlist: WIRED,
    });
    const client = new Client({ name: "allowlist-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();

      expect(listed.tools.length).toBe(WIRED.length);
      expect(listed.tools.length).toBeLessThan(STDIO_TOOL_ENTRIES.length);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses an unknown kind AT CONSTRUCTION with its stable code", () => {
    let message = "";
    let created = false;
    try {
      createStdioMcpServer({
        credential: CREDENTIAL,
        port: createRecordingPort(),
        toolAllowlist: ["project.register", "project.definitely_not_a_kind"],
      });
      created = true;
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(created).toBe(false);
    expect(message).toContain(MCP_TOOL_ALLOWLIST_UNKNOWN_KIND);
    expect(message).toContain("project.definitely_not_a_kind");
    // The refusal names the offender, not the whole roster.
    expect(message).not.toContain("approval.decide");
  });

  it("refuses an EMPTY allowlist with its own code: zero tools is a misconfiguration", () => {
    let message = "";
    let created = false;
    try {
      createStdioMcpServer({ credential: CREDENTIAL, port: createRecordingPort(), toolAllowlist: [] });
      created = true;
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(created).toBe(false);
    expect(message).toContain(MCP_TOOL_ALLOWLIST_EMPTY);
  });

  it("leaves the unfiltered advertisement byte-identical when no allowlist is given", async () => {
    const listed = await withClient(createRecordingPort(), async (client) => client.listTools());

    expect(listed.tools.map((tool) => tool.name))
      .toEqual(STDIO_TOOL_ENTRIES.map((entry) => entry.tool.name));
    expect(listed.tools).toEqual(
      STDIO_TOOL_ENTRIES.map((entry) => ({
        description: entry.tool.description,
        inputSchema: entry.tool.inputSchema,
        name: entry.tool.name,
      })),
    );
  });
});
