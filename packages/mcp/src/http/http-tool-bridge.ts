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

import { STDIO_TOOL_ENTRIES, STDIO_TOOL_INDEX } from "../stdio/stdio-tool-schemas.js";
import type { StdioToolEntry } from "../stdio/stdio-tool-schemas.js";

/**
 * The MCP tool surface for the Streamable HTTP transport: generated schemas in, opaque daemon
 * bytes out. Split from `http-server.ts` purely to keep both modules small; nothing here knows
 * about HTTP requests, sessions, or responses.
 *
 * PORT WIDTH. `HttpDispatchPort` accepts an optional `AbortSignal` and tolerates an
 * asynchronous result. Both are supersets of the stdio port shape, so a narrower implementation
 * — including the shared conformance suite's fake — is assignable here by ordinary
 * parameter-arity and return-type assignability. Threading the signal is this adapter's
 * obligation; an implementation may ignore it, and nothing here reports a cancellation the
 * daemon did not actually perform.
 *
 * ENVELOPE CONSTRUCTION mirrors the stdio adapter byte for byte. It is duplicated rather than
 * shared because that module is owned by another task, and the duplication is guarded
 * executably: the parity suite pushes identical arguments through both transports and
 * byte-compares the envelopes each port received, so drift fails a test rather than shipping.
 */

/** Exactly the generated stdio tool set. There is no HTTP-only tool, by construction. */
export const HTTP_LISTED_TOOLS = Object.freeze(STDIO_TOOL_ENTRIES.map((entry) => entry.tool));

export type HttpAuthOutcome =
  | { readonly error: RuntimeError; readonly ok: false }
  | { readonly ok: true };

export interface HttpDispatchPort {
  authenticate(credential: string, toolKind: string): HttpAuthOutcome;
  dispatchCommandBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> | Uint8Array;
  dispatchQueryBytes(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> | Uint8Array;
}

const encoder = new TextEncoder();

/** Every adapter-side refusal routes through the registry, never through invented codes. */
export function refuse(error: RuntimeError): never {
  throw new McpError(error.transport.mcpCode, error.code, error);
}

export function refuseInvalidInput(): never {
  refuse(createRuntimeError({ code: "INPUT_INVALID" }));
}

/**
 * A broken daemon boundary is never reflected back to a client: anything the port throws
 * becomes the stable `UNKNOWN_ERROR`, so host paths and connection strings in an arbitrary
 * `Error` message cannot reach an MCP client's logs.
 */
export function refuseUnknown(): never {
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
 * `requestDigest`, `commandKind`, or `schemaVersion` cannot override them. Any other unexpected
 * key survives into the envelope and is refused by the exact-key decoder.
 */
export function buildEnvelopeBytes(
  entry: StdioToolEntry,
  credential: string,
  args: Readonly<Record<string, unknown>>,
): Uint8Array {
  if (entry.surface === "command") {
    return encoder.encode(
      serialize({
        ...args,
        commandKind: entry.kind,
        requestDigest: payloadDigest(args["payload"]),
        schemaVersion: RUNTIME_COMMAND_ENVELOPE_VERSION,
        sessionCredential: credential,
      }),
    );
  }
  return encoder.encode(
    serialize({
      ...args,
      queryKind: entry.kind,
      schemaVersion: RUNTIME_QUERY_ENVELOPE_VERSION,
      sessionCredential: credential,
    }),
  );
}

/**
 * Bounded decode, then authenticate with the VERBATIM dotted kind, then exactly one dispatch on
 * the matching surface. A decode refusal performs zero port calls and an authentication refusal
 * performs zero dispatch calls.
 */
export async function decodeAndDispatch(
  port: HttpDispatchPort,
  entry: StdioToolEntry,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const isCommand = entry.surface === "command";
  const decoded = isCommand
    ? decodeRuntimeCommandEnvelopeBytes(bytes)
    : decodeRuntimeQueryEnvelopeBytes(bytes);
  if (!decoded.ok) refuse(decoded.error);
  const auth = port.authenticate(decoded.envelope.sessionCredential, entry.kind);
  if (!auth.ok) refuse(auth.error);
  try {
    return await (isCommand
      ? port.dispatchCommandBytes(bytes, signal)
      : port.dispatchQueryBytes(bytes, signal));
  } catch (error) {
    if (error instanceof McpError) throw error;
    refuseUnknown();
  }
}

async function callTool(
  port: HttpDispatchPort,
  credential: string,
  toolLabel: string,
  args: Readonly<Record<string, unknown>> | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const entry = STDIO_TOOL_INDEX.get(toolLabel);
  if (entry === undefined) refuseInvalidInput();
  const response = await decodeAndDispatch(
    port,
    entry,
    buildEnvelopeBytes(entry, credential, args ?? {}),
    signal,
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(response);
  } catch {
    refuseUnknown();
  }
}

/**
 * Low-level SDK `Server`, matching the stdio adapter: the generated JSON Schema is served
 * verbatim with no zod, and daemon bytes leave as one opaque text block with no `outputSchema`
 * and no `structuredContent`, neither of which would survive the SDK's re-serialisation.
 *
 * The per-request credential arrives through `authInfo`, the only per-request channel the
 * transport offers. A request that somehow reaches here without one is refused rather than
 * dispatched with a blank credential.
 */
export function createHttpMcpServer(
  port: HttpDispatchPort,
  serverName: string,
): Server {
  const server = new Server(
    { name: serverName, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: HTTP_LISTED_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const credential = extra.authInfo?.token;
    if (typeof credential !== "string" || credential.length === 0) refuseInvalidInput();
    return {
      content: [
        {
          text: await callTool(
            port,
            credential,
            request.params.name,
            request.params.arguments,
            extra.signal,
          ),
          type: "text" as const,
        },
      ],
    };
  });
  return server;
}
