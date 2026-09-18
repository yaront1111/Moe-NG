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
  /**
   * Members a host has TYPED for one kind's payload (`withPayloadProperties`). The object stays
   * open: the daemon decoder remains the payload authority, and naming a member here only
   * tells the client what JSON type that member is before it sends it.
   */
  readonly properties?: Readonly<Record<string, StdioPropertySchema>>;
  readonly type: "object";
}

/** Per-kind payload members a host declares; every named kind must be an advertised tool. */
export type StdioPayloadPropertyOverlay =
  Readonly<Record<string, Readonly<Record<string, StdioPropertySchema>>>>;

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

/** An allowlisted kind that no generated entry answers: a construction-time refusal. */
export const MCP_TOOL_ALLOWLIST_UNKNOWN_KIND = "MCP_TOOL_ALLOWLIST_UNKNOWN_KIND" as const;

/** Advertising nothing is a misconfiguration, not a choice, so it refuses on its own code. */
export const MCP_TOOL_ALLOWLIST_EMPTY = "MCP_TOOL_ALLOWLIST_EMPTY" as const;

const ENTRY_BY_KIND: ReadonlyMap<string, StdioToolEntry> = new Map(
  STDIO_TOOL_ENTRIES.map((entry) => [entry.kind, entry]),
);

/**
 * Selects the generated entries an allowlist names, in the allowlist's own order.
 *
 * It REFUSES rather than dropping: a name the generator never produced means the caller's
 * roster and this package's vocabulary have drifted, and silently advertising a shorter
 * list would hide that until an agent called a tool that was never there. Repeats collapse,
 * because two entries sharing a tool name is a client-visible defect, not a caller intent.
 */
export function allowlistedToolEntries(
  allowlist: readonly string[],
): readonly StdioToolEntry[] {
  if (allowlist.length === 0) {
    throw new Error(`${MCP_TOOL_ALLOWLIST_EMPTY}: an MCP server must advertise at least one tool`);
  }
  const selected = new Map<string, StdioToolEntry>();
  for (const kind of allowlist) {
    const entry = ENTRY_BY_KIND.get(kind);
    if (entry === undefined) {
      throw new Error(`${MCP_TOOL_ALLOWLIST_UNKNOWN_KIND}: ${kind} has no generated tool`);
    }
    selected.set(kind, entry);
  }
  return Object.freeze([...selected.values()]);
}

/** An overlay naming a kind that no selected entry advertises: a construction-time refusal. */
export const MCP_PAYLOAD_OVERLAY_UNKNOWN_KIND = "MCP_PAYLOAD_OVERLAY_UNKNOWN_KIND" as const;

/**
 * Types the payload members a host declares, kind by kind, on top of the generated entries.
 *
 * The generator itself cannot know a payload's members: the exact-key roster and the typed
 * decoders live in the daemon, behind the dispatch port. What the host passes here is read
 * from that roster, so the advertised type and the enforced one have one source. The payload
 * object stays `additionalProperties: true` — the daemon decoder is still the only authority —
 * but a client that reads the schema now learns, for example, that `round` is an integer
 * BEFORE it sends the string "4" and is refused. Three seats did exactly that (2026-09-18).
 *
 * It REFUSES an overlay naming a kind the entries do not carry, on the allowlist's own rule:
 * a roster and an overlay that drifted apart would otherwise advertise a typed member for a
 * tool that is not there, and nothing would notice until an agent looked for it.
 */
export function withPayloadProperties(
  entries: readonly StdioToolEntry[],
  overlay: StdioPayloadPropertyOverlay | undefined,
): readonly StdioToolEntry[] {
  if (overlay === undefined) return entries;
  const advertised = new Set(entries.map((entry) => entry.kind));
  for (const kind of Object.keys(overlay)) {
    if (!advertised.has(kind)) {
      throw new Error(`${MCP_PAYLOAD_OVERLAY_UNKNOWN_KIND}: ${kind} is not an advertised tool`);
    }
  }
  return Object.freeze(entries.map((entry) => {
    const members = overlay[entry.kind];
    const payload = entry.tool.inputSchema.properties["payload"];
    if (members === undefined || payload === undefined || payload.type !== "object") return entry;
    const typedPayload: StdioOpaqueObjectSchema = Object.freeze({
      ...payload, properties: Object.freeze({ ...members }),
    });
    return Object.freeze({
      ...entry,
      tool: Object.freeze({
        ...entry.tool,
        inputSchema: Object.freeze({
          ...entry.tool.inputSchema,
          properties: Object.freeze({ ...entry.tool.inputSchema.properties, payload: typedPayload }),
        }),
      }),
    });
  }));
}
