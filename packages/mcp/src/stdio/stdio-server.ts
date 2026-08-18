import { createHash } from "node:crypto";

import {
  RUNTIME_COMMAND_ENVELOPE_VERSION,
  RUNTIME_QUERY_ENVELOPE_VERSION,
  createRuntimeError,
  decodeRuntimeCommandEnvelopeBytes,
  decodeRuntimeQueryEnvelopeBytes,
} from "@moe/contracts";
import type { RuntimeError } from "@moe/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import {
  STDIO_TOOL_ENTRIES,
  STDIO_TOOL_INDEX,
  allowlistedToolEntries,
} from "./stdio-tool-schemas.js";
import type { StdioToolEntry } from "./stdio-tool-schemas.js";
import type { StdioDispatchPort } from "./stdio-dispatch-port.js";

export const MOE_SESSION_CREDENTIAL_ENV = "MOE_SESSION_CREDENTIAL";

export interface StdioServerOptions {
  /** Bootstrap session credential, held in closure and never logged or echoed. */
  readonly credential: string;
  readonly port: StdioDispatchPort;
  readonly serverName?: string;
  /**
   * Runtime KIND strings this server may advertise. Absent means the full generated
   * set, byte for byte, so a consumer that never passes one sees no change. Kinds, not
   * tool names: the caller never learns this package's name-mangling rule.
   */
  readonly toolAllowlist?: readonly string[];
}

const encoder = new TextEncoder();

/**
 * The single process environment read site in this package. Callers are expected to invoke
 * this once at start-up and pass the value on, so nothing downstream re-reads the
 * environment. The refusal names the variable and never its value.
 */
export function readBootstrapCredential(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = environment[MOE_SESSION_CREDENTIAL_ENV];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${MOE_SESSION_CREDENTIAL_ENV} is unset or empty; refusing to start`);
  }
  return value;
}

/** Every adapter-side refusal routes through the registry, never through invented codes. */
function refuse(error: RuntimeError): never {
  throw new McpError(error.transport.mcpCode, error.code, error);
}

function refuseInvalidInput(): never {
  refuse(createRuntimeError({ code: "INPUT_INVALID" }));
}

/**
 * A broken daemon boundary is never reflected back to the client. Anything the port throws
 * becomes the stable `UNKNOWN_ERROR`, so host paths, connection strings, and stack text in
 * an arbitrary `Error` message can never reach an MCP client's logs.
 */
function refuseUnknown(): never {
  refuse(createRuntimeError({ code: "UNKNOWN_ERROR" }));
}

function serialize(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    refuseInvalidInput();
  }
  if (text === undefined) refuseInvalidInput();
  return text;
}

/** Digest binds the request to the payload bytes exactly as this adapter serialises them. */
function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(encoder.encode(serialize(payload ?? null))).digest("hex");
}

/**
 * Adapter-supplied fields are written last so a client that sends `sessionCredential`,
 * `requestDigest`, `commandKind`, or `schemaVersion` cannot override them. Any other
 * unexpected key survives into the envelope and is refused by the exact-key decoder.
 */
function buildCommandEnvelopeBytes(
  kind: string,
  credential: string,
  args: Readonly<Record<string, unknown>>,
): Uint8Array {
  return encoder.encode(
    serialize({
      ...args,
      commandKind: kind,
      requestDigest: payloadDigest(args["payload"]),
      schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
      sessionCredential: credential,
    }),
  );
}

function buildQueryEnvelopeBytes(
  kind: string,
  credential: string,
  args: Readonly<Record<string, unknown>>,
): Uint8Array {
  return encoder.encode(
    serialize({
      ...args,
      queryKind: kind,
      schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
      sessionCredential: credential,
    }),
  );
}

/**
 * The transport-independent core: bounded decode, then authenticate, then exactly one
 * dispatch on the matching surface. A decode refusal performs zero port calls and an
 * authentication refusal performs zero dispatch calls. Exported so hostile bytes can be
 * driven straight at it, which no protocol roundtrip can express.
 */
export async function decodeAndDispatch(
  port: StdioDispatchPort,
  entry: StdioToolEntry,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const isCommand = entry.surface === "command";
  const decoded = isCommand
    ? decodeRuntimeCommandEnvelopeBytes(bytes)
    : decodeRuntimeQueryEnvelopeBytes(bytes);
  if (!decoded.ok) refuse(decoded.error);
  const auth = port.authenticate(decoded.envelope.sessionCredential, entry.kind);
  if (!auth.ok) refuse(auth.error);
  try {
    return await (isCommand ? port.dispatchCommandBytes(bytes) : port.dispatchQueryBytes(bytes));
  } catch (error) {
    if (error instanceof McpError) throw error;
    refuseUnknown();
  }
}

async function callTool(
  options: StdioServerOptions,
  toolLabel: string,
  args: Readonly<Record<string, unknown>> | undefined,
): Promise<string> {
  const entry = STDIO_TOOL_INDEX.get(toolLabel);
  if (entry === undefined) refuseInvalidInput();
  const supplied = args ?? {};
  const bytes =
    entry.surface === "command"
      ? buildCommandEnvelopeBytes(entry.kind, options.credential, supplied)
      : buildQueryEnvelopeBytes(entry.kind, options.credential, supplied);
  const response = await decodeAndDispatch(options.port, entry, bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(response);
  } catch {
    refuseUnknown();
  }
}

/**
 * Built once from the frozen generated entries and frozen again here. The SDK wants the
 * mutable `Tool` shape, so this is a copy rather than the generated object itself; freezing
 * it keeps a single shared module-level value from being edited by any later consumer.
 */
const listedFrom = (entries: readonly StdioToolEntry[]) =>
  Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        description: entry.tool.description,
        inputSchema: Object.freeze({
          additionalProperties: entry.tool.inputSchema.additionalProperties,
          properties: Object.freeze({ ...entry.tool.inputSchema.properties }),
          required: Object.freeze([...entry.tool.inputSchema.required]),
          type: entry.tool.inputSchema.type,
        }),
        name: entry.tool.name,
      }),
    ),
  );

/** The unfiltered advertisement, built once and shared by every allowlist-free server. */
const LISTED_TOOLS = listedFrom(STDIO_TOOL_ENTRIES);

/**
 * Low-level SDK `Server`, deliberately not `McpServer`: the high-level API accepts only a
 * zod input schema, while the low-level request handler serves the generated JSON Schema
 * objects verbatim with no zod dependency and no schema re-derivation.
 *
 * Daemon bytes leave as a single UTF-8 text block with no `outputSchema` and no
 * `structuredContent`, both of which would force the SDK to re-serialise them. Nothing
 * re-parses the daemon response, so command ids, truth classes, opaque cursors, next
 * allowed commands, and recovery commands all survive byte-identical.
 *
 * A client that disconnects mid-dispatch simply loses the result: the outcome is dropped
 * and nothing is fabricated, because idempotency belongs to the daemon ledger.
 */
/**
 * Connects a server to the process's stdio transport. Lives here so composition
 * roots (the daemon's mcp bin) never import the SDK directly — its type surface
 * drags DOM lib types that a node-only tsconfig rightly refuses.
 */
export async function connectStdioTransport(server: Server): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await server.connect(new StdioServerTransport());
}

export function createStdioMcpServer(options: StdioServerOptions): Server {
  const server = new Server(
    { name: options.serverName ?? "moe-runtime", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  // Filtered ONCE, at construction: an unknown or empty allowlist refuses here rather
  // than at the first ListTools, so a misconfigured roster never reaches a client.
  const tools = options.toolAllowlist === undefined
    ? LISTED_TOOLS
    : listedFrom(allowlistedToolEntries(options.toolAllowlist));

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        text: await callTool(options, request.params.name, request.params.arguments),
        type: "text" as const,
      },
    ],
  }));

  return server;
}
