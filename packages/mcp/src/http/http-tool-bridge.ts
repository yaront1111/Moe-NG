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
} from "@modelcontextprotocol/sdk/types.js";

import { refuse, refuseInvalidInput, serialize } from "../adapter-refusals.js";
import { containDispatchThrow } from "../dispatch-fault.js";
import type { McpDispatchFaultObserver, McpDispatchFaultStage } from "../dispatch-fault.js";
import {
  STDIO_TOOL_ENTRIES,
  STDIO_TOOL_INDEX,
  allowlistedToolEntries,
  withPayloadProperties,
} from "../stdio/stdio-tool-schemas.js";
import type { StdioPayloadPropertyOverlay, StdioToolEntry } from "../stdio/stdio-tool-schemas.js";

/**
 * The MCP tool surface for the Streamable HTTP transport: generated schemas in, opaque daemon
 * bytes out. Split from `http-server.ts` to keep both small; nothing here knows about requests.
 *
 * PORT WIDTH. `HttpDispatchPort` carries the authenticated request identity and optional
 * `AbortSignal` in one required context, and tolerates an asynchronous result. A stdio port may
 * still implement the narrower one-argument shape: JavaScript permits ignored trailing arguments
 * and TypeScript permits that parameter-arity narrowing. Threading the context is this adapter's
 * obligation; an implementation may ignore cancellation, and nothing here reports one the daemon
 * did not perform.
 *
 * ENVELOPE CONSTRUCTION mirrors the stdio adapter byte for byte. The duplication is guarded
 * executably rather than by prose: the parity suite pushes identical arguments through both
 * transports and byte-compares the envelopes each port received, so drift fails a test.
 */

/** Exactly the generated stdio tool set. There is no HTTP-only tool, by construction. */
export const HTTP_LISTED_TOOLS = Object.freeze(STDIO_TOOL_ENTRIES.map((entry) => entry.tool));

/**
 * The advertisement for one adapter. An absent allowlist and overlay return the shared
 * module-level value itself, so an existing consumer sees the identical object it always saw; a
 * present one refuses at adapter construction, before any session opens, which makes a bad
 * roster — or an overlay typing a kind the roster lacks — a startup failure. The overlay is
 * applied after the allowlist, exactly as the stdio server applies it, so both transports
 * advertise one schema for one kind.
 */
export function httpListedTools(
  allowlist: readonly string[] | undefined,
  payloadProperties?: StdioPayloadPropertyOverlay,
): typeof HTTP_LISTED_TOOLS {
  if (allowlist === undefined && payloadProperties === undefined) return HTTP_LISTED_TOOLS;
  const entries = allowlist === undefined ? STDIO_TOOL_ENTRIES : allowlistedToolEntries(allowlist);
  return Object.freeze(withPayloadProperties(entries, payloadProperties).map((entry) => entry.tool));
}

export type HttpAuthOutcome =
  | { readonly error: RuntimeError; readonly ok: false }
  | { readonly ok: true };

export interface HttpDispatchContext {
  /** The bearer authenticated immediately before this dispatch. */
  readonly credential: string;
  readonly signal?: AbortSignal;
}

export interface HttpDispatchPort {
  authenticate(credential: string, toolKind: string): HttpAuthOutcome;
  dispatchCommandBytes(
    bytes: Uint8Array,
    context: HttpDispatchContext,
  ): Promise<Uint8Array> | Uint8Array;
  dispatchQueryBytes(
    bytes: Uint8Array,
    context: HttpDispatchContext,
  ): Promise<Uint8Array> | Uint8Array;
}

const encoder = new TextEncoder();

/** Digest binds the request to the payload bytes exactly as this adapter serialises them. */
function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(encoder.encode(serialize(payload ?? null))).digest("hex");
}

/**
 * Adapter-supplied fields are written last so a client sending `sessionCredential`,
 * `requestDigest`, `commandKind` or `schemaVersion` cannot override them; any other key survives
 * into the envelope and is refused by the exact-key decoder.
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
 * the matching surface: a decode refusal makes zero port calls, an auth refusal zero dispatches.
 *
 * Both port calls share one containment: a credential store that THROWS is a broken daemon
 * boundary and becomes `UNKNOWN_ERROR` rather than a raw SDK error carrying the throw's message,
 * while a refusal the port RETURNS is already an `McpError` and passes through intact. The
 * throw itself is reported to `observe`, host-side, with the stage it hit.
 */
export async function decodeAndDispatch(
  port: HttpDispatchPort,
  entry: StdioToolEntry,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
  observe?: McpDispatchFaultObserver,
): Promise<Uint8Array> {
  const isCommand = entry.surface === "command";
  const decoded = isCommand
    ? decodeRuntimeCommandEnvelopeBytes(bytes)
    : decodeRuntimeQueryEnvelopeBytes(bytes);
  if (!decoded.ok) refuse(decoded.error);
  const context: HttpDispatchContext = {
    credential: decoded.envelope.sessionCredential,
    ...(signal === undefined ? {} : { signal }),
  };
  let stage: McpDispatchFaultStage = "authenticate";
  try {
    const auth = port.authenticate(decoded.envelope.sessionCredential, entry.kind);
    if (!auth.ok) refuse(auth.error);
    stage = "dispatch";
    return await (isCommand
      ? port.dispatchCommandBytes(bytes, context)
      : port.dispatchQueryBytes(bytes, context));
  } catch (error) {
    containDispatchThrow(
      error, { stage, surface: entry.surface, toolKind: entry.kind, transport: "http" }, observe,
    );
  }
}

/**
 * `allowed` is the exact tool-name set this session advertises. Omission is an AUTHORIZATION
 * refusal, not a syntax one: unknown stays INPUT_INVALID, known-but-omitted becomes
 * CAPABILITY_DENIED, and both refuse before envelope construction, authentication or dispatch.
 */
async function callTool(
  port: HttpDispatchPort,
  credential: string,
  toolLabel: string,
  args: Readonly<Record<string, unknown>> | undefined,
  signal: AbortSignal | undefined,
  allowed: ReadonlySet<string>,
  observe: McpDispatchFaultObserver | undefined,
): Promise<string> {
  const entry = STDIO_TOOL_INDEX.get(toolLabel);
  if (entry === undefined) refuseInvalidInput();
  if (!allowed.has(toolLabel)) refuse(createRuntimeError({ code: "CAPABILITY_DENIED" }));
  const response = await decodeAndDispatch(
    port,
    entry,
    buildEnvelopeBytes(entry, credential, args ?? {}),
    signal,
    observe,
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(response);
  } catch (error) {
    containDispatchThrow(error, {
      stage: "response-decode", surface: entry.surface, toolKind: entry.kind, transport: "http",
    }, observe);
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
  listedTools: typeof HTTP_LISTED_TOOLS = HTTP_LISTED_TOOLS,
  observe?: McpDispatchFaultObserver,
): Server {
  const server = new Server(
    { name: serverName, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  // ListTools and CallTool read ONE capability set: the exact tools this session advertises.
  const allowed: ReadonlySet<string> = new Set(listedTools.map((tool) => tool.name));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listedTools }));
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
            allowed,
            observe,
          ),
          type: "text" as const,
        },
      ],
    };
  });
  return server;
}
