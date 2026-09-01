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
   * Runtime KIND strings this server may advertise and, by construction, serve. Absent means the
   * full generated set byte for byte. Kinds, not tool names: the caller never learns this
   * package's name-mangling rule.
   */
  readonly toolAllowlist?: readonly string[];
}

const encoder = new TextEncoder();

/**
 * The single process environment read site in this package: callers read once at start-up and
 * pass the value on, so nothing downstream re-reads it. The refusal names the variable, never
 * its value.
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
 * A broken daemon boundary is never reflected back: anything the port throws becomes the stable
 * `UNKNOWN_ERROR`, so host paths and stack text in an arbitrary `Error` never reach client logs.
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
 * Adapter-supplied fields are written last, so a client sending `sessionCredential`,
 * `requestDigest`, `commandKind` or `schemaVersion` cannot override them; any
 * other unexpected key survives into the envelope and is refused by the exact-key decoder.
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
 * The transport-independent core: bounded decode, then authenticate, then exactly one dispatch
 * on the matching surface. A decode refusal performs zero port calls, an authentication refusal
 * zero dispatch calls; exported so hostile bytes can be driven straight at it, which no protocol
 * roundtrip can express. Both port calls share one containment: a credential store that THROWS
 * is a broken daemon boundary and becomes `UNKNOWN_ERROR` rather than a raw SDK error carrying
 * the throw's message, while a refusal the port RETURNS is already an `McpError` and passes
 * through intact.
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
  try {
    const auth = port.authenticate(decoded.envelope.sessionCredential, entry.kind);
    if (!auth.ok) refuse(auth.error);
    return await (isCommand ? port.dispatchCommandBytes(bytes) : port.dispatchQueryBytes(bytes));
  } catch (error) {
    if (error instanceof McpError) throw error;
    refuseUnknown();
  }
}

/**
 * `allowed` is the exact tool-name set this server advertises. Omission is an AUTHORIZATION
 * refusal, not a syntax one: unknown stays INPUT_INVALID, known-but-omitted becomes
 * CAPABILITY_DENIED, and both refuse before envelope construction, authentication or dispatch.
 */
async function callTool(
  options: StdioServerOptions,
  toolLabel: string,
  args: Readonly<Record<string, unknown>> | undefined,
  allowed: ReadonlySet<string>,
): Promise<string> {
  const entry = STDIO_TOOL_INDEX.get(toolLabel);
  if (entry === undefined) refuseInvalidInput();
  if (!allowed.has(toolLabel)) refuse(createRuntimeError({ code: "CAPABILITY_DENIED" }));
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
 * Built once from the frozen generated entries and frozen again here: the SDK wants the mutable
 * `Tool` shape, so this copies rather than shares the generated object, and freezing the copy
 * keeps a shared module-level value out of any later consumer's reach.
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
 * Connects a server to the process's stdio transport. Lives here so composition roots (the
 * daemon's mcp bin) never import the SDK directly — its type surface drags DOM lib types that a
 * node-only tsconfig rightly refuses.
 */
export async function connectStdioTransport(server: Server): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await server.connect(new StdioServerTransport());
}

/**
 * Low-level SDK `Server`, not `McpServer`: the high-level API accepts only a zod input schema,
 * while this handler serves the generated JSON Schema verbatim. Daemon bytes leave as one UTF-8
 * text block with no `outputSchema`/`structuredContent`, either of which would force a
 * re-serialisation, so ids, truth classes, cursors and recovery commands survive byte-identical;
 * a client that disconnects mid-dispatch simply loses the result. ListTools and CallTool read
 * ONE construction-time capability set — the same `tools` value is advertised and, by name,
 * authorises every direct call, so advertisement/call drift is unrepresentable.
 */
export function createStdioMcpServer(options: StdioServerOptions): Server {
  const server = new Server(
    { name: options.serverName ?? "moe-runtime", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  // Filtered ONCE, at construction: an unknown or empty allowlist refuses here rather than at the
  // first ListTools, so a bad roster never reaches a client; the same value is the capability set.
  const tools = options.toolAllowlist === undefined
    ? LISTED_TOOLS
    : listedFrom(allowlistedToolEntries(options.toolAllowlist));
  const allowed: ReadonlySet<string> = new Set(tools.map((tool) => tool.name));

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        text: await callTool(options, request.params.name, request.params.arguments, allowed),
        type: "text" as const,
      },
    ],
  }));

  return server;
}
