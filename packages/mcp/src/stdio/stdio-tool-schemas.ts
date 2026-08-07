import {
  MAX_JSON_BODY_BYTES,
  MAX_JSON_STRING_UTF8_BYTES,
  RUNTIME_COMMAND_KINDS,
  RUNTIME_QUERY_KINDS,
} from "@moe/contracts";

/** Conservative grammar every mainstream MCP client accepts for a tool name. */
export const STDIO_TOOL_LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/u;

/**
 * Command envelope keys the adapter fills in, never the client. `commandKind` comes from
 * the invoked tool label, `schemaVersion` is a constant, `requestDigest` is computed over
 * the canonical payload bytes, and `sessionCredential` is the bootstrap credential the
 * server holds in closure. MCP clients log tool arguments, so none may be an input.
 */
export const ADAPTER_SUPPLIED_COMMAND_FIELDS = Object.freeze([
  "commandKind", "requestDigest", "schemaVersion", "sessionCredential",
] as const);

/** Query envelope counterpart of {@link ADAPTER_SUPPLIED_COMMAND_FIELDS}. */
export const ADAPTER_SUPPLIED_QUERY_FIELDS = Object.freeze([
  "queryKind", "schemaVersion", "sessionCredential",
] as const);

export type StdioToolSurface = "command" | "query";

export interface StdioStringSchema {
  readonly description: string;
  readonly maxLength: number;
  readonly minLength: number;
  readonly pattern?: string;
  readonly type: "string";
}

export interface StdioIntegerSchema {
  readonly description: string;
  readonly maximum: number;
  readonly minimum: number;
  readonly type: "integer";
}

export interface StdioOpaqueObjectSchema {
  readonly additionalProperties: true;
  readonly description: string;
  readonly type: "object";
}

export type StdioPropertySchema =
  | StdioIntegerSchema
  | StdioOpaqueObjectSchema
  | StdioStringSchema;

export interface StdioObjectSchema {
  readonly additionalProperties: false;
  readonly properties: Readonly<Record<string, StdioPropertySchema>>;
  readonly required: readonly string[];
  readonly type: "object";
}

export interface StdioTool {
  readonly description: string;
  readonly inputSchema: StdioObjectSchema;
  readonly name: string;
}

export interface StdioToolEntry {
  readonly kind: string;
  readonly surface: StdioToolSurface;
  readonly tool: StdioTool;
}

const HEX_64_PATTERN = "^[0-9a-f]{64}$";

function identifier(description: string): StdioStringSchema {
  return Object.freeze({
    description,
    maxLength: MAX_JSON_STRING_UTF8_BYTES,
    minLength: 1,
    type: "string" as const,
  });
}

function hex64(description: string): StdioStringSchema {
  return Object.freeze({
    description,
    maxLength: 64,
    minLength: 64,
    pattern: HEX_64_PATTERN,
    type: "string" as const,
  });
}

function safeCount(description: string): StdioIntegerSchema {
  return Object.freeze({
    description,
    maximum: Number.MAX_SAFE_INTEGER,
    minimum: 0,
    type: "integer" as const,
  });
}

function opaqueObject(description: string): StdioOpaqueObjectSchema {
  return Object.freeze({ additionalProperties: true as const, description, type: "object" as const });
}

const BODY_BOUND = `The whole request body is bounded at ${String(MAX_JSON_BODY_BYTES)} bytes.`;

/**
 * Payload stays opaque: the per-command payload surface is generated from one source in
 * M3. Until then the daemon decoder is the only payload authority.
 */
const PAYLOAD = opaqueObject(
  `Operation payload, passed through to the daemon unmodified. ${BODY_BOUND}`,
);

/**
 * Lease binding stays opaque on purpose. Its inner shape is
 * {attemptBindingVersion, authorityHash, epoch, graphEpoch, leaseToken} and is accepted
 * all-or-none by the daemon. Naming the bearer field as a schema property would put it
 * in the argument keys MCP clients log, so the shape is documented here instead.
 */
const LEASE_AUTHORITY = opaqueObject(
  "Optional lease binding, accepted all-or-none. Required members: attemptBindingVersion" +
    " (integer >= 0), authorityHash (lowercase sha-256 hex), epoch (integer >= 0)," +
    " graphEpoch (integer >= 0), leaseToken (non-empty string).",
);

const COMMAND_PROPERTIES: Readonly<Record<string, StdioPropertySchema>> = Object.freeze({
  commandId: identifier("Caller-chosen idempotency key for this command."),
  correlationId: identifier("Caller-chosen id echoed back on the result and on errors."),
  expectedVersion: safeCount("expectedVersion the caller believes the target aggregate is at."),
  graphRevisionHash: hex64("Optional graph revision the caller is acting against."),
  leaseAuthority: LEASE_AUTHORITY,
  payload: PAYLOAD,
  policyRevisionHash: hex64("Optional policy revision the caller is acting against."),
  targetAggregateId: identifier("Identifier of the aggregate this command targets."),
});

const COMMAND_REQUIRED = Object.freeze([
  "commandId", "correlationId", "expectedVersion", "payload", "targetAggregateId",
] as const);

const QUERY_PROPERTIES: Readonly<Record<string, StdioPropertySchema>> = Object.freeze({
  correlationId: identifier("Caller-chosen id echoed back on the result and on errors."),
  cursor: identifier("Opaque continuation cursor returned by a previous read. Never parsed."),
  payload: PAYLOAD,
  targetAggregateId: identifier("Optional identifier of the aggregate this query reads."),
});

const QUERY_REQUIRED = Object.freeze(["correlationId", "payload"] as const);

const COMMAND_SCHEMA: StdioObjectSchema = Object.freeze({
  additionalProperties: false as const,
  properties: COMMAND_PROPERTIES,
  required: COMMAND_REQUIRED,
  type: "object" as const,
});

const QUERY_SCHEMA: StdioObjectSchema = Object.freeze({
  additionalProperties: false as const,
  properties: QUERY_PROPERTIES,
  required: QUERY_REQUIRED,
  type: "object" as const,
});

/**
 * Dots are rejected by common client and model tool-name grammars, so the transport label
 * replaces every dot with an underscore. The mapping is not injective in general: a kind
 * whose segment already contained the underscored form of another kind would collide.
 * `stdio-schemas.test.ts` proves injectivity over the current closed vocabularies and fails
 * the moment a newly added kind collides, which is where that has to be caught.
 */
export function toolLabelForKind(kind: string): string {
  return kind.replaceAll(".", "_");
}

function describeTool(kind: string, surface: StdioToolSurface): string {
  const noun = surface === "command" ? "Runtime command" : "Runtime read-only query";
  return `${noun} ${kind}. The daemon response is returned verbatim as text.`;
}

function buildEntry(kind: string, surface: StdioToolSurface): StdioToolEntry {
  return Object.freeze({
    kind,
    surface,
    tool: Object.freeze({
      description: describeTool(kind, surface),
      inputSchema: surface === "command" ? COMMAND_SCHEMA : QUERY_SCHEMA,
      name: toolLabelForKind(kind),
    }),
  });
}

/**
 * Mechanically derives one tool per closed-vocabulary kind. Ordering follows the frozen
 * source vocabularies, so repeated runs are byte-identical.
 */
export function generateStdioToolEntries(): readonly StdioToolEntry[] {
  const entries: StdioToolEntry[] = [];
  for (const kind of RUNTIME_COMMAND_KINDS) entries.push(buildEntry(kind, "command"));
  for (const kind of RUNTIME_QUERY_KINDS) entries.push(buildEntry(kind, "query"));
  return Object.freeze(entries);
}

export const STDIO_TOOL_ENTRIES: readonly StdioToolEntry[] = generateStdioToolEntries();

export const STDIO_TOOL_INDEX: ReadonlyMap<string, StdioToolEntry> = new Map(
  STDIO_TOOL_ENTRIES.map((entry) => [entry.tool.name, entry]),
);
